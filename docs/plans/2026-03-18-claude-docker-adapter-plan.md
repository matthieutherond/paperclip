# Claude Docker Adapter — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `claude_docker` adapter that runs Claude Code agents in ephemeral Docker containers with zero secrets, using mitmproxy for egress control and secret injection.

**Architecture:** New adapter package at `packages/adapters/claude-docker/` that spawns `docker run` instead of a local child process. A shared mitmproxy container on a bridge network injects API keys into outbound HTTP headers. Agent containers get no secrets — isolation comes from the network layer.

**Tech Stack:** TypeScript (adapter), Docker (containers), mitmproxy/mitmdump (proxy), Python (addon script)

**Design doc:** `docs/plans/2026-03-18-claude-docker-adapter-design.md`

---

### Task 1: Add `claude_docker` to adapter type constants

**Files:**
- Modify: `packages/shared/src/constants.ts:24-34`

**Step 1: Add the type to AGENT_ADAPTER_TYPES**

In `packages/shared/src/constants.ts`, add `"claude_docker"` to the `AGENT_ADAPTER_TYPES` array:

```typescript
export const AGENT_ADAPTER_TYPES = [
  "process",
  "http",
  "claude_local",
  "claude_docker",
  "codex_local",
  "opencode_local",
  "pi_local",
  "cursor",
  "openclaw_gateway",
  "hermes_local",
] as const;
```

**Step 2: Verify typecheck passes**

Run: `cd packages/shared && pnpm typecheck`
Expected: PASS (no type errors — the type union auto-expands from `as const`)

**Step 3: Commit**

```bash
git add packages/shared/src/constants.ts
git commit -m "feat: add claude_docker to adapter type constants"
```

---

### Task 2: Add `claude_docker` to SESSIONED_LOCAL_ADAPTERS

**Files:**
- Modify: `server/src/services/heartbeat.ts:50-57`

**Step 1: Add claude_docker to the session set**

```typescript
const SESSIONED_LOCAL_ADAPTERS = new Set([
  "claude_local",
  "claude_docker",
  "codex_local",
  "cursor",
  "gemini_local",
  "opencode_local",
  "pi_local",
]);
```

**Step 2: Commit**

```bash
git add server/src/services/heartbeat.ts
git commit -m "feat: register claude_docker as sessioned adapter"
```

---

### Task 3: Create infrastructure files

**Files:**
- Create: `packages/adapters/claude-docker/infra/docker-compose.yml`
- Create: `packages/adapters/claude-docker/infra/Dockerfile`
- Create: `packages/adapters/claude-docker/infra/addon.py`

**Step 1: Create docker-compose.yml**

Create `packages/adapters/claude-docker/infra/docker-compose.yml`:

```yaml
services:
  mitmproxy:
    image: mitmproxy/mitmproxy:latest
    command: mitmdump --mode regular --listen-port 8888 -s /scripts/addon.py
    volumes:
      - ./addon.py:/scripts/addon.py:ro
      - mitmproxy-certs:/home/mitmproxy/.mitmproxy
    networks: [agent-net]
    restart: unless-stopped

networks:
  agent-net:
    driver: bridge

volumes:
  mitmproxy-certs:
```

**Step 2: Create Dockerfile**

Create `packages/adapters/claude-docker/infra/Dockerfile`:

```dockerfile
FROM ubuntu:24.04

RUN apt-get update && apt-get install -y \
    git curl python3 pip ca-certificates \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && npm install -g @anthropic-ai/claude-code \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

RUN useradd -m -u 1000 agent
USER agent
WORKDIR /workspace
```

**Step 3: Create addon.py**

Create `packages/adapters/claude-docker/infra/addon.py`:

```python
import os

HEADER_INJECTIONS = {}
ALLOWED = set()

# Parse PROXY_SECRET_<host_with_underscores>=<header_name>:<header_value>
for key, value in os.environ.items():
    if key.startswith("PROXY_SECRET_"):
        host = key[len("PROXY_SECRET_"):].replace("_", ".")
        header_name, header_value = value.split(":", 1)
        HEADER_INJECTIONS[host] = (header_name, header_value)
        ALLOWED.add(host)

# Parse PROXY_PASSTHROUGH=host1,host2,...
for host in os.environ.get("PROXY_PASSTHROUGH", "").split(","):
    host = host.strip()
    if host:
        ALLOWED.add(host)

def request(flow):
    host = flow.request.pretty_host
    if host not in ALLOWED:
        flow.response = flow.make_error_response(
            403, f"Blocked: {host}"
        )
        return
    if host in HEADER_INJECTIONS:
        name, value = HEADER_INJECTIONS[host]
        flow.request.headers[name] = value
```

**Step 4: Commit**

```bash
git add packages/adapters/claude-docker/infra/
git commit -m "feat: add claude-docker infrastructure files (Dockerfile, mitmproxy, addon)"
```

---

### Task 4: Create adapter package scaffold

**Files:**
- Create: `packages/adapters/claude-docker/package.json`
- Create: `packages/adapters/claude-docker/tsconfig.json`
- Create: `packages/adapters/claude-docker/src/index.ts`

**Step 1: Create package.json**

Create `packages/adapters/claude-docker/package.json`:

```json
{
  "name": "@paperclipai/adapter-claude-docker",
  "version": "0.1.0",
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./server": "./src/server/index.ts",
    "./ui": "./src/ui/index.ts",
    "./cli": "./src/cli/index.ts"
  },
  "publishConfig": {
    "access": "public",
    "exports": {
      ".": {
        "types": "./dist/index.d.ts",
        "import": "./dist/index.js"
      },
      "./server": {
        "types": "./dist/server/index.d.ts",
        "import": "./dist/server/index.js"
      },
      "./ui": {
        "types": "./dist/ui/index.d.ts",
        "import": "./dist/ui/index.js"
      },
      "./cli": {
        "types": "./dist/cli/index.d.ts",
        "import": "./dist/cli/index.js"
      }
    },
    "main": "./dist/index.js",
    "types": "./dist/index.d.ts"
  },
  "files": [
    "dist",
    "infra"
  ],
  "scripts": {
    "build": "tsc",
    "clean": "rm -rf dist",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@paperclipai/adapter-utils": "workspace:*",
    "@paperclipai/adapter-claude-local": "workspace:*",
    "picocolors": "^1.1.1"
  },
  "devDependencies": {
    "@types/node": "^24.6.0",
    "typescript": "^5.7.3"
  }
}
```

**Step 2: Create tsconfig.json**

Create `packages/adapters/claude-docker/tsconfig.json`:

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

**Step 3: Create src/index.ts**

Create `packages/adapters/claude-docker/src/index.ts`:

```typescript
export const type = "claude_docker";
export const label = "Claude Code (Docker)";

export const models = [
  { id: "claude-opus-4-6", label: "Claude Opus 4.6" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  { id: "claude-haiku-4-6", label: "Claude Haiku 4.6" },
  { id: "claude-sonnet-4-5-20250929", label: "Claude Sonnet 4.5" },
  { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
];

export const agentConfigurationDoc = `# claude_docker agent configuration

Adapter: claude_docker

Runs Claude Code inside an ephemeral Docker container with mitmproxy egress control.
Secrets are never passed to the agent container — they are injected into HTTP headers by the proxy.

Core fields:
- cwd (string, optional): host directory to mount as /workspace in the container
- model (string, optional): Claude model id
- effort (string, optional): reasoning effort (low|medium|high)
- promptTemplate (string, optional): run prompt template
- maxTurnsPerRun (number, optional): max turns for one run
- dangerouslySkipPermissions (boolean, optional): pass --dangerously-skip-permissions to claude
- extraArgs (string[], optional): additional CLI args
- proxySecrets (object, optional): map of host -> { headerName, secretId } for proxy header injection
- proxyPassthrough (string[], optional): additional hosts allowed through proxy without header injection
- dockerImage (string, optional): defaults to "paperclip-agent:latest"

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds
`;
```

**Step 4: Install deps and verify**

Run: `cd /Users/matt/code/paperclip && pnpm install`
Expected: PASS (workspace packages linked)

**Step 5: Commit**

```bash
git add packages/adapters/claude-docker/package.json packages/adapters/claude-docker/tsconfig.json packages/adapters/claude-docker/src/index.ts
git commit -m "feat: scaffold claude-docker adapter package"
```

---

### Task 5: Create the Docker infrastructure manager

**Files:**
- Create: `packages/adapters/claude-docker/src/server/infra.ts`

This module manages the mitmproxy container lifecycle — ensures it's running, passes secrets as env vars.

**Step 1: Create infra.ts**

Create `packages/adapters/claude-docker/src/server/infra.ts`:

```typescript
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));
const INFRA_DIR_CANDIDATES = [
  path.resolve(__moduleDir, "../../infra"),         // published: dist/server/ -> infra/
  path.resolve(__moduleDir, "../../../../../packages/adapters/claude-docker/infra"), // dev monorepo
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
  opts: { cwd: string; env?: Record<string, string> },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
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

function hashSecrets(secrets: Record<string, string>): string {
  const sorted = Object.entries(secrets).sort(([a], [b]) => a.localeCompare(b));
  return sorted.map(([k, v]) => `${k}=${v}`).join("\n");
}

export interface ProxySecretBinding {
  host: string;
  headerName: string;
  headerValue: string;
}

export function buildProxyEnv(
  secrets: ProxySecretBinding[],
  passthrough: string[],
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const s of secrets) {
    const envKey = `PROXY_SECRET_${s.host.replace(/\./g, "_")}`;
    env[envKey] = `${s.headerName}:${s.headerValue}`;
  }
  if (passthrough.length > 0) {
    env.PROXY_PASSTHROUGH = passthrough.join(",");
  }
  return env;
}

export async function ensureProxyRunning(
  secrets: ProxySecretBinding[],
  passthrough: string[],
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>,
): Promise<void> {
  const infraDir = await resolveInfraDir();
  const proxyEnv = buildProxyEnv(secrets, passthrough);
  const newHash = hashSecrets(proxyEnv);

  if (currentSecretHash && currentSecretHash !== newHash) {
    await onLog("stderr", "[claude-docker] Proxy secrets changed, recreating mitmproxy...\n");
    await runCommand("docker", ["compose", "down"], { cwd: infraDir });
    currentSecretHash = null;
  }

  if (!currentSecretHash) {
    await onLog("stderr", "[claude-docker] Starting mitmproxy proxy...\n");
    const result = await runCommand("docker", ["compose", "up", "-d", "--wait"], {
      cwd: infraDir,
      env: proxyEnv,
    });
    if (result.exitCode !== 0) {
      throw new Error(`Failed to start mitmproxy: ${result.stderr}`);
    }
    currentSecretHash = newHash;
    await onLog("stderr", "[claude-docker] Proxy running.\n");
  }
}

export async function buildAgentImage(
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>,
): Promise<void> {
  const infraDir = await resolveInfraDir();

  // Check if image already exists
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
  return "claude-docker_agent-net";
}

export function getMitmproxyCertsVolume(): string {
  return "claude-docker_mitmproxy-certs";
}
```

**Step 2: Commit**

```bash
git add packages/adapters/claude-docker/src/server/infra.ts
git commit -m "feat: add docker infrastructure manager for mitmproxy lifecycle"
```

---

### Task 6: Create the execute function

**Files:**
- Create: `packages/adapters/claude-docker/src/server/execute.ts`

This is the core — it replaces `runChildProcess` with `docker run`.

**Step 1: Create execute.ts**

Create `packages/adapters/claude-docker/src/server/execute.ts`:

```typescript
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  asString,
  asNumber,
  asBoolean,
  asStringArray,
  parseObject,
  buildPaperclipEnv,
  joinPromptSections,
  renderTemplate,
} from "@paperclipai/adapter-utils/server-utils";
import {
  parseClaudeStreamJson,
  describeClaudeFailure,
  detectClaudeLoginRequired,
  isClaudeMaxTurnsResult,
  isClaudeUnknownSessionError,
} from "@paperclipai/adapter-claude-local/server";
import {
  ensureProxyRunning,
  buildAgentImage,
  getDockerNetworkName,
  getMitmproxyCertsVolume,
  type ProxySecretBinding,
} from "./infra.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));
const PAPERCLIP_SKILLS_CANDIDATES = [
  path.resolve(__moduleDir, "../../skills"),
  path.resolve(__moduleDir, "../../../../../skills"),
];

async function resolvePaperclipSkillsDir(): Promise<string | null> {
  for (const candidate of PAPERCLIP_SKILLS_CANDIDATES) {
    const isDir = await fs.stat(candidate).then((s) => s.isDirectory()).catch(() => false);
    if (isDir) return candidate;
  }
  return null;
}

async function buildSkillsDir(): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-skills-"));
  const target = path.join(tmp, ".claude", "skills");
  await fs.mkdir(target, { recursive: true });
  const skillsDir = await resolvePaperclipSkillsDir();
  if (!skillsDir) return tmp;
  const entries = await fs.readdir(skillsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      await fs.symlink(path.join(skillsDir, entry.name), path.join(target, entry.name));
    }
  }
  return tmp;
}

function runDockerContainer(
  args: string[],
  opts: {
    stdin?: string;
    timeoutSec: number;
    graceSec: number;
    onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  },
): Promise<{ exitCode: number | null; signal: string | null; timedOut: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("docker", args, {
      stdio: [opts.stdin != null ? "pipe" : "ignore", "pipe", "pipe"],
    });

    if (opts.stdin != null && child.stdin) {
      child.stdin.write(opts.stdin);
      child.stdin.end();
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const MAX_CAPTURE = 4 * 1024 * 1024;

    child.stdout.on("data", (d: Buffer) => {
      const chunk = d.toString();
      if (stdout.length < MAX_CAPTURE) stdout += chunk;
      opts.onLog("stdout", chunk).catch(() => {});
    });

    child.stderr.on("data", (d: Buffer) => {
      const chunk = d.toString();
      if (stderr.length < MAX_CAPTURE) stderr += chunk;
      opts.onLog("stderr", chunk).catch(() => {});
    });

    if (opts.timeoutSec > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => { child.kill("SIGKILL"); }, opts.graceSec * 1000);
      }, opts.timeoutSec * 1000);
    }

    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({ exitCode: code, signal, timedOut, stdout, stderr });
    });

    child.on("error", () => {
      if (timer) clearTimeout(timer);
      resolve({ exitCode: 1, signal: null, timedOut: false, stdout, stderr: stderr + "\nFailed to spawn docker" });
    });
  });
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, authToken } = ctx;

  const promptTemplate = asString(
    config.promptTemplate,
    "You are agent {{agent.id}} ({{agent.name}}). Continue your Paperclip work.",
  );
  const model = asString(config.model, "");
  const effort = asString(config.effort, "");
  const maxTurns = asNumber(config.maxTurnsPerRun, 0);
  const dangerouslySkipPermissions = asBoolean(config.dangerouslySkipPermissions, true);
  const timeoutSec = asNumber(config.timeoutSec, 0);
  const graceSec = asNumber(config.graceSec, 20);
  const extraArgs = asStringArray(config.extraArgs);
  const dockerImage = asString(config.dockerImage, "paperclip-agent:latest");

  // Resolve workspace directory
  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const configuredCwd = asString(config.cwd, "");
  const cwd = workspaceCwd || configuredCwd || process.cwd();

  // Resolve proxy secrets from config.proxySecrets
  const proxySecretsConfig = parseObject(config.proxySecrets);
  const proxySecrets: ProxySecretBinding[] = [];
  for (const [host, binding] of Object.entries(proxySecretsConfig)) {
    if (typeof binding === "object" && binding !== null) {
      const b = binding as Record<string, unknown>;
      const headerName = asString(b.headerName, "");
      const headerValue = asString(b.headerValue, "");
      if (headerName && headerValue) {
        proxySecrets.push({ host, headerName, headerValue });
      }
    }
  }
  const proxyPassthrough = asStringArray(config.proxyPassthrough);

  // Resolve env config — extract secret values for proxy, non-secret env for agent
  const envConfig = parseObject(config.env);
  const agentEnv: Record<string, string> = { ...buildPaperclipEnv(agent) };
  agentEnv.PAPERCLIP_RUN_ID = runId;

  // Inject wake context vars
  const wakeTaskId =
    (typeof context.taskId === "string" && context.taskId.trim().length > 0 && context.taskId.trim()) ||
    (typeof context.issueId === "string" && context.issueId.trim().length > 0 && context.issueId.trim()) ||
    null;
  const wakeReason = typeof context.wakeReason === "string" && context.wakeReason.trim().length > 0
    ? context.wakeReason.trim() : null;
  const wakeCommentId =
    (typeof context.wakeCommentId === "string" && context.wakeCommentId.trim().length > 0 && context.wakeCommentId.trim()) ||
    (typeof context.commentId === "string" && context.commentId.trim().length > 0 && context.commentId.trim()) ||
    null;
  const approvalId = typeof context.approvalId === "string" && context.approvalId.trim().length > 0
    ? context.approvalId.trim() : null;
  const approvalStatus = typeof context.approvalStatus === "string" && context.approvalStatus.trim().length > 0
    ? context.approvalStatus.trim() : null;

  if (wakeTaskId) agentEnv.PAPERCLIP_TASK_ID = wakeTaskId;
  if (wakeReason) agentEnv.PAPERCLIP_WAKE_REASON = wakeReason;
  if (wakeCommentId) agentEnv.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  if (approvalId) agentEnv.PAPERCLIP_APPROVAL_ID = approvalId;
  if (approvalStatus) agentEnv.PAPERCLIP_APPROVAL_STATUS = approvalStatus;

  // Non-secret env vars from config pass through to agent container
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") agentEnv[key] = value;
  }

  if (authToken) {
    agentEnv.PAPERCLIP_API_KEY = authToken;
  }

  // Ensure infra is up
  await buildAgentImage(onLog);
  await ensureProxyRunning(proxySecrets, proxyPassthrough, onLog);

  // Build skills directory
  const skillsDir = await buildSkillsDir();

  // Session handling
  const runtimeSessionParams = parseObject(runtime.sessionParams);
  const runtimeSessionId = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "");
  const sessionId = runtimeSessionId.length > 0 ? runtimeSessionId : null;

  // Build prompt
  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };
  const renderedPrompt = renderTemplate(promptTemplate, templateData);
  const bootstrapPromptTemplate = asString(config.bootstrapPromptTemplate, "");
  const renderedBootstrapPrompt =
    !sessionId && bootstrapPromptTemplate.trim().length > 0
      ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
      : "";
  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
  const prompt = joinPromptSections([renderedBootstrapPrompt, sessionHandoffNote, renderedPrompt]);

  // Build claude args
  const buildClaudeArgs = (resumeSessionId: string | null) => {
    const args = ["--print", "-", "--output-format", "stream-json", "--verbose"];
    if (resumeSessionId) args.push("--resume", resumeSessionId);
    if (dangerouslySkipPermissions) args.push("--dangerously-skip-permissions");
    if (model) args.push("--model", model);
    if (effort) args.push("--effort", effort);
    if (maxTurns > 0) args.push("--max-turns", String(maxTurns));
    args.push("--add-dir", "/skills");
    if (extraArgs.length > 0) args.push(...extraArgs);
    return args;
  };

  const runAttempt = async (resumeSessionId: string | null) => {
    const claudeArgs = buildClaudeArgs(resumeSessionId);

    // Build docker run args
    const dockerArgs = [
      "run", "--rm", "-i",
      "--network", getDockerNetworkName(),
      "--cap-drop=ALL",
      "--security-opt", "no-new-privileges",
      "-e", "HTTP_PROXY=http://mitmproxy:8888",
      "-e", "HTTPS_PROXY=http://mitmproxy:8888",
      "-e", `NODE_EXTRA_CA_CERTS=/certs/mitmproxy-ca-cert.pem`,
      "-v", `${cwd}:/workspace`,
      "-v", `${skillsDir}:/skills:ro`,
      "-v", `${getMitmproxyCertsVolume()}:/certs:ro`,
    ];

    // Pass non-secret env vars to agent container
    for (const [key, value] of Object.entries(agentEnv)) {
      dockerArgs.push("-e", `${key}=${value}`);
    }

    dockerArgs.push(dockerImage, "claude", ...claudeArgs);

    if (onMeta) {
      await onMeta({
        adapterType: "claude_docker",
        command: "docker",
        cwd,
        commandArgs: dockerArgs,
        commandNotes: ["Running Claude in Docker container with mitmproxy egress control"],
        env: agentEnv,
        prompt,
        promptMetrics: { promptChars: prompt.length },
        context,
      });
    }

    const proc = await runDockerContainer(dockerArgs, {
      stdin: prompt,
      timeoutSec,
      graceSec,
      onLog,
    });

    const parsedStream = parseClaudeStreamJson(proc.stdout);
    return { proc, parsedStream };
  };

  const toAdapterResult = (
    attempt: {
      proc: Awaited<ReturnType<typeof runDockerContainer>>;
      parsedStream: ReturnType<typeof parseClaudeStreamJson>;
    },
    opts: { fallbackSessionId: string | null; clearSessionOnMissingSession?: boolean },
  ): AdapterExecutionResult => {
    const { proc, parsedStream } = attempt;
    const parsed = parsedStream.resultJson ?? null;

    const loginMeta = detectClaudeLoginRequired({
      parsed,
      stdout: proc.stdout,
      stderr: proc.stderr,
    });
    const errorMeta = loginMeta.loginUrl != null ? { loginUrl: loginMeta.loginUrl } : undefined;

    if (proc.timedOut) {
      return {
        exitCode: proc.exitCode,
        signal: proc.signal,
        timedOut: true,
        errorMessage: `Timed out after ${timeoutSec}s`,
        errorCode: "timeout",
        errorMeta,
        clearSession: Boolean(opts.clearSessionOnMissingSession),
      };
    }

    if (!parsed) {
      const stderrLine = proc.stderr.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
      return {
        exitCode: proc.exitCode,
        signal: proc.signal,
        timedOut: false,
        errorMessage: stderrLine
          ? `Claude exited with code ${proc.exitCode ?? -1}: ${stderrLine}`
          : `Claude exited with code ${proc.exitCode ?? -1}`,
        errorCode: loginMeta.requiresLogin ? "claude_auth_required" : null,
        errorMeta,
        resultJson: { stdout: proc.stdout, stderr: proc.stderr },
        clearSession: Boolean(opts.clearSessionOnMissingSession),
      };
    }

    const usage = parsedStream.usage ?? { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
    const resolvedSessionId = parsedStream.sessionId ?? opts.fallbackSessionId;
    const resolvedSessionParams = resolvedSessionId
      ? { sessionId: resolvedSessionId, cwd } as Record<string, unknown>
      : null;

    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: false,
      errorMessage:
        (proc.exitCode ?? 0) === 0
          ? null
          : describeClaudeFailure(parsed) ?? `Claude exited with code ${proc.exitCode ?? -1}`,
      errorCode: loginMeta.requiresLogin ? "claude_auth_required" : null,
      errorMeta,
      usage,
      sessionId: resolvedSessionId,
      sessionParams: resolvedSessionParams,
      sessionDisplayId: resolvedSessionId,
      provider: "anthropic",
      model: parsedStream.model || model,
      billingType: "api",
      costUsd: parsedStream.costUsd ?? 0,
      resultJson: parsed,
      summary: parsedStream.summary || "",
      clearSession: isClaudeMaxTurnsResult(parsed) || Boolean(opts.clearSessionOnMissingSession && !resolvedSessionId),
    };
  };

  try {
    const initial = await runAttempt(sessionId);
    if (
      sessionId &&
      !initial.proc.timedOut &&
      (initial.proc.exitCode ?? 0) !== 0 &&
      initial.parsedStream.resultJson &&
      isClaudeUnknownSessionError(initial.parsedStream.resultJson)
    ) {
      await onLog("stderr", `[claude-docker] Session "${sessionId}" unavailable; retrying fresh.\n`);
      const retry = await runAttempt(null);
      return toAdapterResult(retry, { fallbackSessionId: null, clearSessionOnMissingSession: true });
    }
    return toAdapterResult(initial, { fallbackSessionId: runtimeSessionId || runtime.sessionId });
  } finally {
    fs.rm(skillsDir, { recursive: true, force: true }).catch(() => {});
  }
}
```

**Step 2: Commit**

```bash
git add packages/adapters/claude-docker/src/server/execute.ts
git commit -m "feat: implement claude-docker execute function with docker run"
```

---

### Task 7: Create server, UI, and CLI exports

**Files:**
- Create: `packages/adapters/claude-docker/src/server/index.ts`
- Create: `packages/adapters/claude-docker/src/ui/index.ts`
- Create: `packages/adapters/claude-docker/src/cli/index.ts`

**Step 1: Create server/index.ts**

Create `packages/adapters/claude-docker/src/server/index.ts`:

```typescript
export { execute } from "./execute.js";
import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    const sessionId = readNonEmptyString(record.sessionId) ?? readNonEmptyString(record.session_id);
    if (!sessionId) return null;
    const cwd = readNonEmptyString(record.cwd);
    return { sessionId, ...(cwd ? { cwd } : {}) };
  },
  serialize(params: Record<string, unknown> | null) {
    if (!params) return null;
    const sessionId = readNonEmptyString(params.sessionId) ?? readNonEmptyString(params.session_id);
    if (!sessionId) return null;
    const cwd = readNonEmptyString(params.cwd);
    return { sessionId, ...(cwd ? { cwd } : {}) };
  },
  getDisplayId(params: Record<string, unknown> | null) {
    if (!params) return null;
    return readNonEmptyString(params.sessionId) ?? readNonEmptyString(params.session_id);
  },
};

export async function testEnvironment(): Promise<{
  adapterType: string;
  status: "pass" | "warn" | "fail";
  checks: { code: string; level: "info" | "warn" | "error"; message: string; detail?: string | null }[];
  testedAt: string;
}> {
  const checks: { code: string; level: "info" | "warn" | "error"; message: string; detail?: string | null }[] = [];

  // Check Docker is available
  try {
    const { execSync } = await import("node:child_process");
    execSync("docker info", { stdio: "pipe" });
    checks.push({ code: "docker", level: "info", message: "Docker is available" });
  } catch {
    checks.push({ code: "docker", level: "error", message: "Docker is not available or not running" });
    return { adapterType: "claude_docker", status: "fail", checks, testedAt: new Date().toISOString() };
  }

  // Check agent image exists
  try {
    const { execSync } = await import("node:child_process");
    execSync("docker image inspect paperclip-agent:latest", { stdio: "pipe" });
    checks.push({ code: "image", level: "info", message: "Agent image paperclip-agent:latest exists" });
  } catch {
    checks.push({ code: "image", level: "warn", message: "Agent image not built yet — will be built on first run" });
  }

  const status = checks.some((c) => c.level === "error") ? "fail" : checks.some((c) => c.level === "warn") ? "warn" : "pass";
  return { adapterType: "claude_docker", status, checks, testedAt: new Date().toISOString() };
}
```

**Step 2: Create ui/index.ts**

Create `packages/adapters/claude-docker/src/ui/index.ts`:

```typescript
// Re-export claude-local parsers — Docker adapter produces identical stream-json output
export { parseClaudeStdoutLine, buildClaudeLocalConfig as buildClaudeDockerConfig } from "@paperclipai/adapter-claude-local/ui";
```

**Step 3: Create cli/index.ts**

Create `packages/adapters/claude-docker/src/cli/index.ts`:

```typescript
// Re-export claude-local CLI formatter — Docker adapter produces identical stream events
export { printClaudeStreamEvent as printClaudeDockerStreamEvent } from "@paperclipai/adapter-claude-local/cli";
```

**Step 4: Run typecheck**

Run: `cd packages/adapters/claude-docker && pnpm typecheck`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/adapters/claude-docker/src/server/index.ts packages/adapters/claude-docker/src/ui/index.ts packages/adapters/claude-docker/src/cli/index.ts
git commit -m "feat: add server, UI, and CLI exports for claude-docker adapter"
```

---

### Task 8: Register adapter in all three registries

**Files:**
- Modify: `server/src/adapters/registry.ts`
- Modify: `cli/src/adapters/registry.ts`
- Modify: `ui/src/adapters/registry.ts`
- Create: `ui/src/adapters/claude-docker/index.ts`

**Step 1: Register in server registry**

In `server/src/adapters/registry.ts`, add imports at the top (after the claude-local imports):

```typescript
import {
  execute as claudeDockerExecute,
  testEnvironment as claudeDockerTestEnvironment,
  sessionCodec as claudeDockerSessionCodec,
} from "@paperclipai/adapter-claude-docker/server";
import { agentConfigurationDoc as claudeDockerAgentConfigurationDoc, models as claudeDockerModels } from "@paperclipai/adapter-claude-docker";
```

Add the adapter definition after `claudeLocalAdapter`:

```typescript
const claudeDockerAdapter: ServerAdapterModule = {
  type: "claude_docker",
  execute: claudeDockerExecute,
  testEnvironment: claudeDockerTestEnvironment,
  sessionCodec: claudeDockerSessionCodec,
  models: claudeDockerModels,
  supportsLocalAgentJwt: true,
  agentConfigurationDoc: claudeDockerAgentConfigurationDoc,
};
```

Add `claudeDockerAdapter` to the `adaptersByType` array (after `claudeLocalAdapter`).

**Step 2: Register in CLI registry**

In `cli/src/adapters/registry.ts`, add import:

```typescript
import { printClaudeDockerStreamEvent } from "@paperclipai/adapter-claude-docker/cli";
```

Add adapter definition:

```typescript
const claudeDockerCLIAdapter: CLIAdapterModule = {
  type: "claude_docker",
  formatStdoutEvent: printClaudeDockerStreamEvent,
};
```

Add `claudeDockerCLIAdapter` to the `adaptersByType` array.

**Step 3: Create UI adapter module**

Create `ui/src/adapters/claude-docker/index.ts`:

```typescript
import type { UIAdapterModule } from "../types";
import { parseClaudeStdoutLine } from "@paperclipai/adapter-claude-docker/ui";
import { ClaudeLocalConfigFields } from "../claude-local/config-fields";
import { buildClaudeDockerConfig } from "@paperclipai/adapter-claude-docker/ui";

export const claudeDockerUIAdapter: UIAdapterModule = {
  type: "claude_docker",
  label: "Claude Code (Docker)",
  parseStdoutLine: parseClaudeStdoutLine,
  ConfigFields: ClaudeLocalConfigFields,
  buildAdapterConfig: buildClaudeDockerConfig,
};
```

**Step 4: Register in UI registry**

In `ui/src/adapters/registry.ts`, add import:

```typescript
import { claudeDockerUIAdapter } from "./claude-docker";
```

Add `claudeDockerUIAdapter` to the `adaptersByType` array.

**Step 5: Run typecheck across packages**

Run: `pnpm typecheck` (from repo root)
Expected: PASS

**Step 6: Commit**

```bash
git add server/src/adapters/registry.ts cli/src/adapters/registry.ts ui/src/adapters/registry.ts ui/src/adapters/claude-docker/index.ts
git commit -m "feat: register claude_docker adapter in server, CLI, and UI registries"
```

---

### Task 9: Add server dependency on new package

**Files:**
- Modify: `server/package.json`
- Modify: `cli/package.json`
- Modify: `ui/package.json`

**Step 1: Add workspace dependency**

Add `"@paperclipai/adapter-claude-docker": "workspace:*"` to the `dependencies` in:
- `server/package.json`
- `cli/package.json`
- `ui/package.json`

**Step 2: Install**

Run: `pnpm install`
Expected: PASS

**Step 3: Commit**

```bash
git add server/package.json cli/package.json ui/package.json pnpm-lock.yaml
git commit -m "feat: add claude-docker adapter dependency to server, CLI, and UI"
```

---

### Task 10: Build and test infrastructure

**Step 1: Build agent image**

Run:
```bash
cd packages/adapters/claude-docker/infra && docker build -t paperclip-agent:latest .
```
Expected: Image builds successfully

**Step 2: Start mitmproxy with test secrets**

Run:
```bash
cd packages/adapters/claude-docker/infra && \
  PROXY_SECRET_api_anthropic_com="x-api-key:test-key-123" \
  PROXY_PASSTHROUGH="registry.npmjs.org,pypi.org" \
  docker compose up -d
```
Expected: mitmproxy starts, CA cert generated

**Step 3: Test egress blocked**

Run:
```bash
docker run --rm --network claude-docker_agent-net \
  -e HTTP_PROXY=http://mitmproxy:8888 \
  paperclip-agent:latest \
  curl -s -o /dev/null -w "%{http_code}" http://evil.example.com/
```
Expected: `403`

**Step 4: Test passthrough allowed**

Run:
```bash
docker run --rm --network claude-docker_agent-net \
  -e HTTP_PROXY=http://mitmproxy:8888 \
  paperclip-agent:latest \
  curl -s -o /dev/null -w "%{http_code}" http://registry.npmjs.org/
```
Expected: `200`

**Step 5: Test container security**

Run:
```bash
docker run --rm --cap-drop=ALL --security-opt no-new-privileges \
  paperclip-agent:latest \
  bash -c "echo pwned > /etc/passwd"
```
Expected: `Permission denied`

**Step 6: Tear down**

Run:
```bash
cd packages/adapters/claude-docker/infra && docker compose down
```

**Step 7: Commit (no code changes — this is validation only)**

No commit needed for this task.

---

### Task 11: End-to-end test with Paperclip

**Step 1: Build the adapter**

Run:
```bash
cd packages/adapters/claude-docker && pnpm build
```
Expected: PASS

**Step 2: Create a test agent with claude_docker adapter**

Use the Paperclip CLI or API to create an agent with:
- `adapterType: "claude_docker"`
- `adapterConfig.cwd`: a test project directory
- `adapterConfig.proxySecrets`: `{ "api.anthropic.com": { "headerName": "x-api-key", "headerValue": "<your-key>" } }`
- `adapterConfig.proxyPassthrough`: `["registry.npmjs.org", "pypi.org"]`

**Step 3: Trigger a heartbeat**

Run:
```bash
pnpm paperclipai heartbeat run --agent-id <agent-id>
```

Expected: Agent runs inside Docker, mitmproxy injects API key, Claude responds, run completes successfully.

**Step 4: Verify no secrets in agent container**

Check the heartbeat run logs — the agent container env should show PAPERCLIP_* vars but no ANTHROPIC_API_KEY.
