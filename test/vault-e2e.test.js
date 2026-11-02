// The whole vault, end to end: porch's main server with the vault mounted, the
// vault's own server, and stub OpenAI and Gemini upstreams on random ports.
// The owner sets up and adds keys on the page routes, an agent asks through MCP,
// the owner approves, the agent picks up its handle once and calls the proxy.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/db.js'
import { openVault } from '../src/vault/store.js'
import { createServer } from '../src/server.js'

const PLANTED = 'sk-PLANTED-SECRET-123'
const PLANTED_GEMINI = 'AIza-PLANTED-SECRET-456'
const PASS = 'correct horse battery'

let dir, store, vault, server, upstream, base, vbase, agentToken, ownerToken
const upstreamSaw = [] // what the stub providers received
const agentSaw = []    // every body and header an agent or outsider got back
const logs = []
const origLog = { log: console.log, error: console.error, warn: console.warn }
const st = {}          // state carried from step to step

// One stub for both providers. It answers with usage, and echoes the key it got
// so the test proves the proxy scrubs an echo.
function stubUpstream() {
  return http.createServer((req, res) => {
    let raw = ''
    req.on('data', c => { raw += c })
    req.on('end', () => {
      upstreamSaw.push({ url: req.url, headers: { ...req.headers }, body: raw })
      const body = JSON.parse(raw || '{}')
      const big = JSON.stringify(body).includes('spend a lot')
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'up=1', 'x-request-id': 'req_1' })
      if (req.url.startsWith('/v1/')) {
        const key = (req.headers.authorization || '').replace(/^Bearer /, '')
        return res.end(JSON.stringify({ id: 'chat_1', echo: key, choices: [{ message: { content: 'hi' } }], usage: { prompt_tokens: 10, completion_tokens: big ? 21000 : 20 } }))
      }
      res.end(JSON.stringify({ echo: req.headers['x-goog-api-key'], candidates: [{ content: { parts: [{ text: 'hi' }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20 } }))
    })
  })
}

const listen = (srv, port = 0) => new Promise(r => srv.listen(port, '127.0.0.1', r))

before(async () => {
  for (const k of Object.keys(origLog)) console[k] = (...a) => logs.push(a.map(String).join(' '))
  dir = mkdtempSync(join(tmpdir(), 'porch-vault-e2e-'))
  store = openDb(join(dir, 'porch.db'))
  ownerToken = store.addAgent('me')
  agentToken = store.addAgent('muse')
  vault = openVault(join(dir, 'vault.db'), { dpapi: false })
  upstream = stubUpstream()
  await listen(upstream)
  const up = `http://127.0.0.1:${upstream.address().port}`
  server = createServer(store, { log: true, vault, vaultPort: 0, vaultProxy: { upstream: { openai: up, gemini: up } } })
  await listen(server)
  if (!server.vault.listening) await new Promise(r => server.vault.once('listening', r))
  base = `http://127.0.0.1:${server.address().port}`
  vbase = `http://127.0.0.1:${server.vault.address().port}`
})

after(() => {
  Object.assign(console, origLog)
  server.close()
  server.closeAllConnections()
  upstream.close()
  upstream.closeAllConnections()
  vault.close()
  store.db.close?.()
  try { rmSync(dir, { recursive: true, force: true }) } catch {}
})

// Calls an agent (or an outsider) makes. Everything that comes back is kept for the scan.
async function seen(r) {
  const text = await r.text()
  agentSaw.push(text, JSON.stringify([...r.headers]))
  return { status: r.status, text, body: (() => { try { return JSON.parse(text) } catch { return null } })(), headers: r.headers }
}
const hub = (path, opts = {}) => fetch(base + path, {
  ...opts,
  headers: { Authorization: `Bearer ${agentToken}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...opts.headers },
}).then(seen)
const proxy = (path, handle, body, headers = {}) => fetch(vbase + path, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers, ...(handle ? { Authorization: `Bearer ${handle}` } : {}) }, body: JSON.stringify(body),
}).then(seen)

// The owner's page routes: a session cookie and the CSRF header.
let cookie = '', csrf = ''
async function page(path, method = 'GET', body) {
  const r = await fetch(vbase + path, {
    method, headers: { 'Content-Type': 'application/json', Cookie: cookie, 'x-vault-csrf': csrf }, body: body === undefined ? undefined : JSON.stringify(body),
  })
  const set = r.headers.get('set-cookie')
  if (set) cookie = set.split(';')[0]
  const out = await r.json().catch(() => null)
  if (out?.csrf) csrf = out.csrf
  return { status: r.status, body: out }
}

let rpcId = 0
async function mcp(name, args) {
  const r = await hub('/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }) })
  return { ...r, result: JSON.parse(r.body.result.content[0].text), isError: !!r.body.result.isError }
}

// A raw request, so the test can set Host and forwarding headers the way Funnel would.
function raw(port, path, headers, body = '') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: body ? 'POST' : 'GET', headers }, res => {
      let t = ''
      res.on('data', c => { t += c })
      res.on('end', () => { agentSaw.push(t, JSON.stringify(res.headers)); resolve({ status: res.statusCode, text: t }) })
    })
    req.on('error', reject)
    req.end(body)
  })
}

const SCOPE = { models: ['gpt-5-mini'], endpoints: ['chat/completions'] }
const BUDGET = { per_request_usd: 0.05, daily_usd: 0.05, total_usd: 0.2, rate_per_min: 30, days: 1 }
const chat = (text, max_tokens = 100) => ({ model: 'gpt-5-mini', max_tokens, messages: [{ role: 'user', content: text }] })

test('the owner sets up the vault and adds keys on the page', async () => {
  const html = await fetch(vbase + '/vault/')
  assert.equal(html.status, 200)
  assert.match(html.headers.get('content-security-policy'), /script-src 'sha256-/)
  assert.match(await html.text(), /<script>/)
  assert.deepEqual((await page('/vault/api/state')).body, { setUp: false, unlocked: false, session: false })
  const setup = await page('/vault/api/setup', 'POST', { passphrase: PASS })
  assert.equal(setup.status, 201)
  assert.ok(cookie && csrf)
  assert.equal((await page('/vault/api/secrets', 'POST', { name: 'openai-main', provider: 'openai', value: PLANTED })).status, 201)
  assert.equal((await page('/vault/api/secrets', 'POST', { name: 'gemini', provider: 'gemini', value: PLANTED_GEMINI })).status, 201)
  const state = await page('/vault/api/state')
  assert.deepEqual(state.body.secrets.map(s => s.name), ['gemini', 'openai-main'])
})

test('the vault routes are not on the main port, and agent tokens cannot approve', async () => {
  for (const p of ['/vault/', '/vault/api/state', '/vault/proxy/openai/v1/chat/completions']) {
    assert.equal((await hub(p)).status, 404, p)
  }
  assert.equal((await hub('/v1/vault/requests/1/decide', { method: 'POST', body: '{"approve":true}' })).status, 404)
})

test('an agent lists and asks through MCP, and the owner is told in the vault room', async () => {
  const tools = await hub('/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/list', params: {} }) })
  const names = tools.body.result.tools.map(t => t.name)
  for (const n of ['vault_list', 'vault_request', 'vault_status']) assert.ok(names.includes(n), n)
  assert.match(tools.text, new RegExp(`127\\.0\\.0\\.1:${server.vault.address().port}/vault/proxy`))

  const list = await mcp('vault_list', {})
  assert.deepEqual(list.result.secrets.map(s => s.name).sort(), ['gemini', 'openai-main'])
  assert.equal(list.result.proxy.openai, `${vbase}/vault/proxy/openai`)

  const req = await mcp('vault_request', { secret: 'openai-main', purpose: 'Summaries for the jobs room', scope: SCOPE, budget: BUDGET })
  assert.equal(req.isError, false)
  assert.equal(req.result.status, 'pending')
  st.openaiReq = req.result.id
  const waiting = await mcp('vault_status', { request_id: st.openaiReq })
  assert.equal(waiting.result.status, 'pending')
  assert.equal(waiting.result.handle, undefined)

  // The note is from "vault", in the vault room, for the owner, and only names numbers.
  const notes = store.list({ room: 'vault' })
  assert.equal(notes.length, 1)
  assert.equal(notes[0].from, 'vault')
  assert.deepEqual(notes[0].to, ['me'])
  assert.match(notes[0].text, /muse asks to use the vault key "openai-main"/)
  assert.match(notes[0].text, new RegExp(`127\\.0\\.0\\.1:${server.vault.address().port}/vault/`))

  // Nobody can register as the vault to forge these notes.
  assert.throws(() => store.addAgent('vault'), /kept for the hub/)

  // The same agent asks for Gemini over plain HTTP.
  const g = await hub('/v1/vault/requests', { method: 'POST', body: JSON.stringify({ secret: 'gemini', purpose: 'Look at photos', scope: { models: ['gemini-2.5-flash'], endpoints: ['generateContent'] }, budget: BUDGET }) })
  assert.equal(g.status, 201)
  st.geminiReq = g.body.id
})

test('the owner approves on the page; the page never sees the handle', async () => {
  const pending = (await page('/vault/api/state')).body.pending
  assert.deepEqual(pending.map(p => p.id).sort(), [st.openaiReq, st.geminiReq].sort())
  for (const id of [st.openaiReq, st.geminiReq]) {
    const d = await page(`/vault/api/requests/${id}/decide`, 'POST', { approve: true, note: 'ok' })
    assert.equal(d.status, 200)
    assert.ok(d.body.grant.id)
    assert.doesNotMatch(JSON.stringify(d.body), /pvh_/)
  }
  // Without the CSRF header, no decision.
  const saved = csrf
  csrf = ''
  assert.equal((await page(`/vault/api/requests/${st.openaiReq}/decide`, 'POST', { approve: true })).status, 403)
  csrf = saved
})

test('the agent gets its handle once', async () => {
  const s = await mcp('vault_status', { request_id: st.openaiReq })
  assert.equal(s.result.status, 'approved')
  assert.match(s.result.handle, /^pvh_[A-Za-z0-9_-]{43}$/)
  st.openaiHandle = s.result.handle
  const again = await mcp('vault_status', { request_id: st.openaiReq })
  assert.equal(again.result.handle, null)

  const g = await hub(`/v1/vault/requests/${st.geminiReq}`)
  assert.equal(g.headers.get('cache-control'), 'no-store')
  st.geminiHandle = g.body.handle
  assert.match(st.geminiHandle, /^pvh_/)
  assert.equal((await hub(`/v1/vault/requests/${st.geminiReq}`)).body.handle, null)

  // Another agent cannot see the request at all.
  const other = store.addAgent('grokbot')
  const r = await fetch(`${base}/v1/vault/requests/${st.openaiReq}`, { headers: { Authorization: `Bearer ${other}` } }).then(seen)
  assert.equal(r.status, 404)
})

test('the proxy adds the real key upstream and the agent never sees it', async () => {
  const before = upstreamSaw.length
  const r = await proxy('/vault/proxy/openai/v1/chat/completions', st.openaiHandle, chat('hello'))
  assert.equal(r.status, 200)
  assert.equal(r.body.choices[0].message.content, 'hi')
  assert.equal(r.body.echo, '[redacted]')
  assert.equal(r.headers.get('set-cookie'), null)
  const up = upstreamSaw.at(-1)
  assert.equal(upstreamSaw.length, before + 1)
  assert.equal(up.url, '/v1/chat/completions')
  assert.equal(up.headers.authorization, `Bearer ${PLANTED}`)
  assert.doesNotMatch(JSON.stringify(up), /pvh_/)

  // Gemini, with the handle as ?key= the way its SDKs send it.
  const gr = await proxy(`/vault/proxy/gemini/v1beta/models/gemini-2.5-flash:generateContent?key=${st.geminiHandle}`, null, { contents: [{ parts: [{ text: 'hi' }] }], generationConfig: { maxOutputTokens: 100 } })
  assert.equal(gr.status, 200)
  const gu = upstreamSaw.at(-1)
  assert.equal(gu.headers['x-goog-api-key'], PLANTED_GEMINI)
  assert.doesNotMatch(gu.url, /key=/)
  assert.doesNotMatch(JSON.stringify(gu), /pvh_/)

  // A handle for one provider does not open the other.
  assert.equal((await proxy('/vault/proxy/gemini/v1beta/models/gemini-2.5-flash:generateContent', st.openaiHandle, {})).status, 403)
})

test('spend is recorded, caps refuse, and a grant pauses at 80% and resumes', async () => {
  let g = (await page('/vault/api/state')).body.grants.find(x => x.request_id === st.openaiReq)
  assert.ok(g.spent > 0 && g.spent < 0.001, String(g.spent))

  // Per call: a large max_tokens estimate is over the $0.05 cap. Nothing goes upstream.
  const n = upstreamSaw.length
  const over = await proxy('/vault/proxy/openai/v1/chat/completions', st.openaiHandle, chat('hello', 100000))
  assert.equal(over.status, 402)
  assert.equal(over.body.reason, 'over_per_request_cap')
  // Out of scope model.
  const model = await proxy('/vault/proxy/openai/v1/chat/completions', st.openaiHandle, { ...chat('hello'), model: 'gpt-5-pro' })
  assert.equal(model.body.reason, 'model_not_in_scope')
  assert.equal(upstreamSaw.length, n)

  // A call that really costs $0.042 takes the grant past 80% of its daily cap.
  assert.equal((await proxy('/vault/proxy/openai/v1/chat/completions', st.openaiHandle, chat('spend a lot', 22000))).status, 200)
  g = (await page('/vault/api/state')).body.grants.find(x => x.request_id === st.openaiReq)
  assert.equal(g.status, 'paused')
  assert.ok(g.today >= 0.04)
  const alert = store.list({ room: 'vault' }).at(-1)
  assert.equal(alert.kind, 'alert')
  assert.equal(alert.priority, 'high')
  assert.match(alert.text, /80% of its daily cap/)
  assert.equal((await proxy('/vault/proxy/openai/v1/chat/completions', st.openaiHandle, chat('hello'))).body.reason, 'grant_paused')

  // The owner resumes it; the next call would cross the daily cap, so it is refused.
  assert.equal((await page(`/vault/api/grants/${g.id}/resume`, 'POST', {})).status, 200)
  const daily = await proxy('/vault/proxy/openai/v1/chat/completions', st.openaiHandle, chat('hello', 5000))
  assert.equal(daily.status, 402)
  assert.equal(daily.body.reason, 'over_daily_cap')
  st.openaiGrant = g.id
})

test('revoke stops the handle', async () => {
  assert.equal((await page(`/vault/api/grants/${st.openaiGrant}/revoke`, 'POST', {})).status, 200)
  const r = await proxy('/vault/proxy/openai/v1/chat/completions', st.openaiHandle, chat('hello'))
  assert.equal(r.status, 403)
  assert.equal(r.body.reason, 'unknown_handle')
  const list = await mcp('vault_list', {})
  assert.equal(list.result.grants.find(x => x.id === st.openaiGrant).status, 'revoked')
})

test('Funnel-style requests to the vault are refused', async () => {
  const port = server.vault.address().port
  const body = JSON.stringify(chat('hello'))
  for (const h of [
    { Host: `127.0.0.1:${port}`, 'X-Forwarded-For': '203.0.113.9' },
    { Host: `127.0.0.1:${port}`, 'Tailscale-Funnel-Request': '?1' },
    { Host: `127.0.0.1:${port}`, Forwarded: 'for=203.0.113.9' },
    { Host: 'my-laptop.tail1234.ts.net' },
    { Host: `127.0.0.1:${server.address().port}` },
  ]) {
    for (const path of ['/vault/', '/vault/api/state', '/vault/proxy/gemini/v1beta/models/gemini-2.5-flash:generateContent']) {
      const r = await raw(port, path, { ...h, 'Content-Type': 'application/json', 'x-goog-api-key': st.geminiHandle }, path.includes('proxy') ? body : '')
      assert.equal(r.status, 403, `${path} ${JSON.stringify(h)}`)
    }
  }
  // The same through the main port, as Funnel would forward it: no vault there.
  const r = await raw(server.address().port, '/vault/proxy/gemini/v1beta/models/gemini-2.5-flash:generateContent', { Host: 'my-laptop.tail1234.ts.net', 'X-Forwarded-For': '203.0.113.9', Authorization: `Bearer ${agentToken}` }, body)
  assert.equal(r.status, 404)
})

test('the audit chain verifies and has a row for every call', async () => {
  const v = await page('/vault/api/audit/verify')
  assert.deepEqual(v.body, { ok: true, brokenAt: null })
  const rows = (await page('/vault/api/audit?limit=500')).body
  const actions = rows.map(r => r.action)
  for (const a of ['vault.setup', 'secret.put', 'request.create', 'grant.create', 'proxy.call', 'proxy.refuse', 'grant.status', 'grant.revoke']) {
    assert.ok(actions.includes(a), a)
  }
  // Two openai calls and one gemini call went out.
  assert.equal(actions.filter(a => a === 'proxy.call').length, 3)
})

test('the planted keys never reach an agent, an outsider, a log, a porch message or porch.db', async () => {
  assert.ok(agentSaw.length > 40)
  for (const s of [...agentSaw, ...logs]) {
    assert.ok(!s.includes(PLANTED), s.slice(0, 200))
    assert.ok(!s.includes(PLANTED_GEMINI), s.slice(0, 200))
  }
  const msgs = JSON.stringify(store.list({ limit: 500 }))
  assert.ok(!msgs.includes(PLANTED) && !msgs.includes(PLANTED_GEMINI))
  assert.doesNotMatch(msgs, /pvh_/)
  for (const f of ['porch.db', 'porch.db-wal', 'vault.db', 'vault.db-wal']) {
    const p = join(dir, f)
    if (!existsSync(p)) continue
    const bytes = readFileSync(p).toString('latin1')
    assert.ok(!bytes.includes(PLANTED) && !bytes.includes(PLANTED_GEMINI), f)
    assert.ok(!bytes.includes(st.openaiHandle) && !bytes.includes(st.geminiHandle), f)
  }
  // Handles only ever reached the agent through vault_status, never a log line.
  for (const s of logs) assert.doesNotMatch(s, /pvh_/)
  // The stub providers did get the real keys.
  assert.ok(upstreamSaw.some(u => u.headers.authorization === `Bearer ${PLANTED}`))
})
