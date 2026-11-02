// The vault's own server: the owner's page, its JSON routes and the proxy.
// It listens on its own port, on 127.0.0.1 only, and refuses anything that
// looks like it came through a tunnel or a proxy (hard rule 2).
import http from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto'
import { handleProxy as realProxy } from './proxy.js'

const PAGE_FILE = fileURLToPath(new URL('../../public/vault.html', import.meta.url))
const COOKIE = 'porch_vault'
const IDLE_MS = 30 * 60 * 1000
const NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/
const PROVIDERS = ['openai', 'gemini']
const CAP_KEYS = ['per_request_usd', 'daily_usd', 'total_usd', 'rate_per_min', 'days']
const REFUSED_HEADERS = ['x-forwarded-for', 'forwarded', 'x-forwarded-host', 'x-real-ip']
const OWNER = 'owner'

export function vaultServer({ vault, notify = () => {}, port = Number(process.env.PORCH_VAULT_PORT || 7778), ...opts } = {}) {
  const idleMs = opts.idleMs ?? IDLE_MS
  const now = opts.now ?? Date.now
  const fetchFn = opts.fetchFn ?? globalThis.fetch
  const page = loadPage()
  const sessions = new Map() // cookie value -> { csrf, last }
  const misses = { count: 0, until: 0 } // wrong passphrases, for a short back-off

  // opts.upstream points the proxy at stub providers in tests.
  const proxy = opts.handleProxy ?? realProxy
  const handleProxy = (req, res) => proxy(req, res, vault, { fetchFn, notify, ...(opts.upstream ? { upstream: opts.upstream } : {}) })

  function newSession() {
    const id = randomBytes(32).toString('base64url')
    const csrf = randomBytes(32).toString('base64url')
    sessions.set(id, { csrf, last: now() })
    return { id, csrf }
  }

  // The session for this request, or null. Idle sessions are dropped.
  function sessionFor(req) {
    const id = cookieValue(req.headers.cookie, COOKIE)
    const s = id && sessions.get(id)
    if (!s) return null
    if (now() - s.last > idleMs) { sessions.delete(id); return null }
    s.last = now()
    return { id, ...s }
  }

  function owner(req, { write }) {
    const s = sessionFor(req)
    if (!s) throw httpError(401, 'Unlock the vault first.')
    if (write && !sameSecret(req.headers['x-vault-csrf'], s.csrf)) throw httpError(403, 'Missing or wrong x-vault-csrf header.')
    return s
  }

  function startSession(res) {
    const { id, csrf } = newSession()
    res.setHeader('Set-Cookie', `${COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/vault`)
    return { csrf }
  }

  // Five wrong passphrases start a one-minute back-off, and the owner is told.
  // The right passphrase still works during it, so a local process cannot lock
  // the owner out by guessing; each guess still costs a full scrypt (and DPAPI).
  function unlockWith(passphrase) {
    const ok = typeof passphrase === 'string' && !!passphrase && vault.unlock(passphrase)
    if (ok) { misses.count = 0; misses.until = 0; return }
    if (now() < misses.until) {
      misses.until = now() + 60 * 1000
      throw httpError(429, 'Too many wrong passphrases. Wait a minute and try again.')
    }
    if (++misses.count >= 5) {
      misses.count = 0
      misses.until = now() + 60 * 1000
      tellOwner('Five wrong vault passphrases in a row. If that was not you, something on this computer is guessing. Your own passphrase still works on the vault page.')
    }
    throw httpError(401, 'That passphrase did not unlock the vault.')
  }

  function tellOwner(text) {
    try {
      const p = notify({ type: 'vault.lockout', text })
      if (p && typeof p.catch === 'function') p.catch(() => {})
    } catch {}
  }

  function state(req) {
    const base = { setUp: vault.isSetUp(), unlocked: vault.unlocked() }
    if (!sessionFor(req)) return { ...base, session: false }
    return {
      ...base,
      session: true,
      secrets: vault.listSecrets().map(publicSecret),
      pending: vault.listRequests({ status: 'pending' }).map(publicRequest),
      grants: vault.grants({}).map(g => publicGrant(g, vault.spentToday(g.id))),
      auditHead: auditHead(vault.audit({ limit: 1 })),
    }
  }

  async function route(req, res, url) {
    const path = url.pathname
    const m = req.method

    if (path.startsWith('/vault/proxy/')) return handleProxy(req, res)

    if (m === 'GET' && (path === '/vault' || path === '/vault/')) return sendPage(res, page)

    if (path === '/vault/session' && m === 'POST') {
      const { passphrase } = parseJson(await readBody(req))
      if (!vault.isSetUp()) throw httpError(409, 'Set up the vault first.')
      unlockWith(passphrase)
      return json(res, 200, startSession(res))
    }
    if (path === '/vault/session' && m === 'DELETE') {
      const s = owner(req, { write: true })
      sessions.delete(s.id)
      res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/vault; Max-Age=0`)
      return json(res, 200, { ok: true })
    }

    if (path === '/vault/api/state' && m === 'GET') return json(res, 200, state(req))

    if (path === '/vault/api/setup' && m === 'POST') {
      const { passphrase } = parseJson(await readBody(req))
      if (vault.isSetUp()) throw httpError(409, 'The vault is already set up.')
      if (typeof passphrase !== 'string' || passphrase.length < 10) throw httpError(400, 'Use a passphrase of at least 10 characters.')
      vault.setUp(passphrase)
      unlockWith(passphrase)
      return json(res, 201, startSession(res))
    }

    if (!path.startsWith('/vault/api/')) throw httpError(404, 'Not found')
    owner(req, { write: m !== 'GET' })
    const parts = path.slice('/vault/api/'.length).split('/').map(decodeURIComponent)

    if (parts[0] === 'secrets' && parts.length === 1 && m === 'POST') return addSecret(res, await readBody(req))
    if (parts[0] === 'secrets' && parts.length === 2 && m === 'DELETE') {
      if (!NAME.test(parts[1])) throw httpError(400, 'Not a secret name.')
      vault.deleteSecret(parts[1], OWNER)
      return json(res, 200, { ok: true })
    }
    if (parts[0] === 'requests' && parts[2] === 'decide' && parts.length === 3 && m === 'POST') {
      const body = parseJson(await readBody(req))
      const decision = { approve: body.approve === true, note: cleanNote(body.note), changes: cleanChanges(body.changes) }
      const out = vault.decide(toId(parts[1]), decision, OWNER) || {}
      // The handle goes to the agent, never to the page.
      return json(res, 200, { grant: out.grant ? publicGrant(out.grant, 0) : null })
    }
    if (parts[0] === 'grants' && parts.length === 3 && m === 'POST') {
      const id = toId(parts[1])
      if (parts[2] === 'revoke') { vault.revoke(id, OWNER); return json(res, 200, { ok: true }) }
      if (parts[2] === 'resume') { vault.setStatus(id, 'active', OWNER); return json(res, 200, { ok: true }) }
    }
    if (parts[0] === 'audit' && parts.length === 1 && m === 'GET') {
      const q = url.searchParams
      const limit = Math.min(Math.max(Number(q.get('limit')) || 200, 1), 2000)
      const rows = vault.audit({ limit, secret: q.get('secret') || undefined, agent: q.get('agent') || undefined })
      return json(res, 200, rows.map(publicAudit))
    }
    if (parts[0] === 'audit' && parts[1] === 'verify' && parts.length === 2 && m === 'GET') {
      const { ok, brokenAt } = vault.verifyAudit()
      return json(res, 200, { ok: !!ok, brokenAt: brokenAt ?? null })
    }
    throw httpError(404, 'Not found')
  }

  // The value is checked and handed to the store; it is never echoed back,
  // and it is scrubbed from any error the store might raise.
  function addSecret(res, raw) {
    const body = parseJson(raw)
    const value = body.value
    try {
      if (!NAME.test(String(body.name ?? ''))) throw httpError(400, 'Name must be lower case letters, digits, - or _, up to 40 characters.')
      if (!PROVIDERS.includes(body.provider)) throw httpError(400, 'Provider must be openai or gemini.')
      if (typeof value !== 'string' || !value.trim() || value.length > 4096) throw httpError(400, 'Paste the key into the value field.')
      vault.putSecret(body.name, body.provider, value.trim(), OWNER)
      return json(res, 201, { ok: true, name: body.name, provider: body.provider })
    } catch (err) {
      throw scrubbed(err, [value, typeof value === 'string' ? value.trim() : null])
    }
  }

  const server = http.createServer(async (req, res) => {
    try {
      const why = refusal(req, server.address()?.port)
      if (why) return json(res, 403, { error: why })
      const url = new URL(req.url, 'http://127.0.0.1')
      if (!url.pathname.startsWith('/vault/proxy/') && req.method !== 'GET' && !sameOrigin(req)) {
        return json(res, 403, { error: 'Cross-site request refused.' })
      }
      await route(req, res, url)
    } catch (err) {
      if (res.headersSent) return res.destroy()
      // Only messages we wrote ourselves reach the page; anything unexpected stays generic.
      const status = err.status || 400
      json(res, status, { error: err.status || err.vaultSafe ? err.message : 'The vault could not do that.' })
    }
  })

  // A slow upload cannot hold a grant check open for long (see proxy.js).
  server.requestTimeout = 60 * 1000
  server.headersTimeout = 20 * 1000

  // Whatever the caller passes, bind to loopback only.
  const listen = server.listen.bind(server)
  server.listen = (p = port, ...rest) => {
    const cb = rest.find(a => typeof a === 'function')
    return listen(typeof p === 'object' ? { ...p, host: '127.0.0.1' } : p, '127.0.0.1', cb)
  }
  return server
}

// Hard rule 2: no forwarding headers, and a Host that names this listener.
export function refusal(req, port) {
  for (const h of Object.keys(req.headers)) {
    if (REFUSED_HEADERS.includes(h) || h.startsWith('tailscale-')) return 'Forwarded requests are refused. Open the vault on this computer.'
  }
  const host = req.headers.host
  if (!port || (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`)) return 'Wrong Host. Open the vault at http://127.0.0.1:<port>/vault/.'
  return null
}

// A browser sends Origin on cross-site posts; when present it must be us.
function sameOrigin(req) {
  const origin = req.headers.origin
  return !origin || origin === `http://${req.headers.host}`
}

function loadPage() {
  const html = readFileSync(PAGE_FILE, 'utf8')
  // Allow exactly the inline script and style in the file, nothing else.
  const hashes = tag => [...html.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))]
    // The browser hashes the text after turning CRLF into LF, so do the same.
    .map(m => `'sha256-${createHash('sha256').update(m[1].replace(/\r\n?/g, '\n')).digest('base64')}'`).join(' ')
  const csp = `default-src 'none'; script-src ${hashes('script')}; style-src ${hashes('style')}; connect-src 'self'; img-src 'self' data:; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`
  return { html, csp }
}

function sendPage(res, { html, csp }) {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': csp,
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  })
  res.end(html)
}

// Shapes sent to the page. Each lists the fields it keeps, so a new store
// column (or a handle) can never slip through.

function publicSecret(s) {
  return { name: s.name, provider: s.provider, created: s.created, rotated: s.rotated ?? null }
}

function publicRequest(r) {
  return {
    id: r.id, agent: r.agent, secret: r.secret, purpose: r.purpose,
    scope: r.scope ?? parseOr(r.scope_json, {}), budget: r.budget ?? parseOr(r.budget_json, {}),
    replaces_grant: r.replaces_grant ?? null, status: r.status, created: r.created,
  }
}

function publicGrant(g, today) {
  return {
    id: g.id, request_id: g.request_id, agent: g.agent, secret: g.secret,
    scope: g.scope ?? parseOr(g.scope_json, {}),
    per_request_usd: g.per_request_usd, daily_usd: g.daily_usd, total_usd: g.total_usd, rate_per_min: g.rate_per_min,
    spent: g.spent_usd ?? 0, today: Number(today) || 0,
    status: g.status, expires: g.expires, created: g.created,
  }
}

function publicAudit(a) {
  return {
    seq: a.seq, ts: a.ts, actor: a.actor, action: a.action, secret: a.secret ?? null,
    grant_id: a.grant_id ?? null, request_id: a.request_id ?? null, cost_usd: a.cost_usd ?? null,
    detail: a.detail ?? null, hash: a.hash,
  }
}

// The newest row, whatever order the store returns.
function auditHead(rows) {
  const last = (rows || []).reduce((a, r) => (!a || r.seq > a.seq ? r : a), null)
  return last ? { seq: last.seq, hash: last.hash, ts: last.ts } : null
}

function cleanNote(note) {
  return note == null ? undefined : String(note).slice(0, 500)
}

// Owner edits to caps and expiry: known keys, positive numbers only.
function cleanChanges(changes) {
  if (!changes || typeof changes !== 'object') return undefined
  const out = {}
  for (const k of CAP_KEYS) {
    if (changes[k] == null || changes[k] === '') continue
    const n = Number(changes[k])
    if (!Number.isFinite(n) || n <= 0) throw httpError(400, `${k} must be a positive number.`)
    out[k] = k === 'rate_per_min' || k === 'days' ? Math.round(n) : n
  }
  return Object.keys(out).length ? out : undefined
}

function toId(s) {
  const n = Number(s)
  if (!Number.isInteger(n) || n <= 0) throw httpError(400, 'Not an id.')
  return n
}

function scrubbed(err, values) {
  const safe = Object.assign(new Error(String(err.message || '')), { status: err.status })
  for (const v of values) if (v) safe.message = safe.message.split(v).join('[hidden]')
  if (!err.status) safe.message = 'The vault could not save that secret.'
  return safe
}

function sameSecret(given, want) {
  if (typeof given !== 'string') return false
  const a = Buffer.from(given), b = Buffer.from(want)
  return a.length === b.length && timingSafeEqual(a, b)
}

function cookieValue(header, name) {
  for (const part of String(header || '').split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === name) return v.join('=')
  }
  return null
}

function parseOr(text, fallback) {
  try { return JSON.parse(text) } catch { return fallback }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', c => {
      data += c
      if (data.length > 64 * 1024) { reject(httpError(413, 'Body too large')); req.destroy() }
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

function parseJson(body) {
  try { return JSON.parse(body || '{}') ?? {} } catch { throw httpError(400, 'Body must be JSON') }
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
  res.end(JSON.stringify(obj))
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status })
}
