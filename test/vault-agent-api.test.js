import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes, createHash } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { openDb } from '../src/db.js'
import { vaultAgentApi } from '../src/vault/agent-api.js'
import { handleVaultHttp } from '../src/vault/http.js'
import { registerVaultTools } from '../src/vault/mcp-tools.js'

const PLANTED = 'sk-PLANTED-SECRET-123'

// A stand-in for store.js, built from CONTRACT.md. It holds a planted key value
// so the tests can prove it never comes out.
function stubVault() {
  const secrets = new Map([['gemini', { provider: 'gemini', value: PLANTED }], ['openai-main', { provider: 'openai', value: PLANTED }]])
  const requests = []
  const grants = []
  const now = () => new Date().toISOString()
  const hash = h => createHash('sha256').update(h).digest('hex')
  return {
    listSecrets: () => [...secrets].map(([name, s]) => ({ name, provider: s.provider, created: now(), rotated: null })),
    useSecret: (name, fn) => fn(secrets.get(name).value),
    createRequest({ agent, secret, purpose, scope, budget, replaces_grant }) {
      const row = { id: requests.length + 1, agent, secret, purpose, scope_json: JSON.stringify(scope), budget_json: JSON.stringify(budget), replaces_grant: replaces_grant ?? null, status: 'pending', created: now(), decided_at: null, decision_note: null }
      requests.push(row)
      return { ...row }
    },
    listRequests: ({ status } = {}) => requests.filter(r => !status || r.status === status).map(r => ({ ...r })),
    decide(id, { approve, note }) {
      const r = requests.find(x => x.id === id)
      r.status = approve ? 'approved' : 'denied'
      r.decided_at = now()
      r.decision_note = note || null
      if (!approve) return {}
      const handle = 'pvh_' + randomBytes(32).toString('base64url')
      const b = JSON.parse(r.budget_json)
      const g = { id: grants.length + 1, request_id: id, agent: r.agent, secret: r.secret, scope_json: r.scope_json, per_request_usd: b.per_request_usd, daily_usd: b.daily_usd, total_usd: b.total_usd, rate_per_min: b.rate_per_min, spent_usd: 0, handle_hash: hash(handle), expires: new Date(Date.now() + b.days * 864e5).toISOString(), status: 'active', created: now() }
      grants.push(g)
      const { handle_hash, ...shown } = g
      return { grant: shown, handle }
    },
    grants: ({ agent } = {}) => grants.filter(g => !agent || g.agent === agent).map(({ handle_hash, ...g }) => g),
    grantForHandle(handle) {
      const g = grants.find(x => x.handle_hash === hash(handle))
      if (!g || g.status === 'revoked') return null
      const { handle_hash, ...shown } = g
      return shown
    },
    revoke(id) { grants.find(g => g.id === id).status = 'revoked' },
  }
}

let dir, store, vault, api, server, base, notes, seen, logs, restoreLog
let me, muse, other, anton, viewer

const ask = {
  secret: 'gemini', purpose: 'Label robot camera frames',
  scope: { models: ['gemini-robotics-er-2'], endpoints: ['generateContent'] },
  budget: { per_request_usd: 1, daily_usd: 2, total_usd: 5, rate_per_min: 30, days: 7 },
}

before(async () => {
  // Catch every log line, to prove the planted value is never printed.
  logs = []
  const orig = { log: console.log, error: console.error, warn: console.warn }
  for (const k of Object.keys(orig)) console[k] = (...a) => { logs.push(a.join(' ')); orig[k](...a) }
  restoreLog = () => Object.assign(console, orig)

  dir = mkdtempSync(join(tmpdir(), 'porch-vault-agent-'))
  store = openDb(join(dir, 'test.db'))
  me = store.addAgent('me')
  muse = store.addAgent('muse', { rooms: ['research'] })
  other = store.addAgent('other-bot')
  anton = store.addAgent('anton', { rooms: ['anton'] })
  viewer = store.addAgent('viewer', { canPost: false })
  store.setActs('anton', ['claude-code/*'])
  store.addMember(store.agentForToken(anton), 'claude-code/main')

  vault = stubVault()
  notes = []
  api = vaultAgentApi(vault, { notify: n => notes.push(n), store, port: 7778 })

  server = http.createServer(async (req, res) => {
    const auth = req.headers.authorization || ''
    const agent = store.agentForToken(auth.slice(7))
    if (!agent) { res.writeHead(401); return res.end('{}') }
    if (req.url === '/mcp') {
      let body = ''
      for await (const c of req) body += c
      const mcp = new McpServer({ name: 'test', version: '0' })
      registerVaultTools(mcp, agent, api)
      const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
      res.on('close', () => { t.close(); mcp.close() })
      await mcp.connect(t)
      return t.handleRequest(req, res, JSON.parse(body))
    }
    if (await handleVaultHttp(req, res, agent, api)) return
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Not found' }))
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}`
  seen = []
})

after(() => {
  restoreLog()
  server.close()
  try { rmSync(dir, { recursive: true, force: true }) } catch {}
})

// Every answer body is kept, to check for the planted value at the end.
async function call(method, path, token, body) {
  const r = await fetch(base + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  })
  const text = await r.text()
  seen.push(text)
  return { status: r.status, headers: r.headers, body: text ? JSON.parse(text) : null }
}

async function tool(token, name, args) {
  const r = await call('POST', '/mcp', token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
  const result = r.body.result
  return { isError: !!result.isError, data: JSON.parse(result.content[0].text) }
}

// What routes.js does on approval, plus the wiring step's hand-off.
function ownerApproves(id) {
  const { handle } = vault.decide(id, { approve: true, note: 'ok' }, 'me')
  api.hold(id, handle)
  return handle
}

test('list: names and providers, no values, no handles, only your own grants', async () => {
  const r = await call('GET', '/v1/vault', muse)
  assert.equal(r.status, 200)
  assert.deepEqual(r.body.secrets, [{ name: 'gemini', provider: 'gemini' }, { name: 'openai-main', provider: 'openai' }])
  assert.deepEqual(r.body.grants, [])
  assert.equal(r.body.proxy.gemini, 'http://127.0.0.1:7778/vault/proxy/gemini')
})

test('request: pending, owner gets a DM note, a status in the body is ignored', async () => {
  const r = await call('POST', '/v1/vault/requests', muse, { ...ask, status: 'approved', decided_at: 'now' })
  assert.equal(r.status, 201)
  assert.equal(r.body.status, 'pending')
  assert.equal(r.body.agent, 'muse')
  assert.equal(vault.listRequests({ status: 'approved' }).length, 0)
  const note = notes.at(-1)
  assert.equal(note.request_id, r.body.id)
  assert.match(note.text, /muse asks to use the vault key "gemini" \(gemini\)/)
  assert.match(note.text, /\$1 a call, \$2 a day, \$5 in all, 30 calls a minute, for 7 days/)
  assert.match(note.text, /vault page/)
  const s = await call('GET', `/v1/vault/requests/${r.body.id}`, muse)
  assert.equal(s.body.status, 'pending')
  assert.equal(s.body.handle, undefined)
})

test('status: the handle goes once, to the requesting agent only', async () => {
  const id = (await call('POST', '/v1/vault/requests', muse, ask)).body.id
  const handle = ownerApproves(id)
  // Another agent, and the owner's porch token, see nothing at all.
  assert.equal((await call('GET', `/v1/vault/requests/${id}`, other)).status, 404)
  assert.equal((await call('GET', `/v1/vault/requests/${id}`, me)).status, 404)
  assert.equal((await call('GET', `/v1/vault/requests/${id}`, anton)).status, 404)
  const first = await call('GET', `/v1/vault/requests/${id}`, muse)
  assert.equal(first.status, 200)
  assert.equal(first.body.status, 'approved')
  assert.equal(first.body.handle, handle)
  assert.equal(first.body.proxy, 'http://127.0.0.1:7778/vault/proxy/gemini')
  assert.equal(first.body.grant.daily_usd, 2)
  assert.equal(first.body.grant.handle_hash, undefined)
  assert.equal(first.headers.get('cache-control'), 'no-store')
  const second = await call('GET', `/v1/vault/requests/${id}`, muse)
  assert.equal(second.body.status, 'approved')
  assert.equal(second.body.handle, null)
  // The grant now shows in muse's list, never in another agent's, and never with a handle.
  const mine = await call('GET', '/v1/vault', muse)
  assert.ok(mine.body.grants.some(g => g.request_id === id))
  assert.ok(!JSON.stringify(mine.body).includes(handle))
  const theirs = await call('GET', '/v1/vault', other)
  assert.deepEqual(theirs.body.grants, [])
  assert.deepEqual(theirs.body.requests, [])
  // Nobody can read muse's list through "as".
  assert.equal((await call('GET', '/v1/vault?as=muse', other)).status, 403)
})

test('a manager asks for a member it speaks for, and picks up the handle', async () => {
  const r = await call('POST', '/v1/vault/requests', anton, { ...ask, as: 'claude-code/main' })
  assert.equal(r.status, 201)
  assert.equal(r.body.agent, 'claude-code/main')
  assert.match(notes.at(-1).text, /^anton for claude-code\/main asks/)
  // Not for a member it did not register, and no one else may act for its member.
  assert.equal((await call('POST', '/v1/vault/requests', anton, { ...ask, as: 'claude-code/other' })).status, 403)
  assert.equal((await call('POST', '/v1/vault/requests', muse, { ...ask, as: 'claude-code/main' })).status, 403)
  const handle = ownerApproves(r.body.id)
  assert.equal((await call('GET', `/v1/vault/requests/${r.body.id}`, muse)).status, 404)
  const s = await call('GET', `/v1/vault/requests/${r.body.id}`, anton)
  assert.equal(s.body.handle, handle)
  const listed = await call('GET', '/v1/vault?as=claude-code/main', anton)
  assert.equal(listed.body.grants.length, 1)
  // Anton's own list does not mix in its member's grants.
  assert.deepEqual((await call('GET', '/v1/vault', anton)).body.grants, [])
})

test('nothing here can approve: no decide route, no decide tool, held handles only for live grants', async () => {
  const id = (await call('POST', '/v1/vault/requests', other, { ...ask, secret: 'openai-main', scope: { models: ['gpt-5.4-mini'], endpoints: ['chat/completions'] } })).body.id
  for (const [method, path] of [['POST', `/v1/vault/requests/${id}/decide`], ['POST', `/v1/vault/requests/${id}`], ['PUT', `/v1/vault/requests/${id}`], ['POST', '/v1/vault/grants/1/revoke'], ['POST', '/vault/api/requests/1/decide']]) {
    assert.equal((await call(method, path, me, { approve: true })).status, 404, `${method} ${path}`)
  }
  assert.equal(vault.listRequests({}).find(r => r.id === id).status, 'pending')
  const tools = (await call('POST', '/mcp', me, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })).body.result.tools.map(t => t.name)
  assert.deepEqual(tools.sort(), ['vault_list', 'vault_request', 'vault_status'])
  // A fake handle planted through hold() for a pending request is never handed out.
  api.hold(id, 'pvh_fake')
  assert.equal((await call('GET', `/v1/vault/requests/${id}`, other)).body.handle, undefined)
  // A real handle for a revoked grant is not handed out either.
  const handle = ownerApproves(id)
  vault.revoke(vault.grants({ agent: 'other-bot' })[0].id)
  const s = await call('GET', `/v1/vault/requests/${id}`, other)
  assert.equal(s.body.handle, null)
  assert.ok(!seen.join('').includes(handle))
  // A handle held under the wrong request id does not open it.
  const id2 = (await call('POST', '/v1/vault/requests', other, ask)).body.id
  const h2 = vault.decide(id2, { approve: true }, 'me').handle
  const id3 = (await call('POST', '/v1/vault/requests', other, ask)).body.id
  vault.decide(id3, { approve: true }, 'me')
  api.hold(id3, h2)
  assert.equal((await call('GET', `/v1/vault/requests/${id3}`, other)).body.handle, null)
})

test('requests are checked: post right, real key, scope, caps, own grant, pending cap', async () => {
  assert.equal((await call('POST', '/v1/vault/requests', viewer, ask)).status, 403)
  assert.equal((await call('POST', '/v1/vault/requests', muse, { ...ask, secret: 'nope' })).status, 404)
  assert.equal((await call('POST', '/v1/vault/requests', muse, { ...ask, scope: { models: [] } })).status, 400)
  assert.equal((await call('POST', '/v1/vault/requests', muse, { ...ask, budget: { ...ask.budget, daily_usd: -1 } })).status, 400)
  assert.equal((await call('POST', '/v1/vault/requests', muse, { ...ask, budget: { ...ask.budget, per_request_usd: 3 } })).status, 400)
  assert.equal((await call('POST', '/v1/vault/requests', muse, { ...ask, replaces_grant: 999 })).status, 404)
  const museGrant = (await call('GET', '/v1/vault', muse)).body.grants[0].id
  assert.equal((await call('POST', '/v1/vault/requests', other, { ...ask, replaces_grant: museGrant })).status, 404)
  assert.equal((await call('POST', '/v1/vault/requests', muse, { ...ask, replaces_grant: museGrant })).status, 201)
  assert.equal((await call('POST', '/v1/vault/requests', muse, 'not json')).status, 400)
  const fresh = store.addAgent('spammer')
  for (let i = 0; i < 5; i++) assert.equal((await call('POST', '/v1/vault/requests', fresh, ask)).status, 201)
  assert.equal((await call('POST', '/v1/vault/requests', fresh, ask)).status, 429)
})

test('MCP tools: same rules, descriptions say keys are never returned', async () => {
  const list = (await call('POST', '/mcp', muse, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })).body.result.tools
  for (const t of list) {
    assert.match(t.description, /never returned/)
    assert.match(t.description, /http:\/\/127\.0\.0\.1:7778\/vault\/proxy\/<provider>/)
  }
  const r = await tool(muse, 'vault_request', { ...ask, secret: 'openai-main', scope: { models: ['gpt-5.4-mini'], endpoints: ['chat/completions'] } })
  assert.equal(r.data.status, 'pending')
  assert.equal((await tool(other, 'vault_status', { request_id: r.data.id })).isError, true)
  const handle = ownerApproves(r.data.id)
  assert.equal((await tool(muse, 'vault_status', { request_id: r.data.id })).data.handle, handle)
  assert.equal((await tool(muse, 'vault_status', { request_id: r.data.id })).data.handle, null)
  const l = await tool(muse, 'vault_list', {})
  assert.ok(l.data.grants.length >= 2)
  assert.equal((await tool(other, 'vault_list', { as: 'muse' })).isError, true)
})

test('a broken notify never loses the request or leaks', async () => {
  const quiet = vaultAgentApi(vault, { notify: () => { throw new Error(PLANTED) }, store })
  const row = quiet.request(store.agentForToken(muse), { ...ask })
  assert.equal(row.status, 'pending')
  const asyncFail = vaultAgentApi(vault, { notify: async () => { throw new Error(PLANTED) }, store })
  assert.equal(asyncFail.request(store.agentForToken(other), { ...ask }).status, 'pending')
})

test('errors never echo what the agent sent', async () => {
  const r = await call('POST', '/v1/vault/requests', muse, { ...ask, purpose: `use ${PLANTED}`, scope: { models: [PLANTED + ' x'], endpoints: ['a'] } })
  assert.equal(r.status, 400)
  assert.ok(!JSON.stringify(r.body).includes(PLANTED))
  const s = await call('POST', '/v1/vault/requests', muse, { ...ask, secret: PLANTED })
  assert.ok(!JSON.stringify(s.body).includes(PLANTED))
  for (const r of [await call('POST', '/v1/vault/requests', anton, { ...ask, as: PLANTED }), await call('GET', `/v1/vault?as=${PLANTED}`, anton)]) {
    assert.equal(r.status, 403)
    assert.ok(!JSON.stringify(r.body).includes(PLANTED))
  }
})

test('against the real store.js: request, approve, handle once, planted value stays inside', async () => {
  const { openVault } = await import('../src/vault/store.js')
  const real = openVault(join(dir, 'vault.db'))
  real.setUp('a long test passphrase')
  if (!real.unlocked()) real.unlock('a long test passphrase')
  real.putSecret('gemini', 'gemini', PLANTED, 'me')
  const realNotes = []
  const a = vaultAgentApi(real, { notify: n => realNotes.push(n), store, port: 7778 })
  const museAgent = store.agentForToken(muse)
  const row = a.request(museAgent, ask)
  assert.equal(a.status(museAgent, row.id).status, 'pending')
  const { handle } = real.decide(row.id, { approve: true }, 'me')
  a.hold(row.id, handle)
  assert.throws(() => a.status(store.agentForToken(other), row.id), e => e.status === 404)
  const first = a.status(museAgent, row.id)
  assert.equal(first.handle, handle)
  assert.equal(first.provider, 'gemini')
  assert.equal(first.grant.request_id, row.id)
  assert.equal(a.status(museAgent, row.id).handle, null)
  const listed = a.list(museAgent)
  assert.equal(listed.requests[0].id, row.id)
  assert.equal(listed.grants.length, 1)
  const out = JSON.stringify([row, first, listed, realNotes, a.list(store.agentForToken(other))])
  assert.ok(!out.includes(PLANTED))
  assert.ok(!JSON.stringify(listed).includes(handle))
  assert.ok(!out.includes(createHash('sha256').update(handle).digest('hex')))
  // Revoked by the owner: a handle held again is not handed out.
  real.revoke(first.grant.id, 'me')
  a.hold(row.id, handle)
  assert.equal(a.status(museAgent, row.id).handle, null)
})

test('the planted key value never appears in any answer, note or log line', async () => {
  const out = [...seen, ...notes.map(n => JSON.stringify(n)), ...logs].join('\n')
  assert.ok(seen.length > 30)
  assert.ok(!out.includes(PLANTED), 'planted value leaked')
})
