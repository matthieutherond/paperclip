# Proxy-Side GitHub App Token Refresh — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move GitHub App installation token generation into the credential proxy so tokens auto-refresh and never go stale.

**Architecture:** The credential proxy (`credential-proxy.mjs`) gains JWT generation and GitHub App token exchange. The host (`infra.ts`) passes App credentials instead of a pre-resolved token. Docker-compose mounts the private key file into the proxy container.

**Tech Stack:** Node.js 20 (built-in `crypto`), Docker Compose, vitest

**Spec:** `docs/superpowers/specs/2026-04-01-proxy-github-app-token-refresh-design.md`

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `packages/adapters/claude-docker/infra/credential-proxy.mjs` | Add `getGitHubToken()` with JWT generation, token exchange, caching, and Promise dedup |
| Modify | `packages/adapters/claude-docker/infra/docker-compose.yml` | Add optional private key volume mount |
| Modify | `packages/adapters/claude-docker/src/server/infra.ts` | Update `buildProxyEnv()` and `ensureProxyRunning()` to pass App credentials instead of resolved token |
| Create | `packages/adapters/claude-docker/src/server/__tests__/credential-proxy.test.ts` | Unit tests for the proxy's token resolution logic |

---

### Task 1: Add `getGitHubToken()` to credential proxy

**Files:**
- Modify: `packages/adapters/claude-docker/infra/credential-proxy.mjs`

This task adds the core token resolution function to the proxy. It handles three modes: static token, GitHub App (with lazy refresh + dedup), and no-auth.

- [ ] **Step 1: Add GitHub App env var parsing and cache state**

At the top of `credential-proxy.mjs`, after the existing GitHub config section (line 24), add:

```javascript
// --- GitHub App config (alternative to static GITHUB_TOKEN) ---
const GITHUB_APP_ID = process.env.GITHUB_APP_ID || "";
const GITHUB_APP_INSTALLATION_ID = process.env.GITHUB_APP_INSTALLATION_ID || "";
const GITHUB_APP_PRIVATE_KEY_PATH = "/secrets/github-app.pem";

let cachedInstallToken = null; // { token: string, expiresAt: number }
let pendingTokenRefresh = null; // Promise dedup
```

- [ ] **Step 2: Add JWT generation function**

After the new constants, add:

```javascript
function generateGitHubJwt(appId, privateKey) {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId })).toString("base64url");
  const signature = crypto.sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), privateKey).toString("base64url");
  return `${header}.${payload}.${signature}`;
}
```

Also add `import crypto from "node:crypto";` after the existing `import { createServer }` and `import { request as httpsRequest }` at the top (line 13-14). Since this is an `.mjs` file, use:

```javascript
import crypto from "node:crypto";
```

- [ ] **Step 3: Add `requestInstallationToken()` function**

```javascript
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
```

- [ ] **Step 4: Add `getGitHubToken()` with lazy refresh and Promise dedup**

Also add `import { readFile } from "node:fs/promises";` at the top alongside the other imports.

```javascript
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
```

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/claude-docker/infra/credential-proxy.mjs
git commit -m "feat(credential-proxy): add GitHub App token generation with lazy refresh"
```

---

### Task 2: Update proxy request handlers to use `getGitHubToken()`

**Files:**
- Modify: `packages/adapters/claude-docker/infra/credential-proxy.mjs`

Replace synchronous `GITHUB_TOKEN` reads in the `/gh/` and `/gh-api/` handlers with `await getGitHubToken()`, and fix the branch protection guard.

- [ ] **Step 1: Make the request handler async and resolve token**

In the `createServer` callback, find `req.on("end", () => {` and replace with `req.on("end", async () => {`.

Then, immediately after the line `const url = req.url || "/";`, before the `if (url.startsWith("/gh/"))` check, add:

```javascript
    // Resolve GitHub token (static or App-generated)
    let githubToken = "";
    if (url.startsWith("/gh/") || url.startsWith("/gh-api/")) {
      try {
        githubToken = await getGitHubToken();
      } catch (err) {
        console.error(`GitHub token resolution failed: ${err.message}`);
        res.writeHead(502, { "content-type": "text/plain" });
        res.end(`GitHub auth error: ${err.message}\n`);
        return;
      }
    }
```

- [ ] **Step 2: Update `/gh/` handler to use resolved token**

In the `/gh/` block, replace all three occurrences of `GITHUB_TOKEN` with `githubToken`:

Branch protection guard — find and replace:
```javascript
// Find:
if (req.method === "POST" && ghPath.includes("/git-receive-pack") && GITHUB_TOKEN) {
// Replace with:
if (req.method === "POST" && ghPath.includes("/git-receive-pack") && githubToken) {
```

Auth header injection — find and replace:
```javascript
// Find:
if (GITHUB_TOKEN) {
  delete headers["authorization"];
  headers["authorization"] = `Basic ${Buffer.from(`x-access-token:${GITHUB_TOKEN}`).toString("base64")}`;
}
// Replace with:
if (githubToken) {
  delete headers["authorization"];
  headers["authorization"] = `Basic ${Buffer.from(`x-access-token:${githubToken}`).toString("base64")}`;
}
```

- [ ] **Step 3: Update `/gh-api/` handler to use resolved token**

In the `/gh-api/` block, find and replace `GITHUB_TOKEN` with `githubToken`:

```javascript
// Find:
if (GITHUB_TOKEN) {
  delete headers["authorization"];
  headers["authorization"] = `Bearer ${GITHUB_TOKEN}`;
}
// Replace with:
if (githubToken) {
  delete headers["authorization"];
  headers["authorization"] = `Bearer ${githubToken}`;
}
```

- [ ] **Step 4: Update startup log to reflect App mode**

Find the `server.listen(PORT, HOST, () => {` block at the end of the file and replace its body:

```javascript
server.listen(PORT, HOST, () => {
  const features = [AUTH_MODE];
  if (GITHUB_TOKEN) features.push("github:static-token");
  if (GITHUB_APP_ID) features.push(`github:app(${GITHUB_APP_ID})`);
  if (PROTECTED_BRANCHES.length) features.push(`protected: ${PROTECTED_BRANCHES.join(",")}`);
  console.log(`Credential proxy started on ${HOST}:${PORT} [${features.join(" | ")}]`);
});
```

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/claude-docker/infra/credential-proxy.mjs
git commit -m "feat(credential-proxy): use async token resolution in request handlers"
```

---

### Task 3: Update docker-compose.yml with private key mount

**Files:**
- Modify: `packages/adapters/claude-docker/infra/docker-compose.yml`

- [ ] **Step 1: Add volume mount for private key**

Replace the current docker-compose.yml content with:

```yaml
services:
  credential-proxy:
    image: node:20-slim
    command: ["node", "/proxy/credential-proxy.mjs"]
    volumes:
      - ./credential-proxy.mjs:/proxy/credential-proxy.mjs:ro
      - ${GITHUB_APP_KEY_PATH:-/dev/null}:/secrets/github-app.pem:ro
    env_file:
      - path: .env
        required: false
    networks: [agent-net]
    restart: unless-stopped

networks:
  agent-net:
    driver: bridge
```

The only change is adding the second volume mount line. When `GITHUB_APP_KEY_PATH` is unset, `/dev/null` is mounted and the proxy sees an empty file (falls back to static token or no-auth).

- [ ] **Step 2: Commit**

```bash
git add packages/adapters/claude-docker/infra/docker-compose.yml
git commit -m "feat(credential-proxy): mount GitHub App private key into proxy container"
```

---

### Task 4: Write failing tests for `buildProxyEnv()` changes (TDD)

**Files:**
- Create: `packages/adapters/claude-docker/src/server/__tests__/credential-proxy.test.ts`

Write the tests first. These will fail until Task 5 implements the `buildProxyEnv()` changes.

- [ ] **Step 1: Create the test file**

```typescript
import { describe, it, expect } from "vitest";
import { buildProxyEnv, type CredentialProxyConfig } from "../infra.js";

describe("buildProxyEnv", () => {
  it("emits GITHUB_TOKEN for static token config", () => {
    const config: CredentialProxyConfig = {
      authMode: "api-key",
      apiKey: "sk-test",
      githubToken: "ghp_static123",
    };
    const env = buildProxyEnv(config);
    expect(env.GITHUB_TOKEN).toBe("ghp_static123");
    expect(env.GITHUB_APP_ID).toBeUndefined();
    expect(env.GITHUB_APP_INSTALLATION_ID).toBeUndefined();
    expect(env.GITHUB_APP_KEY_PATH).toBeUndefined();
  });

  it("emits App credentials for GitHub App config", () => {
    const config: CredentialProxyConfig = {
      authMode: "api-key",
      apiKey: "sk-test",
      githubApp: {
        appId: "12345",
        installationId: "67890",
        privateKeyPath: "/path/to/key.pem",
      },
    };
    const env = buildProxyEnv(config);
    expect(env.GITHUB_APP_ID).toBe("12345");
    expect(env.GITHUB_APP_INSTALLATION_ID).toBe("67890");
    expect(env.GITHUB_APP_KEY_PATH).toBe("/path/to/key.pem");
    expect(env.GITHUB_TOKEN).toBeUndefined();
  });

  it("prefers GitHub App over static token when both present", () => {
    const config: CredentialProxyConfig = {
      authMode: "oauth",
      oauthToken: "oauth-tok",
      githubToken: "ghp_static",
      githubApp: {
        appId: "111",
        installationId: "222",
        privateKeyPath: "/key.pem",
      },
    };
    const env = buildProxyEnv(config);
    expect(env.GITHUB_APP_ID).toBe("111");
    expect(env.GITHUB_TOKEN).toBeUndefined();
  });

  it("emits no GitHub vars when neither token nor app configured", () => {
    const config: CredentialProxyConfig = {
      authMode: "api-key",
      apiKey: "sk-test",
    };
    const env = buildProxyEnv(config);
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.GITHUB_APP_ID).toBeUndefined();
  });

  it("includes protected branches when configured", () => {
    const config: CredentialProxyConfig = {
      authMode: "api-key",
      apiKey: "sk-test",
      protectedBranches: ["main", "release"],
    };
    const env = buildProxyEnv(config);
    expect(env.PROTECTED_BRANCHES).toBe("main,release");
  });
});
```

- [ ] **Step 2: Run tests to verify the App-mode tests fail**

Run: `pnpm vitest run packages/adapters/claude-docker/src/server/__tests__/credential-proxy.test.ts`

Expected: Tests 1, 4, 5 pass (existing behavior). Tests 2, 3 fail (App credentials not yet emitted by `buildProxyEnv`).

- [ ] **Step 3: Commit**

```bash
git add packages/adapters/claude-docker/src/server/__tests__/credential-proxy.test.ts
git commit -m "test: add failing buildProxyEnv tests for GitHub App credential passing"
```

---

### Task 5: Update host-side `infra.ts` to pass App credentials

**Files:**
- Modify: `packages/adapters/claude-docker/src/server/infra.ts`

- [ ] **Step 1: Update `buildProxyEnv()` to emit App config vars**

Find the `buildProxyEnv` function and replace its entire body. The key change: when `config.githubApp` is present, emit App credential env vars instead of `GITHUB_TOKEN`:

```typescript
export function buildProxyEnv(config: CredentialProxyConfig): Record<string, string> {
  const env: Record<string, string> = {};
  if (config.authMode === "api-key" && config.apiKey) {
    env.ANTHROPIC_API_KEY = config.apiKey;
  } else if (config.oauthToken) {
    env.CLAUDE_CODE_OAUTH_TOKEN = config.oauthToken;
  }
  if (config.githubApp) {
    // App mode: pass credentials so the proxy generates its own tokens
    env.GITHUB_APP_ID = config.githubApp.appId;
    env.GITHUB_APP_INSTALLATION_ID = config.githubApp.installationId;
    env.GITHUB_APP_KEY_PATH = config.githubApp.privateKeyPath;
  } else if (config.githubToken) {
    // Static token mode
    env.GITHUB_TOKEN = config.githubToken;
  }
  if (config.protectedBranches?.length) {
    env.PROTECTED_BRANCHES = config.protectedBranches.join(",");
  }
  return env;
}
```

Note: `GITHUB_APP_KEY_PATH` here is the **host-side** path. Docker-compose substitutes it into the volume mount source. The proxy container reads from the fixed container path `/secrets/github-app.pem`.

- [ ] **Step 2: Run tests to verify they now pass**

Run: `pnpm vitest run packages/adapters/claude-docker/src/server/__tests__/credential-proxy.test.ts`

Expected: All 5 tests pass.

- [ ] **Step 3: Remove token pre-generation from `ensureProxyRunning()`**

In `ensureProxyRunning()`, find and replace:

```typescript
// Find:
  // If using GitHub App, resolve the installation token first
  if (config.githubApp && !config.githubToken) {
    await onLog("stderr", "[claude-docker] Generating GitHub App installation token...\n");
    config.githubToken = await getGitHubInstallationToken(config.githubApp);
    await onLog("stderr", "[claude-docker] GitHub App token acquired.\n");
  }
// Replace with:
  if (config.githubApp) {
    await onLog("stderr", "[claude-docker] GitHub App configured — proxy will manage token refresh.\n");
  }
```

Note: The existing `getGitHubInstallationToken()`, `generateGitHubJwt()`, `requestInstallationToken()`, and module-level `cachedInstallToken` in `infra.ts` are intentionally left in place. They are no longer called from `ensureProxyRunning()` but remain available for potential non-Docker callers.

- [ ] **Step 4: Commit**

```bash
git add packages/adapters/claude-docker/src/server/infra.ts
git commit -m "feat(infra): pass GitHub App credentials to proxy instead of pre-resolved token"
```

---

### Task 6: Manual integration verification

**Files:** None (manual verification steps)

- [ ] **Step 1: Rebuild the proxy container**

```bash
cd packages/adapters/claude-docker/infra
docker compose down
docker compose up -d --wait
```

Check logs:

```bash
docker logs infra-credential-proxy-1
```

Expected: Startup line shows `github:app(...)` instead of `github`.

- [ ] **Step 2: Test from inside an agent container**

```bash
docker run --rm --network infra_agent-net paperclip-agent:latest \
  sh -c 'GH_TOKEN=placeholder GITHUB_API_URL=http://credential-proxy:3001/gh-api gh api /octocat 2>&1'
```

Expected: Successful response (ASCII art octocat), NOT a 401 error.

- [ ] **Step 3: Test PR creation (if a feature branch is available)**

```bash
docker run --rm --network infra_agent-net \
  -e GH_TOKEN=placeholder \
  -e GITHUB_API_URL=http://credential-proxy:3001/gh-api \
  -v $(pwd):/workspace \
  paperclip-agent:latest \
  sh -c 'cd /workspace && gh pr list --limit 1 2>&1'
```

Expected: Lists PRs without auth errors.

- [ ] **Step 4: Commit any final adjustments**

If any tweaks were needed during verification, commit them.
