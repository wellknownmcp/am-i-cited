# BYOK — how user keys are stored (hosted mode)

`am-i-cited` is bring-your-own-keys by design: the probe spends *your* API
credits, on *your* accounts, at cost. The hosted mode (`server/backend.mjs`)
makes that multi-user. This document is the full design of the key custody —
published because if we hold your keys, you deserve to know exactly how.

## The flow

The hosted backend implements the
[cortex-gateway backend contract](https://github.com/wellknownmcp/cortex-gateway/blob/main/docs/backend-contract.md):
users authenticate against the gateway with OAuth 2.1 (magic link — no
password exists anywhere), and every call reaches this backend with the
user's verified identity (`X-Cortex-User-Id`, from the JWT the gateway
validated). Tools:

| Tool | Scope | Does |
|---|---|---|
| `set_engine_key(engine, api_key)` | write | store your key for perplexity / openai / anthropic |
| `get_key_status()` | read | which engines are configured — masked (last 4 chars) |
| `delete_engine_key(engine)` | write | remove one key |
| `set_project(config)` / `list_projects()` | write / read | your probe configs (max 15 prompts) |
| `run_probe(project, runs?)` | write | run the probe **with your keys, on your credits** |
| `get_history(project)` | read | your CSV history |

## Custody design

- **Encryption at rest**: AES-256-GCM, one random 96-bit IV per write, auth
  tag verified on read. Master key = `AMICITED_VAULT_KEY` (32 bytes), held
  only in the server's environment. **The server refuses to boot without
  it** — there is no default key and no plaintext fallback path.
- **Per-user isolation**: one vault file per user, named by
  `sha256(user_id)` — the identifier itself never appears on disk. A user's
  keys are only ever decrypted inside `run_probe` for that same user.
- **Write-only keys**: no tool, log line, or error message ever contains a
  key. The only readable surface is the masked status (`last4`, `setAt`).
- **Audit trail**: every set/delete appends `{at, user_hash, action,
  engine}` — who did what, when; never the value.
- **Deletion is real**: `delete_engine_key` removes the ciphertext; the
  vault also supports full per-user erasure (GDPR Art. 17).
- **Projects and results** are equally per-user (`AMICITED_PROJECTS_DIR` /
  `AMICITED_RESULTS_DIR` overrides on the engine) — no shared CSV.

## Trust boundaries — what this does NOT protect against

Honesty section. The design protects keys **at rest** and **between users**;
it cannot protect against:

- **A compromised host**: the master key lives in the environment of the
  same machine. An attacker with root reads both. Standard mitigation
  applies (dedicated user, file modes 600, no key in shell history).
- **The operator**: we *can* technically decrypt (that is what `run_probe`
  does). If that is unacceptable, run the engine locally — it is the same
  code, MIT-licensed, and needs nothing but Node.
- **Key scope**: we recommend dedicated, budget-capped API keys (all three
  providers support per-key spending limits). A probe key never needs more
  than a few dollars a month.

## Deployment

The backend trusts `X-Cortex-User-Id` headers, which is correct **only**
behind a cortex-gateway on the same host (loopback bind; the gateway
verified the OAuth JWT and the technical token gates the catalog). Wiring:

```bash
# gateway .env
CORTEX_BACKENDS=amicited
CORTEX_BACKEND_AMICITED_URL=http://127.0.0.1:4930

# backend
AMICITED_VAULT_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
AMICITED_VAULT_KEY=... node server/backend.mjs
```

Scopes follow the gateway convention: `mcp:amicited:read` (status, history)
and `mcp:amicited:write` (keys, projects, runs) — the gateway filters
`tools/list` per user token, and this backend re-checks on every call.

Exposing the backend on anything other than loopback-behind-the-gateway
requires verifying the propagated JWT in the backend itself (issuer,
audience, signature) — do not skip that.
