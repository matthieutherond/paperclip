# Claude Docker Adapter — Design

## Problem

Paperclip agents run as local child processes with full host access. Secrets are decrypted and injected as plaintext env vars into the agent process. A compromised or hallucinating agent can exfiltrate secrets through any network destination.

## Solution

New `claude_docker` adapter that runs agents in ephemeral Docker containers with zero secrets. A shared mitmproxy forward proxy handles egress whitelisting and injects API keys into request headers on the fly. The agent never sees the keys.

## Architecture

```
Paperclip (macOS)
  ├── resolves secrets from its encrypted store
  ├── passes them as PROXY_SECRET_* env vars to mitmproxy container
  ├── ensures mitmproxy + agent-net are running
  └── spawns: docker run --rm --network agent-net ... agent-image claude

mitmproxy (shared, long-lived)
  ├── reads PROXY_SECRET_* from its own env
  ├── MITM terminates TLS, injects auth headers per destination host
  └── blocks all non-whitelisted egress (HTTP 403)

agent container (per-task, ephemeral)
  ├── zero secrets in env or filesystem
  ├── trusts proxy CA cert via NODE_EXTRA_CA_CERTS
  ├── all HTTP/HTTPS routed through proxy
  └── --cap-drop=ALL, --no-new-privileges, non-root user
```

## Threat Model

This design targets two threats:

1. **Secret exfiltration** — agent cannot exfiltrate secrets because it doesn't have them. The proxy injects keys into outbound requests; the agent only sees responses.
2. **Host escape** — Docker Desktop on macOS runs a Linux VM (two isolation layers). `--cap-drop=ALL` + `--no-new-privileges` + non-root user prevents privilege escalation.

Explicitly **not** in scope (acceptable risks):
- Resource exhaustion (agent can fork bomb / OOM the container) — acceptable for dev pipeline
- Lateral movement between agents — all agents share `agent-net`; acceptable since agents have no secrets to steal from each other
- Supply chain attacks via malicious packages — proxy whitelist limits where packages can phone home

## Package Structure

```
packages/adapters/claude-docker/
├── infra/
│   ├── docker-compose.yml    ← mitmproxy service + agent-net network
│   ├── Dockerfile            ← agent image (ubuntu, node, claude CLI, non-root user)
│   └── addon.py              ← proxy whitelist + header injection script
├── server/
│   └── execute.ts            ← spawns docker run, captures output + session
├── ui/
│   └── index.ts              ← re-exports claude-local transcript parser
└── cli/
    └── index.ts              ← re-exports claude-local terminal formatter
```

## Infrastructure

### Network

```bash
# Created by docker-compose.yml
docker network create agent-net
```

Bridge network. Agent containers and mitmproxy share it. No host network access.

### mitmproxy (docker-compose.yml)

```yaml
services:
  mitmproxy:
    image: mitmproxy/mitmproxy:latest
    command: mitmdump --mode regular --listen-port 8888 -s /scripts/addon.py
    volumes:
      - ./addon.py:/scripts/addon.py:ro
      - mitmproxy-certs:/home/mitmproxy/.mitmproxy
    networks: [agent-net]
    # env vars injected by Paperclip at startup:
    # PROXY_SECRET_api_anthropic_com=x-api-key:sk-ant-xxx
    # PROXY_SECRET_api_github_com=Authorization:Bearer ghp_xxx
    # PROXY_PASSTHROUGH=registry.npmjs.org,pypi.org,files.pythonhosted.org

networks:
  agent-net:
    driver: bridge

volumes:
  mitmproxy-certs:
```

### Agent Image (Dockerfile)

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

No secrets baked in. No sudo/gosu. CA cert handling via runtime mount + env var.

### Proxy Addon (addon.py)

```python
import os

HEADER_INJECTIONS = {}
ALLOWED = set()

# PROXY_SECRET_api_anthropic_com="x-api-key:sk-ant-..."
for key, value in os.environ.items():
    if key.startswith("PROXY_SECRET_"):
        host = key[len("PROXY_SECRET_"):].replace("_", ".")
        header_name, header_value = value.split(":", 1)
        HEADER_INJECTIONS[host] = (header_name, header_value)
        ALLOWED.add(host)

# PROXY_PASSTHROUGH="registry.npmjs.org,pypi.org,..."
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

Convention: `PROXY_SECRET_{host_with_underscores}={header_name}:{header_value}`

## Adapter Execution Flow

### execute.ts pseudocode

```
1. Resolve agent secrets from Paperclip secret store
2. Convert to PROXY_SECRET_* env var format
3. Ensure mitmproxy is running:
   - docker compose up -d with PROXY_SECRET_* and PROXY_PASSTHROUGH env vars
   - If secrets changed since last start, recreate mitmproxy container
4. Spawn agent container:
   docker run --rm \
     --network agent-net \
     --cap-drop=ALL \
     --no-new-privileges \
     -e HTTP_PROXY=http://mitmproxy:8888 \
     -e HTTPS_PROXY=http://mitmproxy:8888 \
     -e NODE_EXTRA_CA_CERTS=/certs/mitmproxy-ca-cert.pem \
     -v ${taskWorkdir}:/workspace \
     -v mitmproxy-certs:/certs:ro \
     agent-image:latest \
     claude ...args
5. Stream stdout/stderr, parse session ID, capture usage (same codec as claude_local)
6. Container auto-removes on exit (--rm)
```

### Session persistence

Same as `claude_local` — the adapter captures the Claude session ID from stdout and stores it in the database. On next heartbeat, the session ID is passed back to resume context. The session state lives in Anthropic's API, not in the container.

## Registration

Add `claude_docker` to:

- `packages/shared/src/constants.ts` — adapter type enum
- `server/src/adapters/registry.ts` — import execute from `@paperclipai/adapter-claude-docker`
- `ui/src/adapters/registry.ts` — re-export `claude-local` transcript parser
- `cli/src/adapters/registry.ts` — re-export `claude-local` terminal formatter

## Mitmproxy Lifecycle

- **Shared instance** — one mitmproxy serves all agent containers
- **Started by adapter** — first `claude_docker` execution ensures it's running
- **Secret updates** — if Paperclip secrets change, recreate the mitmproxy container with new env vars
- **CA cert** — auto-generated on first run, persisted in `mitmproxy-certs` Docker volume

## Testing

```bash
# Egress blocked
docker run --rm --network agent-net \
  -e HTTPS_PROXY=http://mitmproxy:8888 \
  agent-image:latest curl -s -w "%{http_code}" http://evil.example.com/
# Expected: 403

# Egress allowed (passthrough)
docker run --rm --network agent-net \
  -e HTTPS_PROXY=http://mitmproxy:8888 \
  agent-image:latest curl -s -w "%{http_code}" https://registry.npmjs.org/
# Expected: 200

# Header injection works
docker run --rm --network agent-net \
  -e HTTPS_PROXY=http://mitmproxy:8888 \
  -e NODE_EXTRA_CA_CERTS=/certs/mitmproxy-ca-cert.pem \
  -v mitmproxy-certs:/certs:ro \
  agent-image:latest \
  curl -v https://api.anthropic.com/v1/messages 2>&1 | grep x-api-key
# Expected: x-api-key header present (injected by proxy)

# Host escape blocked
docker run --rm --cap-drop=ALL --no-new-privileges \
  agent-image:latest cat /etc/shadow
# Expected: permission denied
```

## Decisions Log

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Secret delivery | Proxy injects headers, agent gets zero secrets | Eliminates exfiltration by removing the thing to exfiltrate |
| Proxy tool | mitmproxy (mitmdump) | Purpose-built for MITM forward proxy + Python scripting; Envoy too complex, nginx/Caddy can't do it |
| Secret source for proxy | Env vars on mitmproxy container (option b) | Proxy is trusted infra; simpler than Infisical or callback |
| Adapter approach | New `claude_docker` type (option a) | Clean separation from `claude_local`, no risk to existing flows |
| Proxy lifecycle | Shared single instance (option a) | Simpler; agent-to-agent isolation not in threat model |
| Resource limits | None | Acceptable risk for dev pipeline |
| Root filesystem | Writable | Agent autonomy; isolation comes from network + caps, not filesystem |
| Infisical | Dropped | Marginal security gain vs complexity; proxy + env vars sufficient |
