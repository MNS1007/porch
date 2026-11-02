import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { wakeOnTag, wakeFromEnv } from '../src/wake.js'
import { openDb } from '../src/db.js'
import { createServer } from '../src/server.js'

const tag = (from = 'anton', to = ['claude-ai']) => ({ from, to })
const flush = () => new Promise(r => setImmediate(r))

function setup(opts = {}) {
  const calls = []
  const logs = []
  const fetchFn = opts.fetchFn || (async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200 } })
  const w = wakeOnTag({ url: 'https://fire.example/x', token: 'tok', log: m => logs.push(m), ...opts, fetchFn })
  return { w, calls, logs }
}

test('fires once with the right headers after the debounce', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const { w, calls } = setup()
  w.notify(tag())
  t.mock.timers.tick(19_999); await flush()
  assert.equal(calls.length, 0)
  t.mock.timers.tick(1); await flush()
  assert.equal(calls.length, 1)
  const { url, init } = calls[0]
  assert.equal(url, 'https://fire.example/x')
  assert.equal(init.method, 'POST')
  assert.equal(init.headers.Authorization, 'Bearer tok')
  assert.equal(init.headers['anthropic-beta'], 'experimental-cc-routine-2026-04-01')
  assert.equal(init.headers['anthropic-version'], '2023-06-01')
  assert.equal(init.body, '{}')
})

test('ignores its own posts and posts for other agents', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const { w, calls } = setup()
  w.notify(tag('claude-ai'))
  w.notify(tag('anton', ['grokbot']))
  w.notify({ from: 'anton' })
  t.mock.timers.tick(60_000); await flush()
  assert.equal(calls.length, 0)
})

test('a burst of tags makes one call', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const { w, calls } = setup()
  for (let i = 0; i < 10; i++) { w.notify(tag()); t.mock.timers.tick(1000) }
  t.mock.timers.tick(30_000); await flush()
  assert.equal(calls.length, 1)
})

test('a tag during the cooldown is delayed, not lost', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const { w, calls } = setup()
  w.notify(tag())
  t.mock.timers.tick(20_000); await flush()
  assert.equal(calls.length, 1)
  t.mock.timers.tick(10_000)
  w.notify(tag())
  t.mock.timers.tick(100_000); await flush()
  assert.equal(calls.length, 1, 'still cooling down')
  t.mock.timers.tick(70_000); await flush()
  assert.equal(calls.length, 2, 'fires when the 3 minute cooldown ends')
})

test('caps wakes per hour and logs the dropped one', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const { w, calls, logs } = setup({ maxPerHour: 2, cooldownMs: 0, debounceMs: 10 })
  for (let i = 0; i < 3; i++) { w.notify(tag()); t.mock.timers.tick(10); await flush() }
  assert.equal(calls.length, 2)
  assert.match(logs.join('\n'), /reached 2 wakes this hour/)
  t.mock.timers.tick(60 * 60 * 1000)
  w.notify(tag()); t.mock.timers.tick(10); await flush()
  assert.equal(calls.length, 3, 'the cap resets after an hour')
})

test('a failed call is logged and never throws', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const bad = setup({ fetchFn: async () => { throw new Error('offline') } })
  bad.w.notify(tag()); t.mock.timers.tick(20_000); await flush()
  assert.match(bad.logs.join('\n'), /failed: offline/)
  const refused = setup({ fetchFn: async () => ({ ok: false, status: 401 }) })
  refused.w.notify(tag()); t.mock.timers.tick(20_000); await flush()
  assert.match(refused.logs.join('\n'), /status 401/)
})

test('off when either setting is missing', () => {
  assert.equal(wakeFromEnv({}), null)
  assert.equal(wakeFromEnv({ PORCH_WAKE_URL: 'https://x' }), null)
  assert.equal(wakeFromEnv({ PORCH_WAKE_TOKEN: 't' }), null)
  const w = wakeFromEnv({ PORCH_WAKE_URL: 'https://x', PORCH_WAKE_TOKEN: 't' })
  assert.ok(w); w.close()
})

test('the hub tells the waker about every saved post', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'porch-wake-'))
  const store = openDb(join(dir, 'test.db'))
  const anton = store.addAgent('anton')
  store.addAgent('claude-ai')
  const seen = []
  const server = createServer(store, { log: false, wake: { notify: m => seen.push(m) } })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/v1/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${anton}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ dm: 'claude-ai', text: 'can you check this' }),
    })
    assert.equal(res.status, 201)
    assert.equal(seen.length, 1)
    assert.deepEqual(seen[0].to, ['claude-ai'])
  } finally {
    server.close()
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  }
})

test('a webhook target gets the message, a Bearer key, no routine headers, and one retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const calls = []
  let fail = 1
  const fetchFn = async (url, init) => { calls.push({ url, init }); return fail-- > 0 ? { ok: false, status: 502 } : { ok: true, status: 200 } }
  const w = wakeFromEnv({ PORCH_WAKE_GROKBOT_URL: 'https://hook.example/g', PORCH_WAKE_GROKBOT_KEY: 'gk' }, { fetchFn, log: () => {} })
  assert.deepEqual(w.agents, ['grokbot'])
  w.notify({ id: 7, from: 'anton', room: 'jobs', to: [], text: 'hey @grokbot can you look' })
  w.notify({ id: 8, from: 'grokbot', room: 'jobs', to: ['grokbot'], text: 'my own post' })
  t.mock.timers.tick(5_000); await flush(); await flush()
  assert.equal(calls.length, 2, 'first try failed, retried once')
  const { url, init } = calls[1]
  assert.equal(url, 'https://hook.example/g')
  assert.equal(init.headers.Authorization, 'Bearer gk')
  assert.equal(init.headers['anthropic-beta'], undefined)
  assert.deepEqual(JSON.parse(init.body), { event: 'porch_message', message_id: 7, room: 'jobs', from: 'anton', to: 'grokbot', text: 'hey @grokbot can you look' })
})

test('a mention needs the @ and the whole name', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const calls = []
  const w = wakeFromEnv({ PORCH_WAKE_GROKBOT_URL: 'https://hook.example/g', PORCH_WAKE_GROKBOT_AUTH: 'Key raw' }, { fetchFn: async (u, i) => { calls.push(i); return { ok: true } } })
  w.notify({ id: 1, from: 'anton', to: [], text: 'grokbot said so' })
  w.notify({ id: 2, from: 'anton', to: [], text: '@grokbots are fun' })
  t.mock.timers.tick(60_000); await flush()
  assert.equal(calls.length, 0)
  w.notify({ id: 3, from: 'anton', to: [], text: '(@GrokBot) ping' })
  t.mock.timers.tick(60_000); await flush()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].headers.Authorization, 'Key raw')
})

test('claude-ai and grokbot are woken independently', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const urls = []
  const w = wakeFromEnv({ PORCH_WAKE_URL: 'https://fire.example/c', PORCH_WAKE_TOKEN: 'c', PORCH_WAKE_GROKBOT_URL: 'https://hook.example/g', PORCH_WAKE_GROKBOT_KEY: 'g' }, { fetchFn: async u => { urls.push(u); return { ok: true } } })
  assert.deepEqual(w.agents, ['claude-ai', 'grokbot'])
  w.notify({ id: 1, from: 'anton', to: ['claude-ai', 'grokbot'], text: 'both of you' })
  t.mock.timers.tick(20_000); await flush()
  assert.deepEqual(urls.sort(), ['https://fire.example/c', 'https://hook.example/g'])
  w.close()
})
