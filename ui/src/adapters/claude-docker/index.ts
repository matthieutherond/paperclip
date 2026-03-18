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
