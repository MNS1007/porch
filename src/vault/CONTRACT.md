# Vault contract (phase one)

Every vault module is built against this file. Change it only in the wiring step.

## What the vault is

A broker for API keys. The owner stores keys; agents never receive them. An agent
holds a **capability handle** (opaque, random, short-lived) tied to one grant, and
sends its API calls through the vault's **proxy**, which checks the grant, adds the
real key on the way out, and meters the cost.

## Hard rules (every module, every test)

1. No secret value ever leaves the vault module except inside the outgoing HTTPS
   request to the provider. Not in any HTTP response, MCP result, porch message,
   log line, error message, audit row or exception text.
2. Vault routes and the proxy listen on their **own port** (default 7778,
   `PORCH_VAULT_PORT`), bound to 127.0.0.1 only. Tailscale Funnel forwards public
   traffic to 127.0.0.1:7777, so a loopback address alone proves nothing. The vault
   listener also refuses any request that carries `X-Forwarded-For`, `Forwarded`,
   `X-Forwarded-Host`, `X-Real-IP` or any `Tailscale-*` header, or whose Host header
   is not `127.0.0.1:<port>` or `localhost:<port>`.
3. Only the owner, on the local page with the vault passphrase, can add or change
   secrets, approve, deny or revoke. A porch token, MCP call, porch message or voice
   call can request access but never grant it.
4. Handles are random (32 bytes, base64url, prefix `pvh_`), stored only as SHA-256
   hashes, expire, and are bound to one grant.
5. Every state change and every proxied call writes one audit row.

## Storage: `vault.db` (separate file, default `~/.porch/vault.db`, `PORCH_VAULT_DB`)

```sql
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- meta keys: 'wrapped_master' (master key wrapped, base64), 'kdf_salt', 'pass_check'

CREATE TABLE IF NOT EXISTS secrets (
  name TEXT PRIMARY KEY,            -- e.g. 'gemini', 'openai-main'; [a-z0-9][a-z0-9_-]{0,39}
  provider TEXT NOT NULL,           -- 'openai' | 'gemini'
  ciphertext BLOB NOT NULL, nonce BLOB NOT NULL, tag BLOB NOT NULL,
  created TEXT NOT NULL, rotated TEXT
);

CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent TEXT NOT NULL,              -- porch agent name (may be a family member like claude-code/vision-24h)
  secret TEXT NOT NULL,
  purpose TEXT NOT NULL,
  scope_json TEXT NOT NULL,         -- {"models": ["gemini-robotics-er-2"], "endpoints": ["generateContent"]}
  budget_json TEXT NOT NULL,        -- {"per_request_usd": 1, "daily_usd": 2, "total_usd": 5, "rate_per_min": 30, "days": 7}
  replaces_grant INTEGER,           -- set when this asks to change an existing grant's scope or caps
  status TEXT NOT NULL,             -- 'pending' | 'approved' | 'denied' | 'withdrawn'
  created TEXT NOT NULL, decided_at TEXT, decision_note TEXT
);

CREATE TABLE IF NOT EXISTS grants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL,
  agent TEXT NOT NULL, secret TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  per_request_usd REAL NOT NULL, daily_usd REAL NOT NULL, total_usd REAL NOT NULL, rate_per_min INTEGER NOT NULL,
  spent_usd REAL NOT NULL DEFAULT 0,
  handle_hash TEXT NOT NULL UNIQUE,
  expires TEXT NOT NULL,
  status TEXT NOT NULL,             -- 'active' | 'paused' (hit 80% of a cap) | 'revoked' | 'expired'
  created TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS spend (       -- one row per proxied call, for daily caps and the page
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  grant_id INTEGER NOT NULL, ts TEXT NOT NULL,
  model TEXT, estimate_usd REAL NOT NULL, actual_usd REAL, status INTEGER, refused TEXT
);

CREATE TABLE IF NOT EXISTS audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL,
  secret TEXT, grant_id INTEGER, request_id INTEGER, cost_usd REAL, detail TEXT,
  prev_hash TEXT NOT NULL, hash TEXT NOT NULL   -- hash = sha256(prev_hash + canonical JSON of the other columns)
);
```

## Module interfaces (ES modules, in `src/vault/`)

**`store.js`** (workstream a)
```js
export function openVault(path)            // -> vault object below; creates tables
vault.isSetUp()                            // has a passphrase been set
vault.setUp(passphrase)                    // first time: random 32-byte master key, wrapped (see crypto)
vault.unlock(passphrase)                   // -> true/false; keeps the master key in memory only, for this process
vault.lock()
vault.unlocked()                           // bool
vault.putSecret(name, provider, value, actor)   // owner only (caller checks); encrypts; audit 'secret.put' (never the value)
vault.listSecrets()                        // [{name, provider, created, rotated}] — never values
vault.deleteSecret(name, actor)
vault.useSecret(name, fn)                  // the ONLY way to get a value: calls fn(value) inside the vault, returns fn's result; value never returned
vault.createRequest({agent, secret, purpose, scope, budget, replaces_grant}) // -> request row; audit 'request.create'
vault.listRequests({status})
vault.decide(id, {approve, note, changes}, actor)  // owner; approve -> creates grant and returns {grant, handle} ONCE; audit
vault.grants({agent})                      // rows without handle_hash
vault.grantForHandle(handle)               // hash lookup; null if unknown/expired/revoked (marks expired)
vault.revoke(grantId, actor)
vault.recordSpend(grantId, {model, estimate_usd, actual_usd, status, refused})
vault.spentToday(grantId)                  // UTC day
vault.setStatus(grantId, status, actor)
vault.audit({limit, secret, agent})        // rows
vault.verifyAudit()                        // -> {ok, brokenAt}
```

**`crypto.js`** (workstream a)
```js
export function wrapKey(masterKey, passphrase)   // scrypt(passphrase, salt) -> AES-256-GCM wrap; on Windows ALSO DPAPI-protect the result (CurrentUser) via PowerShell [System.Security.Cryptography.ProtectedData]; fall back to scrypt-only elsewhere
export function unwrapKey(wrapped, passphrase)
export function encrypt(masterKey, plaintext)    // -> {ciphertext, nonce, tag}
export function decrypt(masterKey, {ciphertext, nonce, tag})
export function newHandle()                      // -> {handle: 'pvh_' + base64url(32 bytes), hash}
export const hashHandle = handle => sha256 hex
```

**`pricing.js`** and **`proxy.js`** (workstream b)
```js
export const PRICES = { openai: {...per model in/out USD per 1M tokens}, gemini: {...} }   // table with a 'default' per provider that errs high
export function estimate(provider, model, body)  // worst-case USD before the call (input size + max output tokens)
export function actual(provider, model, usage)   // USD from the provider's usage block
export async function handleProxy(req, res, vault, {fetchFn, notify})  // path /vault/proxy/<provider>/...
```
Proxy steps: read handle from `Authorization: Bearer pvh_...` or `x-goog-api-key: pvh_...` or `?key=pvh_...`;
`grantForHandle`; check provider matches the secret's provider, model and endpoint in scope, status active, not
expired; rate limit (calls in the last minute < rate_per_min); `estimate` <= per_request_usd; spentToday + estimate
<= daily_usd; spent + estimate <= total_usd; then `vault.useSecret(name, key => fetchFn(provider URL, with the
key header set and the incoming auth removed))`; stream the response back unchanged; read usage (non-streaming
JSON, or the final streamed chunk); `recordSpend`; add to spent; if spent or spentToday >= 80% of a cap, set
status 'paused' and `notify(...)`. Refusals answer 402 or 403 JSON `{error, reason}` and record a spend row with
`refused`. Upstream hosts: `https://api.openai.com` and `https://generativelanguage.googleapis.com`. Never log
request or response bodies or headers.

**`routes.js`** and **`public/vault.html`** (workstream c)
```js
export function vaultServer({vault, notify, port})   // http server bound to 127.0.0.1:port; enforces hard rule 2 on every request
// page session: POST /vault/session {passphrase} -> unlocks, sets an HttpOnly SameSite=Strict cookie (random,
//   in memory, 30 min idle timeout); every owner route requires it. CSRF: owner POSTs require header
//   'x-vault-csrf' equal to a value returned by /vault/session.
// GET  /vault/            -> public/vault.html
// GET  /vault/api/state   -> {setUp, unlocked, secrets, pending, grants (with spent, today, status), auditHead}
// POST /vault/api/setup {passphrase}            (only if not set up)
// POST /vault/api/secrets {name, provider, value}
// DELETE /vault/api/secrets/:name
// POST /vault/api/requests/:id/decide {approve, note, changes}  -> {grant}; the handle goes to the agent (see d), never shown
// POST /vault/api/grants/:id/revoke
// POST /vault/api/grants/:id/resume
// GET  /vault/api/audit?limit=&secret=&agent= ; GET /vault/api/audit/verify
// /vault/proxy/*          -> handleProxy (no page session; the handle is the credential)
```
The page is plain HTML+JS, no build step, text rendered as text. Secret values are typed into a password field
and sent once; the page never displays a stored value.

**`agent-api.js`** and MCP (workstream d)
```js
export function vaultAgentApi(vault, {notify})   // used by porch's main server (port 7777) for agents
api.list(agent)                    // names, providers, and this agent's own grants (status, caps, spent, expires) — no values, no handles
api.request(agent, {secret, purpose, scope, budget, replaces_grant})  // pending request; notify owner with a porch DM
api.status(agent, requestId)       // pending | approved | denied; when approved, returns the handle ONCE to the requesting agent only, then marks it delivered
```
Main-server routes (agent token auth, may be reachable through Funnel but expose no secrets or grants):
`GET /v1/vault` -> list, `POST /v1/vault/requests` -> request, `GET /v1/vault/requests/:id` -> status.
MCP tools: `vault_list`, `vault_request`, `vault_status`, each description saying keys are never returned, use the
proxy at `http://127.0.0.1:7778/vault/proxy/<provider>` with the handle as the API key.
Anton (`../anton`): when a session's request is approved, Anton fetches the handle via `vault_status` with its own
token on behalf of the managed member, stores it only in memory, and starts that session's tasks with env
`OPENAI_BASE_URL`/`GOOGLE_GEMINI_BASE_URL` pointing at the proxy and the API key env var set to the handle.

## Out of scope for phase one

Windows service account, Windows Hello, more providers, key rotation reminders.
