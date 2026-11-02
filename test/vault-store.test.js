import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspect } from 'node:util'
import { DatabaseSync } from 'node:sqlite'
import { openVault } from '../src/vault/store.js'
import { wrapKey, unwrapKey, encrypt, decrypt, newHandle, hashHandle } from '../src/vault/crypto.js'
import { randomBytes } from 'node:crypto'

const PLANTED = 'sk-PLANTED-SECRET-123'
const PASS = 'correct horse battery'
let dir, n = 0

before(() => { dir = mkdtempSync(join(tmpdir(), 'porch-vault-')) })
after(() => { try { rmSync(dir, { recursive: true, force: true }) } catch {} })

// A fresh vault per test, scrypt only so the suite does not start PowerShell each time.
function fresh() {
  const path = join(dir, `v${++n}.db`)
  const vault = openVault(path, { dpapi: false })
  vault.setUp(PASS)
  return { vault, path }
}

const request = (vault, extra = {}) => vault.createRequest({
  agent: 'claude-code/vision', secret: 'gemini', purpose: 'robot vision test',
  scope: { models: ['gemini-robotics-er-2'], endpoints: ['generateContent'] },
  budget: { per_request_usd: 1, daily_usd: 2, total_usd: 5, rate_per_min: 30, days: 7 },
  ...extra,
})

function approved(vault, changes) {
  vault.putSecret('gemini', 'gemini', PLANTED, 'owner')
  const req = request(vault)
  return vault.decide(req.id, { approve: true, note: 'ok', changes }, 'owner')
}

const noPlant = (what, label) => assert.ok(!inspect(what, { depth: 20, showHidden: true }).includes(PLANTED), `${label} leaks the value`)

test('crypto round-trips and rejects a wrong passphrase', () => {
  const key = randomBytes(32)
  const wrapped = wrapKey(key, PASS, { dpapi: false })
  assert.ok(wrapped.startsWith('scrypt:'))
  assert.deepEqual(unwrapKey(wrapped, PASS), key)
  assert.throws(() => unwrapKey(wrapped, 'wrong passphrase'), /could not unwrap/)
  const parts = encrypt(key, PLANTED)
  assert.ok(!parts.ciphertext.toString('latin1').includes(PLANTED))
  assert.equal(decrypt(key, parts), PLANTED)
  assert.throws(() => decrypt(randomBytes(32), parts), err => !String(err).includes(PLANTED))
  const h = newHandle()
  assert.match(h.handle, /^pvh_[A-Za-z0-9_-]{43}$/)
  assert.equal(h.hash, hashHandle(h.handle))
  assert.match(h.hash, /^[0-9a-f]{64}$/)
  assert.notEqual(newHandle().handle, h.handle)
})

test('DPAPI protects the wrapped key on Windows', { skip: process.platform !== 'win32' }, () => {
  const key = randomBytes(32)
  const wrapped = wrapKey(key, PASS, { dpapi: true })
  assert.ok(wrapped.startsWith('dpapi:'), 'DPAPI path was not taken')
  assert.deepEqual(unwrapKey(wrapped, PASS), key)
  assert.throws(() => unwrapKey(wrapped, 'wrong passphrase'))
})

test('unlock needs the right passphrase and lock forgets the key', () => {
  const { vault, path } = fresh()
  assert.equal(vault.isSetUp(), true)
  assert.throws(() => vault.setUp('another passphrase'), /already set up/)
  vault.lock()
  assert.equal(vault.unlocked(), false)
  assert.throws(() => vault.useSecret('x', v => v), /locked/)
  assert.equal(vault.unlock('wrong passphrase'), false)
  assert.equal(vault.unlocked(), false)
  assert.equal(vault.unlock(PASS), true)
  vault.close()
  // A second process starts locked.
  const again = openVault(path, { dpapi: false })
  assert.equal(again.unlocked(), false)
  assert.equal(again.unlock(PASS), true)
  const actions = again.audit({ limit: 20 }).map(r => r.action)
  assert.ok(actions.includes('vault.unlock_failed') && actions.includes('vault.setup'))
  again.close()
})

test('values only come back through useSecret, never in lists, rows or the file', async () => {
  const { vault, path } = fresh()
  const put = vault.putSecret('gemini', 'gemini', PLANTED, 'owner')
  assert.deepEqual(Object.keys(put).sort(), ['created', 'name', 'provider', 'rotated'])
  const list = vault.listSecrets()
  assert.equal(list.length, 1)
  noPlant(list, 'listSecrets')
  noPlant(vault, 'the vault object')
  assert.equal(vault.useSecret('gemini', v => v.length), PLANTED.length)
  assert.equal(await vault.useSecret('gemini', async v => v.startsWith('sk-')), true)
  assert.throws(() => vault.useSecret('missing', v => v), /no such secret/)
  // Errors that carry the value are replaced, sync and async.
  assert.throws(() => vault.useSecret('gemini', v => { throw new Error('bad key ' + v) }), err => {
    noPlant(err, 'sync error'); return /withheld/.test(err.message)
  })
  await assert.rejects(vault.useSecret('gemini', async v => { throw new Error(v) }), err => {
    noPlant(err, 'async error'); return true
  })
  // Errors without the value pass through unchanged.
  assert.throws(() => vault.useSecret('gemini', () => { throw new Error('upstream 500') }), /upstream 500/)
  // Rotation keeps one row and updates the value.
  vault.putSecret('gemini', 'gemini', PLANTED + '-2', 'owner')
  assert.equal(vault.useSecret('gemini', v => v.endsWith('-2')), true)
  assert.ok(vault.listSecrets()[0].rotated)
  noPlant(vault.audit({ limit: 100 }), 'audit rows')
  // Bad input errors never echo the value.
  assert.throws(() => vault.putSecret('Bad Name', 'gemini', PLANTED), err => { noPlant(err, 'name error'); return true })
  assert.throws(() => vault.putSecret('ok', 'nope', PLANTED), err => { noPlant(err, 'provider error'); return true })
  vault.close()
  for (const f of [path, path + '-wal']) {
    if (existsSync(f)) assert.ok(!readFileSync(f).includes(PLANTED), `${f} holds the value in the clear`)
  }
  const raw = new DatabaseSync(path)
  noPlant(raw.prepare('SELECT * FROM audit').all(), 'raw audit table')
  noPlant(raw.prepare('SELECT * FROM meta').all(), 'raw meta table')
  raw.close()
})

test('putSecret needs an unlocked vault and deleteSecret revokes its grants', () => {
  const { vault } = fresh()
  const { grant, handle } = approved(vault)
  vault.lock()
  assert.throws(() => vault.putSecret('other', 'openai', PLANTED), /locked/)
  vault.unlock(PASS)
  assert.equal(vault.deleteSecret('gemini', 'owner'), true)
  assert.equal(vault.listSecrets().length, 0)
  assert.equal(vault.grantForHandle(handle), null)
  assert.equal(vault.grant(grant.id).status, 'revoked')
  vault.close()
})

test('decide creates a grant, applies owner changes and returns the handle once', () => {
  const { vault, path } = fresh()
  const { grant, handle, request: req } = approved(vault, { budget: { daily_usd: 1 }, scope: { models: ['gemini-robotics-er-2'], endpoints: ['generateContent', 'countTokens'] } })
  assert.equal(req.status, 'approved')
  assert.match(handle, /^pvh_/)
  assert.equal(grant.daily_usd, 1)
  assert.equal(grant.per_request_usd, 1)
  assert.equal(grant.total_usd, 5)
  assert.deepEqual(grant.scope.endpoints, ['generateContent', 'countTokens'])
  assert.equal(grant.status, 'active')
  assert.equal('handle_hash' in grant, false)
  const days = (Date.parse(grant.expires) - Date.now()) / 86400000
  assert.ok(days > 6.9 && days <= 7)
  // No handle anywhere afterwards: not in grants(), the audit or the db.
  for (const g of vault.grants({ agent: 'claude-code/vision' })) assert.equal('handle_hash' in g, false)
  assert.ok(!JSON.stringify(vault.grants({})).includes(handle))
  assert.ok(!JSON.stringify(vault.audit({ limit: 100 })).includes(handle))
  noPlant(grant, 'grant')
  assert.throws(() => vault.decide(req.id, { approve: true }), /not pending/)
  // The stored hash is the SHA-256 of the handle.
  const raw = new DatabaseSync(path)
  assert.equal(raw.prepare('SELECT handle_hash FROM grants WHERE id = ?').get(grant.id).handle_hash, hashHandle(handle))
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM grants WHERE handle_hash = ?").get(handle).n, 0)
  raw.close()
  // Deny.
  const r2 = request(vault)
  assert.equal(vault.decide(r2.id, { approve: false, note: 'no' }).request.status, 'denied')
  assert.equal(vault.listRequests({ status: 'pending' }).length, 0)
  vault.close()
})

test('a replaces_grant request updates the grant in place with a new handle', () => {
  const { vault } = fresh()
  const first = approved(vault)
  vault.recordSpend(first.grant.id, { model: 'gemini-robotics-er-2', estimate_usd: 0.5, actual_usd: 0.25, status: 200 })
  const req = request(vault, { replaces_grant: first.grant.id, budget: { per_request_usd: 1, daily_usd: 3, total_usd: 10, rate_per_min: 30, days: 7 } })
  const next = vault.decide(req.id, { approve: true })
  assert.equal(next.grant.id, first.grant.id)
  assert.equal(next.grant.total_usd, 10)
  assert.equal(next.grant.spent_usd, 0.25)
  assert.notEqual(next.handle, first.handle)
  assert.equal(vault.grantForHandle(first.handle), null)
  assert.equal(vault.grantForHandle(next.handle).id, first.grant.id)
  assert.throws(() => request(vault, { agent: 'someone-else', replaces_grant: first.grant.id }), /replaces_grant/)
  vault.close()
})

test('grantForHandle looks up by hash, marks expiry, and drops revoked grants', () => {
  const { vault, path } = fresh()
  const { grant, handle } = approved(vault)
  const found = vault.grantForHandle(handle)
  assert.equal(found.id, grant.id)
  assert.equal(found.provider, 'gemini')
  assert.equal('handle_hash' in found, false)
  assert.equal(vault.grantForHandle('pvh_' + 'x'.repeat(43)), null)
  assert.equal(vault.grantForHandle(hashHandle(handle)), null)
  assert.equal(vault.grantForHandle(undefined), null)
  // Paused still resolves so the proxy can say why it refuses.
  vault.setStatus(grant.id, 'paused', 'vault')
  assert.equal(vault.grantForHandle(handle).status, 'paused')
  vault.setStatus(grant.id, 'active', 'owner')
  // Expiry: push expires into the past from outside.
  const raw = new DatabaseSync(path)
  raw.prepare('UPDATE grants SET expires = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), grant.id)
  raw.close()
  assert.equal(vault.grantForHandle(handle), null)
  assert.equal(vault.grant(grant.id).status, 'expired')
  assert.throws(() => vault.setStatus(grant.id, 'active'), /expired/)
  assert.ok(vault.audit({ limit: 5 }).some(r => r.action === 'grant.expire'))
  // Revoke.
  const second = vault.decide(request(vault).id, { approve: true })
  assert.ok(vault.grantForHandle(second.handle))
  vault.revoke(second.grant.id, 'owner')
  assert.equal(vault.grantForHandle(second.handle), null)
  assert.throws(() => vault.setStatus(second.grant.id, 'active'), /revoked/)
  vault.close()
})

test('recordSpend meters spent and spentToday counts only this UTC day', () => {
  const { vault, path } = fresh()
  const { grant } = approved(vault)
  vault.recordSpend(grant.id, { model: 'm', estimate_usd: 0.4, actual_usd: 0.1, status: 200 })
  vault.recordSpend(grant.id, { model: 'm', estimate_usd: 0.3, status: 200 })          // usage unreadable: estimate counts
  vault.recordSpend(grant.id, { model: 'm', estimate_usd: 9, refused: 'per_request' })  // refused: nothing counts
  const raw = new DatabaseSync(path)
  const yesterday = new Date(Date.parse(new Date().toISOString().slice(0, 10) + 'T00:00:00Z') - 1).toISOString()
  raw.prepare('INSERT INTO spend (grant_id, ts, model, estimate_usd, actual_usd, status) VALUES (?, ?, ?, ?, ?, ?)').run(grant.id, yesterday, 'm', 1, 1, 200)
  raw.close()
  assert.ok(Math.abs(vault.spentToday(grant.id) - 0.4) < 1e-9)
  assert.ok(Math.abs(vault.grant(grant.id).spent_usd - 0.4) < 1e-9)
  assert.equal(vault.callsLastMinute(grant.id), 2)
  const rows = vault.audit({ limit: 10, agent: 'claude-code/vision' })
  assert.equal(rows.filter(r => r.action === 'proxy.call').length, 2)
  assert.equal(rows.filter(r => r.action === 'proxy.refuse').length, 1)
  assert.equal(vault.audit({ secret: 'nothing' }).length, 0)
  vault.close()
})

test('verifyAudit catches an edited row, a deleted middle row and a deleted last row', () => {
  const make = () => {
    const f = fresh()
    approved(f.vault)
    f.vault.recordSpend(f.vault.grants({})[0].id, { estimate_usd: 0.1, actual_usd: 0.1, status: 200 })
    assert.deepEqual(f.vault.verifyAudit(), { ok: true, brokenAt: null })
    return f
  }
  const poke = (path, sql, ...args) => { const raw = new DatabaseSync(path); raw.prepare(sql).run(...args); raw.close() }

  let { vault, path } = make()
  poke(path, 'UPDATE audit SET detail = ? WHERE seq = 3', '{"edited":true}')
  assert.deepEqual(vault.verifyAudit(), { ok: false, brokenAt: 3 })
  vault.close()

  ;({ vault, path } = make())
  poke(path, 'UPDATE audit SET cost_usd = 0 WHERE action = ?', 'proxy.call')
  assert.equal(vault.verifyAudit().ok, false)
  vault.close()

  ;({ vault, path } = make())
  poke(path, 'DELETE FROM audit WHERE seq = 2')
  assert.deepEqual(vault.verifyAudit(), { ok: false, brokenAt: 2 })
  vault.close()

  ;({ vault, path } = make())
  const last = vault.auditHead().seq
  poke(path, 'DELETE FROM audit WHERE seq = ?', last)
  assert.deepEqual(vault.verifyAudit(), { ok: false, brokenAt: last })
  vault.close()
})

test('string ids from a URL keep the audit chain valid', () => {
  const { vault } = fresh()
  const { grant } = approved(vault)
  const req = request(vault, { replaces_grant: String(grant.id) })
  vault.decide(String(req.id), { approve: true })
  vault.decide(String(request(vault).id), { approve: false })
  vault.recordSpend(String(grant.id), { estimate_usd: 0.1, actual_usd: 0.05, status: 200 })
  vault.setStatus(String(grant.id), 'paused')
  vault.revoke(String(grant.id))
  assert.deepEqual(vault.verifyAudit(), { ok: true, brokenAt: null })
  vault.close()
})

test('every state change writes one audit row with no value in it', () => {
  const { vault } = fresh()
  const before = vault.auditHead().seq
  vault.putSecret('gemini', 'gemini', PLANTED, 'owner')
  const req = request(vault)
  const { grant } = vault.decide(req.id, { approve: true })
  vault.setStatus(grant.id, 'paused', 'vault')
  vault.revoke(grant.id, 'owner')
  vault.deleteSecret('gemini', 'owner')
  const rows = vault.audit({ limit: 100 }).filter(r => r.seq > before).reverse()
  assert.deepEqual(rows.map(r => r.action), ['secret.put', 'request.create', 'grant.create', 'grant.status', 'grant.revoke', 'secret.delete'])
  noPlant(rows, 'audit rows')
  assert.equal(vault.verifyAudit().ok, true)
  vault.close()
})
