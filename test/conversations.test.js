import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openDb, roomName } from '../src/db.js'
import { createServer } from '../src/server.js'

let dir, store, server, base, me, anton, grok, muse, claude, viewer

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'porch-conv-'))
  store = openDb(join(dir, 'test.db'))
  me = store.addAgent('me')
  anton = store.addAgent('anton')
  grok = store.addAgent('grokbot', { rooms: ['jobs'] })
  muse = store.addAgent('muse', { rooms: [] })
  claude = store.addAgent('claude-code', { rooms: [] })
  viewer = store.addAgent('viewer', { canPost: false })
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
const post = (token, body) => call('/v1/messages', token, { method: 'POST', body: JSON.stringify(body) })
const get = async (path, token) => (await call(path, token)).json()

test('room names: DM names are sorted and a query-string space becomes +', () => {
  assert.equal(roomName('dm:me+grokbot'), 'dm:grokbot+me')
  assert.equal(roomName('dm:grokbot me'), 'dm:grokbot+me')
  assert.equal(roomName(''), 'general')
  assert.throws(() => roomName('dm:me+me'))
  assert.throws(() => roomName('dm:me'))
  assert.throws(() => roomName('bad room'))
})

test('/v1/me says who the owner is', async () => {
  assert.equal((await get('/v1/me', me)).owner, true)
  assert.equal((await get('/v1/me', anton)).owner, false)
})

test('a DM between the owner and a room-limited agent', async () => {
  const dm = await get('/v1/dm/grokbot', me)
  assert.equal(dm.room, 'dm:grokbot+me')
  // grokbot's token only lists "jobs", but it is a member of this DM
  const r = await post(me, { room: dm.room, text: 'Pause applications for a week' })
  assert.equal(r.status, 201)
  const m = await r.json()
  assert.deepEqual(m.to, ['grokbot']) // the other member is filled in
  const seen = await get('/v1/messages?room=' + encodeURIComponent(dm.room), grok)
  assert.equal(seen.at(-1).text, 'Pause applications for a week')
  const back = await post(grok, { room: 'dm:me+grokbot', text: 'Paused', reply_to: m.id })
  assert.equal(back.status, 201)
  assert.equal((await back.json()).room, 'dm:grokbot+me')
  // a plain read without a room includes the DM for grokbot too
  assert.ok((await get('/v1/messages', grok)).some(x => x.text === 'Paused'))
})

test('agents DM each other with the dm field, and outsiders cannot write in', async () => {
  const r = await post(muse, { dm: 'claude-code', text: 'Can you check the paper draft?' })
  assert.equal(r.status, 201)
  const m = await r.json()
  assert.equal(m.room, 'dm:claude-code+muse')
  assert.deepEqual(m.to, ['claude-code'])
  const reply = await post(claude, { room: m.room, reply_to: m.id, text: 'Done, two notes.' })
  assert.equal(reply.status, 201)
  // the reply shows up when muse asks for replies to its message
  const thread = await get(`/v1/messages?reply_to=${m.id}`, muse)
  assert.equal(thread.length, 1)
  assert.equal(thread[0].from, 'claude-code')
  // grokbot is not a member: no reading, no writing
  assert.equal((await call('/v1/messages?room=' + encodeURIComponent(m.room), grok)).status, 403)
  assert.equal((await post(grok, { room: m.room, text: 'hi' })).status, 403)
  // anton has every room, so it can read, but a DM only takes posts from its members
  assert.equal((await call('/v1/messages?room=' + encodeURIComponent(m.room), anton)).status, 200)
  assert.equal((await post(anton, { room: m.room, text: 'butting in' })).status, 403)
  // the owner can read every DM
  assert.equal((await get('/v1/messages?room=' + encodeURIComponent(m.room), me)).length, 2)
})

test('DMs need registered agents', async () => {
  assert.equal((await post(muse, { dm: 'nobody', text: 'hi' })).status, 400)
  assert.equal((await call('/v1/dm/nobody', muse)).status, 404)
  assert.equal((await call('/v1/dm/muse', muse)).status, 400)
})

test('only the owner makes groups, and members can use them', async () => {
  assert.equal((await call('/v1/groups', anton, { method: 'POST', body: JSON.stringify({ name: 'research', members: ['muse'] }) })).status, 403)
  assert.equal((await call('/v1/groups', me, { method: 'POST', body: JSON.stringify({ name: 'general', members: ['muse'] }) })).status, 400)
  assert.equal((await call('/v1/groups', me, { method: 'POST', body: JSON.stringify({ name: 'x', members: ['ghost'] }) })).status, 400)
  const r = await call('/v1/groups', me, { method: 'POST', body: JSON.stringify({ name: 'Research', title: 'Research', members: ['muse', 'claude-code'] }) })
  assert.equal(r.status, 201)
  const g = await r.json()
  assert.equal(g.name, 'research')
  assert.deepEqual(g.members, ['claude-code', 'muse'])
  assert.equal((await post(muse, { room: 'research', text: 'New paper on tactile sensing' })).status, 201)
  assert.equal((await get('/v1/messages?room=research', claude)).length, 1)
  assert.equal((await call('/v1/messages?room=research', grok)).status, 403)
  assert.equal((await post(grok, { room: 'research', text: 'x' })).status, 403)
})

test('adding a member reaches a stream that is already open', async () => {
  const ctrl = new AbortController()
  const res = await fetch(`${base}/v1/stream?token=${grok}`, { signal: ctrl.signal })
  const reader = res.body.getReader()
  await reader.read()
  await call('/v1/groups', me, { method: 'POST', body: JSON.stringify({ name: 'research', title: 'Research', members: ['muse', 'claude-code', 'grokbot'] }) })
  await post(muse, { room: 'research', text: 'welcome grokbot' })
  let buf = ''
  while (!buf.includes('welcome grokbot')) buf += new TextDecoder().decode((await reader.read()).value)
  ctrl.abort()
})

test('conversations list: newest first, unread counts, and who sees what', async () => {
  const mine = await get('/v1/conversations', me)
  const rooms = mine.map(c => c.room)
  // the owner sees everything, agent-to-agent DMs included
  for (const r of ['general', 'dm:grokbot+me', 'dm:claude-code+muse', 'research']) assert.ok(rooms.includes(r), r)
  const ids = mine.map(c => c.lastId)
  assert.deepEqual(ids, [...ids].sort((a, b) => b - a))
  const everyone = mine.find(c => c.room === 'general')
  assert.equal(everyone.title, 'Everyone')
  const dm = mine.find(c => c.room === 'dm:grokbot+me')
  assert.equal(dm.type, 'dm')
  assert.equal(dm.title, 'grokbot')
  assert.equal(dm.unread, 1) // "Paused"; the owner's own message does not count
  assert.equal(dm.last.text, 'Paused')
  assert.equal(mine.find(c => c.room === 'dm:claude-code+muse').title, 'claude-code and muse')

  // marking read clears it
  await call('/v1/read', me, { method: 'POST', body: JSON.stringify({ room: dm.room, id: dm.lastId }) })
  assert.equal((await get('/v1/conversations', me)).find(c => c.room === dm.room).unread, 0)

  // grokbot: Everyone, its token room, its DM and the group it was added to, nothing else
  const g = (await get('/v1/conversations', grok)).map(c => c.room).sort()
  assert.deepEqual(g, ['dm:grokbot+me', 'general', 'jobs', 'research'])
  // anton can read everything but only lists open groups and its own conversations
  const a = (await get('/v1/conversations', anton)).map(c => c.room)
  assert.ok(a.includes('general'))
  assert.ok(!a.includes('dm:claude-code+muse'))
  assert.ok(!a.includes('research'))
})

test('old rooms keep working as open groups and /v1/rooms keeps its shape', async () => {
  assert.equal((await post(anton, { text: 'morning', room: 'jobs' })).status, 201)
  assert.equal((await post(anton, { text: 'to grokbot, no room', to: ['grokbot'] })).status, 201)
  const rooms = await get('/v1/rooms', anton)
  const jobs = rooms.find(r => r.room === 'jobs')
  assert.equal(jobs.type, 'group')
  for (const k of ['room', 'count', 'lastId', 'lastTs']) assert.ok(k in jobs)
  // a message with "to" and no room still lands in general, as before
  const last = (await get('/v1/messages?room=general', anton)).at(-1)
  assert.equal(last.text, 'to grokbot, no room')
})

test('a read-only token cannot mark a room it cannot read, or post', async () => {
  assert.equal((await post(viewer, { dm: 'me', text: 'x' })).status, 403)
  assert.equal((await call('/v1/read', grok, { method: 'POST', body: JSON.stringify({ room: 'news', id: 1 }) })).status, 403)
})

test('upgrading an old database keeps its messages and counts them as read', async () => {
  const path = join(dir, 'old.db')
  const old = new DatabaseSync(path)
  old.exec(`CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, room TEXT NOT NULL, sender TEXT NOT NULL, kind TEXT NOT NULL,
    text TEXT NOT NULL, recipients TEXT NOT NULL DEFAULT '[]', reply_to INTEGER, priority TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]', data TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE agents (name TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, rooms TEXT NOT NULL, can_post INTEGER NOT NULL, created TEXT NOT NULL, last_seen TEXT);
    INSERT INTO agents VALUES ('me', 'x', '["*"]', 1, '2026-01-01', NULL);
    INSERT INTO messages (ts, room, sender, kind, text, priority) VALUES ('2026-01-01', 'jobs', 'grokbot', 'note', 'old news', 'normal');`)
  old.close()
  const s = openDb(path)
  assert.equal(s.list({ room: 'jobs' })[0].text, 'old news')
  const owner = { name: 'me', rooms: ['*'], owner: true }
  assert.equal(s.conversations(owner).find(c => c.room === 'jobs').unread, 0)
  s.post('grokbot', { room: 'jobs', text: 'new news' })
  assert.equal(s.conversations(owner).find(c => c.room === 'jobs').unread, 1)
  s.db.close()
  // opening again changes nothing
  const again = openDb(path)
  assert.equal(again.list({ room: 'jobs' }).length, 2)
  again.db.close()
})

test('over MCP an agent starts a DM, the other reads it and replies in the thread', async () => {
  const rpc = async (token, name, args) => {
    const r = await call('/mcp', token, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })
    const body = await r.json()
    return JSON.parse(body.result.content[0].text)
  }
  const sent = await rpc(muse, 'send_dm', { to: 'anton', text: 'Any news on the robotics list?' })
  assert.equal(sent.room, 'dm:anton+muse')
  const convs = await rpc(anton, 'list_conversations', {})
  const dm = convs.find(c => c.room === 'dm:anton+muse')
  assert.equal(dm.title, 'muse')
  assert.equal(dm.unread, 1)
  const read = await rpc(anton, 'read_messages', { dm: 'muse' })
  assert.equal(read.at(-1).text, 'Any news on the robotics list?')
  // reading marked it read
  assert.equal((await rpc(anton, 'list_conversations', {})).find(c => c.room === dm.room).unread, 0)
  await rpc(anton, 'send_dm', { to: 'muse', text: 'Three new ones.', reply_to: sent.id })
  const replies = await rpc(muse, 'read_messages', { reply_to: sent.id })
  assert.equal(replies[0].text, 'Three new ones.')
  assert.deepEqual(replies[0].to, ['muse'])
  // the owner sees this DM too
  assert.ok((await rpc(me, 'list_conversations', {})).some(c => c.room === 'dm:anton+muse'))
})

test('Everyone and groups open to every agent need no token change', async () => {
  // muse's token lists no rooms at all
  assert.equal((await post(muse, { text: 'hello everyone' })).status, 201)
  assert.equal((await post(anton, { room: 'context', text: 'Brief: the owner is job hunting in robotics.' })).status, 201)
  assert.equal((await call('/v1/messages?room=context', muse)).status, 403)
  const r = await call('/v1/groups', me, { method: 'POST', body: JSON.stringify({ name: 'context', title: 'Context', members: ['*'] }) })
  assert.deepEqual((await r.json()).members, ['*'])
  assert.equal((await get('/v1/messages?room=context', muse)).at(-1).from, 'anton')
  assert.ok((await get('/v1/conversations', muse)).some(c => c.room === 'context'))
})

test('a group change made by another connection (the CLI) is seen at once', async () => {
  const other = openDb(join(dir, 'test.db'))
  other.saveGroup({ name: 'jobs-team', members: ['muse'] }, 'me')
  other.db.close()
  assert.equal((await call('/v1/messages?room=jobs-team', muse)).status, 200)
})
