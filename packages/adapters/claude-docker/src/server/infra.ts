import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));
const INFRA_DIR_CANDIDATES = [
  path.resolve(__moduleDir, "../../infra"),
  path.resolve(__moduleDir, "../../../../../packages/adapters/claude-docker/infra"),
];

async function resolveInfraDir(): Promise<string> {
  for (const candidate of INFRA_DIR_CANDIDATES) {
    const isDir = await fs.stat(candidate).then((s) => s.isDirectory()).catch(() => false);
    if (isDir) return candidate;
  }
  throw new Error("claude-docker infra directory not found");
}

function runCommand(
  command: string,
  args: string[],
  opts: { cwd: string },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
  });
}

let currentSecretHash: string | null = null;

function hashSecrets(env: Record<string, string>): string {
  const sorted = Object.entries(env).sort(([a], [b]) => a.localeCompare(b));
  return sorted.map(([k, v]) => `${k}=${v}`).join("\n");
}

// ---------------------------------------------------------------------------
// GitHub App installation token generation
// ---------------------------------------------------------------------------

export interface GitHubAppConfig {
  appId: string;
  installationId: string;
  privateKeyPath: string;
}

let cachedInstallToken: { token: string; expiresAt: number } | null = null;

function generateGitHubJwt(appId: string, privateKey: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId })).toString("base64url");
  const signature = crypto.sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), privateKey).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

function requestInstallationToken(jwt: string, installationId: string): Promise<{ token: string; expires_at: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "api.github.com",
      path: `/app/installations/${installationId}/access_tokens`,
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "paperclip-agent",
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

/**
 * Get a GitHub installation access token, using a cached one if still valid.
 * Refreshes when the token has less than 5 minutes remaining.
 */
export async function getGitHubInstallationToken(app: GitHubAppConfig): Promise<string> {
  const now = Date.now();
  const REFRESH_MARGIN_MS = 5 * 60 * 1000;

  if (cachedInstallToken && cachedInstallToken.expiresAt - now > REFRESH_MARGIN_MS) {
    return cachedInstallToken.token;
  }

  const privateKey = await fs.readFile(app.privateKeyPath, "utf-8");
  const jwt = generateGitHubJwt(app.appId, privateKey);
  const result = await requestInstallationToken(jwt, app.installationId);

  cachedInstallToken = {
    token: result.token,
    expiresAt: new Date(result.expires_at).getTime(),
  };

  return cachedInstallToken.token;
}

// ---------------------------------------------------------------------------
// Credential proxy config & lifecycle
// ---------------------------------------------------------------------------

export type AuthMode = "api-key" | "oauth";

export interface CredentialProxyConfig {
  authMode: AuthMode;
  apiKey?: string;
  oauthToken?: string;
  githubToken?: string;
  githubApp?: GitHubAppConfig;
  protectedBranches?: string[];
}

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

export async function ensureProxyRunning(
  config: CredentialProxyConfig,
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>,
): Promise<void> {
  if (config.githubApp) {
    await onLog("stderr", "[claude-docker] GitHub App configured — proxy will manage token refresh.\n");
  }

  const infraDir = await resolveInfraDir();
  const proxyEnv = buildProxyEnv(config);
  const newHash = hashSecrets(proxyEnv);

  if (currentSecretHash && currentSecretHash !== newHash) {
    await onLog("stderr", "[claude-docker] Proxy credentials changed, recreating...\n");
    await runCommand("docker", ["compose", "down"], { cwd: infraDir });
    currentSecretHash = null;
  }

  if (!currentSecretHash) {
    await onLog("stderr", `[claude-docker] Starting credential proxy [${config.authMode} mode]...\n`);

    const envFileLines = Object.entries(proxyEnv).map(([k, v]) => `${k}=${v}`);
    await fs.writeFile(path.join(infraDir, ".env"), envFileLines.join("\n") + "\n", "utf-8");

    const result = await runCommand("docker", ["compose", "up", "-d", "--wait"], { cwd: infraDir });
    if (result.exitCode !== 0) {
      throw new Error(`Failed to start credential proxy: ${result.stderr}`);
    }
    currentSecretHash = newHash;
    await onLog("stderr", "[claude-docker] Credential proxy running.\n");
  }
}

export async function buildAgentImage(
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>,
): Promise<void> {
  const infraDir = await resolveInfraDir();

  const check = await runCommand("docker", ["image", "inspect", "paperclip-agent:latest"], { cwd: infraDir });
  if (check.exitCode === 0) return;

  await onLog("stderr", "[claude-docker] Building agent image...\n");
  const result = await runCommand("docker", ["build", "-t", "paperclip-agent:latest", "."], { cwd: infraDir });
  if (result.exitCode !== 0) {
    throw new Error(`Failed to build agent image: ${result.stderr}`);
  }
  await onLog("stderr", "[claude-docker] Agent image built.\n");
}

export function getDockerNetworkName(): string {
  return "infra_agent-net";
}
