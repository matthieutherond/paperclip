import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));
const INFRA_DIR_CANDIDATES = [
  path.resolve(__moduleDir, "../../infra"),
  path.resolve(__moduleDir, "../../../../../packages/adapters/claude-docker/infra"),
];

async function resolveInfraDir(): Promise<string> {
  const { stat } = await import("node:fs/promises");
  for (const candidate of INFRA_DIR_CANDIDATES) {
    const isDir = await stat(candidate).then((s) => s.isDirectory()).catch(() => false);
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

export type AuthMode = "api-key" | "oauth";

export interface CredentialProxyConfig {
  authMode: AuthMode;
  apiKey?: string;
  oauthToken?: string;
  githubToken?: string;
  protectedBranches?: string[];
}

export function buildProxyEnv(config: CredentialProxyConfig): Record<string, string> {
  const env: Record<string, string> = {};
  if (config.authMode === "api-key" && config.apiKey) {
    env.ANTHROPIC_API_KEY = config.apiKey;
  } else if (config.oauthToken) {
    env.CLAUDE_CODE_OAUTH_TOKEN = config.oauthToken;
  }
  if (config.githubToken) {
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

    // Write .env file for docker compose
    const { writeFile } = await import("node:fs/promises");
    const envFileLines = Object.entries(proxyEnv).map(([k, v]) => `${k}=${v}`);
    await writeFile(path.join(infraDir, ".env"), envFileLines.join("\n") + "\n", "utf-8");

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
