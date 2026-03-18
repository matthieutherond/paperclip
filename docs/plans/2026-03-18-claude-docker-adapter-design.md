# Claude Docker Adapter -- Design

## Problem

Paperclip agents run as local child processes with full host access. Secrets are decrypted and injected as plaintext env vars into the agent process. A compromised or hallucinating agent can exfiltrate secrets through any network destination.

## Solution

New `claude_docker` adapter that runs agents in ephemeral Docker containers with zero secrets. A lightweight credential proxy (a single ~140-line Node.js HTTP server) intercepts outbound requests and injects API keys into request headers on the fly. The agent never sees the real keys -- it only receives placeholder tokens.

Inspired by nanoclaw's credential proxy pattern.

## Architecture

```
Paperclip (macOS)
  |-- resolves secrets from its encrypted store
  |-- writes them to .env file for credential-proxy container
  |-- ensures credential-proxy + agent-net are running (docker compose up)
  |-- spawns: docker run --rm --network agent-net ... agent-image claude

credential-proxy (shared, long-lived)
  |-- ~140-line Node.js HTTP server (credential-proxy.mjs), built-in modules only
  |-- routes by path prefix:
  |     /gh/*          -> github.com       (git clone/push via HTTP)
  |     /gh-api/*      -> api.github.com   (gh CLI, REST API)
  |     everything else -> api.anthropic.com (Claude API)
  |-- injects real auth headers, replacing placeholder tokens
  |-- enforces branch protection by inspecting git-receive-pack POST bodies
  |-- no TLS termination, no CA certs, no complex proxy setup

agent container (per-task, ephemeral)
  |-- zero secrets in env or filesystem (only placeholder tokens)
  |-- ANTHROPIC_BASE_URL=http://credential-proxy:3001 (plain HTTP)
  |-- git URLs rewritten via url.insteadOf to route through proxy
  |-- --cap-drop=ALL, --no-new-privileges, non-root user
```

## Threat Model

This design targets two threats:

1. **Secret exfiltration** -- agent cannot exfiltrate secrets because it doesn't have them. The proxy injects real keys into outbound requests; the agent only holds placeholder tokens.
2. **Host escape** -- Docker Desktop on macOS runs a Linux VM (two isolation layers). `--cap-drop=ALL` + `--no-new-privileges` + non-root user prevents privilege escalation.

Explicitly **not** in scope (acceptable risks):
- Resource exhaustion (agent can fork bomb / OOM the container) -- acceptable for dev pipeline
- Lateral movement between agents -- all agents share `agent-net`; acceptable since agents have no secrets to steal from each other
- Supply chain attacks via malicious packages -- agents can only reach the proxy, not arbitrary internet hosts

## Package Structure

```
packages/adapters/claude-docker/
|-- infra/
|   |-- docker-compose.yml       <- credential-proxy service + agent-net network
|   |-- Dockerfile               <- agent image (ubuntu, node, claude CLI, non-root user)
|   |-- credential-proxy.mjs     <- ~140-line Node.js HTTP proxy (built-in modules only)
|   +-- .env                     <- generated at runtime with real secrets (gitignored)
|-- src/server/
|   |-- execute.ts               <- spawns docker run, captures output + session
|   +-- infra.ts                 <- proxy lifecycle, GitHub App token gen, image build
|-- src/ui/
|   +-- index.ts                 <- re-exports claude-local transcript parser
+-- src/cli/
    +-- index.ts                 <- re-exports claude-local terminal formatter
```

## Infrastructure

### Network

```bash
# Created by docker-compose.yml
docker network create agent-net
```

Bridge network. Agent containers and credential-proxy share it. No host network access.

### Credential Proxy (docker-compose.yml)

```yaml
services:
  credential-proxy:
    image: node:20-slim
    command: ["node", "/proxy/credential-proxy.mjs"]
    volumes:
      - ./credential-proxy.mjs:/proxy/credential-proxy.mjs:ro
    env_file:
      - path: .env
        required: false
    networks: [agent-net]
    restart: unless-stopped

networks:
  agent-net:
    driver: bridge
```

No volumes for certs, no CA certificates, no TLS termination. The proxy speaks plain HTTP to the agent and HTTPS to upstream services.

### Agent Image (Dockerfile)

```dockerfile
FROM ubuntu:24.04

RUN apt-get update && apt-get install -y \
    git curl python3 pip ca-certificates \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && npm install -g @anthropic-ai/claude-code \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

RUN useradd -m agent || true
USER agent
WORKDIR /workspace
```

No secrets baked in. No sudo/gosu. No CA cert handling needed since the proxy speaks plain HTTP.

### Credential Proxy (credential-proxy.mjs)

A single ~140-line Node.js HTTP server using only built-in modules (`node:http`, `node:https`). No npm dependencies.

**Routing by path prefix:**

| Path prefix | Upstream | Auth header injected |
|-------------|----------|---------------------|
| `/gh/*` | `github.com` (HTTPS) | `Authorization: Basic <base64(x-access-token:GITHUB_TOKEN)>` |
| `/gh-api/*` | `api.github.com` (HTTPS) | `Authorization: Bearer GITHUB_TOKEN` |
| everything else | `api.anthropic.com` (HTTPS) | `x-api-key` (API key mode) or `Authorization: Bearer` (OAuth mode) |

**Auth mode selection:** If `ANTHROPIC_API_KEY` is set, uses API key mode. Otherwise uses OAuth mode with `CLAUDE_CODE_OAUTH_TOKEN`.

**Branch protection:** For `POST` requests to paths containing `/git-receive-pack`, the proxy parses the pkt-line formatted body to extract target refs. If any ref matches a protected branch (configured via `PROTECTED_BRANCHES` env var, defaults to `main,master`), the push is rejected with HTTP 403.

**Environment variables consumed by the proxy:**

| Variable | Purpose |
|----------|---------|
| `ANTHROPIC_API_KEY` | Anthropic API key (api-key auth mode) |
| `CLAUDE_CODE_OAUTH_TOKEN` | OAuth token (oauth auth mode) |
| `GITHUB_TOKEN` | GitHub token for git operations and API calls |
| `PROTECTED_BRANCHES` | Comma-separated branch names to protect (default: `main,master`) |
| `PROXY_PORT` | Listen port (default: `3001`) |
| `PROXY_HOST` | Listen address (default: `0.0.0.0`) |
| `UPSTREAM_URL` | Override Anthropic API URL (default: `https://api.anthropic.com`) |

### GitHub App Support

Instead of a static `GITHUB_TOKEN`, the adapter supports GitHub App authentication with auto-refreshing installation tokens. Configured in `infra.ts`:

1. **JWT generation** -- Signs a JWT using the App's private key (RS256) with standard GitHub App claims (`iat`, `exp`, `iss`).
2. **Token exchange** -- POSTs to `api.github.com/app/installations/{id}/access_tokens` to get an installation token.
3. **Caching** -- The installation token is cached and reused until it has less than 5 minutes remaining before expiry, then auto-refreshed.
4. **Transparent to proxy** -- The resolved installation token is passed to the credential proxy as `GITHUB_TOKEN`; the proxy does not need to know it came from a GitHub App.

## Adapter Execution Flow

### execute.ts pseudocode

```
1. Resolve agent credentials:
   - Anthropic: config.apiKey > config.oauthToken > macOS Keychain lookup
   - GitHub: config.githubToken or config.githubApp (App ID + installation ID + private key)
2. Build CredentialProxyConfig with auth mode, tokens, protected branches
3. Ensure credential proxy is running:
   - If using GitHub App, generate installation token (JWT -> token exchange, cached)
   - Write proxy env vars to .env file in infra dir
   - docker compose up -d --wait (recreate if secrets changed since last start)
4. Build agent Docker image if not already present
5. Spawn agent container:
   docker run --rm -i \
     --network infra_agent-net \
     --cap-drop=ALL \
     --security-opt no-new-privileges \
     -e ANTHROPIC_BASE_URL=http://credential-proxy:3001 \
     -e ANTHROPIC_API_KEY=placeholder  (or CLAUDE_CODE_OAUTH_TOKEN=placeholder) \
     -e GIT_CONFIG_COUNT=2 \
     -e GIT_CONFIG_KEY_0=url.http://credential-proxy:3001/gh/.insteadOf \
     -e GIT_CONFIG_VALUE_0=https://github.com/ \
     -e GIT_CONFIG_KEY_1=credential.http://credential-proxy:3001.helper \
     -e GIT_CONFIG_VALUE_1='!f() { echo username=x-access-token; echo password=placeholder; }; f' \
     -e GIT_TERMINAL_PROMPT=0 \
     -e GITHUB_API_URL=http://credential-proxy:3001/gh-api \
     -e GH_TOKEN=placeholder \
     -v ${cwd}:/workspace \
     -v ${skillsDir}:/skills:ro \
     paperclip-agent:latest \
     claude ...args
6. Pipe prompt to stdin, stream stdout/stderr, parse session ID + usage
7. Container auto-removes on exit (--rm)
```

### Git credential flow

The agent container never holds a real GitHub token. The flow:

1. `url.insteadOf` rewrites `https://github.com/` to `http://credential-proxy:3001/gh/`
2. Git's credential helper returns `username=x-access-token` and `password=placeholder`
3. Git sends the request with `Authorization: Basic <base64(x-access-token:placeholder)>` to the proxy
4. The proxy strips the placeholder auth header and injects the real token as `Authorization: Basic <base64(x-access-token:REAL_TOKEN)>`
5. The proxy forwards the request to `github.com` over HTTPS

The `gh` CLI similarly uses `GITHUB_API_URL=http://credential-proxy:3001/gh-api` and `GH_TOKEN=placeholder`. The proxy strips the placeholder and injects the real token.

### Session persistence

Same as `claude_local` -- the adapter captures the Claude session ID from stdout and stores it in the database. On next heartbeat, the session ID is passed back to resume context. The session state lives in Anthropic's API, not in the container. If a session is unavailable, the adapter retries with a fresh session.

## Registration

Add `claude_docker` to:

- `packages/shared/src/constants.ts` -- adapter type enum
- `server/src/adapters/registry.ts` -- import execute from `@paperclipai/adapter-claude-docker`
- `ui/src/adapters/registry.ts` -- re-export `claude-local` transcript parser
- `cli/src/adapters/registry.ts` -- re-export `claude-local` terminal formatter

## Credential Proxy Lifecycle

- **Shared instance** -- one credential proxy serves all agent containers
- **Started by adapter** -- first `claude_docker` execution ensures it's running via `docker compose up -d --wait`
- **Secret updates** -- if Paperclip secrets change (detected by hashing the proxy env vars), the proxy container is recreated with `docker compose down` followed by `up`
- **No CA certs** -- plain HTTP between agent and proxy, HTTPS from proxy to upstream; no cert generation or distribution needed
- **GitHub App tokens** -- auto-refreshed on the host side before being passed to the proxy as `GITHUB_TOKEN`

## Testing

```bash
# Anthropic API proxied (placeholder token replaced with real key)
docker run --rm --network infra_agent-net \
  -e ANTHROPIC_BASE_URL=http://credential-proxy:3001 \
  -e ANTHROPIC_API_KEY=placeholder \
  paperclip-agent:latest \
  curl -s -o /dev/null -w "%{http_code}" \
    -H "x-api-key: placeholder" \
    http://credential-proxy:3001/v1/messages
# Expected: 401 (auth works, just no valid request body)

# GitHub git clone through proxy
docker run --rm --network infra_agent-net \
  -e GIT_CONFIG_COUNT=2 \
  -e GIT_CONFIG_KEY_0=url.http://credential-proxy:3001/gh/.insteadOf \
  -e GIT_CONFIG_VALUE_0=https://github.com/ \
  -e GIT_CONFIG_KEY_1=credential.http://credential-proxy:3001.helper \
  -e 'GIT_CONFIG_VALUE_1=!f() { echo username=x-access-token; echo password=placeholder; }; f' \
  paperclip-agent:latest \
  git clone https://github.com/org/repo.git
# Expected: clone succeeds (proxy injects real token)

# Branch protection blocks push to main
docker run --rm --network infra_agent-net \
  paperclip-agent:latest \
  git push origin HEAD:refs/heads/main
# Expected: HTTP 403 "Push rejected: protected branch(es) refs/heads/main"

# GitHub API through proxy (gh CLI)
docker run --rm --network infra_agent-net \
  -e GITHUB_API_URL=http://credential-proxy:3001/gh-api \
  -e GH_TOKEN=placeholder \
  paperclip-agent:latest \
  gh api /user
# Expected: 200 with authenticated user info

# Host escape blocked
docker run --rm --cap-drop=ALL --no-new-privileges \
  paperclip-agent:latest cat /etc/shadow
# Expected: permission denied
```

## Decisions Log

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Secret delivery | Proxy injects headers, agent gets placeholder tokens | Eliminates exfiltration by removing the thing to exfiltrate |
| Proxy tool | Single-file Node.js HTTP server (credential-proxy.mjs) | ~140 lines, built-in modules only, no dependencies; inspired by nanoclaw's credential proxy pattern |
| Why not mitmproxy | Replaced with credential proxy | No TLS termination needed, no CA cert distribution, no Python dependency; path-prefix routing is simpler and sufficient |
| Secret source for proxy | .env file written at runtime, loaded by docker compose | Proxy is trusted infra; simpler than Infisical or callback |
| GitHub auth | Static token or GitHub App with auto-refreshing installation tokens | App tokens provide fine-grained permissions and auto-expire; static token as simpler fallback |
| Branch protection | Proxy inspects git-receive-pack pkt-line bodies | Enforced at proxy level before the push reaches GitHub; agent cannot bypass |
| Adapter approach | New `claude_docker` type | Clean separation from `claude_local`, no risk to existing flows |
| Proxy lifecycle | Shared single instance | Simpler; agent-to-agent isolation not in threat model |
| Resource limits | None | Acceptable risk for dev pipeline |
| Root filesystem | Writable | Agent autonomy; isolation comes from network + caps, not filesystem |
| Infisical | Dropped | Marginal security gain vs complexity; proxy + env vars sufficient |
