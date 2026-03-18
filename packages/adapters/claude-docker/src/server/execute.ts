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
  isClaudeMaxTurnsResult,
  isClaudeUnknownSessionError,
} from "@paperclipai/adapter-claude-local/server";
import { execSync } from "node:child_process";
import {
  ensureProxyRunning,
  buildAgentImage,
  getDockerNetworkName,
  type CredentialProxyConfig,
  type GitHubAppConfig,
} from "./infra.js";

async function readOauthTokenFromKeychain(): Promise<string> {
  try {
    const raw = execSync(
      'security find-generic-password -s "Claude Code-credentials" -w',
      { stdio: ["ignore", "pipe", "ignore"], encoding: "utf-8" },
    ).trim();
    const parsed = JSON.parse(raw);
    const token = parsed?.claudeAiOauth?.accessToken;
    if (typeof token === "string" && token.length > 0) return token;
  } catch {
    // Keychain not available or no credentials stored
  }
  return "";
}

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

function detectLoginRequired(stdout: string, stderr: string): { requiresLogin: boolean; loginUrl: string | null } {
  const combined = stdout + stderr;
  const urlMatch = combined.match(/https:\/\/console\.anthropic\.com\/[^\s"')]+/);
  if (combined.includes("login") && urlMatch) {
    return { requiresLogin: true, loginUrl: urlMatch[0] };
  }
  return { requiresLogin: false, loginUrl: null };
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

    child.stdout!.on("data", (d: Buffer) => {
      const chunk = d.toString();
      if (stdout.length < MAX_CAPTURE) stdout += chunk;
      opts.onLog("stdout", chunk).catch(() => {});
    });

    child.stderr!.on("data", (d: Buffer) => {
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

  // Resolve credential proxy config
  // Priority: config.apiKey > config.oauthToken > auto-detect from keychain
  const explicitApiKey = asString(config.anthropicApiKey, "");
  const explicitOauthToken = asString(config.oauthToken, "");
  const githubToken = asString(config.githubToken, "");
  const protectedBranches = asStringArray(config.protectedBranches);

  // GitHub App config (alternative to static githubToken)
  const ghAppConfig = parseObject(config.githubApp);
  const ghAppId = asString(ghAppConfig.appId, "");
  const ghInstallId = asString(ghAppConfig.installationId, "");
  const ghKeyPath = asString(ghAppConfig.privateKeyPath, "");
  const githubApp: GitHubAppConfig | undefined =
    ghAppId && ghInstallId && ghKeyPath
      ? { appId: ghAppId, installationId: ghInstallId, privateKeyPath: ghKeyPath }
      : undefined;

  const proxyConfig: CredentialProxyConfig = {
    ...(explicitApiKey
      ? { authMode: "api-key" as const, apiKey: explicitApiKey }
      : { authMode: "oauth" as const, oauthToken: explicitOauthToken || await readOauthTokenFromKeychain() }),
    githubToken: githubToken || undefined,
    githubApp,
    protectedBranches: protectedBranches.length > 0 ? protectedBranches : undefined,
  };

  // Build agent env (non-secret vars only)
  const envConfig = parseObject(config.env);
  const agentEnv: Record<string, string> = { ...buildPaperclipEnv(agent) };
  agentEnv.PAPERCLIP_RUN_ID = runId;

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

  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") agentEnv[key] = value;
  }

  if (authToken) {
    agentEnv.PAPERCLIP_API_KEY = authToken;
  }

  // Ensure infra is up
  await buildAgentImage(onLog);
  await ensureProxyRunning(proxyConfig, onLog);

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

    const dockerArgs = [
      "run", "--rm", "-i",
      "--network", getDockerNetworkName(),
      "--cap-drop=ALL",
      "--security-opt", "no-new-privileges",
      "-e", "ANTHROPIC_BASE_URL=http://credential-proxy:3001",
      "-e", proxyConfig.authMode === "api-key"
        ? "ANTHROPIC_API_KEY=placeholder"
        : "CLAUDE_CODE_OAUTH_TOKEN=placeholder",
      "-v", `${cwd}:/workspace`,
      "-v", `${skillsDir}:/skills:ro`,
    ];

    // GitHub: route git and gh CLI through the credential proxy
    if (githubToken || githubApp) {
      // Rewrite github.com URLs to go through the proxy
      dockerArgs.push("-e", "GIT_CONFIG_COUNT=2");
      dockerArgs.push("-e", "GIT_CONFIG_KEY_0=url.http://credential-proxy:3001/gh/.insteadOf");
      dockerArgs.push("-e", "GIT_CONFIG_VALUE_0=https://github.com/");
      // Credential helper returns placeholder — proxy swaps it for the real token
      dockerArgs.push("-e", "GIT_CONFIG_KEY_1=credential.http://credential-proxy:3001.helper");
      dockerArgs.push("-e", `GIT_CONFIG_VALUE_1=!f() { echo username=x-access-token; echo password=placeholder; }; f`);
      dockerArgs.push("-e", "GIT_TERMINAL_PROMPT=0");
      // gh CLI uses GITHUB_API_URL
      dockerArgs.push("-e", "GITHUB_API_URL=http://credential-proxy:3001/gh-api");
      // GH_TOKEN placeholder so gh CLI doesn't complain about auth
      dockerArgs.push("-e", "GH_TOKEN=placeholder");
    }

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

    const loginMeta = detectLoginRequired(proc.stdout, proc.stderr);
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
