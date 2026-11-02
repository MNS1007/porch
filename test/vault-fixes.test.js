// Regression tests for the red-team findings on the vault. Each block names the
// finding it covers. Real store on a temp vault.db, real proxy and page server,
// stub providers on random ports. No real key is ever used.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/db.js'
import { openVault } from '../src/vault/store.js'
import { handleProxy } from '../src/vault/proxy.js'
import { vaultServer } from '../src/vault/routes.js'
import { vaultAgentApi } from '../src/vault/agent-api.js'
import { estimate, actual, priceFor, PRICES } from '../src/vault/pricing.js'

const PLANTED = 'sk-PLANTED-SECRET-123'
const GKEY = 'AIza-PLANTED-SECRET-456'
const PASS = 'correct horse battery'

let dir, vault, up, upBase, thief, thiefBase, proxySrv, base
let reply, upSeen, thiefSeen, notes
const outputs = [] // everything a client or the owner got back, for the leak scan
const logs = []
const origLog = { log: console.log, error: console.error, warn: console.warn }

const listen = srv => new Promise(r => srv.listen(0, '127.0.0.1', r))
const sleep = ms => new Promise(r => setTimeout(r, ms))

function recorder(list, answer) {
  return http.createServer((req, res) => {
    const parts = []
    req.on('data', c => parts.push(c))
    req.on('end', () => {
      list.push({ url: req.url, headers: { ...req.headers }, body: Buffer.concat(parts).toString() })
      answer(req, res)
    })
  })
}

before(async () => {
  for (const k of Object.keys(origLog)) console[k] = (...a) => logs.push(a.map(String).join(' '))
  dir = mkdtempSync(join(tmpdir(), 'porch-vault-fixes-'))
  vault = openVault(join(dir, 'vault.db'), { dpapi: false })
  vault.setUp(PASS)
  vault.unlock(PASS)
  vault.putSecret('openai-main', 'openai', PLANTED, 'owner')
  vault.putSecret('gemini', 'gemini', GKEY, 'owner')
  up = recorder(upSeen = [], (req, res) => reply(req, res))
  thief = recorder(thiefSeen = [], (req, res) => { res.writeHead(200); res.end('{}') })
  await listen(up)
  await listen(thief)
  upBase = `http://127.0.0.1:${up.address().port}`
  thiefBase = `http://127.0.0.1:${thief.address().port}`
  proxySrv = http.createServer((req, res) => handleProxy(req, res, vault, { notify: n => notes.push(n), upstream: { openai: upBase, gemini: upBase } }))
  await listen(proxySrv)
  base = `http://127.0.0.1:${proxySrv.address().port}`
})

after(() => {
  Object.assign(console, origLog)
  for (const s of [up, thief, proxySrv]) { s.close(); s.closeAllConnections() }
  vault.close()
  try { rmSync(dir, { recursive: true, force: true }) } catch {}
})

beforeEach(() => {
  upSeen.length = 0
  thiefSeen.length = 0
  notes = []
  reply = (req, res) => json(res, 200, { choices: [], usage: { prompt_tokens: 10, completion_tokens: 10 } })
})

const json = (res, status, obj, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(JSON.stringify(obj))
}

// A fresh approved grant; returns its handle and id.
let n = 0
function grant({ secret = 'openai-main', models = ['gpt-4.1-mini'], endpoints = ['chat/completions', 'responses'], budget = {} } = {}) {
  const r = vault.createRequest({
    agent: `claude-code/t${++n}`, secret, purpose: 'tests', scope: { models, endpoints },
    budget: { per_request_usd: 5, daily_usd: 50, total_usd: 100, rate_per_min: 60, days: 1, ...budget }, replaces_grant: null,
  })
  const out = vault.decide(r.id, { approve: true }, 'owner')
  return { handle: out.handle, id: out.grant.id }
}

async function call(path, handle, body, headers = {}) {
  const r = await fetch(base + path, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${handle}`, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
  const text = await r.text()
  outputs.push(text, JSON.stringify([...r.headers]))
  let j = null
  try { j = JSON.parse(text) } catch {}
  return { status: r.status, text, json: j }
}
const chat = (over = {}) => ({ model: 'gpt-4.1-mini', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }], ...over })
const OPENAI = '/vault/proxy/openai/v1/chat/completions'
const RESPONSES = '/vault/proxy/openai/v1/responses'
const GEMINI = '/vault/proxy/gemini/v1beta/models/gemini-2.5-flash:generateContent'
const GEMINI_STREAM = '/vault/proxy/gemini/v1beta/models/gemini-2.5-pro:streamGenerateContent'

// Finding: the proxy followed redirects, so the Gemini key went to another host.
test('an upstream redirect is never followed, so no key reaches another host', async () => {
  reply = (req, res) => { res.writeHead(307, { location: thiefBase + '/steal' }); res.end() }
  const g = grant({ secret: 'gemini', models: ['gemini-2.5-flash'], endpoints: ['generateContent'] })
  const r = await call(GEMINI, g.handle, { contents: [{ parts: [{ text: 'hi' }] }], generationConfig: { maxOutputTokens: 10 } }, { authorization: '', 'x-goog-api-key': g.handle })
  assert.equal(r.status, 502)
  assert.equal(r.json.reason, 'upstream_redirect')
  assert.equal(thiefSeen.length, 0, 'the redirect target was called')
  assert.ok(!r.text.includes(thiefBase), 'the redirect target was passed on')
  const o = grant()
  const r2 = await call(OPENAI, o.handle, chat())
  assert.equal(r2.status, 502)
  assert.equal(thiefSeen.length, 0)
})

// Finding: OpenAI's masked-key error text passed through.
test('an upstream 401 or 403 body is replaced with a fixed error', async () => {
  reply = (req, res) => json(res, 401, { error: { message: `Incorrect API key provided: sk-PL****-123. ${PLANTED}` } })
  const g = grant()
  const r = await call(OPENAI, g.handle, chat())
  assert.equal(r.status, 401)
  assert.equal(r.json.error, 'upstream_auth_failed')
  assert.ok(!r.text.includes('****') && !r.text.includes('-123'), 'masked key passed through')
  reply = (req, res) => json(res, 403, { error: { message: 'key ****-456 has no access' } })
  const r2 = await call(OPENAI, g.handle, chat())
  assert.equal(r2.status, 403)
  assert.ok(!r2.text.includes('****'))
})

// Finding: long text without spaces was counted as a media blob.
test('a long text string is counted as text, not as a media blob', () => {
  const s = 'QUJD'.repeat(632_500) // 2.53M base64-alphabet characters
  const est = estimate('openai', 'gpt-4.1', { model: 'gpt-4.1', max_tokens: 16, messages: [{ role: 'user', content: s }] })
  assert.ok(est > 1.6, `estimate ${est} undercounts the text`)
  const parts = estimate('gemini', 'gemini-2.5-flash', { contents: [{ parts: [{ text: s }] }], generationConfig: { maxOutputTokens: 1 } })
  assert.ok(parts > 0.25, `gemini text estimate ${parts} undercounts`)
  // Real media in a media field still counts as media, so images are not refused.
  const img = 'A'.repeat(400_000)
  const withImg = estimate('gemini', 'gemini-2.5-flash', { contents: [{ parts: [{ inlineData: { mimeType: 'image/png', data: img } }] }], generationConfig: { maxOutputTokens: 100 } })
  assert.ok(withImg < 0.01, `image estimate ${withImg} too high`)
  const dataUrl = estimate('openai', 'gpt-4.1-mini', chat({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,' + img } }] }] }))
  assert.ok(dataUrl < 0.01, `data URL estimate ${dataUrl} too high`)
  // A text "data:" prefix outside a media field does not make text cheap.
  const fake = estimate('openai', 'gpt-4.1', { model: 'gpt-4.1', max_tokens: 16, messages: [{ role: 'user', content: 'data:image/png;base64,' + s }] })
  assert.ok(fake > 1.6, `data: text estimate ${fake} undercounts`)
  // A linked image gets at least the image allowance, not the link's length.
  const linked = estimate('openai', 'gpt-4.1', { model: 'gpt-4.1', max_tokens: 1, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://x.test/a.png' } }] }] })
  assert.ok(linked >= 3000 * 2 / 1e6, `linked image estimate ${linked}`)
  // A PDF or text blob counts on its decoded size, as text.
  const pdf = estimate('gemini', 'gemini-2.5-flash', { contents: [{ parts: [{ inlineData: { mimeType: 'text/plain', data: img } }] }], generationConfig: { maxOutputTokens: 1 } })
  assert.ok(pdf > 0.025, `inline text blob estimate ${pdf} undercounts`)
})

// Finding (critical): stored or linked input and paid tools got past the caps.
test('input the estimate cannot see, and paid tools, are refused before forwarding', async () => {
  const g = grant()
  const bad = [
    [RESPONSES, { model: 'gpt-4.1-mini', previous_response_id: 'resp_big', input: 'continue', max_output_tokens: 16 }],
    [RESPONSES, { model: 'gpt-4.1-mini', conversation: 'conv_1', input: 'go', max_output_tokens: 16 }],
    [RESPONSES, { model: 'gpt-4.1-mini', prompt: { id: 'pmpt_1' }, max_output_tokens: 16 }],
    [RESPONSES, { model: 'gpt-4.1-mini', input: [{ role: 'user', content: [{ type: 'input_file', file_id: 'file_1' }] }], max_output_tokens: 16 }],
    [RESPONSES, { model: 'gpt-4.1-mini', input: [{ role: 'user', content: [{ type: 'input_file', file_url: 'https://x.test/a.pdf' }] }], max_output_tokens: 16 }],
    [OPENAI, chat({ messages: [{ role: 'user', content: [{ type: 'file', file: { file_id: 'file_1' } }] }] })],
    [RESPONSES, { model: 'gpt-4.1-mini', input: 'x', tools: [{ type: 'web_search' }], max_output_tokens: 16 }],
    [RESPONSES, { model: 'gpt-4.1-mini', input: 'x', tools: [{ type: 'code_interpreter', container: { type: 'auto' } }], max_output_tokens: 16 }],
    [OPENAI, chat({ web_search_options: {} })],
  ]
  for (const [path, body] of bad) {
    const r = await call(path, g.handle, body)
    assert.equal(r.status, 403, JSON.stringify(body))
    assert.equal(r.json.reason, 'unsupported_input', JSON.stringify(body))
  }
  const gg = grant({ secret: 'gemini', models: ['gemini-2.5-flash'], endpoints: ['generateContent'] })
  const gbad = [
    { contents: [{ parts: [{ fileData: { fileUri: 'https://youtube.com/watch?v=x', mimeType: 'video/mp4' } }] }] },
    { contents: [{ parts: [{ text: 'x' }] }], cachedContent: 'cachedContents/abc' },
    { contents: [{ parts: [{ text: 'x' }] }], tools: [{ googleSearch: {} }] },
    { contents: [{ parts: [{ text: 'x' }] }], tools: [{ codeExecution: {} }] },
    { contents: [{ parts: [{ text: 'x' }] }], tools: [{ urlContext: {} }] },
  ]
  for (const body of gbad) {
    const r = await call(GEMINI, gg.handle, { ...body, generationConfig: { maxOutputTokens: 10 } })
    assert.equal(r.status, 403, JSON.stringify(body))
    assert.equal(r.json.reason, 'unsupported_input')
  }
  assert.equal(upSeen.length, 0, 'a refused call reached the provider')
  // Function tools and inline images still work.
  const ok = await call(OPENAI, g.handle, chat({ tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object' } } }] }))
  assert.equal(ok.status, 200)
  const okg = await call(GEMINI, gg.handle, { contents: [{ parts: [{ text: 'x' }] }], tools: [{ functionDeclarations: [{ name: 'f' }] }], generationConfig: { maxOutputTokens: 10 } })
  assert.equal(okg.status, 200)
})

// Finding: priority tier and audio input were priced at the standard rate.
test('priority tier is refused, and Gemini audio is priced at the audio rate', async () => {
  const g = grant()
  const r = await call(OPENAI, g.handle, chat({ service_tier: 'priority' }))
  assert.equal(r.status, 403)
  assert.equal(r.json.reason, 'unsupported_service_tier')
  for (const tier of ['auto', 'default', 'flex']) assert.equal((await call(OPENAI, g.handle, chat({ service_tier: tier }))).status, 200)
  const text = actual('gemini', 'gemini-2.5-flash', { promptTokenCount: 1e6, candidatesTokenCount: 0 })
  const heard = actual('gemini', 'gemini-2.5-flash', { promptTokenCount: 1e6, candidatesTokenCount: 0, promptTokensDetails: [{ modality: 'AUDIO', tokenCount: 1e6 }] })
  assert.ok(Math.abs(text - 0.3) < 1e-9)
  assert.ok(Math.abs(heard - 1) < 1e-9, `audio metered at ${heard}`)
  const clip = 'A'.repeat(400_000)
  const asAudio = estimate('gemini', 'gemini-2.5-flash', { contents: [{ parts: [{ inlineData: { mimeType: 'audio/ogg', data: clip } }] }], generationConfig: { maxOutputTokens: 1 } })
  const asImage = estimate('gemini', 'gemini-2.5-flash', { contents: [{ parts: [{ inlineData: { mimeType: 'image/png', data: clip } }] }], generationConfig: { maxOutputTokens: 1 } })
  assert.ok(asAudio > asImage * 3, `audio ${asAudio} vs image ${asImage}`)
})

// Finding: a date suffix mapped older snapshots to cheaper prices.
test('only exact model names get their own price; others get the most expensive row', () => {
  assert.deepEqual(priceFor('openai', 'gpt-4o-2024-05-13'), { input: 5, output: 15 })
  assert.equal(priceFor('openai', 'gpt-4o-mini-2024-07-18'), PRICES.openai.default)
  assert.equal(priceFor('openai', 'gpt-4.1-2025-04-14'), PRICES.openai.default)
  for (const p of Object.keys(PRICES)) {
    for (const [name, row] of Object.entries(PRICES[p])) {
      assert.ok(PRICES[p].default.input >= row.input && PRICES[p].default.output >= row.output, `${p} default is below ${name}`)
    }
  }
})

// Finding: the raw bytes went upstream, not the object that was checked.
test('the provider gets exactly the body that was checked', async () => {
  const g = grant()
  const raw = '{"model":"gpt-5-pro","model":"gpt-4.1-mini","max_tokens":100,"messages":[{"role":"user","content":"hi"}]}'
  const r = await call(OPENAI, g.handle, raw)
  assert.equal(r.status, 200)
  assert.equal(upSeen.length, 1)
  assert.ok(!upSeen[0].body.includes('gpt-5-pro'), 'unchecked model reached the provider')
  assert.equal(JSON.parse(upSeen[0].body).model, 'gpt-4.1-mini')
  const gg = grant({ secret: 'gemini', models: ['gemini-2.5-flash'], endpoints: ['generateContent'] })
  const r2 = await call(GEMINI, gg.handle, { model: 'gemini-2.5-pro', contents: [], generationConfig: { maxOutputTokens: 10 } })
  assert.equal(r2.status, 400)
  assert.equal(r2.json.reason, 'model_in_body')
  const low = estimate('gemini', 'gemini-2.5-flash', { generationConfig: { maxOutputTokens: 10 } })
  const think = estimate('gemini', 'gemini-2.5-flash', { generationConfig: { maxOutputTokens: 10, thinkingConfig: { thinking_budget: 100_000 } } })
  assert.ok(think > low + 0.2, 'thinking_budget not counted')
})

// Finding: an early client drop on a stream metered the partial usage.
test('a stream the client leaves early is charged at least the estimate', async () => {
  let release
  reply = (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ candidates: [], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1 } })}\r\n\r\n`)
    release = () => res.end()
  }
  const g = grant({ secret: 'gemini', models: ['gemini-2.5-pro'], endpoints: ['streamGenerateContent'] })
  const ac = new AbortController()
  const r = await fetch(base + GEMINI_STREAM + '?alt=sse', { method: 'POST', signal: ac.signal, headers: { 'content-type': 'application/json', 'x-goog-api-key': g.handle }, body: JSON.stringify({ contents: [{ parts: [{ text: 'hi' }] }] }) })
  const reader = r.body.getReader()
  await reader.read()
  ac.abort()
  for (let i = 0; i < 100; i++) {
    const row = vault.grants({}).find(x => x.id === g.id)
    if (row.spent_usd > 0) break
    await sleep(20)
  }
  release?.()
  const est = estimate('gemini', 'gemini-2.5-pro', { contents: [{ parts: [{ text: 'hi' }] }] })
  const spent = vault.grants({}).find(x => x.id === g.id).spent_usd
  assert.ok(spent >= est - 1e-9, `metered ${spent}, estimate ${est}`)
})

// Finding: a revoke did not stop calls that were still uploading.
test('a grant revoked while the body uploads is refused', async () => {
  const g = grant()
  const port = proxySrv.address().port
  const body = JSON.stringify(chat())
  const pending = new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: OPENAI, method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${g.handle}`, 'content-length': Buffer.byteLength(body) } }, res => {
      let t = ''
      res.on('data', c => { t += c })
      res.on('end', () => { outputs.push(t); resolve({ status: res.statusCode, json: JSON.parse(t) }) })
    })
    req.on('error', reject)
    req.write(body.slice(0, 5))
    setTimeout(() => { vault.revoke(g.id, 'owner'); req.end(body.slice(5)) }, 50)
  })
  const r = await pending
  assert.equal(r.status, 403)
  assert.equal(upSeen.length, 0, 'the revoked call reached the provider')
})

test('owner changes must keep per_request <= daily <= total', () => {
  const r = vault.createRequest({ agent: 'claude-code/caps', secret: 'openai-main', purpose: 'tests', scope: { models: ['gpt-4.1-mini'], endpoints: ['chat/completions'] }, budget: { per_request_usd: 1, daily_usd: 2, total_usd: 5, rate_per_min: 30, days: 1 } })
  assert.throws(() => vault.decide(r.id, { approve: true, changes: { daily_usd: 50 } }, 'owner'), /Caps must grow/)
  assert.equal(vault.listRequests({ status: 'pending' }).some(x => x.id === r.id), true)
})

// Finding: 5 wrong passphrases locked the owner out for a minute.
test('during the lockout a correct passphrase still unlocks, and the owner is told once', async () => {
  const told = []
  const srv = vaultServer({ vault, notify: x => told.push(x), port: 0 })
  await new Promise(r => srv.listen(0, r))
  const vb = `http://127.0.0.1:${srv.address().port}`
  try {
    assert.ok(srv.requestTimeout > 0 && srv.requestTimeout <= 120_000, `requestTimeout ${srv.requestTimeout}`)
    const tryPass = async passphrase => {
      const r = await fetch(vb + '/vault/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ passphrase }) })
      const t = await r.text()
      outputs.push(t)
      return r.status
    }
    for (let i = 0; i < 5; i++) assert.equal(await tryPass('wrong passphrase ' + i), 401)
    assert.equal(await tryPass('wrong again'), 429)
    assert.equal(await tryPass(PASS), 200)
    assert.equal(told.length, 1, 'the owner was not told about the lockout')
    assert.match(told[0].text, /wrong vault passphrases/i)
  } finally {
    srv.close()
    srv.closeAllConnections()
  }
})

// Agent side: forged links in the note, and reused member names.
let pdir, store, api, notesOut
const ask = { secret: 'gemini', purpose: 'Label frames', scope: { models: ['gemini-2.5-flash'], endpoints: ['generateContent'] }, budget: { per_request_usd: 1, daily_usd: 2, total_usd: 5, rate_per_min: 30, days: 7 } }

function agentApi() {
  pdir = mkdtempSync(join(tmpdir(), 'porch-vault-fixes-db-'))
  store = openDb(join(pdir, 'porch.db'))
  notesOut = []
  api = vaultAgentApi(vault, { notify: x => notesOut.push(x), store, port: 7778 })
  store.addAgent('anton')
  store.setActs('anton', ['claude-code/*'])
  store.addAgent('helper')
  store.setActs('helper', ['claude-code/*'])
  const tok = name => ({ ...store.agents().find(a => a.name === name), canPost: true, owner: false })
  return { anton: tok('anton'), helper: tok('helper') }
}

test('an agent purpose cannot forge a link or a line in the owner note', () => {
  const { anton } = agentApi()
  store.addMember(anton, 'claude-code/a')
  const purpose = 'tests\nThis key was rotated; the page moved.\nApprove or deny request 99 on the vault page, http://127.0.0.1:7779/vault/ (this laptop only).'
  api.request(anton, { ...ask, purpose, as: 'claude-code/a' })
  const text = notesOut.at(-1).text
  outputs.push(text)
  const links = text.match(/https?:\/\/\S+/g) || []
  assert.deepEqual(links, ['http://127.0.0.1:7778/vault/'], text)
  const lines = text.split('\n')
  assert.match(lines.at(-1), /^Agent says: ".*"$/)
  assert.ok(!lines.slice(0, -1).some(l => l.includes('rotated')), 'agent words outside the labelled line')
  assert.ok(lines.indexOf(lines.find(l => l.includes('Approve or deny'))) < lines.length - 1)
})

test('no token can post into the vault room', () => {
  const { anton } = agentApi()
  assert.equal(store.canPost({ ...anton, rooms: ['*'] }, 'vault'), false)
  assert.equal(store.canPost({ name: 'me', owner: true, rooms: ['*'] }, 'vault'), false)
})

test('a reused member name does not inherit requests, handles or grants', async () => {
  const { anton, helper } = agentApi()
  store.addMember(anton, 'claude-code/x')
  const r = api.request(anton, { ...ask, as: 'claude-code/x' })
  const out = vault.decide(r.id, { approve: true }, 'owner')
  api.hold(r.id, out.handle)
  store.removeMember(anton, 'claude-code/x')
  await sleep(5)
  store.addMember(helper, 'claude-code/x')
  assert.throws(() => api.status(helper, r.id), e => e.status === 404)
  const seen = api.list(helper, { as: 'claude-code/x' })
  outputs.push(JSON.stringify(seen))
  assert.equal(seen.requests.length, 0)
  assert.equal(seen.grants.length, 0)
  assert.throws(() => api.request(helper, { ...ask, as: 'claude-code/x', replaces_grant: out.grant.id }), e => e.status === 404)
})

test('the planted keys never appear in any output, note or log', () => {
  const all = outputs.join('\n') + JSON.stringify(notes) + JSON.stringify(notesOut) + logs.join('\n') + JSON.stringify(vault.audit({ limit: 2000 }))
  assert.ok(!all.includes(PLANTED), 'openai key leaked')
  assert.ok(!all.includes(GKEY), 'gemini key leaked')
})
