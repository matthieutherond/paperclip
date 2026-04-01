/**
 * Credential proxy for Docker-isolated Claude agents.
 *
 * Routing (by path prefix):
 *   /gh/*          → github.com       (GitHub token injection + branch protection)
 *   /gh-api/*      → api.github.com   (GitHub token injection)
 *   everything else → Anthropic API   (API key or OAuth injection)
 *
 * GitHub branch protection:
 *   Inspects git-receive-pack POST bodies and rejects pushes to protected
 *   branches (configured via PROTECTED_BRANCHES env, comma-separated).
 */
import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";

// --- Anthropic config ---
const ANTHROPIC_URL = new URL(process.env.UPSTREAM_URL || "https://api.anthropic.com");
const API_KEY = process.env.ANTHROPIC_API_KEY || "";
const OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_AUTH_TOKEN || "";
const AUTH_MODE = API_KEY ? "api-key" : "oauth";

// --- GitHub config ---
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const PROTECTED_BRANCHES = (process.env.PROTECTED_BRANCHES || "main,master")
  .split(",").map(b => b.trim()).filter(Boolean);

// --- GitHub App config (alternative to static GITHUB_TOKEN) ---
const GITHUB_APP_ID = process.env.GITHUB_APP_ID || "";
const GITHUB_APP_INSTALLATION_ID = process.env.GITHUB_APP_INSTALLATION_ID || "";
const GITHUB_APP_PRIVATE_KEY_PATH = "/secrets/github-app.pem";

let cachedInstallToken = null; // { token: string, expiresAt: number }
let pendingTokenRefresh = null; // Promise dedup

function generateGitHubJwt(appId, privateKey) {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId })).toString("base64url");
  const signature = crypto.sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), privateKey).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

function requestInstallationToken(jwt, installationId) {
  return new Promise((resolve, reject) => {
    const req = httpsRequest({
      hostname: "api.github.com",
      path: `/app/installations/${installationId}/access_tokens`,
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "paperclip-credential-proxy",
        "Content-Length": 0,
      },
    }, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.token) {
            resolve({ token: parsed.token, expires_at: parsed.expires_at });
          } else {
            reject(new Error(`GitHub App token exchange failed: ${data}`));
          }
        } catch {
          reject(new Error(`GitHub App token response parse error: ${data}`));
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

const REFRESH_MARGIN_MS = 5 * 60 * 1000;

async function refreshGitHubAppToken() {
  const privateKey = await readFile(GITHUB_APP_PRIVATE_KEY_PATH, "utf-8");
  if (!privateKey.trim()) {
    throw new Error("GitHub App private key is empty (check volume mount)");
  }
  const jwt = generateGitHubJwt(GITHUB_APP_ID, privateKey);
  const result = await requestInstallationToken(jwt, GITHUB_APP_INSTALLATION_ID);
  cachedInstallToken = {
    token: result.token,
    expiresAt: new Date(result.expires_at).getTime(),
  };
  console.log(`GitHub App token refreshed, expires at ${result.expires_at}`);
  return cachedInstallToken.token;
}

async function getGitHubToken() {
  // Static token takes precedence
  if (GITHUB_TOKEN) return GITHUB_TOKEN;

  // No App config → no GitHub auth
  if (!GITHUB_APP_ID || !GITHUB_APP_INSTALLATION_ID) return "";

  // Cached token still valid?
  if (cachedInstallToken && cachedInstallToken.expiresAt - Date.now() > REFRESH_MARGIN_MS) {
    return cachedInstallToken.token;
  }

  // Deduplicate concurrent refresh requests
  if (pendingTokenRefresh) return pendingTokenRefresh;

  pendingTokenRefresh = refreshGitHubAppToken().finally(() => {
    pendingTokenRefresh = null;
  });
  return pendingTokenRefresh;
}

const PORT = parseInt(process.env.PROXY_PORT || "3001", 10);
const HOST = process.env.PROXY_HOST || "0.0.0.0";

/**
 * Parse the first few pkt-lines of a git-receive-pack body to extract
 * target refs. Returns an array of ref names being pushed to.
 * Format: "<old-sha> <new-sha> <refname>\0<capabilities>" (first line)
 *         "<old-sha> <new-sha> <refname>" (subsequent lines)
 */
function extractPushRefs(body) {
  const refs = [];
  let offset = 0;
  const str = body.toString("utf-8", 0, Math.min(body.length, 4096));

  while (offset < str.length) {
    const hexLen = str.slice(offset, offset + 4);
    const pktLen = parseInt(hexLen, 16);
    if (pktLen === 0) break; // flush packet
    if (pktLen < 4) break;

    const line = str.slice(offset + 4, offset + pktLen);
    // Each line: "<40-hex-old> <40-hex-new> <refname>[\0capabilities]"
    const match = line.match(/^[0-9a-f]{40} [0-9a-f]{40} ([^\0\n]+)/);
    if (match) refs.push(match[1].trim());

    offset += pktLen;
  }
  return refs;
}

function isProtectedRef(ref) {
  for (const branch of PROTECTED_BRANCHES) {
    if (ref === `refs/heads/${branch}` || ref === branch) return true;
  }
  return false;
}

function forwardRequest({ hostname, port, basePath, path, method, headers, body, res }) {
  const upstream = httpsRequest(
    { hostname, port: port || 443, path: basePath + path, method, headers },
    (upRes) => {
      res.writeHead(upRes.statusCode, upRes.headers);
      upRes.pipe(res);
    },
  );
  upstream.on("error", (err) => {
    console.error(`Proxy upstream error: ${err.message} (${path})`);
    if (!res.headersSent) { res.writeHead(502); res.end("Bad Gateway"); }
  });
  upstream.write(body);
  upstream.end();
}

const server = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    const url = req.url || "/";

    // --- GitHub git traffic: /gh/org/repo.git/... ---
    if (url.startsWith("/gh/")) {
      const ghPath = url.slice(3); // strip "/gh" prefix, keep leading "/"

      // Branch protection: block pushes to protected branches
      if (req.method === "POST" && ghPath.includes("/git-receive-pack") && GITHUB_TOKEN) {
        const refs = extractPushRefs(body);
        const blocked = refs.filter(isProtectedRef);
        if (blocked.length > 0) {
          console.warn(`BLOCKED push to protected branch(es): ${blocked.join(", ")}`);
          res.writeHead(403, { "content-type": "text/plain" });
          res.end(`Push rejected: protected branch(es) ${blocked.join(", ")}\n`);
          return;
        }
      }

      const headers = { ...req.headers, host: "github.com", "content-length": body.length };
      delete headers["connection"]; delete headers["keep-alive"]; delete headers["transfer-encoding"];
      if (GITHUB_TOKEN) {
        delete headers["authorization"];
        headers["authorization"] = `Basic ${Buffer.from(`x-access-token:${GITHUB_TOKEN}`).toString("base64")}`;
      }

      forwardRequest({ hostname: "github.com", port: 443, basePath: "", path: ghPath, method: req.method, headers, body, res });
      return;
    }

    // --- GitHub API traffic: /gh-api/... ---
    if (url.startsWith("/gh-api/")) {
      const apiPath = url.slice(7); // strip "/gh-api" prefix, keep leading "/"

      const headers = { ...req.headers, host: "api.github.com", "content-length": body.length };
      delete headers["connection"]; delete headers["keep-alive"]; delete headers["transfer-encoding"];
      if (GITHUB_TOKEN) {
        delete headers["authorization"];
        headers["authorization"] = `Bearer ${GITHUB_TOKEN}`;
      }

      forwardRequest({ hostname: "api.github.com", port: 443, basePath: "", path: apiPath, method: req.method, headers, body, res });
      return;
    }

    // --- Default: Anthropic API ---
    const headers = {
      ...req.headers,
      host: ANTHROPIC_URL.host,
      "content-length": body.length,
    };
    delete headers["connection"]; delete headers["keep-alive"]; delete headers["transfer-encoding"];

    if (AUTH_MODE === "api-key") {
      delete headers["x-api-key"];
      headers["x-api-key"] = API_KEY;
    } else {
      if (headers["authorization"]) {
        delete headers["authorization"];
        if (OAUTH_TOKEN) headers["authorization"] = `Bearer ${OAUTH_TOKEN}`;
      }
    }

    forwardRequest({
      hostname: ANTHROPIC_URL.hostname,
      port: ANTHROPIC_URL.port || 443,
      basePath: "",
      path: url,
      method: req.method,
      headers,
      body,
      res,
    });
  });
});

server.listen(PORT, HOST, () => {
  const features = [AUTH_MODE];
  if (GITHUB_TOKEN) features.push("github");
  if (PROTECTED_BRANCHES.length) features.push(`protected: ${PROTECTED_BRANCHES.join(",")}`);
  console.log(`Credential proxy started on ${HOST}:${PORT} [${features.join(" | ")}]`);
});
