import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { handleProxy, redactor, usageScanner } from '../src/vault/proxy.js'
import { estimate, actual, priceFor, PRICES } from '../src/vault/pricing.js'

const SECRET = 'sk-PLANTED-SECRET-123'
const GKEY = 'AIza-PLANTED-SECRET-456'

// A fake vault that follows the store interface, in memory.
function fakeVault() {
  const secrets = new Map([['openai-main', { provider: 'openai', value: SECRET }], ['gemini', { provider: 'gemini', value: GKEY }]])
  const grants = new Map()
  const v = {
    spend: [], statusCalls: [], isUnlocked: true,
    unlocked: () => v.isUnlocked,
    listSecrets: () => [...secrets].map(([name, s]) => ({ name, provider: s.provider, created: 'x', rotated: null })),
    useSecret: (name, fn) => {
      const s = secrets.get(name)
      if (!s) throw new Error('no such secret')
      return fn(s.value)
    },
    grantForHandle: h => {
      const g = grants.get(h)
      if (!g || g.status === 'revoked' || g.status === 'expired') return null
      return { ...g }
    },
    grants: ({ agent } = {}) => [...grants.values()].filter(g => !agent || g.agent === agent).map(g => ({ ...g })),
    recordSpend: (grantId, row) => {
      v.spend.push({ grant_id: grantId, ...row })
      const g = [...grants.values()].find(x => x.id === grantId)
      if (row.actual_usd) g.spent_usd += row.actual_usd
    },
    spentToday: grantId => v.spend.filter(r => r.grant_id === grantId && !r.refused).reduce((a, r) => a + (r.actual_usd ?? r.estimate_usd), 0),
    setStatus: (grantId, status, actor) => {
      v.statusCalls.push({ grantId, status, actor })
      const g = [...grants.values()].find(x => x.id === grantId)
      g.status = status
    },
    add(handle, over = {}) {
      const g = {
        id: grants.size + 1, request_id: 1, agent: 'claude-code/main', secret: 'openai-main',
        scope_json: JSON.stringify({ models: ['gpt-4o-mini'], endpoints: ['chat/completions', 'responses'] }),
        per_request_usd: 1, daily_usd: 2, total_usd: 5, rate_per_min: 30, spent_usd: 0,
        expires: new Date(Date.now() + 86_400_000).toISOString(), status: 'active', created: 'x', ...over,
      }
      grants.set(handle, g)
      return g
    },
  }
  return v
}

// The stub provider. Records what it receives and answers per path.
let upstream, upBase, seen, reply
// The proxy under test, wired like routes.js would.
let proxyServer, base, vault, notes

before(async () => {
  upstream = http.createServer((req, res) => {
    const parts = []
    req.on('data', c => parts.push(c))
    req.on('end', () => {
      seen.push({ url: req.url, headers: req.headers, body: Buffer.concat(parts).toString() })
      reply(req, res)
    })
  })
  await new Promise(r => upstream.listen(0, '127.0.0.1', r))
  upBase = `http://127.0.0.1:${upstream.address().port}`
  proxyServer = http.createServer((req, res) => handleProxy(req, res, vault, {
    notify: n => notes.push(n),
    upstream: { openai: upBase, gemini: upBase },
  }))
  await new Promise(r => proxyServer.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${proxyServer.address().port}`
})

after(() => {
  upstream.close()
  proxyServer.close()
})

beforeEach(() => {
  vault = fakeVault()
  seen = []
  notes = []
  reply = (req, res) => json(res, 200, { id: 'x', choices: [], usage: { prompt_tokens: 1000, completion_tokens: 500 } })
})

const json = (res, status, obj, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(JSON.stringify(obj))
}

const chat = (body = {}) => JSON.stringify({ model: 'gpt-4o-mini', max_tokens: 1000, messages: [{ role: 'user', content: 'hi' }], ...body })

async function call(path, { handle = 'pvh_a', body = chat(), headers = {} } = {}) {
  const r = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(handle ? { authorization: `Bearer ${handle}` } : {}), ...headers },
    body,
  })
  const text = await r.text()
  return { status: r.status, headers: Object.fromEntries(r.headers), text, json: tryJson(text) }
}
const tryJson = t => { try { return JSON.parse(t) } catch { return null } }

// Nothing the client gets, and nothing passed to the store or notify, holds a key.
function assertClean(r) {
  const all = JSON.stringify(r) + JSON.stringify(vault.spend) + JSON.stringify(vault.statusCalls) + JSON.stringify(notes)
  assert.ok(!all.includes(SECRET), 'openai key leaked')
  assert.ok(!all.includes(GKEY), 'gemini key leaked')
}

// What the stub provider got never holds the handle.
function assertNoHandleUpstream() {
  for (const s of seen) assert.ok(!JSON.stringify(s).includes('pvh_'), 'handle reached the provider')
}

// Refusals

async function refused(r, status, reason) {
  assert.equal(r.status, status)
  assert.equal(r.json.reason, reason)
  assert.equal(seen.length, 0, 'provider was called')
  assertClean(r)
}

test('unknown or missing handle is refused before anything else', async () => {
  vault.add('pvh_a')
  await refused(await call('/vault/proxy/openai/v1/chat/completions', { handle: 'pvh_nope' }), 403, 'unknown_handle')
  await refused(await call('/vault/proxy/openai/v1/chat/completions', { handle: null }), 403, 'missing_handle')
  await refused(await call('/vault/proxy/openai/v1/chat/completions', { handle: SECRET }), 403, 'missing_handle')
  assert.equal(vault.spend.length, 0)
})

test('unknown provider is 404', async () => {
  vault.add('pvh_a')
  const r = await call('/vault/proxy/anthropic/v1/messages')
  assert.equal(r.status, 404)
  assertClean(r)
})

test('wrong provider is refused and recorded', async () => {
  vault.add('pvh_a')
  const r = await call('/vault/proxy/gemini/v1beta/models/gpt-4o-mini:generateContent', { body: '{}' })
  await refused(r, 403, 'wrong_provider')
  assert.equal(vault.spend[0].refused, 'wrong_provider')
})

test('endpoint and model out of scope are refused', async () => {
  vault.add('pvh_a', { scope_json: JSON.stringify({ models: ['gpt-4o-mini'], endpoints: ['chat/completions'] }) })
  await refused(await call('/vault/proxy/openai/v1/responses'), 403, 'endpoint_not_in_scope')
  await refused(await call('/vault/proxy/openai/v1/embeddings'), 403, 'endpoint_not_supported')
  await refused(await call('/vault/proxy/openai/v1/chat/completions', { body: chat({ model: 'gpt-4o' }) }), 403, 'model_not_in_scope')
  assert.deepEqual(vault.spend.map(s => s.refused), ['endpoint_not_in_scope', 'endpoint_not_supported', 'model_not_in_scope'])
})

test('paused and expired grants are refused', async () => {
  vault.add('pvh_a', { status: 'paused' })
  vault.add('pvh_b', { expires: new Date(Date.now() - 1000).toISOString() })
  await refused(await call('/vault/proxy/openai/v1/chat/completions'), 403, 'grant_paused')
  await refused(await call('/vault/proxy/openai/v1/chat/completions', { handle: 'pvh_b' }), 403, 'grant_expired')
})

test('rate limit counts calls in the last minute', async () => {
  vault.add('pvh_a', { rate_per_min: 2 })
  assert.equal((await call('/vault/proxy/openai/v1/chat/completions')).status, 200)
  assert.equal((await call('/vault/proxy/openai/v1/chat/completions')).status, 200)
  seen = []
  await refused(await call('/vault/proxy/openai/v1/chat/completions'), 403, 'rate_limited')
})

test('per-request cap refuses a big worst case, with a hint when no max is set', async () => {
  vault.add('pvh_a', { per_request_usd: 0.0001 })
  await refused(await call('/vault/proxy/openai/v1/chat/completions'), 402, 'over_per_request_cap')
  const r = await call('/vault/proxy/openai/v1/chat/completions', { body: JSON.stringify({ model: 'gpt-4o-mini', messages: [] }) })
  await refused(r, 402, 'over_per_request_cap')
  assert.match(r.json.hint, /max tokens/)
})

test('daily cap counts what was spent today', async () => {
  vault.add('pvh_a', { daily_usd: 0.002 })
  vault.spend.push({ grant_id: 1, actual_usd: 0.0019, estimate_usd: 0.0019, refused: null })
  await refused(await call('/vault/proxy/openai/v1/chat/completions'), 402, 'over_daily_cap')
})

test('total cap counts all spend', async () => {
  vault.add('pvh_a', { total_usd: 0.002, spent_usd: 0.0019 })
  await refused(await call('/vault/proxy/openai/v1/chat/completions'), 402, 'over_total_cap')
})

test('locked vault answers 503 without calling the provider', async () => {
  vault.add('pvh_a')
  vault.isUnlocked = false
  await refused(await call('/vault/proxy/openai/v1/chat/completions'), 503, 'vault_locked')
})

test('bad JSON is refused', async () => {
  vault.add('pvh_a')
  await refused(await call('/vault/proxy/openai/v1/chat/completions', { body: 'not json' }), 400, 'bad_json')
})

// Forwarding and metering

test('openai chat: real key upstream, handle never, usage metered', async () => {
  vault.add('pvh_a')
  const r = await call('/vault/proxy/openai/v1/chat/completions', { headers: { 'x-forwarded-for': '1.2.3.4', cookie: 'a=b', 'openai-beta': 'x' } })
  assert.equal(r.status, 200)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].url, '/v1/chat/completions')
  assert.equal(seen[0].headers.authorization, `Bearer ${SECRET}`)
  assert.equal(seen[0].headers['openai-beta'], 'x')
  assert.equal(seen[0].headers['x-forwarded-for'], undefined)
  assert.equal(seen[0].headers.cookie, undefined)
  assert.equal(seen[0].body, chat(), 'body forwarded unchanged')
  assertNoHandleUpstream()
  const want = actual('openai', 'gpt-4o-mini', { prompt_tokens: 1000, completion_tokens: 500 })
  assert.equal(vault.spend.length, 1)
  assert.equal(vault.spend[0].actual_usd, want)
  assert.equal(vault.spend[0].refused, null)
  assert.ok(vault.spend[0].estimate_usd >= want)
  assertClean(r)
})

test('openai SDK base URL without v1 also works', async () => {
  vault.add('pvh_a')
  const r = await call('/vault/proxy/openai/chat/completions')
  assert.equal(r.status, 200)
  assert.equal(seen[0].url, '/v1/chat/completions')
})

test('openai chat stream with include_usage reads the final chunk', async () => {
  vault.add('pvh_a')
  const events = [
    { choices: [{ delta: { content: 'Hel' } }] },
    { choices: [{ delta: { content: 'lo' } }] },
    { choices: [], usage: { prompt_tokens: 200, completion_tokens: 40 } },
  ]
  reply = (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`)
    res.end('data: [DONE]\n\n')
  }
  const r = await call('/vault/proxy/openai/v1/chat/completions', { body: chat({ stream: true, stream_options: { include_usage: true } }) })
  assert.equal(r.status, 200)
  assert.match(r.headers['content-type'], /event-stream/)
  assert.ok(r.text.includes('[DONE]') && r.text.includes('Hel'))
  assert.equal(vault.spend[0].actual_usd, actual('openai', 'gpt-4o-mini', { prompt_tokens: 200, completion_tokens: 40 }))
})

test('stream without usage is charged the estimate', async () => {
  vault.add('pvh_a')
  reply = (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end('data: {"choices":[]}\n\ndata: [DONE]\n\n')
  }
  await call('/vault/proxy/openai/v1/chat/completions', { body: chat({ stream: true }) })
  assert.equal(vault.spend[0].actual_usd, vault.spend[0].estimate_usd)
})

test('openai responses stream reads response.completed', async () => {
  vault.add('pvh_a')
  reply = (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hi"}\n\n')
    res.end('event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":300,"output_tokens":70}}}\n\n')
  }
  const r = await call('/vault/proxy/openai/v1/responses', { body: JSON.stringify({ model: 'gpt-4o-mini', input: 'hi', max_output_tokens: 100, stream: true }) })
  assert.equal(r.status, 200)
  assert.equal(seen[0].url, '/v1/responses')
  assert.equal(vault.spend[0].actual_usd, actual('openai', 'gpt-4o-mini', { input_tokens: 300, output_tokens: 70 }))
})

test('upstream error with no usage costs nothing and passes through', async () => {
  vault.add('pvh_a')
  reply = (req, res) => json(res, 429, { error: { message: 'slow down' } }, { 'retry-after': '3', 'set-cookie': 'x=y' })
  const r = await call('/vault/proxy/openai/v1/chat/completions')
  assert.equal(r.status, 429)
  assert.equal(r.headers['retry-after'], '3')
  assert.equal(r.headers['set-cookie'], undefined)
  assert.equal(vault.spend[0].actual_usd, 0)
  assert.equal(vault.spend[0].status, 429)
})

test('the key is scrubbed if the provider echoes it, even split across chunks', async () => {
  vault.add('pvh_a')
  reply = (req, res) => {
    res.writeHead(500, { 'content-type': 'application/json', 'x-echo': req.headers.authorization })
    const msg = JSON.stringify({ error: { message: `Incorrect API key provided: ${req.headers.authorization}` } })
    const cut = msg.indexOf('PLANTED')
    res.write(msg.slice(0, cut))
    setTimeout(() => res.end(msg.slice(cut)), 20)
  }
  const r = await call('/vault/proxy/openai/v1/chat/completions')
  assert.equal(r.status, 500)
  assert.equal(r.headers['x-echo'], undefined)
  assert.ok(r.text.includes('[redacted]'))
  assertClean(r)
})

test('upstream network failure is a plain 502', async () => {
  vault.add('pvh_a')
  const r = await new Promise(resolve => {
    const s = http.createServer((req, res) => handleProxy(req, res, vault, {
      fetchFn: async (url, init) => { throw new Error(`connect failed ${init.headers.authorization}`) },
    }))
    s.listen(0, '127.0.0.1', async () => {
      const res = await fetch(`http://127.0.0.1:${s.address().port}/vault/proxy/openai/v1/chat/completions`, {
        method: 'POST', headers: { authorization: 'Bearer pvh_a' }, body: chat(),
      })
      const text = await res.text()
      s.close()
      resolve({ status: res.status, text, headers: Object.fromEntries(res.headers) })
    })
  })
  assert.equal(r.status, 502)
  assert.equal(JSON.parse(r.text).reason, 'upstream_failed')
  assert.equal(vault.spend[0].refused, 'upstream_failed')
  assertClean(r)
})

test('fetchFn stub gets the real key and the provider URL', async () => {
  vault.add('pvh_a')
  const got = []
  const s = http.createServer((req, res) => handleProxy(req, res, vault, {
    fetchFn: async (url, init) => {
      got.push({ url, init })
      return new Response(JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 1 } }), { headers: { 'content-type': 'application/json' } })
    },
  }))
  await new Promise(r => s.listen(0, '127.0.0.1', r))
  const res = await fetch(`http://127.0.0.1:${s.address().port}/vault/proxy/openai/v1/chat/completions`, {
    method: 'POST', headers: { authorization: 'Bearer pvh_a' }, body: chat(),
  })
  await res.text()
  s.close()
  assert.equal(got[0].url, 'https://api.openai.com/v1/chat/completions')
  assert.equal(got[0].init.headers.authorization, `Bearer ${SECRET}`)
})

// Gemini

const gscope = { secret: 'gemini', scope_json: JSON.stringify({ models: ['gemini-2.5-flash'], endpoints: ['generateContent', 'streamGenerateContent'] }) }
const gbody = JSON.stringify({ contents: [{ parts: [{ text: 'hi' }] }], generationConfig: { maxOutputTokens: 500 } })

test('gemini generateContent with x-goog-api-key handle', async () => {
  vault.add('pvh_g', gscope)
  reply = (req, res) => json(res, 200, { candidates: [], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50, thoughtsTokenCount: 20 } })
  const r = await call('/vault/proxy/gemini/v1beta/models/gemini-2.5-flash:generateContent', { handle: null, body: gbody, headers: { 'x-goog-api-key': 'pvh_g' } })
  assert.equal(r.status, 200)
  assert.equal(seen[0].url, '/v1beta/models/gemini-2.5-flash:generateContent')
  assert.equal(seen[0].headers['x-goog-api-key'], GKEY)
  assert.equal(seen[0].headers.authorization, undefined)
  assertNoHandleUpstream()
  assert.equal(vault.spend[0].actual_usd, actual('gemini', 'gemini-2.5-flash', { promptTokenCount: 100, candidatesTokenCount: 50, thoughtsTokenCount: 20 }))
  assertClean(r)
})

test('gemini streamGenerateContent with ?key= handle and alt=sse', async () => {
  vault.add('pvh_g', gscope)
  reply = (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ candidates: [], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 5 } })}\r\n\r\n`)
    res.end(`data: ${JSON.stringify({ candidates: [], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 60 } })}\r\n\r\n`)
  }
  const r = await call('/vault/proxy/gemini/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse&key=pvh_g', { handle: null, body: gbody })
  assert.equal(r.status, 200)
  assert.equal(seen[0].url, '/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse')
  assertNoHandleUpstream()
  assert.equal(vault.spend[0].actual_usd, actual('gemini', 'gemini-2.5-flash', { promptTokenCount: 100, candidatesTokenCount: 60 }))
})

test('gemini stream as a JSON array uses the last usageMetadata', async () => {
  vault.add('pvh_g', gscope)
  reply = (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.write('[{"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":1}}\n')
    res.end(',{"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":30}}]')
  }
  await call('/vault/proxy/gemini/v1beta/models/gemini-2.5-flash:streamGenerateContent', { handle: null, body: gbody, headers: { 'x-goog-api-key': 'pvh_g' } })
  assert.equal(vault.spend[0].actual_usd, actual('gemini', 'gemini-2.5-flash', { promptTokenCount: 10, candidatesTokenCount: 30 }))
})

test('gemini model out of scope is refused from the path', async () => {
  vault.add('pvh_g', gscope)
  await refused(await call('/vault/proxy/gemini/v1beta/models/gemini-2.5-pro:generateContent', { handle: null, body: gbody, headers: { 'x-goog-api-key': 'pvh_g' } }), 403, 'model_not_in_scope')
})

// Pausing

test('pauses at 80% of the total cap and notifies once', async () => {
  const usage = { prompt_tokens: 1000, completion_tokens: 500 }
  const cost = actual('openai', 'gpt-4o-mini', usage)
  vault.add('pvh_a', { total_usd: 1, spent_usd: 0.8 - cost / 2 })
  const r = await call('/vault/proxy/openai/v1/chat/completions')
  assert.equal(r.status, 200)
  assert.deepEqual(vault.statusCalls, [{ grantId: 1, status: 'paused', actor: 'proxy' }])
  assert.equal(notes.length, 1)
  assert.equal(notes[0].cap, 'total')
  assert.equal(notes[0].grant_id, 1)
  seen = []
  await refused(await call('/vault/proxy/openai/v1/chat/completions'), 403, 'grant_paused')
  assert.equal(notes.length, 1)
  assertClean(r)
})

test('pauses at 80% of the daily cap', async () => {
  vault.add('pvh_a', { daily_usd: 0.0009 })
  reply = (req, res) => json(res, 200, { usage: { prompt_tokens: 1000, completion_tokens: 1000 } })
  await call('/vault/proxy/openai/v1/chat/completions')
  assert.equal(vault.statusCalls[0]?.status, 'paused')
  assert.equal(notes[0].cap, 'daily')
})

test('no pause below 80%', async () => {
  vault.add('pvh_a')
  await call('/vault/proxy/openai/v1/chat/completions')
  assert.equal(vault.statusCalls.length, 0)
  assert.equal(notes.length, 0)
})

// Pricing and helpers

test('pricing: exact, dated and unknown models', () => {
  assert.equal(priceFor('openai', 'gpt-4o-mini'), PRICES.openai['gpt-4o-mini'])
  assert.equal(priceFor('openai', 'gpt-4o-mini-2024-07-18'), PRICES.openai.default) // dated snapshots are not mapped to the base price
  assert.equal(priceFor('openai', 'gpt-5-pro'), PRICES.openai['gpt-5-pro'])
  assert.equal(priceFor('openai', 'gpt-9-ultra'), PRICES.openai.default)
  assert.equal(priceFor('gemini', 'models/gemini-2.5-flash'), PRICES.gemini['gemini-2.5-flash'])
  assert.equal(priceFor('gemini', 'gemini-robotics-er-2'), PRICES.gemini.default)
  for (const p of ['openai', 'gemini']) {
    const top = Math.max(...Object.entries(PRICES[p]).filter(([k]) => !['default', 'o1-pro'].includes(k)).map(([, v]) => v.output))
    assert.ok(PRICES[p].default.output >= top, `${p} default errs high`)
  }
})

test('estimate covers the max output, choices and media', () => {
  const small = estimate('openai', 'gpt-4o-mini', { model: 'gpt-4o-mini', max_tokens: 100, messages: [] })
  const many = estimate('openai', 'gpt-4o-mini', { model: 'gpt-4o-mini', max_tokens: 100, n: 4, messages: [] })
  const none = estimate('openai', 'gpt-4o-mini', { model: 'gpt-4o-mini', messages: [] })
  assert.ok(many > small * 3 && none > many)
  const img = 'A'.repeat(500_000)
  const withImage = estimate('gemini', 'gemini-2.5-flash', { contents: [{ parts: [{ inlineData: { mimeType: 'image/png', data: img } }] }], generationConfig: { maxOutputTokens: 100 } })
  // One image should not cost as if each byte were text.
  assert.ok(withImage < (img.length / 3) * PRICES.gemini['gemini-2.5-flash'].input / 1e6)
  assert.ok(withImage > 3000 * PRICES.gemini['gemini-2.5-flash'].input / 1e6)
  assert.ok(actual('openai', 'gpt-4o-mini', { prompt_tokens: 1, completion_tokens: 100 }) <= small)
  assert.equal(actual('openai', 'gpt-4o-mini', null), null)
})

test('redactor removes the key across any chunk split', () => {
  const text = `before ${SECRET} middle ${SECRET}${SECRET} after sk-PLAN`
  for (let cut = 0; cut < text.length; cut++) {
    const r = redactor(SECRET)
    const out = Buffer.concat([r.push(Buffer.from(text.slice(0, cut))), r.push(Buffer.from(text.slice(cut))), r.end()]).toString()
    assert.ok(!out.includes(SECRET))
    assert.ok(out.startsWith('before [redacted] middle [redacted][redacted] after sk-PLAN'))
  }
})

test('usage scanner reads the last usage from SSE split mid-line', () => {
  const s = usageScanner('openai')
  const body = 'data: {"usage":{"prompt_tokens":1,"completion_tokens":2}}\n\ndata: {"usage":{"prompt_tokens":3,"completion_tokens":4}}\n\ndata: [DONE]\n\n'
  s.push(Buffer.from(body.slice(0, 40)))
  s.push(Buffer.from(body.slice(40)))
  assert.deepEqual(s.end(), { prompt_tokens: 3, completion_tokens: 4 })
})
