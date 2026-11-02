import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { openDb } from '../src/db.js'
import { createServer } from '../src/server.js'

let dir, store, server, base, me, anton, muse, other
const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url))
const porch = (...args) => execFileSync(process.execPath, [cli, ...args], { env: { ...process.env, PORCH_DB: join(dir, 'test.db') }, encoding: 'utf8' })

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'porch-managed-'))
  store = openDb(join(dir, 'test.db'))
  me = store.addAgent('me')
  // Anton's token only lists its own room, to show that speaking for members widens what it sees
  anton = store.addAgent('anton', { rooms: ['anton'] })
  muse = store.addAgent('muse', { rooms: ['research'] })
  other = store.addAgent('other-bot')
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
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...opts.headers },
})
const send = (method, path, token, body) => call(path, token, { method, body: body && JSON.stringify(body) })
const get = async (path, token) => (await call(path, token)).json()

test('token acts: set from the CLI, shown in token list, refused for bad patterns', () => {
  assert.match(porch('token', 'acts', 'anton', 'claude-code/*'), /can now speak for: claude-code\/\*/)
  assert.match(porch('token', 'list'), /anton .*acts for: claude-code\/\*/)
  assert.throws(() => porch('token', 'acts', 'anton', 'bad pattern'), /not a pattern/)
})

test('registering members: only inside the pattern, idempotent, never over a real token', async () => {
  assert.equal((await send('POST', '/v1/agents', other, { name: 'claude-code/main' })).status, 403) // no acts
  assert.equal((await send('POST', '/v1/agents', anton, { name: 'grokbot/x' })).status, 403) // outside the pattern
  assert.equal((await send('POST', '/v1/agents', anton, { name: 'claude-code' })).status, 403) // the family alone is not a member
  const r = await send('POST', '/v1/agents', anton, { name: 'claude-code/main' })
  assert.equal(r.status, 201)
  assert.equal((await r.json()).managed_by, 'anton')
  assert.equal((await send('POST', '/v1/agents', anton, { name: 'claude-code/main' })).status, 201) // again: no change
  assert.equal((await send('POST', '/v1/agents', anton, { name: 'claude-code/gpt-live-spike' })).status, 201)
  // a real token under the pattern cannot be taken over, and a managed name cannot get a token
  store.addAgent('claude-code/renfort')
  assert.equal((await send('POST', '/v1/agents', anton, { name: 'claude-code/renfort' })).status, 409)
  assert.throws(() => store.addAgent('claude-code/main'), /spoken for by anton/)
  assert.match(porch('token', 'list'), /claude-code\/main\s+spoken for by anton/)
})

test('members show in /v1/agents with managed_by, and listen while the manager does', async () => {
  let list = await get('/v1/agents', me)
  const main = list.find(a => a.name === 'claude-code/main')
  assert.equal(main.managed_by, 'anton')
  assert.equal(main.family, 'claude-code')
  assert.equal(main.online, false)
  const ctrl = new AbortController()
  const res = await fetch(`${base}/v1/stream?token=${anton}`, { signal: ctrl.signal })
  await res.body.getReader().read()
  list = await get('/v1/agents', me)
  assert.equal(list.find(a => a.name === 'claude-code/main').online, true)
  assert.equal(list.find(a => a.name === 'claude-code/renfort').online, false)
  ctrl.abort()
})

test('DMs to a member reach the manager on the stream and in reads, whatever its rooms', async () => {
  const ctrl = new AbortController()
  const res = await fetch(`${base}/v1/stream?token=${anton}`, { signal: ctrl.signal })
  const reader = res.body.getReader()
  await reader.read()
  const dm = await (await send('POST', '/v1/messages', me, { dm: 'claude-code/main', text: 'main: run the tests' })).json()
  assert.equal(dm.room, 'dm:claude-code/main+me')
  // addressed to a member in a room the manager's token does not list
  await send('POST', '/v1/messages', muse, { room: 'research', to: ['claude-code/gpt-live-spike'], text: 'spike: read this paper' })
  await send('POST', '/v1/messages', muse, { room: 'research', text: 'not for anyone in particular' })
  let buf = ''
  while (!buf.includes('spike: read this paper')) buf += new TextDecoder().decode((await reader.read()).value)
  assert.match(buf, /main: run the tests/)
  ctrl.abort()

  const seen = await get('/v1/messages?limit=100', anton)
  assert.ok(seen.some(m => m.text === 'main: run the tests'))
  assert.ok(seen.some(m => m.text === 'spike: read this paper'))
  assert.ok(!seen.some(m => m.text === 'not for anyone in particular'))
  assert.equal((await get('/v1/messages?to=claude-code/gpt-live-spike', anton)).length, 1)
  assert.equal((await call('/v1/messages?room=' + encodeURIComponent(dm.room), anton)).status, 200)
  // and the member's DM is in the manager's conversation list
  assert.ok((await get('/v1/conversations', anton)).some(c => c.room === dm.room))
})

test('posting as a member: from is the member; refused outside the pattern or unregistered', async () => {
  const ask = (await get('/v1/messages?room=' + encodeURIComponent('dm:claude-code/main+me'), anton)).at(-1)
  const r = await send('POST', '/v1/messages', anton, { as: 'claude-code/main', dm: 'me', reply_to: ask.id, text: 'Tests pass.' })
  assert.equal(r.status, 201)
  const m = await r.json()
  assert.equal(m.from, 'claude-code/main')
  assert.equal(m.room, 'dm:claude-code/main+me')
  assert.deepEqual(m.to, ['me'])
  assert.equal((await send('POST', '/v1/messages', anton, { as: 'claude-code/nobody', dm: 'me', text: 'x' })).status, 403)
  assert.equal((await send('POST', '/v1/messages', anton, { as: 'claude-code/renfort', dm: 'me', text: 'x' })).status, 403) // real token, not managed
  assert.equal((await send('POST', '/v1/messages', anton, { as: 'muse', text: 'x' })).status, 403)
  assert.equal((await send('POST', '/v1/messages', other, { as: 'claude-code/main', dm: 'me', text: 'x' })).status, 403)
  // what anton posted for main is not unread for anton
  assert.equal((await get('/v1/conversations', anton)).find(c => c.room === 'dm:claude-code/main+me').unread, 1)
  // a member's name has no token, so it cannot sign in
  assert.equal((await call('/v1/me', 'managed:claude-code/main')).status, 401)
})

test('removing a member keeps its history; another agent cannot remove it', async () => {
  assert.equal((await send('DELETE', '/v1/agents/claude-code/gpt-live-spike', other)).status, 403)
  assert.equal((await send('DELETE', '/v1/agents/claude-code/gpt-live-spike', anton)).status, 200)
  assert.equal((await send('DELETE', '/v1/agents/claude-code/gpt-live-spike', anton)).status, 404)
  assert.ok(!(await get('/v1/agents', me)).some(a => a.name === 'claude-code/gpt-live-spike'))
  assert.ok((await get('/v1/messages?q=spike', me)).length >= 1)
  // now a real token may take the name
  store.addAgent('claude-code/gpt-live-spike')
})

test('renaming the manager and a member moves the managed link', async () => {
  store.renameAgent('claude-code/main', 'claude-code/primary')
  const list = await get('/v1/agents', me)
  assert.equal(list.find(a => a.name === 'claude-code/primary').managed_by, 'anton')
  assert.equal((await send('POST', '/v1/messages', anton, { as: 'claude-code/primary', dm: 'me', text: 'renamed and working' })).status, 201)
  assert.equal((await get('/v1/messages?room=' + encodeURIComponent('dm:claude-code/primary+me'), me)).length, 3)
  store.renameAgent('anton', 'anton2')
  assert.equal((await get('/v1/agents', me)).find(a => a.name === 'claude-code/primary').managed_by, 'anton2')
  assert.equal((await send('POST', '/v1/messages', anton, { as: 'claude-code/primary', dm: 'me', text: 'still mine' })).status, 201)
})

test('the page says who a member speaks through', async () => {
  const html = await (await fetch(base + '/')).text()
  assert.ok(html.includes('managed_by'))
})

test('token acts none removes it', () => {
  assert.match(porch('token', 'acts', 'anton2', 'none'), /no longer speaks for anyone/)
  assert.equal(store.agents().find(a => a.name === 'anton2').acts.length, 0)
})
