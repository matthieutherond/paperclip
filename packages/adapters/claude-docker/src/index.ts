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
- proxySecrets (object, optional): map of host -> { headerName, headerValue } for proxy header injection
- proxyPassthrough (string[], optional): additional hosts allowed through proxy without header injection
- dockerImage (string, optional): defaults to "paperclip-agent:latest"

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds
`;
