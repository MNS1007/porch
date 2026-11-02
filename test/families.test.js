import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { openDb, roomName, displayName, families } from '../src/db.js'
import { createServer } from '../src/server.js'

let dir, store, server, base, me, anton, renfort, muse

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'porch-fam-'))
  store = openDb(join(dir, 'test.db'))
  me = store.addAgent('me')
  anton = store.addAgent('anton')
  muse = store.addAgent('muse', { rooms: [] })
  renfort = store.addAgent('renfort-claude', { rooms: ['jobs'] })
  store.addAgent('claude-code/main', { rooms: [] })
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

test('names: one slash makes a family member, and DMs with one work', () => {
  assert.equal(roomName('dm:me+claude-code/renfort'), 'dm:claude-code/renfort+me')
  assert.equal(roomName('dm:claude-code/renfort me'), 'dm:claude-code/renfort+me')
  assert.throws(() => roomName('dm:a/b/c+me'))
  assert.throws(() => roomName('jobs/x')) // group names stay one part
  assert.throws(() => store.addAgent('a/b/c'))
  assert.throws(() => store.addAgent('/x'))
  assert.equal(displayName('claude-code/renfort'), 'Claude Code: renfort')
  assert.equal(displayName('grokbot'), 'grokbot')
  assert.deepEqual(families(['claude-code/main', 'claude-code/renfort', 'grokbot']), [{
    family: 'claude-code', title: 'Claude Code', members: ['main', 'renfort'],
    note: 'claude-code has sessions main and renfort. Write to one as claude-code/<session>.',
  }])
})

test('before the rename: history under the old name', async () => {
  const m = await (await post(me, { dm: 'renfort-claude', text: 'Run the perio bench' })).json()
  await post(renfort, { room: m.room, reply_to: m.id, text: 'Bench done, 84%' })
  await post(renfort, { room: 'jobs', text: 'Posted in jobs' })
  await post(anton, { room: 'general', text: 'Task for renfort', to: ['renfort-claude', 'muse'] })
  await post(muse, { dm: 'renfort-claude', text: 'muse to renfort' })
  await call('/v1/groups', me, { method: 'POST', body: JSON.stringify({ name: 'perio', members: ['renfort-claude', 'muse'] }) })
  await call('/v1/read', renfort, { method: 'POST', body: JSON.stringify({ room: 'dm:muse+renfort-claude', id: 999 }) })
})

test('rename moves everything and the token keeps working', async () => {
  assert.throws(() => store.renameAgent('renfort-claude', 'muse'), /already exists/)
  assert.throws(() => store.renameAgent('me', 'boss'), /owner/)
  // through the CLI, on the same temp database, while this hub keeps running
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url))
  const out = execFileSync(process.execPath, [cli, 'token', 'rename', 'renfort-claude', 'claude-code/renfort'], { env: { ...process.env, PORCH_DB: join(dir, 'test.db') }, encoding: 'utf8' })
  assert.match(out, /Renamed "renfort-claude" to "claude-code\/renfort"/)

  const who = await get('/v1/me', renfort)
  assert.equal(who.name, 'claude-code/renfort')
  const all = await get('/v1/messages?limit=500', me)
  assert.ok(!JSON.stringify(all).includes('renfort-claude'), 'old name is gone')
  assert.equal(all.find(m => m.text === 'Bench done, 84%').from, 'claude-code/renfort')
  assert.equal(all.find(m => m.text === 'Bench done, 84%').room, 'dm:claude-code/renfort+me')
  assert.equal(all.find(m => m.text === 'Run the perio bench').room, 'dm:claude-code/renfort+me')
  assert.deepEqual(all.find(m => m.text === 'Task for renfort').to, ['claude-code/renfort', 'muse'])
  assert.equal(all.find(m => m.text === 'muse to renfort').room, 'dm:claude-code/renfort+muse')
  // the group member list and the running hub's view of it
  const group = (await get('/v1/conversations', me)).find(c => c.room === 'perio')
  assert.deepEqual(group.members, ['claude-code/renfort', 'muse'])
  assert.equal((await call('/v1/messages?room=perio', renfort)).status, 200)
  // read state moved with the DM
  const dm = (await get('/v1/conversations', renfort)).find(c => c.room === 'dm:claude-code/renfort+muse')
  assert.equal(dm.unread, 0)
  // the renamed agent still reads and posts in its DMs
  assert.equal((await get('/v1/messages?room=' + encodeURIComponent('dm:claude-code/renfort+me'), renfort)).length, 2)
  assert.equal((await post(renfort, { dm: 'me', text: 'still here' })).status, 201)
})

test('DMs with a family member over HTTP and MCP', async () => {
  const room = await get('/v1/dm/claude-code/renfort', anton)
  assert.equal(room.room, 'dm:anton+claude-code/renfort')
  const sent = await (await post(anton, { dm: 'claude-code/renfort', text: 'Can you rerun the bench?' })).json()
  assert.deepEqual(sent.to, ['claude-code/renfort'])
  const convs = await get('/v1/conversations', renfort)
  const c = convs.find(x => x.room === 'dm:anton+claude-code/renfort')
  assert.equal(c.title, 'anton')
  assert.equal(c.unread, 1)
  const mine = (await get('/v1/conversations', anton)).find(x => x.room === 'dm:anton+claude-code/renfort')
  assert.equal(mine.title, 'Claude Code: renfort')
  assert.deepEqual(mine.with, { name: 'claude-code/renfort', family: 'claude-code', member: 'renfort', title: 'Claude Code: renfort' })

  const rpc = async (token, name, args) => {
    const r = await call('/mcp', token, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })
    return JSON.parse((await r.json()).result.content[0].text)
  }
  const list = await rpc(muse, 'list_agents', {})
  assert.equal(list.agents.find(a => a.name === 'claude-code/renfort').family, 'claude-code')
  assert.equal(list.families[0].note, 'claude-code has sessions main and renfort. Write to one as claude-code/<session>.')
  const dm = await rpc(muse, 'send_dm', { to: 'claude-code/main', text: 'hello main' })
  assert.equal(dm.room, 'dm:claude-code/main+muse')
  const agents = await get('/v1/agents', me)
  assert.ok(Array.isArray(agents))
  assert.deepEqual(agents.find(a => a.name === 'claude-code/main').member, 'main')
})

test('the page groups families and titles DMs with the session', async () => {
  const html = await (await fetch(base + '/')).text()
  // Lift the page's own grouping functions out of its script and run them.
  const fn = name => html.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n}\\n`))[0]
  const page = new Function(`${fn('familyTitle')}${fn('displayName')}${fn('groupAgents')} return { displayName, groupAgents }`)()
  const agents = await get('/v1/agents', me)
  const groups = page.groupAgents(agents.filter(a => a.name !== 'me'))
  const cc = groups.find(g => g.family === 'claude-code')
  assert.equal(cc.title, 'Claude Code')
  assert.equal(cc.self, null)
  assert.deepEqual(cc.members.map(m => m.member), ['main', 'renfort'])
  assert.equal(groups.find(g => g.family === 'muse').title, 'muse')
  assert.equal(page.displayName('claude-code/renfort'), 'Claude Code: renfort')
  // the server's conversation title for a DM with a session matches
  const conv = (await get('/v1/conversations', me)).find(c => c.room === 'dm:claude-code/renfort+me')
  assert.equal(conv.title, page.displayName('claude-code/renfort'))
})
