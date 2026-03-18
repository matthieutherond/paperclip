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

  try {
    const { execSync } = await import("node:child_process");
    execSync("docker info", { stdio: "pipe" });
    checks.push({ code: "docker", level: "info", message: "Docker is available" });
  } catch {
    checks.push({ code: "docker", level: "error", message: "Docker is not available or not running" });
    return { adapterType: "claude_docker", status: "fail", checks, testedAt: new Date().toISOString() };
  }

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
