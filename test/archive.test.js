import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { openDb } from '../src/db.js'
import { createServer } from '../src/server.js'

let dir, store, server, base, me, anton

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'porch-arch-'))
  store = openDb(join(dir, 'test.db'))
  me = store.addAgent('me')
  anton = store.addAgent('anton')
  server = createServer(store, { log: false })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}`
  // the old setup: an open room named like an agent, and a context room
  store.post('anton', { room: 'anton', text: 'Claude finished the task' })
  store.post('anton', { room: 'context', text: 'Brief: robotics job hunt' })
  store.post('me', { dm: 'anton', room: 'dm:anton+me', text: 'hi anton' })
})

after(() => {
  server.close()
  try { rmSync(dir, { recursive: true, force: true }) } catch {}
})

const call = (path, token, opts = {}) => fetch(base + path, {
  ...opts,
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...opts.headers },
})
const send = (path, token, body) => call(path, token, { method: 'POST', body: JSON.stringify(body) })
const get = async (path, token) => (await call(path, token)).json()

test('a group named like an agent reads "#anton", the DM reads "anton"', async () => {
  const convs = await get('/v1/conversations', me)
  assert.equal(convs.find(c => c.room === 'anton').title, '#anton')
  assert.equal(convs.find(c => c.room === 'dm:anton+me').title, 'anton')
  assert.equal(convs.find(c => c.room === 'context').title, 'context')
})

test('only the owner archives, and never Everyone or a DM', async () => {
  assert.equal((await send('/v1/groups/archive', anton, { name: 'anton' })).status, 403)
  assert.equal((await send('/v1/groups/archive', me, { name: 'general' })).status, 400)
  assert.equal((await send('/v1/groups/archive', me, { name: 'dm:anton+me' })).status, 400)
  assert.equal((await send('/v1/groups/archive', me, { name: 'nothing-here' })).status, 400)
})

test('archived groups leave the list, keep their messages and stay searchable', async () => {
  const r = await send('/v1/groups/archive', me, { name: 'anton' })
  assert.equal(r.status, 200)
  assert.equal((await r.json()).archived, true)
  // the CLI archives too, on the same database while the hub runs
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url))
  const out = execFileSync(process.execPath, [cli, 'group', 'archive', 'context'], { env: { ...process.env, PORCH_DB: join(dir, 'test.db') }, encoding: 'utf8' })
  assert.match(out, /Archived "context"/)

  const rooms = (await get('/v1/conversations', me)).map(c => c.room)
  assert.ok(!rooms.includes('anton') && !rooms.includes('context'))
  assert.ok(rooms.includes('dm:anton+me'))
  const all = await get('/v1/conversations?archived=1', me)
  assert.equal(all.find(c => c.room === 'anton').archived, true)
  assert.equal(all.find(c => c.room === 'context').archived, true)
  assert.equal((await get('/v1/messages?room=anton', me)).length, 1)
  assert.equal((await get('/v1/messages?q=robotics', me))[0].room, 'context')

  // MCP hides them unless asked
  const rpc = async args => {
    const r = await call('/mcp', anton, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_conversations', arguments: args } }) })
    return JSON.parse((await r.json()).result.content[0].text).map(c => c.room)
  }
  assert.ok(!(await rpc({})).includes('anton'))
  assert.ok((await rpc({ include_archived: true })).includes('anton'))
})

test('posting into an archived group brings it back; unarchive works too', async () => {
  assert.equal((await send('/v1/messages', anton, { room: 'anton', text: 'still using this room' })).status, 201)
  assert.ok((await get('/v1/conversations', me)).some(c => c.room === 'anton' && !c.archived))
  assert.equal((await send('/v1/groups/unarchive', me, { name: 'context' })).status, 200)
  assert.ok((await get('/v1/conversations', me)).some(c => c.room === 'context'))
})

test('the archived column is added to an older rooms table without losing rows', () => {
  const path = join(dir, 'old.db')
  const old = new DatabaseSync(path)
  old.exec(`CREATE TABLE rooms (name TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT, members TEXT, created_by TEXT, created TEXT NOT NULL);
    INSERT INTO rooms VALUES ('research', 'group', 'Research', '["muse"]', 'me', '2026-10-01');`)
  old.close()
  const s = openDb(path)
  assert.deepEqual(s.room('research').members, ['muse'])
  assert.equal(s.room('research').archived, false)
  s.db.close()
})

test('the page has an archive action and a collapsed Archived list', async () => {
  const html = await (await fetch(base + '/')).text()
  for (const s of ['id="archive-group"', 'id="archived-box"', '/v1/groups/archive', '/v1/groups/unarchive', '/v1/conversations?archived=1']) assert.ok(html.includes(s), s)
})
