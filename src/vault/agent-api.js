// The agent-facing side of the vault, used by porch's main server (port 7777).
// Agents can see which keys exist, ask for access, and pick up a handle once the
// owner approves on the local vault page. Nothing here can approve, deny or
// revoke, and no key value ever passes through: the vault only hands this module
// names, grant rows without handle hashes, and the one-time handle.

const PROVIDERS = ['openai', 'gemini']
const SECRET_NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/
const SCOPE_ITEM = /^[A-Za-z0-9._:\/-]{1,80}$/
const MAX_PENDING = 5 // per agent, so one agent cannot flood the owner's DMs

// `store` is porch's store, used to check that a manager (Anton) speaks for a member.
// `port` is the vault listener, for the proxy address agents are told to use: a
// number, or a function when the port is only known once the listener is up.
export function vaultAgentApi(vault, { notify = () => {}, store = null, port = Number(process.env.PORCH_VAULT_PORT || 7778) } = {}) {
  const portOf = typeof port === 'function' ? port : () => port
  // Approved handles waiting for their agent, by request id. Memory only: never
  // written to vault.db, never logged. The wiring step puts them here with hold().
  const outbox = new Map()
  const proxy = provider => `http://127.0.0.1:${portOf()}/vault/proxy/${provider}`

  // Who the call is for: the caller, or a member it speaks for ("as").
  function subject(agent, as) {
    if (!as || as === agent.name) return agent.name
    if (!store) throw httpError(403, 'This hub does not let tokens act for others in the vault.')
    // speakAs checks the pattern and that this manager registered the member.
    // Its message names what was sent, so answer with a fixed one.
    try { return store.speakAs(agent, as).name } catch { throw httpError(403, 'This token cannot act for that agent in the vault.') }
  }

  // The caller may see a request made by itself or by a member it manages,
  // as long as the name was not removed and taken again since.
  function mayRead(agent, request) {
    if (!current(request)) return false
    if (request.agent === agent.name) return true
    return !!store && store.membersOf(agent.name).has(request.agent)
  }

  // A name can be removed and then registered again, by another manager or as a
  // new token. A request or grant made before today's holder of the name existed
  // belongs to the old one: it is never shown to, used by or handed to the new.
  function current(row) {
    const holder = store?.agent?.(row.agent)
    if (!holder?.created || !row?.created) return true
    return !(Date.parse(holder.created) > Date.parse(row.created))
  }

  const providerOf = name => vault.listSecrets().find(s => s.name === name)?.provider || null
  const findRequest = id => (vault.request ? vault.request(id) : vault.listRequests({}).find(r => r.id === id)) || null
  const grantFor = request => vault.grants({ agent: request.agent }).find(g => g.request_id === request.id) || null

  return {
    port: portOf,

    // The wiring step calls this with the handle vault.decide returned on approval.
    // Not reachable over HTTP or MCP.
    hold(requestId, handle) {
      if (typeof handle === 'string' && handle.startsWith('pvh_')) outbox.set(Number(requestId), handle)
    },

    list(agent, { as } = {}) {
      const name = subject(agent, as)
      return {
        secrets: vault.listSecrets().map(s => ({ name: s.name, provider: s.provider })),
        grants: vault.grants({ agent: name }).filter(g => g.agent === name && current(g)).map(publicGrant),
        requests: vault.listRequests({}).filter(r => r.agent === name && current(r)).sort((a, b) => b.id - a.id).slice(0, 20).map(publicRequest),
        proxy: Object.fromEntries(PROVIDERS.map(p => [p, proxy(p)])),
      }
    },

    request(agent, body = {}) {
      if (!agent.canPost) throw httpError(403, 'This token can read but not post, so it cannot ask for vault access.')
      const name = subject(agent, body.as)
      const secret = String(body.secret || '')
      if (!SECRET_NAME.test(secret)) throw httpError(400, 'secret must be the name of a vault key, from the vault list.')
      const provider = providerOf(secret)
      if (!provider) throw httpError(404, 'There is no vault key with that name.')
      const purpose = String(body.purpose || '').trim()
      if (purpose.length < 3) throw httpError(400, 'Say in purpose what the key is for.')
      const scope = checkScope(body.scope)
      const budget = checkBudget(body.budget)
      let replaces = null
      if (body.replaces_grant !== undefined && body.replaces_grant !== null) {
        replaces = Number(body.replaces_grant)
        const own = vault.grants({ agent: name }).find(g => g.id === replaces && g.agent === name && g.secret === secret && current(g))
        if (!own) throw httpError(404, 'replaces_grant must be one of your own grants on this key.')
      }
      const pending = vault.listRequests({ status: 'pending' }).filter(r => r.agent === name && current(r))
      if (pending.length >= MAX_PENDING) throw httpError(429, `You already have ${MAX_PENDING} requests waiting for the owner.`)

      // Only these fields reach the store; anything else in the body (a status, a
      // decision) is ignored. A request always starts pending.
      const row = vault.createRequest({ agent: name, secret, purpose: clip(purpose, 500), scope, budget, replaces_grant: replaces })
      tell(notify, {
        kind: 'question',
        request_id: row.id,
        agent: name,
        text: noteFor({ row, by: agent.name, name, secret, provider, purpose, scope, budget, replaces, port: portOf() }),
      })
      return { ...publicRequest(row), message: 'Asked the owner. Check vault_status (GET /v1/vault/requests/' + row.id + ') later for the handle.' }
    },

    status(agent, requestId) {
      const id = Number(requestId)
      const request = Number.isInteger(id) ? findRequest(id) : null
      // Someone else's request looks the same as a missing one.
      if (!request || !mayRead(agent, request)) throw httpError(404, 'No such vault request of yours.')
      const out = publicRequest(request)
      if (request.status !== 'approved') {
        outbox.delete(id)
        return out
      }
      const provider = providerOf(request.secret)
      const grant = grantFor(request)
      out.provider = provider
      out.grant = grant ? publicGrant(grant) : null
      out.proxy = provider ? proxy(provider) : null
      const handle = outbox.get(id)
      outbox.delete(id) // once, whatever happens next
      // Give it out only if it still opens this request's live grant.
      const live = handle ? vault.grantForHandle(handle) : null
      if (handle && live && live.request_id === id && live.status === 'active') {
        out.handle = handle
        out.use = `Send calls to ${out.proxy} with this handle as the API key. It works only there, only within this grant, and is shown once: keep it in memory, never in files, logs or messages.`
      } else {
        out.handle = null
        out.use = 'The handle was already given out, has expired, or was lost when porch restarted. Ask again with vault_request if you need a new one.'
      }
      return out
    },
  }
}

function checkScope(scope) {
  if (!scope || typeof scope !== 'object') throw httpError(400, 'scope needs models and endpoints, for example {"models": ["gpt-5.4-mini"], "endpoints": ["chat/completions"]}.')
  const list = (v, what) => {
    if (!Array.isArray(v) || !v.length || v.length > 20) throw httpError(400, `scope.${what} must be a list of 1 to 20 names.`)
    for (const x of v) if (typeof x !== 'string' || !SCOPE_ITEM.test(x)) throw httpError(400, `scope.${what} holds a name that is not allowed.`)
    return [...new Set(v)]
  }
  return { models: list(scope.models, 'models'), endpoints: list(scope.endpoints, 'endpoints') }
}

function checkBudget(budget) {
  if (!budget || typeof budget !== 'object') throw httpError(400, 'budget needs per_request_usd, daily_usd, total_usd, rate_per_min and days.')
  const num = (key, max, int = false) => {
    const v = Number(budget[key])
    if (!Number.isFinite(v) || v <= 0 || v > max || (int && !Number.isInteger(v))) throw httpError(400, `budget.${key} must be a ${int ? 'whole ' : ''}number above 0 and at most ${max}.`)
    return v
  }
  const b = {
    per_request_usd: num('per_request_usd', 100),
    daily_usd: num('daily_usd', 1000),
    total_usd: num('total_usd', 10000),
    rate_per_min: num('rate_per_min', 600, true),
    days: num('days', 90, true),
  }
  if (b.per_request_usd > b.daily_usd || b.daily_usd > b.total_usd) throw httpError(400, 'budget caps must grow: per_request_usd <= daily_usd <= total_usd.')
  return b
}

// The porch DM to the owner. Names and numbers only, never a value. The fixed
// lines come first and hold the only link. The agent's own words come last, on
// one labelled line, with no line breaks and no links, so they cannot pass for
// the hub's text or point the owner at a fake vault page.
function noteFor({ row, by, name, secret, provider, purpose, scope, budget, replaces, port }) {
  const who = by === name ? name : `${by} for ${name}`
  return `${who} asks to use the vault key "${secret}" (${provider})${replaces ? `, to change grant ${replaces}` : ''}.
Models: ${scope.models.join(', ')}. Endpoints: ${scope.endpoints.join(', ')}.
Caps: $${budget.per_request_usd} a call, $${budget.daily_usd} a day, $${budget.total_usd} in all, ${budget.rate_per_min} calls a minute, for ${budget.days} days.
Approve or deny request ${row.id} on the vault page, http://127.0.0.1:${port}/vault/ (this laptop only; check the port is ${port}).
Agent says: "${agentWords(purpose, 300)}"`
}

// One line of agent text, links and look-alike addresses taken out.
function agentWords(s, n) {
  return clip(String(s || '').replace(/\s+/g, ' ').replace(/\b(?:https?|ftp|file):\/*\S*/gi, '[link removed]').replace(/\b(?:localhost|127\.\d+\.\d+\.\d+|\[?::1\]?)(?::\d+)?\S*/gi, '[link removed]').replace(/"/g, "'").trim(), n)
}

// notify must never break a request, and must never throw a secret back at us.
function tell(notify, note) {
  try {
    const p = notify(note)
    if (p && typeof p.catch === 'function') p.catch(() => {})
  } catch {}
}

const parse = s => { try { return JSON.parse(s) } catch { return null } }

function publicRequest(r) {
  return {
    id: r.id, agent: r.agent, secret: r.secret, purpose: r.purpose,
    scope: parse(r.scope_json), budget: parse(r.budget_json), replaces_grant: r.replaces_grant ?? null,
    status: r.status, created: r.created, decided_at: r.decided_at || null, note: r.decision_note || null,
  }
}

function publicGrant(g) {
  return {
    id: g.id, request_id: g.request_id, secret: g.secret, scope: parse(g.scope_json),
    per_request_usd: g.per_request_usd, daily_usd: g.daily_usd, total_usd: g.total_usd, rate_per_min: g.rate_per_min,
    spent_usd: g.spent_usd, expires: g.expires, status: g.status, created: g.created,
  }
}

function clip(s, n) {
  s = String(s || '')
  return s.length > n ? s.slice(0, n) + '...' : s
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status })
}
