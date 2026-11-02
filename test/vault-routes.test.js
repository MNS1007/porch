import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { vaultServer } from '../src/vault/routes.js'

const PLANTED = 'sk-PLANTED-SECRET-123'
const HASH = 'f'.repeat(64)

// A stand-in for store.js that follows the CONTRACT.md interface.
function stubVault() {
  const v = {
    pass: null, open: false, secrets: new Map(), calls: [],
    rows: [
      { seq: 1, ts: '2026-11-01T00:00:00Z', actor: 'owner', action: 'setup', prev_hash: '0', hash: 'h1' },
      { seq: 2, ts: '2026-11-01T00:01:00Z', actor: 'claude-code', action: 'request.create', secret: 'gemini', request_id: 1, prev_hash: 'h1', hash: 'h2' },
    ],
    requests: [{ id: 1, agent: 'claude-code/vision', secret: 'gemini', purpose: '<img src=x onerror=alert(1)>', scope_json: '{"models":["gemini-robotics-er-2"]}', budget_json: '{"daily_usd":2}', status: 'pending', created: '2026-11-01T00:01:00Z' }],
    grantRows: [{ id: 7, request_id: 1, agent: 'anton', secret: 'gemini', scope_json: '{}', per_request_usd: 1, daily_usd: 2, total_usd: 5, rate_per_min: 30, spent_usd: 1.5, handle_hash: HASH, handle: 'pvh_shouldnotleak', expires: '2026-11-09T00:00:00Z', status: 'paused', created: '2026-11-01T00:00:00Z' }],
    isSetUp: () => v.pass != null,
    setUp(p) { v.pass = p },
    unlock(p) { v.open = p === v.pass; return v.open },
    lock() { v.open = false },
    unlocked: () => v.open,
    putSecret(name, provider, value, actor) {
      if (name === 'boom') throw new Error(`could not store ${value}`)
      v.secrets.set(name, { name, provider, value, created: '2026-11-01' }); v.calls.push(['put', name, actor])
    },
    listSecrets: () => [...v.secrets.values()].map(s => ({ ...s })), // a careless store that leaks the value
    deleteSecret(name, actor) { v.secrets.delete(name); v.calls.push(['delete', name, actor]) },
    useSecret: (name, fn) => fn(v.secrets.get(name)?.value),
    listRequests: ({ status }) => v.requests.filter(r => r.status === status),
    decide(id, d, actor) {
      v.calls.push(['decide', id, d, actor])
      return d.approve ? { grant: { ...v.grantRows[0], id: 8 }, handle: 'pvh_' + 'a'.repeat(43) } : {}
    },
    grants: () => v.grantRows.map(g => ({ ...g })),
    spentToday: () => 0.25,
    revoke(id, actor) { v.calls.push(['revoke', id, actor]) },
    setStatus(id, status, actor) { v.calls.push(['status', id, status, actor]) },
    audit: ({ limit }) => v.rows.slice(-limit),
    verifyAudit: () => ({ ok: true, brokenAt: null }),
  }
  return v
}

let vault, server, port, clock = 1_000_000, proxied = []
const seen = [] // every body and header the server sent, plus every log line
const origLog = { log: console.log, error: console.error, warn: console.warn }

before(async () => {
  for (const k of Object.keys(origLog)) console[k] = (...a) => { seen.push(a.join(' ')); origLog[k](...a) }
  vault = stubVault()
  server = vaultServer({
    vault, port: 0, idleMs: 1000, now: () => clock,
    handleProxy: (req, res, v, opts) => { proxied.push({ v, opts }); res.writeHead(200); res.end('proxied') },
  })
  await new Promise(r => server.listen(0, r))
  port = server.address().port
})

after(() => {
  Object.assign(console, origLog)
  server.close()
})

// node:http so the test can set Host and forwarding headers freely.
function call(path, { method = 'GET', headers = {}, body, cookie, csrf } = {}) {
  const h = { host: `127.0.0.1:${port}`, 'content-type': 'application/json', ...headers }
  if (cookie) h.cookie = cookie
  if (csrf) h['x-vault-csrf'] = csrf
  for (const k of Object.keys(h)) if (h[k] === undefined) delete h[k]
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: h, setHost: !!h.host }, res => {
      let data = ''
      res.on('data', c => { data += c })
      res.on('end', () => {
        seen.push(JSON.stringify(res.headers), data)
        let json = null
        try { json = JSON.parse(data) } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text: data, json })
      })
    })
    req.on('error', reject)
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body))
    req.end()
  })
}

async function login() {
  const r = await call('/vault/session', { method: 'POST', body: { passphrase: 'correct horse battery' } })
  assert.equal(r.status, 200)
  return { cookie: r.headers['set-cookie'][0].split(';')[0], csrf: r.json.csrf }
}

test('binds to 127.0.0.1 only', () => {
  assert.equal(server.address().address, '127.0.0.1')
})

test('setup needs no session, then refuses a second time', async () => {
  const before = await call('/vault/api/state')
  assert.deepEqual(before.json, { setUp: false, unlocked: false, session: false })
  assert.equal((await call('/vault/session', { method: 'POST', body: { passphrase: 'x' } })).status, 409)
  assert.equal((await call('/vault/api/setup', { method: 'POST', body: { passphrase: 'short' } })).status, 400)
  const r = await call('/vault/api/setup', { method: 'POST', body: { passphrase: 'correct horse battery' } })
  assert.equal(r.status, 201)
  assert.ok(r.json.csrf)
  const cookie = r.headers['set-cookie'][0]
  assert.match(cookie, /HttpOnly/)
  assert.match(cookie, /SameSite=Strict/)
  assert.doesNotMatch(cookie, /Max-Age|Expires/) // the server's idle clock is the only one
  assert.match(cookie, /^porch_vault=[A-Za-z0-9_-]{43};/)
  assert.equal((await call('/vault/api/setup', { method: 'POST', body: { passphrase: 'another long one' } })).status, 409)
})

test('forwarded headers are refused on every path, proxy included', async () => {
  const bad = [
    { 'x-forwarded-for': '1.2.3.4' }, { forwarded: 'for=1.2.3.4' }, { 'x-forwarded-host': 'evil.ts.net' },
    { 'x-real-ip': '1.2.3.4' }, { 'tailscale-user-login': 'someone@example.com' }, { 'Tailscale-Funnel-Request': '1' },
  ]
  const { cookie } = await login()
  for (const path of ['/vault/', '/vault/api/state', '/vault/proxy/openai/v1/chat/completions']) {
    for (const headers of bad) {
      const r = await call(path, { headers, cookie })
      assert.equal(r.status, 403, `${path} ${JSON.stringify(headers)}`)
    }
  }
  assert.equal(proxied.length, 0)
})

test('a Host other than 127.0.0.1:<port> or localhost:<port> is refused', async () => {
  for (const host of ['example.com', `127.0.0.1:${port + 1}`, `evil.ts.net:${port}`, '127.0.0.1', `localhost:${port}.evil.com`, undefined]) {
    const r = await call('/vault/api/state', { headers: { host } })
    // Node itself answers 400 to an HTTP/1.1 request with no Host at all.
    assert.equal(r.status, host === undefined ? 400 : 403, String(host))
  }
  assert.equal((await call('/vault/api/state', { headers: { host: `localhost:${port}` } })).status, 200)
  assert.equal((await call('/vault/api/state')).status, 200)
})

test('the proxy is handed the request and the vault, with no page session', async () => {
  const r = await call('/vault/proxy/gemini/v1beta/models/x:generateContent', { method: 'POST', body: {} })
  assert.equal(r.status, 200)
  assert.equal(r.text, 'proxied')
  assert.equal(proxied.length, 1)
  assert.equal(proxied[0].v, vault)
  assert.equal(typeof proxied[0].opts.fetchFn, 'function')
  assert.equal(typeof proxied[0].opts.notify, 'function')
})

const ownerRoutes = [
  ['GET', '/vault/api/audit'],
  ['GET', '/vault/api/audit/verify'],
  ['POST', '/vault/api/secrets', { name: 'openai-main', provider: 'openai', value: PLANTED }],
  ['DELETE', '/vault/api/secrets/nothing'],
  ['POST', '/vault/api/requests/1/decide', { approve: false }],
  ['POST', '/vault/api/grants/7/revoke'],
  ['POST', '/vault/api/grants/7/resume'],
  ['DELETE', '/vault/session'],
]

test('every owner route needs the session cookie', async () => {
  for (const [method, path, body] of ownerRoutes) {
    assert.equal((await call(path, { method, body })).status, 401, `${method} ${path}`)
    assert.equal((await call(path, { method, body, cookie: 'porch_vault=made-up' })).status, 401, `${method} ${path}`)
  }
  assert.equal(vault.calls.length, 0)
})

test('every owner POST and DELETE also needs the CSRF header', async () => {
  const { cookie, csrf } = await login()
  const other = await login()
  for (const [method, path, body] of ownerRoutes) {
    if (method === 'GET') {
      assert.equal((await call(path, { method, cookie })).status, 200, path)
      continue
    }
    assert.equal((await call(path, { method, body, cookie })).status, 403, `${method} ${path}`)
    assert.equal((await call(path, { method, body, cookie, csrf: 'wrong' })).status, 403, `${method} ${path}`)
    // Another session's token does not work with this cookie.
    assert.equal((await call(path, { method, body, cookie, csrf: other.csrf })).status, 403, `${method} ${path}`)
  }
  assert.equal(vault.calls.length, 0)
  // A cross-site Origin is refused even with both.
  const r = await call('/vault/api/grants/7/revoke', { method: 'POST', cookie, csrf, headers: { origin: 'https://evil.example' } })
  assert.equal(r.status, 403)
  assert.equal(vault.calls.length, 0)
})

test('owner routes work with session and CSRF', async () => {
  const s = await login()
  const put = await call('/vault/api/secrets', { method: 'POST', body: { name: 'openai-main', provider: 'openai', value: PLANTED }, ...s })
  assert.equal(put.status, 201)
  assert.deepEqual(put.json, { ok: true, name: 'openai-main', provider: 'openai' })
  assert.equal(vault.secrets.get('openai-main').value, PLANTED)

  const d = await call('/vault/api/requests/1/decide', { method: 'POST', body: { approve: true, note: 'ok', changes: { daily_usd: '1.5', days: 3, bogus: 9 } }, ...s })
  assert.equal(d.status, 200)
  assert.equal(d.json.grant.id, 8)
  assert.equal(d.text.includes('pvh_'), false)
  assert.equal(d.text.includes(HASH), false)
  assert.deepEqual(vault.calls.at(-1), ['decide', 1, { approve: true, note: 'ok', changes: { daily_usd: 1.5, days: 3 } }, 'owner'])
  assert.equal((await call('/vault/api/requests/1/decide', { method: 'POST', body: { approve: true, changes: { daily_usd: -1 } }, ...s })).status, 400)

  assert.equal((await call('/vault/api/grants/7/revoke', { method: 'POST', ...s })).status, 200)
  assert.deepEqual(vault.calls.at(-1), ['revoke', 7, 'owner'])
  assert.equal((await call('/vault/api/grants/7/resume', { method: 'POST', ...s })).status, 200)
  assert.deepEqual(vault.calls.at(-1), ['status', 7, 'active', 'owner'])

  const audit = await call('/vault/api/audit?limit=1', s)
  assert.deepEqual(audit.json.map(a => a.seq), [2])
  assert.deepEqual((await call('/vault/api/audit/verify', s)).json, { ok: true, brokenAt: null })
})

test('state never includes secret values or handle hashes', async () => {
  const s = await login()
  const r = await call('/vault/api/state', s)
  assert.equal(r.status, 200)
  assert.equal(r.json.setUp, true)
  assert.equal(r.json.session, true)
  assert.deepEqual(Object.keys(r.json.secrets[0]).sort(), ['created', 'name', 'provider', 'rotated'])
  assert.equal(r.json.pending[0].purpose, '<img src=x onerror=alert(1)>')
  assert.deepEqual(r.json.pending[0].scope, { models: ['gemini-robotics-er-2'] })
  const g = r.json.grants[0]
  assert.equal(g.spent, 1.5)
  assert.equal(g.today, 0.25)
  assert.equal(g.status, 'paused')
  assert.equal('handle_hash' in g || 'handle' in g, false)
  assert.equal(r.json.auditHead.seq, 2)
  for (const bad of [PLANTED, HASH, 'pvh_', 'handle_hash', 'ciphertext']) assert.equal(r.text.includes(bad), false, bad)
})

test('a bad passphrase gets no session and backs off after five tries', async () => {
  for (let i = 0; i < 5; i++) assert.equal((await call('/vault/session', { method: 'POST', body: { passphrase: 'wrong' } })).status, 401)
  assert.equal((await call('/vault/session', { method: 'POST', body: { passphrase: 'wrong' } })).status, 429)
  clock += 61 * 1000
  assert.equal((await call('/vault/session', { method: 'POST', body: { passphrase: 'correct horse battery' } })).status, 200)
})

test('a session expires after the idle timeout, and use keeps it alive', async () => {
  const s = await login()
  clock += 800
  assert.equal((await call('/vault/api/audit', s)).status, 200)
  clock += 800 // 1600 since login, 800 since last use
  assert.equal((await call('/vault/api/audit', s)).status, 200)
  clock += 1001
  assert.equal((await call('/vault/api/audit', s)).status, 401)
  assert.equal((await call('/vault/api/state', s)).json.session, false)
  // Signing out ends the session at once.
  const t = await login()
  assert.equal((await call('/vault/session', { method: 'DELETE', ...t })).status, 200)
  assert.equal((await call('/vault/api/audit', t)).status, 401)
})

test('the page loads with a strict content policy', async () => {
  for (const path of ['/vault/', '/vault']) {
    const r = await call(path)
    assert.equal(r.status, 200)
    assert.match(r.headers['content-type'], /text\/html/)
    assert.match(r.text, /porch vault/)
    const csp = r.headers['content-security-policy']
    assert.match(csp, /default-src 'none'/)
    assert.match(csp, /script-src 'sha256-/)
    assert.match(csp, /frame-ancestors 'none'/)
    assert.equal(r.headers['x-frame-options'], 'DENY')
  }
  const page = (await call('/vault/')).text
  assert.equal(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(page), false)
  assert.equal(/https?:\/\//.test(page.replace(/http:\/\/127\.0\.0\.1:<port>/g, '')), false, 'page loads nothing from elsewhere')
})

test('unknown routes 404 and bad bodies do not echo the key', async () => {
  const s = await login()
  assert.equal((await call('/vault/api/nope', s)).status, 404)
  assert.equal((await call('/elsewhere')).status, 404)
  const badName = await call('/vault/api/secrets', { method: 'POST', body: { name: 'Bad Name', provider: 'openai', value: PLANTED }, ...s })
  assert.equal(badName.status, 400)
  const badProvider = await call('/vault/api/secrets', { method: 'POST', body: { name: 'ok', provider: 'anthropic', value: PLANTED }, ...s })
  assert.equal(badProvider.status, 400)
  const broken = await call('/vault/api/secrets', { method: 'POST', body: `{"name":"x","value":"${PLANTED}"`, ...s })
  assert.equal(broken.status, 400)
  // The store throws with the value in its message; the route must not pass it on.
  const boom = await call('/vault/api/secrets', { method: 'POST', body: { name: 'boom', provider: 'openai', value: PLANTED }, ...s })
  assert.equal(boom.status, 400)
  assert.equal(boom.text.includes(PLANTED), false)
})

test('the planted secret never appeared in any response, header or log', () => {
  assert.ok(seen.length > 50)
  for (const line of seen) {
    assert.equal(line.includes(PLANTED), false, line)
    assert.equal(line.includes(HASH), false, line)
    assert.equal(line.includes('pvh_shouldnotleak'), false, line)
  }
})
