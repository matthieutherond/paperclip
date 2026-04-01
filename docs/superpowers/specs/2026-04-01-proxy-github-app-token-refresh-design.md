# Proxy-Side GitHub App Token Refresh

## Problem

The credential proxy for Docker-isolated Claude agents receives a GitHub App installation token at startup via `.env`. These tokens expire after 1 hour. The host generates the token in `ensureProxyRunning` and writes it to the proxy's `.env`, but the proxy container keeps running with the stale token. Subsequent agent runs skip proxy recreation because the secret hash hasn't changed (the host-side cache still considers the token valid within its process lifetime). Result: all GitHub API calls from agents fail with 401 after the first hour.

## Solution

Move GitHub App token generation into the credential proxy itself. Instead of passing a pre-resolved `GITHUB_TOKEN`, pass the App credentials (appId, installationId, private key path) and let the proxy generate and refresh tokens on demand.

## Design

### Credential Proxy (`credential-proxy.mjs`)

**New environment variables** (used when no static `GITHUB_TOKEN` is set):
- `GITHUB_APP_ID` — GitHub App ID
- `GITHUB_APP_INSTALLATION_ID` — Installation ID for the target org/repo
- `GITHUB_APP_PRIVATE_KEY_PATH` — Container-local path to the `.pem` file (e.g. `/secrets/github-app.pem`)

**Token resolution — `getGitHubToken()`:**
A new async function called before every `/gh/` and `/gh-api/` request:
1. If static `GITHUB_TOKEN` env is set → return it (PAT/static token path, unchanged).
2. If GitHub App config is present → check in-memory cached installation token.
   - If cached token exists and has >5 minutes remaining → return it.
   - Otherwise → read private key from disk, generate RS256 JWT (iat now-60s, exp now+540s, iss appId), POST to `https://api.github.com/app/installations/{id}/access_tokens`, cache the returned token and `expires_at`, return it.
3. If neither is configured → return empty string (no GitHub auth).

**JWT and token exchange logic**: Ported from the existing `generateGitHubJwt()` and `requestInstallationToken()` in `infra.ts`. Uses Node 20 built-in `crypto` module — no new dependencies.

**Integration point**: The existing `/gh/` and `/gh-api/` handlers currently read `GITHUB_TOKEN` synchronously. Change to `await getGitHubToken()` before constructing headers. This makes the request handler async (it already buffers the full body before processing, so this is straightforward).

**Concurrency**: If multiple requests hit the proxy simultaneously with an expired token, deduplicate the refresh by storing a pending Promise. The first caller triggers the token exchange; concurrent callers await the same Promise. This avoids thundering herd on the GitHub token endpoint.

**Branch protection guard**: The existing branch protection check (`if (GITHUB_TOKEN)`) must be updated to use the resolved token from `getGitHubToken()`, since `GITHUB_TOKEN` env is not set in App mode. The guard becomes: if a token was resolved (static or App), inspect push refs for protected branches.

### Infrastructure (`docker-compose.yml`)

Add an optional volume mount for the private key. The `GITHUB_APP_KEY_PATH` env var serves dual purpose: docker-compose reads it for the volume mount (compose substitutes from `.env` at the project root), and the proxy container receives it for logging/diagnostics only (the container always reads the key from the fixed mount path `/secrets/github-app.pem`).

```yaml
services:
  credential-proxy:
    image: node:20-slim
    command: ["node", "/proxy/credential-proxy.mjs"]
    volumes:
      - ./credential-proxy.mjs:/proxy/credential-proxy.mjs:ro
      - ${GITHUB_APP_KEY_PATH:-/dev/null}:/secrets/github-app.pem:ro
    env_file:
      - path: .env
        required: false
    networks: [agent-net]
    restart: unless-stopped
```

When `GITHUB_APP_KEY_PATH` is not set, `/dev/null` is mounted — the proxy sees an empty file and falls back to `GITHUB_TOKEN` or no-auth mode. This relies on `/dev/null` existing on the Docker host (Linux/macOS). Windows Docker Desktop users would need to set the path explicitly.

Note: the proxy uses the hardcoded container path `/secrets/github-app.pem` to read the key, not the `GITHUB_APP_KEY_PATH` env var. The env var is only consumed by docker-compose for the volume bind source.

### Host-Side Changes (`infra.ts`)

**`buildProxyEnv()`**: When `config.githubApp` is present, write App config env vars instead of a pre-resolved token:
- `GITHUB_APP_ID` = appId
- `GITHUB_APP_INSTALLATION_ID` = installationId
- `GITHUB_APP_KEY_PATH` = host-side path to `.pem` (used by docker-compose for the volume mount)

Remove the `GITHUB_TOKEN` entry for App mode (the proxy generates its own).

**`ensureProxyRunning()`**: Remove the call to `getGitHubInstallationToken()` when `config.githubApp` is present. The proxy handles token lifecycle now.

**Hash stability**: The proxy env hash now includes the static App credentials (appId, installationId, keyPath) which don't change, so the proxy won't be needlessly recreated — which is the desired behavior since the proxy manages its own token refresh.

**Existing functions**: `getGitHubInstallationToken()`, `generateGitHubJwt()`, `requestInstallationToken()` remain in `infra.ts` — they may be useful for non-Docker callers. They just stop being called from `ensureProxyRunning`.

### Backward Compatibility

- **Static `githubToken`**: Unchanged. Proxy receives `GITHUB_TOKEN` env, uses it directly. No App config env vars are set.
- **GitHub App config**: Same user-facing `adapterConfig.githubApp` shape. Internal change: host passes credentials to proxy instead of resolving a token.
- **No GitHub config**: Unchanged. No GitHub env vars set, proxy skips auth injection.
- **Agent container / Dockerfile**: No changes needed.

### Error Handling

- If the private key file is unreadable at request time → log error, return 502 to the agent with a descriptive message.
- If GitHub token exchange fails (bad App ID, revoked key, etc.) → log error, return 502.
- Transient GitHub API failures → no retry on the proxy side; the agent's `gh` CLI or git will retry or surface the error.
- No startup probe for key readability. The proxy starts successfully even if the key is missing/empty; the first GitHub request surfaces the error. This is intentional — it keeps the proxy simple and avoids blocking non-GitHub traffic.

### Implementation Notes

- The JWT lifetime (10 min) and the installation token lifetime (1 hour, set by GitHub) are distinct. The JWT is ephemeral — generated fresh for each token exchange. The installation token is cached using the `expires_at` field from GitHub's response, not derived from the JWT.
- The `GITHUB_APP_PRIVATE_KEY_PATH` inside the container is always `/secrets/github-app.pem` (the mount target). The host path is only used by docker-compose.
