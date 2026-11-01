import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/db.js'
import { createServer } from '../src/server.js'

let dir, store, server, base, anton, grok, reader

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'porch-'))
  store = openDb(join(dir, 'test.db'))
  anton = store.addAgent('anton')
  grok = store.addAgent('grokbot', { rooms: ['jobs'] })
  reader = store.addAgent('viewer', { canPost: false })
  server = createServer(store, { log: false })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}`
})

after(() => {
  server.close()
  try { rmSync(dir, { recursive: true, force: true }) } catch {}
})

const call = (path, token, opts = {}) => fetch(base + path, {
  ...opts,
  headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...opts.headers },
})

test('rejects requests without a valid token', async () => {
  assert.equal((await call('/v1/messages')).status, 401)
  assert.equal((await call('/v1/messages', 'porch_wrong')).status, 401)
})

test('posts and reads back, sender comes from the token', async () => {
  const r = await call('/v1/messages', anton, { method: 'POST', body: JSON.stringify({ text: 'Robotics startup Foo raised $20M', room: 'news', from: 'someone-else', priority: 'high' }) })
  assert.equal(r.status, 201)
  const m = await r.json()
  assert.equal(m.from, 'anton')
  assert.equal(m.room, 'news')
  const list = await (await call('/v1/messages?room=news', anton)).json()
  assert.equal(list.at(-1).text, 'Robotics startup Foo raised $20M')
})

test('room limits and read-only tokens are enforced', async () => {
  assert.equal((await call('/v1/messages', grok, { method: 'POST', body: JSON.stringify({ text: 'hi', room: 'news' }) })).status, 403)
  assert.equal((await call('/v1/messages', grok, { method: 'POST', body: JSON.stringify({ text: 'Applied to 3 robotics jobs', room: 'jobs' }) })).status, 201)
  const seen = await (await call('/v1/messages', grok)).json()
  assert.ok(seen.every(m => m.room === 'jobs'))
  assert.equal((await call('/v1/messages', reader, { method: 'POST', body: JSON.stringify({ text: 'x' }) })).status, 403)
})

test('full-text search finds partial words', async () => {
  const hits = await (await call('/v1/messages?q=robot', anton)).json()
  assert.ok(hits.length >= 2)
})

test('inbox accepts plain text with an API key header', async () => {
  const r = await fetch(base + '/v1/inbox?room=briefings', { method: 'POST', headers: { 'X-API-Key': anton, 'Content-Type': 'text/plain' }, body: 'Morning briefing: three new humanoid companies.' })
  assert.equal(r.status, 201)
  const m = await r.json()
  assert.equal(m.kind, 'briefing')
  assert.equal(m.room, 'briefings')
})

test('stream delivers new messages and replays after a cursor', async () => {
  const ctrl = new AbortController()
  const res = await fetch(`${base}/v1/stream?token=${anton}&after=1`, { signal: ctrl.signal })
  const reader = res.body.getReader()
  await call('/v1/messages', anton, { method: 'POST', body: JSON.stringify({ text: 'live one', room: 'general' }) })
  let buf = ''
  while (!buf.includes('live one')) buf += new TextDecoder().decode((await reader.read()).value)
  assert.match(buf, /Applied to 3 robotics jobs/) // replayed from after=1
  ctrl.abort()
})

test('MCP lists tools and posts through them', async () => {
  const rpc = async (method, params, id = 1) => {
    const r = await call('/mcp', anton, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) })
    return r.json()
  }
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
  const tools = await rpc('tools/list', {}, 2)
  const names = tools.result.tools.map(t => t.name)
  assert.deepEqual(names.sort(), ['list_agents', 'list_rooms', 'post_message', 'read_messages', 'search_messages'])
  const posted = await rpc('tools/call', { name: 'post_message', arguments: { text: 'from mcp', room: 'general' } }, 3)
  assert.match(posted.result.content[0].text, /"from": "anton"/)
})

test('messages addressed to an agent can be filtered', async () => {
  await call('/v1/messages', anton, { method: 'POST', body: JSON.stringify({ text: 'pause applications', room: 'jobs', to: ['grokbot'] }) })
  const mine = await (await call('/v1/messages?to=grokbot', grok)).json()
  assert.equal(mine.length, 1)
  assert.equal(mine[0].text, 'pause applications')
})

test('connector doc is public and names the real address', async () => {
  const r = await fetch(base + '/docs/connector', { headers: { 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'laptop.example.ts.net' } })
  assert.equal(r.status, 200)
  assert.ok((await r.text()).includes('https://laptop.example.ts.net/v1/messages'))
})

test('bad tokens from one address get locked out', async () => {
  const hit = () => fetch(base + '/v1/messages', { headers: { Authorization: 'Bearer porch_guess', 'X-Forwarded-For': '203.0.113.9' } })
  for (let i = 0; i < 10; i++) await hit()
  assert.equal((await hit()).status, 429)
  // a good token from that address is refused too while locked
  assert.equal((await fetch(base + '/v1/me', { headers: { Authorization: `Bearer ${anton}`, 'X-Forwarded-For': '203.0.113.9' } })).status, 429)
})

test('each agent is rate limited', async () => {
  const s2 = createServer(store, { perMinute: 3, log: false })
  await new Promise(r => s2.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${s2.address().port}/v1/me`
  const codes = []
  for (let i = 0; i < 5; i++) codes.push((await fetch(url, { headers: { Authorization: `Bearer ${reader}` } })).status)
  s2.close()
  assert.deepEqual(codes, [200, 200, 200, 429, 429])
})

test('an agent holding the stream open shows as online', async () => {
  const ctrl = new AbortController()
  const res = await fetch(`${base}/v1/stream?token=${grok}`, { signal: ctrl.signal })
  await res.body.getReader().read()
  const list = await (await call('/v1/agents', anton)).json()
  assert.equal(list.find(a => a.name === 'grokbot').online, true)
  assert.equal(list.find(a => a.name === 'viewer').online, false)
  ctrl.abort()
})
