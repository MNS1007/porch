import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/db.js'
import { replaceSection } from '../src/memory.js'
import { createServer } from '../src/server.js'

let dir, store, server, base, me, muse, claudeAi, viewer, limited

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'porch-mem-'))
  store = openDb(join(dir, 'test.db'))
  me = store.addAgent('me')
  muse = store.addAgent('muse', { rooms: ['research'] })
  claudeAi = store.addAgent('claude-ai')
  viewer = store.addAgent('viewer', { canPost: false })
  limited = store.addAgent('jobbot', { rooms: [] })
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
const send = (method, path, token, body) => call(path, token, { method, body: JSON.stringify(body) })
const get = async (path, token) => (await call(path, token)).json()

const FIRST = `# About Nithin

## Work right now

Building porch and Anton.

## How Nithin thinks

Short and plain. Ships small pieces.
`

test('sections: replace one, keep the rest, add a missing one, skip code fences', () => {
  const doc = '# A\n\n## One\n\nold\n\n### Sub\n\nsub text\n\n## Two\n\nkeep\n'
  assert.equal(replaceSection(doc, '## One', 'new'), '# A\n\n## One\n\nnew\n\n## Two\n\nkeep\n')
  assert.equal(replaceSection(doc, '### Sub', 'x'), '# A\n\n## One\n\nold\n\n### Sub\n\nx\n\n## Two\n\nkeep\n')
  assert.equal(replaceSection(doc, '## Three', 'more'), doc.trim() + '\n\n## Three\n\nmore')
  assert.equal(replaceSection('', '## One', 'x'), '## One\n\nx')
  assert.equal(replaceSection(doc, '## Two', '## Two\n\nrepeated heading is fine'), '# A\n\n## One\n\nold\n\n### Sub\n\nsub text\n\n## Two\n\nrepeated heading is fine')
  const fenced = '## One\n\n```\n## Two\n```\n\n## Two\n\nreal\n'
  assert.equal(replaceSection(fenced, '## One', 'y'), '## One\n\ny\n\n## Two\n\nreal\n')
})

test('an unwritten memory reads as empty, version 0, for any token', async () => {
  for (const t of [me, viewer, limited]) {
    const m = await get('/v1/memory', t)
    assert.equal(m.text, '')
    assert.equal(m.version, 0)
    assert.equal(m.updated_at, null)
  }
})

test('whole replace needs the current version and returns the current text on conflict', async () => {
  assert.equal((await send('PUT', '/v1/memory', me, { text: FIRST })).status, 400) // no base_version
  const r = await send('PUT', '/v1/memory', me, { text: FIRST, base_version: 0 })
  assert.equal(r.status, 200)
  const v1 = await r.json()
  assert.equal(v1.version, 1)
  const stale = await send('PUT', '/v1/memory', claudeAi, { text: '# Something else', base_version: 0 })
  assert.equal(stale.status, 409)
  const body = await stale.json()
  assert.equal(body.version, 1)
  assert.equal(body.text, v1.text)
  assert.match(body.error, /version 1/)
  assert.equal((await get('/v1/memory', muse)).text, v1.text)
})

test('section patch replaces an existing section and adds a new one', async () => {
  const r = await send('PATCH', '/v1/memory', muse, { section: '## Work right now', text: 'Building porch, Anton and a perio bench.' })
  assert.equal(r.status, 200)
  const v2 = await r.json()
  assert.equal(v2.version, 2)
  assert.match(v2.text, /## Work right now\n\nBuilding porch, Anton and a perio bench\.\n\n## How Nithin thinks/)
  assert.ok(!v2.text.includes('Building porch and Anton.'))
  const v3 = await (await send('PATCH', '/v1/memory', claudeAi, { section: '## Reading list', text: '- Tactile sensing papers' })).json()
  assert.equal(v3.version, 3)
  assert.ok(v3.text.trimEnd().endsWith('## Reading list\n\n- Tactile sensing papers'))
  // a stale base_version on a patch is a conflict; no base_version applies to the latest
  assert.equal((await send('PATCH', '/v1/memory', muse, { section: '## Reading list', text: 'x', base_version: 1 })).status, 409)
  assert.equal((await send('PATCH', '/v1/memory', muse, { section: 'Reading list', text: 'x' })).status, 400) // not a heading
  // the text never names its writers
  assert.ok(!/muse|claude-ai/.test(v3.text))
})

test('history lists who wrote each version and when; the owner restores', async () => {
  const hist = await get('/v1/memory/history', viewer)
  assert.deepEqual(hist.map(h => [h.version, h.author]), [[3, 'claude-ai'], [2, 'muse'], [1, 'me']])
  assert.ok(hist[0].ts)
  const one = await get('/v1/memory/history/1', muse)
  assert.equal(one.text, FIRST)
  assert.equal((await call('/v1/memory/history/99', muse)).status, 404)
  assert.equal((await send('POST', '/v1/memory/restore', muse, { version: 1 })).status, 403)
  const r = await send('POST', '/v1/memory/restore', me, { version: 1 })
  assert.equal(r.status, 200)
  const v4 = await r.json()
  assert.equal(v4.version, 4)
  assert.equal(v4.text, FIRST)
  assert.equal((await get('/v1/memory/history', me))[0].author, 'me')
})

test('read-only tokens read but cannot write', async () => {
  assert.equal((await send('PUT', '/v1/memory', viewer, { text: 'x', base_version: 4 })).status, 403)
  assert.equal((await send('PATCH', '/v1/memory', viewer, { section: '## X', text: 'x' })).status, 403)
  // a token limited to no rooms can still read and write memory
  assert.equal((await send('PATCH', '/v1/memory', limited, { section: '## Jobs', text: 'Robotics roles.' })).status, 200)
})

test('every write is announced on the stream without moving the message cursor', async () => {
  const ctrl = new AbortController()
  const res = await fetch(`${base}/v1/stream?token=${viewer}`, { signal: ctrl.signal })
  const reader = res.body.getReader()
  await reader.read()
  const saved = await (await send('PATCH', '/v1/memory', muse, { section: '## Jobs', text: 'Robotics roles, Boston.' })).json()
  let buf = ''
  while (!buf.includes('event: memory')) buf += new TextDecoder().decode((await reader.read()).value)
  while (!buf.includes('\n\n', buf.indexOf('event: memory'))) buf += new TextDecoder().decode((await reader.read()).value)
  const block = buf.slice(buf.indexOf('event: memory')).split('\n\n')[0]
  assert.ok(!/^id:/m.test(block))
  const data = JSON.parse(block.split('\n').find(l => l.startsWith('data:')).slice(5))
  assert.equal(data.type, 'memory')
  assert.equal(data.version, saved.version)
  ctrl.abort()
})

test('MCP: read, update a section, and replace with a conflict answer', async () => {
  const rpc = async (token, name, args) => {
    const r = await call('/mcp', token, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })
    const body = await r.json()
    return { error: body.result.isError, data: (() => { try { return JSON.parse(body.result.content[0].text) } catch { return body.result.content[0].text } })() }
  }
  const tools = await (await call('/mcp', muse, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) })).json()
  const desc = tools.result.tools.find(t => t.name === 'update_memory_section').description
  assert.match(desc, /single shared memory/)
  assert.match(desc, /Never say who wrote what/)
  assert.match(desc, /Nothing private/)

  const read = (await rpc(claudeAi, 'read_memory', {})).data
  const up = (await rpc(claudeAi, 'update_memory_section', { section: '## How Nithin thinks', text: 'Plain words. Small commits.' })).data
  assert.equal(up.version, read.version + 1)
  const stale = (await rpc(muse, 'replace_memory', { text: '# Rewritten', base_version: read.version })).data
  assert.equal(stale.current.version, up.version)
  assert.match(stale.error, /saved version/)
  const ok = (await rpc(muse, 'replace_memory', { text: stale.current.text.replace('Small commits.', 'Small commits, pushed as he goes.'), base_version: up.version })).data
  assert.equal(ok.version, up.version + 1)
  assert.equal((await rpc(viewer, 'update_memory_section', { section: '## X', text: 'x' })).error, true)
})

test('renaming an agent renames it in the history too', async () => {
  store.renameAgent('claude-ai', 'claude/web')
  const hist = await get('/v1/memory/history', me)
  assert.ok(hist.some(h => h.author === 'claude/web'))
  assert.ok(!hist.some(h => h.author === 'claude-ai'))
})
