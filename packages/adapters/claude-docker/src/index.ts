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

Runs Claude Code inside an ephemeral Docker container with a credential proxy.
Secrets are never passed to the agent container — the proxy injects real credentials
at the network level. Branch protection is enforced by the proxy.

Core fields:
- cwd (string, optional): host directory to mount as /workspace in the container
- model (string, optional): Claude model id
- effort (string, optional): reasoning effort (low|medium|high)
- promptTemplate (string, optional): run prompt template
- maxTurnsPerRun (number, optional): max turns for one run
- dangerouslySkipPermissions (boolean, optional): pass --dangerously-skip-permissions to claude
- extraArgs (string[], optional): additional CLI args
- dockerImage (string, optional): defaults to "paperclip-agent:latest"

Anthropic auth (pick one, or auto-detects OAuth from macOS keychain):
- anthropicApiKey (string, optional): Anthropic API key
- oauthToken (string, optional): Claude Max OAuth token

GitHub auth (pick one):
- githubToken (string, optional): static GitHub PAT or installation token
- githubApp (object, optional): GitHub App for auto-refreshing tokens
  - appId (string): GitHub App ID
  - installationId (string): installation ID for the org
  - privateKeyPath (string): path to the .pem private key file on the host

GitHub branch protection:
- protectedBranches (string[], optional): branches the proxy blocks pushes to (default: main, master)

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds
`;
