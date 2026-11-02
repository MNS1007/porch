// The vault proxy. An agent sends its API call here with a capability handle in
// place of the API key. We check the grant, swap in the real key, stream the
// answer back and meter the cost. The key never leaves this file except inside
// the outgoing request to the provider. Nothing here logs.

import { estimate, actual, hasOutputLimit } from './pricing.js'

export const UPSTREAM = {
  openai: 'https://api.openai.com',
  gemini: 'https://generativelanguage.googleapis.com',
}

const PREFIX = '/vault/proxy/'
const MAX_BODY = 32 * 1024 * 1024
const SCAN_LIMIT = 8 * 1024 * 1024 // most response text kept for reading usage
const PAUSE_AT = 0.8
const WINDOW_MS = 60_000
const ACTOR = 'proxy'

const OPENAI_ENDPOINTS = ['chat/completions', 'responses']
const GEMINI_ENDPOINTS = ['generateContent', 'streamGenerateContent']

// Inputs the estimate cannot size from the body (stored context, uploaded or
// linked files, cached content) and tools with their own per-call fee. They are
// refused, since a cap that cannot see them cannot hold.
const OPENAI_REFUSED_FIELDS = ['previous_response_id', 'conversation', 'prompt', 'web_search_options']
const OPENAI_REFUSED_PARTS = ['file_id', 'file_url']
const OPENAI_TOOLS = ['function', 'custom']
const OPENAI_TIERS = ['auto', 'default', 'flex']
const GEMINI_REFUSED_FIELDS = ['cachedContent', 'cached_content']
const GEMINI_REFUSED_PARTS = ['fileData', 'file_data']
const GEMINI_TOOL_KEYS = ['functionDeclarations', 'function_declarations']

// Request headers we pass on. Everything else, including any credential, is dropped.
const UP_HEADERS = ['content-type', 'accept', 'user-agent', 'openai-beta', 'openai-organization', 'openai-project', 'idempotency-key', 'x-goog-api-client']
const UP_PREFIXES = ['x-stainless-']
// Response headers we pass back.
const DOWN_HEADERS = ['content-type', 'cache-control', 'x-request-id', 'retry-after', 'openai-processing-ms', 'openai-version']
const DOWN_PREFIXES = ['x-ratelimit-']

// Rate and in-flight state, kept per vault so separate vaults never share it.
const state = new WeakMap()
function stateFor(vault) {
  let s = state.get(vault)
  if (!s) state.set(vault, s = { calls: new Map(), inflight: new Map() })
  return s
}

class Refusal extends Error {
  constructor(status, reason, error = 'refused', hint) {
    super(reason)
    this.status = status
    this.reason = reason
    this.error = error
    this.hint = hint
  }
}
const refuse = (status, reason, error, hint) => { throw new Refusal(status, reason, error, hint) }

export async function handleProxy(req, res, vault, { fetchFn = globalThis.fetch, notify = () => {}, upstream = UPSTREAM } = {}) {
  const ctx = { grant: null, model: null, est: 0 }
  try {
    await proxy(req, res, vault, ctx, { fetchFn, notify, upstream })
  } catch (err) {
    const r = err instanceof Refusal ? err : new Refusal(500, 'internal', 'proxy_failed')
    if (ctx.grant && !ctx.recorded) {
      ctx.recorded = true
      safe(() => vault.recordSpend(ctx.grant.id, { model: ctx.model, estimate_usd: ctx.est, actual_usd: null, status: r.status, refused: r.reason }))
    }
    if (!res.headersSent) sendJson(res, r.status, { error: r.error, reason: r.reason, ...(r.hint ? { hint: r.hint } : {}) })
    else res.destroy()
  }
}

async function proxy(req, res, vault, ctx, { fetchFn, notify, upstream }) {
  const url = new URL(req.url, 'http://vault.local')
  const route = parseRoute(url.pathname)
  if (!route) refuse(404, 'unknown_provider', 'not_found')

  // 1. Handle valid.
  const handle = readHandle(req, url)
  if (!handle) refuse(403, 'missing_handle')
  let grant = vault.grantForHandle(handle)
  if (!grant) refuse(403, 'unknown_handle')
  ctx.grant = grant

  // 2. Provider matches the secret's provider.
  const secret = vault.listSecrets().find(s => s.name === grant.secret)
  if (!secret) refuse(403, 'secret_missing')
  if (secret.provider !== route.provider) refuse(403, 'wrong_provider')

  // 3. Endpoint and model in scope.
  if (!route.endpoint || req.method !== 'POST') refuse(403, 'endpoint_not_supported')
  const scope = parseJson(grant.scope_json) || {}
  if (!inList(scope.endpoints, route.endpoint)) refuse(403, 'endpoint_not_in_scope')
  const body = parseJson((await readBody(req)).toString('utf8'))
  if (!body || typeof body !== 'object' || Array.isArray(body)) refuse(400, 'bad_json', 'bad_request')
  // The provider gets exactly what was checked: one model, one max tokens.
  const raw = Buffer.from(JSON.stringify(body))
  if (route.provider === 'gemini' && 'model' in body) refuse(400, 'model_in_body', 'bad_request')
  const model = route.provider === 'gemini' ? route.model : (typeof body.model === 'string' ? body.model : null)
  ctx.model = model
  if (!model) refuse(400, 'missing_model', 'bad_request')
  if (!inList(scope.models, model)) refuse(403, 'model_not_in_scope')
  checkInput(route.provider, body)

  // The grant may have been revoked, paused or charged while the body came in,
  // so read it again and check that copy from here on.
  const fresh = vault.grantForHandle(handle)
  if (!fresh || fresh.id !== grant.id) refuse(403, 'unknown_handle')
  grant = ctx.grant = fresh
  const scopeNow = parseJson(grant.scope_json) || {}
  if (!inList(scopeNow.endpoints, route.endpoint)) refuse(403, 'endpoint_not_in_scope')
  if (!inList(scopeNow.models, model)) refuse(403, 'model_not_in_scope')

  // 4. Active and not expired.
  if (grant.status !== 'active') refuse(403, grant.status === 'paused' ? 'grant_paused' : 'grant_not_active')
  if (!(Date.parse(grant.expires) > Date.now())) refuse(403, 'grant_expired')

  // 5. Rate limit: calls in the last minute < rate_per_min.
  const s = stateFor(vault)
  const now = Date.now()
  const calls = (s.calls.get(grant.id) || []).filter(t => now - t < WINDOW_MS)
  s.calls.set(grant.id, calls)
  if (calls.length >= grant.rate_per_min) refuse(403, 'rate_limited')
  calls.push(now)

  // 6 to 8. Money caps, counting calls still in flight.
  const est = estimate(route.provider, model, body)
  ctx.est = est
  const pending = s.inflight.get(grant.id) || 0
  const hint = hasOutputLimit(route.provider, body) ? undefined : 'No max tokens set, so the estimate assumes a large output. Set one to lower it.'
  if (est > grant.per_request_usd) refuse(402, 'over_per_request_cap', 'refused', hint)
  const today = Number(vault.spentToday(grant.id)) || 0
  if (today + pending + est > grant.daily_usd) refuse(402, 'over_daily_cap')
  const spent = Number(grant.spent_usd) || 0
  if (spent + pending + est > grant.total_usd) refuse(402, 'over_total_cap')

  if (!vault.unlocked()) refuse(503, 'vault_locked', 'unavailable')

  s.inflight.set(grant.id, pending + est)
  let out
  try {
    out = await vault.useSecret(grant.secret, key => forward({ req, res, raw, url, route, key, fetchFn, upstream }))
  } catch (err) {
    if (err instanceof Refusal) throw err
    refuse(502, 'upstream_failed', 'upstream_failed')
  } finally {
    const left = (s.inflight.get(grant.id) || 0) - est
    if (left > 1e-12) s.inflight.set(grant.id, left)
    else s.inflight.delete(grant.id)
  }

  // Meter: usage when we have it; nothing for an upstream error with no usage.
  // A client that left early pays at least the estimate: a stream stopped after
  // its first chunk shows almost no usage, and the provider may still bill what
  // it went on to generate.
  let cost = out.usage ? actual(route.provider, model, out.usage) : null
  if (out.aborted) cost = Math.max(cost ?? 0, est)
  else if (cost == null) cost = out.status >= 400 ? 0 : est
  ctx.recorded = true
  vault.recordSpend(grant.id, { model, estimate_usd: est, actual_usd: cost, status: out.status, refused: null })

  checkPause(vault, grant, spent + cost, notify)
}

// Pause the grant at 80% of its daily or total cap, and tell the owner once.
function checkPause(vault, grant, spentLocal, notify) {
  const fresh = safe(() => (vault.grants({ agent: grant.agent }) || []).find(g => g.id === grant.id))
  const spent = Math.max(spentLocal, Number(fresh?.spent_usd) || 0)
  const today = Number(safe(() => vault.spentToday(grant.id))) || 0
  const hitTotal = spent >= PAUSE_AT * grant.total_usd
  const hitDaily = today >= PAUSE_AT * grant.daily_usd
  if (!hitTotal && !hitDaily) return
  if ((fresh?.status ?? grant.status) !== 'active') return
  vault.setStatus(grant.id, 'paused', ACTOR)
  const cap = hitTotal ? 'total' : 'daily'
  const info = {
    type: 'vault.paused', grant_id: grant.id, agent: grant.agent, secret: grant.secret, cap,
    spent_usd: spent, today_usd: today, daily_usd: grant.daily_usd, total_usd: grant.total_usd,
    text: `Paused ${grant.agent}'s grant ${grant.id} on "${grant.secret}": it reached 80% of its ${cap} cap. Resume it on the vault page.`,
  }
  try {
    const p = notify(info)
    if (p && typeof p.catch === 'function') p.catch(() => {})
  } catch {}
}

// Runs inside useSecret: the only place the key is in scope.
async function forward({ req, res, raw, url, route, key, fetchFn, upstream }) {
  const headers = upstreamHeaders(req.headers)
  const q = new URLSearchParams(url.search)
  q.delete('key')
  const qs = q.toString() ? '?' + q.toString() : ''
  let target
  if (route.provider === 'openai') {
    headers.authorization = `Bearer ${key}`
    target = `${upstream.openai}/v1/${route.endpoint}${qs}`
  } else {
    headers['x-goog-api-key'] = key
    target = `${upstream.gemini}${route.rest}${qs}`
  }

  const ac = new AbortController()
  let aborted = false
  const onClose = () => { if (!res.writableEnded) { aborted = true; ac.abort() } }
  res.on('close', onClose)
  try {
    let up
    try {
      // Never follow a redirect: the key header would go to whatever host it names.
      up = await fetchFn(target, { method: 'POST', headers, body: raw, signal: ac.signal, redirect: 'manual' })
    } catch {
      // The client left while we waited: the provider may still bill, so meter it.
      if (aborted) return { status: 499, usage: null, aborted }
      throw new Refusal(502, 'upstream_failed', 'upstream_failed')
    }
    if ((up.status >= 300 && up.status < 400) || up.type === 'opaqueredirect') {
      await drain(up)
      throw new Refusal(502, 'upstream_redirect', 'upstream_failed')
    }
    // An auth error can quote part of the key (OpenAI shows a masked form), so
    // its body is replaced with a fixed one.
    if (up.status === 401 || up.status === 403) {
      await drain(up)
      sendJson(res, up.status, { error: 'upstream_auth_failed', reason: 'The provider refused the vault key. Tell the owner.' })
      return { status: up.status, usage: null, aborted: false }
    }
    res.writeHead(up.status, downstreamHeaders(up.headers))
    const scrub = redactor(key)
    const scan = usageScanner(route.provider)
    try {
      if (up.body) {
        for await (const chunk of up.body) {
          const buf = Buffer.from(chunk)
          scan.push(buf)
          const clean = scrub.push(buf)
          if (clean.length) res.write(clean)
        }
      }
      const tail = scrub.end()
      if (tail.length) res.write(tail)
      res.end()
    } catch {
      aborted = true
      res.destroy()
    }
    return { status: up.status, usage: scan.end(), aborted }
  } finally {
    res.off('close', onClose)
  }
}

async function drain(up) {
  try { await up.body?.cancel() } catch {}
}

// Refuses inputs and tools the estimate cannot price (see the lists at the top).
function checkInput(provider, body) {
  const no = () => refuse(403, 'unsupported_input', 'refused', 'Stored context, file ids, file links, cached content and paid tools are not allowed through the vault. Send the content inline.')
  if (provider === 'openai') {
    if (OPENAI_REFUSED_FIELDS.some(k => body[k] != null)) no()
    if (body.service_tier != null && !OPENAI_TIERS.includes(body.service_tier)) refuse(403, 'unsupported_service_tier', 'refused', 'Use service_tier auto, default or flex.')
    if (body.tools != null && (!Array.isArray(body.tools) || body.tools.some(t => !OPENAI_TOOLS.includes(t?.type)))) no()
    if (hasKey([body.messages, body.input], OPENAI_REFUSED_PARTS)) no()
  } else {
    if (GEMINI_REFUSED_FIELDS.some(k => body[k] != null)) no()
    const toolOk = t => t && typeof t === 'object' && Object.keys(t).every(k => GEMINI_TOOL_KEYS.includes(k))
    if (body.tools != null && (!Array.isArray(body.tools) || !body.tools.every(toolOk))) no()
    if (hasKey([body.contents, body.systemInstruction, body.system_instruction], GEMINI_REFUSED_PARTS)) no()
  }
}

// True when any of the keys appears anywhere inside v.
function hasKey(v, keys) {
  if (Array.isArray(v)) return v.some(x => hasKey(x, keys))
  if (!v || typeof v !== 'object') return false
  return Object.entries(v).some(([k, x]) => (keys.includes(k) && x != null) || hasKey(x, keys))
}

// /vault/proxy/<provider>/<rest>. OpenAI accepts an optional v1/ prefix, since
// the SDK's base URL may or may not include it. Gemini keeps its own path.
function parseRoute(pathname) {
  if (!pathname.startsWith(PREFIX)) return null
  const tail = pathname.slice(PREFIX.length)
  const slash = tail.indexOf('/')
  const provider = slash < 0 ? tail : tail.slice(0, slash)
  const rest = slash < 0 ? '' : tail.slice(slash)
  if (provider === 'openai') {
    const ep = rest.replace(/^\/(v1\/)?/, '').replace(/\/$/, '')
    return { provider, endpoint: OPENAI_ENDPOINTS.includes(ep) ? ep : null }
  }
  if (provider === 'gemini') {
    const m = rest.match(/^\/(v1|v1beta|v1alpha)\/models\/([A-Za-z0-9._-]+):([A-Za-z]+)$/)
    if (!m || !GEMINI_ENDPOINTS.includes(m[3])) return { provider, endpoint: null }
    return { provider, endpoint: m[3], model: m[2], rest }
  }
  return null
}

// The handle, from the bearer header, the Gemini key header, or ?key=.
function readHandle(req, url) {
  const auth = String(req.headers.authorization || '')
  const bearer = auth.match(/^Bearer\s+(\S+)$/i)?.[1]
  const found = [bearer, req.headers['x-goog-api-key'], url.searchParams.get('key')]
    .map(v => (Array.isArray(v) ? v[0] : v))
    .find(v => typeof v === 'string' && v.startsWith('pvh_'))
  return found || null
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const parts = []
    let size = 0
    let over = false
    req.on('data', c => {
      if (over) return
      size += c.length
      if (size > MAX_BODY) { over = true; parts.length = 0; return }
      parts.push(c)
    })
    req.on('end', () => (over ? reject(new Refusal(413, 'body_too_large', 'too_large')) : resolve(Buffer.concat(parts))))
    req.on('error', () => reject(new Refusal(400, 'bad_body', 'bad_request')))
  })
}

function upstreamHeaders(incoming) {
  const out = {}
  for (const [k, v] of Object.entries(incoming)) {
    const name = k.toLowerCase()
    if (!UP_HEADERS.includes(name) && !UP_PREFIXES.some(p => name.startsWith(p))) continue
    const value = Array.isArray(v) ? v.join(', ') : String(v)
    if (value.includes('pvh_')) continue
    out[name] = value
  }
  return out
}

function downstreamHeaders(h) {
  const out = {}
  h.forEach((v, k) => {
    const name = k.toLowerCase()
    if (DOWN_HEADERS.includes(name) || DOWN_PREFIXES.some(p => name.startsWith(p))) out[name] = v
  })
  return out
}

// Removes the key from the response stream, even when it is split across
// chunks. Holds back only a tail that could be the start of the key.
export function redactor(key) {
  const needle = Buffer.from(key)
  const mask = Buffer.from('[redacted]')
  let held = Buffer.alloc(0)
  const clean = buf => {
    const parts = []
    let from = 0
    let i
    while ((i = buf.indexOf(needle, from)) !== -1) {
      parts.push(buf.subarray(from, i), mask)
      from = i + needle.length
    }
    parts.push(buf.subarray(from))
    return Buffer.concat(parts)
  }
  return {
    push(chunk) {
      const buf = clean(Buffer.concat([held, chunk]))
      let keep = 0
      for (let k = Math.min(needle.length - 1, buf.length); k > 0; k--) {
        if (buf.subarray(buf.length - k).equals(needle.subarray(0, k))) { keep = k; break }
      }
      held = Buffer.from(buf.subarray(buf.length - keep))
      return buf.subarray(0, buf.length - keep)
    },
    end() {
      const out = held
      held = Buffer.alloc(0)
      return out
    },
  }
}

// Finds the last usage block in a response: plain JSON, server-sent events
// (OpenAI streams, Gemini alt=sse) or a streamed JSON array (Gemini default).
export function usageScanner(provider) {
  const decoder = new TextDecoder()
  let line = ''
  let text = ''
  let overflow = false
  let sawEvents = false
  let usage = null
  const pick = obj => {
    if (!obj || typeof obj !== 'object') return
    const u = provider === 'openai' ? (obj.usage || obj.response?.usage) : obj.usageMetadata
    if (u && typeof u === 'object') usage = u
  }
  const onLine = l => {
    const m = l.match(/^data:\s?(.*)$/)
    if (!m) return
    sawEvents = true
    if (m[1].trim() === '[DONE]') return
    pick(parseJson(m[1]))
  }
  const feed = s => {
    if (!overflow) {
      if (text.length + s.length > SCAN_LIMIT) { overflow = true; text = '' } else text += s
    }
    line += s
    let i
    while ((i = line.indexOf('\n')) !== -1) {
      onLine(line.slice(0, i).replace(/\r$/, ''))
      line = line.slice(i + 1)
    }
    if (line.length > SCAN_LIMIT) line = ''
  }
  return {
    push(buf) { feed(decoder.decode(buf, { stream: true })) },
    end() {
      feed(decoder.decode())
      if (line) onLine(line.replace(/\r$/, ''))
      if (!sawEvents && !overflow) {
        const whole = parseJson(text)
        if (Array.isArray(whole)) whole.forEach(pick)
        else pick(whole)
      }
      return usage
    },
  }
}

function inList(list, value) {
  return Array.isArray(list) && list.includes(value)
}

function parseJson(s) {
  try { return JSON.parse(s) } catch { return null }
}

function safe(fn) {
  try { return fn() } catch { return undefined }
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(obj))
}
