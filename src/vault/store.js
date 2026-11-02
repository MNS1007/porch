// The vault's own SQLite file: encrypted secrets, agents' requests, grants
// with their caps, spend rows and a hash-chained audit log. The master key
// lives only in this process's memory, and only after unlock().
import { DatabaseSync } from 'node:sqlite'
import { createHash, randomBytes } from 'node:crypto'
import { inspect } from 'node:util'
import { wrapKey, unwrapKey, wrappedSalt, encrypt, decrypt, newHandle, hashHandle } from './crypto.js'

export const PROVIDERS = ['openai', 'gemini']
export const GRANT_STATUS = ['active', 'paused', 'revoked', 'expired']
const NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/
const PART = '[a-z0-9][a-z0-9_-]{0,39}'
const AGENT = new RegExp(`^${PART}(?:/${PART})?$`)
const GENESIS = '0'.repeat(64)
const CHECK = 'porch-vault-check'
const MAX_VALUE = 8192
const BUDGET_DEFAULTS = { rate_per_min: 30, days: 7 }
const AUDIT_COLS = ['seq', 'ts', 'actor', 'action', 'secret', 'grant_id', 'request_id', 'cost_usd', 'detail']

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS secrets (
    name TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    ciphertext BLOB NOT NULL, nonce BLOB NOT NULL, tag BLOB NOT NULL,
    created TEXT NOT NULL, rotated TEXT
  );
  CREATE TABLE IF NOT EXISTS requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent TEXT NOT NULL,
    secret TEXT NOT NULL,
    purpose TEXT NOT NULL,
    scope_json TEXT NOT NULL,
    budget_json TEXT NOT NULL,
    replaces_grant INTEGER,
    status TEXT NOT NULL,
    created TEXT NOT NULL, decided_at TEXT, decision_note TEXT
  );
  CREATE TABLE IF NOT EXISTS grants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id INTEGER NOT NULL,
    agent TEXT NOT NULL, secret TEXT NOT NULL,
    scope_json TEXT NOT NULL,
    per_request_usd REAL NOT NULL, daily_usd REAL NOT NULL, total_usd REAL NOT NULL, rate_per_min INTEGER NOT NULL,
    spent_usd REAL NOT NULL DEFAULT 0,
    handle_hash TEXT NOT NULL UNIQUE,
    expires TEXT NOT NULL,
    status TEXT NOT NULL,
    created TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS spend (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    grant_id INTEGER NOT NULL, ts TEXT NOT NULL,
    model TEXT, estimate_usd REAL NOT NULL, actual_usd REAL, status INTEGER, refused TEXT
  );
  CREATE INDEX IF NOT EXISTS spend_grant ON spend(grant_id, ts);
  CREATE TABLE IF NOT EXISTS audit (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL,
    secret TEXT, grant_id INTEGER, request_id INTEGER, cost_usd REAL, detail TEXT,
    prev_hash TEXT NOT NULL, hash TEXT NOT NULL
  );
`

const now = () => new Date().toISOString()
const utcDayStart = () => now().slice(0, 10) + 'T00:00:00.000Z'
const sha256 = text => createHash('sha256').update(text).digest('hex')

// Sorted keys, undefined as null, so the hash is the same however the row was built.
function canonical(row) {
  const out = {}
  for (const k of [...AUDIT_COLS].sort()) out[k] = row[k] ?? null
  return JSON.stringify(out)
}
const rowHash = (prev, row) => sha256(prev + canonical(row))

// Grant rows go out without handle_hash, with scope parsed for callers.
function publicGrant(row) {
  if (!row) return null
  const { handle_hash, ...rest } = row
  return { ...rest, scope: JSON.parse(rest.scope_json) }
}

function parseRequest(row) {
  if (!row) return null
  return { ...row, scope: JSON.parse(row.scope_json), budget: JSON.parse(row.budget_json) }
}

function checkName(name) {
  if (typeof name !== 'string' || !NAME.test(name)) throw new Error('invalid secret name')
}

function checkScope(scope) {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) throw new Error('scope must be an object')
  for (const key of ['models', 'endpoints']) {
    const list = scope[key]
    if (list === undefined) continue
    if (!Array.isArray(list) || !list.every(x => typeof x === 'string' && x.length && x.length <= 100)) {
      throw new Error(`scope.${key} must be a list of names`)
    }
  }
  return { models: scope.models ?? [], endpoints: scope.endpoints ?? [] }
}

function checkBudget(budget) {
  if (!budget || typeof budget !== 'object') throw new Error('budget must be an object')
  const b = { ...BUDGET_DEFAULTS, ...budget }
  for (const key of ['per_request_usd', 'daily_usd', 'total_usd', 'rate_per_min', 'days']) {
    if (typeof b[key] !== 'number' || !Number.isFinite(b[key]) || b[key] <= 0) throw new Error(`budget.${key} must be a positive number`)
  }
  if (!Number.isInteger(b.rate_per_min)) throw new Error('budget.rate_per_min must be a whole number')
  if (b.days > 365) throw new Error('budget.days is at most 365')
  return {
    per_request_usd: b.per_request_usd, daily_usd: b.daily_usd, total_usd: b.total_usd,
    rate_per_min: b.rate_per_min, days: b.days,
  }
}

// Owner edits on approve: {scope} replaces the scope, {budget} (or budget keys
// at the top level) are merged over the requested budget.
function applyChanges(request, changes = {}) {
  const { scope, budget, ...flat } = changes || {}
  const b = checkBudget({ ...request.budget, ...(budget || {}), ...pick(flat, Object.keys(BUDGET_DEFAULTS).concat(['per_request_usd', 'daily_usd', 'total_usd'])) })
  // A daily cap above the total would let calls finishing together slip past the total.
  if (b.per_request_usd > b.daily_usd || b.daily_usd > b.total_usd) throw Object.assign(new Error('Caps must grow: a call <= a day <= in all.'), { vaultSafe: true })
  return { scope: checkScope(scope ?? request.scope), budget: b }
}

const num = x => x == null || !Number.isFinite(Number(x)) ? null : Number(x)
const pick = (obj, keys) => Object.fromEntries(keys.filter(k => obj[k] !== undefined).map(k => [k, obj[k]]))

export function openVault(path, { dpapi } = {}) {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;')
  db.exec(SCHEMA)
  let masterKey = null
  let depth = 0

  // One transaction for a whole state change; nested calls join the outer one.
  function tx(fn) {
    if (depth > 0) return fn()
    db.exec('BEGIN IMMEDIATE')
    depth++
    try {
      const out = fn()
      db.exec('COMMIT')
      return out
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    } finally {
      depth--
    }
  }

  const meta = key => db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null
  const setMeta = (key, value) => db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)

  // The next seq is fixed before the insert so it can be part of the hash.
  function writeAudit({ actor, action, secret = null, grant_id = null, request_id = null, cost_usd = null, detail = null }) {
    return tx(() => {
      const last = db.prepare('SELECT seq, hash FROM audit ORDER BY seq DESC LIMIT 1').get()
      const used = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'audit'").get()?.seq ?? 0
      const row = {
        seq: Math.max(last?.seq ?? 0, used) + 1, ts: now(), actor: String(actor), action,
        // Coerced to what SQLite will store, so the hash matches the row read back.
        secret: secret == null ? null : String(secret),
        grant_id: num(grant_id), request_id: num(request_id), cost_usd: num(cost_usd),
        detail: detail == null ? null : typeof detail === 'string' ? detail : JSON.stringify(detail),
      }
      const prev = last?.hash ?? GENESIS
      db.prepare(`INSERT INTO audit (seq, ts, actor, action, secret, grant_id, request_id, cost_usd, detail, prev_hash, hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(row.seq, row.ts, row.actor, row.action, row.secret, row.grant_id, row.request_id, row.cost_usd, row.detail, prev, rowHash(prev, row))
      return row.seq
    })
  }

  function needUnlocked() {
    if (!masterKey) throw new Error('vault is locked')
  }

  const grantRow = id => db.prepare('SELECT * FROM grants WHERE id = ?').get(id)
  function needGrant(id) {
    const row = grantRow(id)
    if (!row) throw new Error('no such grant')
    return row
  }

  function spentToday(grantId) {
    return db.prepare(`SELECT COALESCE(SUM(COALESCE(actual_usd, estimate_usd)), 0) AS usd FROM spend
      WHERE grant_id = ? AND refused IS NULL AND ts >= ?`).get(grantId, utcDayStart()).usd
  }

  function markExpired(row) {
    if (row.status !== 'active' && row.status !== 'paused') return false
    if (row.expires > now()) return false
    tx(() => {
      db.prepare("UPDATE grants SET status = 'expired' WHERE id = ?").run(row.id)
      writeAudit({ actor: 'vault', action: 'grant.expire', secret: row.secret, grant_id: row.id, request_id: row.request_id })
    })
    return true
  }

  const vault = {
    isSetUp: () => meta('wrapped_master') !== null,

    setUp(passphrase) {
      if (vault.isSetUp()) throw new Error('vault is already set up')
      if (typeof passphrase !== 'string' || passphrase.length < 8) throw new Error('passphrase must be at least 8 characters')
      const key = randomBytes(32)
      const wrapped = wrapKey(key, passphrase, dpapi === undefined ? {} : { dpapi })
      const check = encrypt(key, CHECK)
      tx(() => {
        setMeta('wrapped_master', wrapped)
        setMeta('kdf_salt', wrappedSalt(wrapped))
        setMeta('pass_check', JSON.stringify({ ciphertext: check.ciphertext.toString('base64'), nonce: check.nonce.toString('base64'), tag: check.tag.toString('base64') }))
        writeAudit({ actor: 'owner', action: 'vault.setup', detail: { protection: wrapped.split(':')[0] } })
      })
      masterKey = key
      return true
    },

    unlock(passphrase) {
      const wrapped = meta('wrapped_master')
      if (!wrapped) return false
      let key
      try {
        key = unwrapKey(wrapped, passphrase)
        const c = JSON.parse(meta('pass_check'))
        if (decrypt(key, { ciphertext: Buffer.from(c.ciphertext, 'base64'), nonce: Buffer.from(c.nonce, 'base64'), tag: Buffer.from(c.tag, 'base64') }) !== CHECK) throw new Error('check')
      } catch {
        writeAudit({ actor: 'owner', action: 'vault.unlock_failed' })
        return false
      }
      if (masterKey) masterKey.fill(0)
      masterKey = key
      writeAudit({ actor: 'owner', action: 'vault.unlock' })
      return true
    },

    lock() {
      if (!masterKey) return
      masterKey.fill(0)
      masterKey = null
      writeAudit({ actor: 'owner', action: 'vault.lock' })
    },

    unlocked: () => masterKey !== null,

    putSecret(name, provider, value, actor = 'owner') {
      needUnlocked()
      checkName(name)
      if (!PROVIDERS.includes(provider)) throw new Error('unknown provider')
      if (typeof value !== 'string' || !value.length || value.length > MAX_VALUE) throw new Error('secret value must be a non-empty string')
      const { ciphertext, nonce, tag } = encrypt(masterKey, value)
      tx(() => {
        const had = db.prepare('SELECT 1 FROM secrets WHERE name = ?').get(name)
        if (had) {
          db.prepare('UPDATE secrets SET provider = ?, ciphertext = ?, nonce = ?, tag = ?, rotated = ? WHERE name = ?').run(provider, ciphertext, nonce, tag, now(), name)
        } else {
          db.prepare('INSERT INTO secrets (name, provider, ciphertext, nonce, tag, created) VALUES (?, ?, ?, ?, ?, ?)').run(name, provider, ciphertext, nonce, tag, now())
        }
        writeAudit({ actor, action: 'secret.put', secret: name, detail: { provider, rotated: !!had } })
      })
      return vault.listSecrets().find(s => s.name === name)
    },

    listSecrets: () => db.prepare('SELECT name, provider, created, rotated FROM secrets ORDER BY name').all().map(r => ({ ...r })),

    // Removing a secret also revokes every live grant on it.
    deleteSecret(name, actor = 'owner') {
      checkName(name)
      return tx(() => {
        if (!db.prepare('DELETE FROM secrets WHERE name = ?').run(name).changes) return false
        for (const g of db.prepare("SELECT * FROM grants WHERE secret = ? AND status IN ('active', 'paused')").all(name)) {
          db.prepare("UPDATE grants SET status = 'revoked' WHERE id = ?").run(g.id)
          writeAudit({ actor, action: 'grant.revoke', secret: name, grant_id: g.id, request_id: g.request_id, detail: { reason: 'secret deleted' } })
        }
        writeAudit({ actor, action: 'secret.delete', secret: name })
        return true
      })
    },

    // The only way to reach a value. fn runs here and its result is returned;
    // any error that carries the value is replaced by one that does not.
    useSecret(name, fn) {
      needUnlocked()
      const row = db.prepare('SELECT ciphertext, nonce, tag FROM secrets WHERE name = ?').get(name)
      if (!row) throw new Error('no such secret')
      const value = decrypt(masterKey, row)
      const scrub = err => {
        if (inspect(err, { depth: 10, showHidden: true }).includes(value) || String(err).includes(value)) {
          return new Error('secret use failed (details withheld)')
        }
        return err
      }
      let out
      try { out = fn(value) } catch (err) { throw scrub(err) }
      if (out && typeof out.then === 'function') return out.then(x => x, err => { throw scrub(err) })
      return out
    },

    createRequest({ agent, secret, purpose, scope, budget, replaces_grant = null } = {}) {
      if (typeof agent !== 'string' || !AGENT.test(agent)) throw new Error('invalid agent name')
      checkName(secret)
      if (typeof purpose !== 'string' || !purpose.trim() || purpose.length > 1000) throw new Error('purpose must be 1 to 1000 characters')
      const s = checkScope(scope)
      const b = checkBudget(budget)
      if (replaces_grant != null) {
        replaces_grant = num(replaces_grant)
        const g = grantRow(replaces_grant)
        if (!g || g.agent !== agent || g.secret !== secret) throw new Error('replaces_grant must be one of this agent\'s grants on this secret')
      }
      return tx(() => {
        const id = Number(db.prepare(`INSERT INTO requests (agent, secret, purpose, scope_json, budget_json, replaces_grant, status, created)
          VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`).run(agent, secret, purpose.trim(), JSON.stringify(s), JSON.stringify(b), replaces_grant, now()).lastInsertRowid)
        writeAudit({ actor: agent, action: 'request.create', secret, request_id: id, grant_id: replaces_grant, detail: { scope: s, budget: b } })
        return vault.request(id)
      })
    },

    request: id => parseRequest(db.prepare('SELECT * FROM requests WHERE id = ?').get(id)),

    listRequests({ status, agent } = {}) {
      const where = [], args = []
      if (status) { where.push('status = ?'); args.push(status) }
      if (agent) { where.push('agent = ?'); args.push(agent) }
      return db.prepare(`SELECT * FROM requests ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC`).all(...args).map(parseRequest)
    },

    // Approve: a new grant (or, for replaces_grant, the old grant updated in
    // place with a fresh handle so its spend history stays). The handle is
    // returned here once and never stored.
    decide(id, { approve, note = null, changes } = {}, actor = 'owner') {
      needUnlocked()
      const req = vault.request(id)
      if (!req) throw new Error('no such request')
      if (req.status !== 'pending') throw new Error('request is not pending')
      const decidedNote = note == null ? null : String(note).slice(0, 1000)
      if (!approve) {
        tx(() => {
          db.prepare("UPDATE requests SET status = 'denied', decided_at = ?, decision_note = ? WHERE id = ?").run(now(), decidedNote, req.id)
          writeAudit({ actor, action: 'request.deny', secret: req.secret, request_id: req.id })
        })
        return { request: vault.request(req.id) }
      }
      const { scope, budget } = applyChanges(req, changes)
      if (!db.prepare('SELECT 1 FROM secrets WHERE name = ?').get(req.secret)) throw new Error('no such secret')
      const { handle, hash } = newHandle()
      const expires = new Date(Date.now() + budget.days * 86400000).toISOString()
      const caps = [JSON.stringify(scope), budget.per_request_usd, budget.daily_usd, budget.total_usd, budget.rate_per_min, hash, expires]
      const grantId = tx(() => {
        let gid
        if (req.replaces_grant != null) {
          const old = needGrant(req.replaces_grant)
          if (old.agent !== req.agent || old.secret !== req.secret) throw new Error('replaced grant does not match the request')
          if (old.status === 'revoked') throw new Error('replaced grant is revoked')
          db.prepare(`UPDATE grants SET request_id = ?, scope_json = ?, per_request_usd = ?, daily_usd = ?, total_usd = ?, rate_per_min = ?,
            handle_hash = ?, expires = ?, status = 'active' WHERE id = ?`).run(req.id, ...caps, old.id)
          gid = old.id
        } else {
          gid = Number(db.prepare(`INSERT INTO grants (request_id, agent, secret, scope_json, per_request_usd, daily_usd, total_usd, rate_per_min,
            handle_hash, expires, status, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`).run(req.id, req.agent, req.secret, ...caps, now()).lastInsertRowid)
        }
        db.prepare("UPDATE requests SET status = 'approved', decided_at = ?, decision_note = ? WHERE id = ?").run(now(), decidedNote, req.id)
        writeAudit({
          actor, action: req.replaces_grant != null ? 'grant.update' : 'grant.create', secret: req.secret, grant_id: gid, request_id: req.id,
          detail: { scope, budget, changed: !!changes },
        })
        return gid
      })
      return { request: vault.request(req.id), grant: publicGrant(grantRow(grantId)), handle }
    },

    // Agents withdraw their own pending request.
    withdraw(id, agent) {
      const req = vault.request(id)
      if (!req || req.agent !== agent || req.status !== 'pending') throw new Error('no pending request to withdraw')
      tx(() => {
        db.prepare("UPDATE requests SET status = 'withdrawn', decided_at = ? WHERE id = ?").run(now(), req.id)
        writeAudit({ actor: agent, action: 'request.withdraw', secret: req.secret, request_id: req.id })
      })
      return vault.request(req.id)
    },

    grants({ agent, secret, status } = {}) {
      const where = [], args = []
      if (agent) { where.push('agent = ?'); args.push(agent) }
      if (secret) { where.push('secret = ?'); args.push(secret) }
      if (status) { where.push('status = ?'); args.push(status) }
      const rows = db.prepare(`SELECT * FROM grants ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC`).all(...args)
      for (const r of rows) markExpired(r)
      return db.prepare(`SELECT * FROM grants ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC`).all(...args)
        .map(r => ({ ...publicGrant(r), today: spentToday(r.id) }))
    },

    grant: id => publicGrant(grantRow(id)),

    // Paused grants come back (the proxy refuses them by status); unknown,
    // revoked and expired ones are null. Adds the secret's provider.
    grantForHandle(handle) {
      if (typeof handle !== 'string' || !handle.startsWith('pvh_') || handle.length > 200) return null
      const row = db.prepare('SELECT * FROM grants WHERE handle_hash = ?').get(hashHandle(handle))
      if (!row || row.status === 'revoked' || row.status === 'expired') return null
      if (markExpired(row)) return null
      const provider = db.prepare('SELECT provider FROM secrets WHERE name = ?').get(row.secret)?.provider ?? null
      return { ...publicGrant(row), provider }
    },

    revoke(grantId, actor = 'owner') {
      const g = needGrant(grantId)
      if (g.status === 'revoked') return publicGrant(g)
      tx(() => {
        db.prepare("UPDATE grants SET status = 'revoked' WHERE id = ?").run(g.id)
        writeAudit({ actor, action: 'grant.revoke', secret: g.secret, grant_id: g.id, request_id: g.request_id })
      })
      return publicGrant(grantRow(g.id))
    },

    // One spend row and one audit row per proxied call. A call that went out
    // adds actual_usd (or the estimate when usage was unreadable) to spent_usd.
    recordSpend(grantId, { model = null, estimate_usd, actual_usd = null, status = null, refused = null } = {}) {
      const g = needGrant(grantId)
      if (typeof estimate_usd !== 'number' || !Number.isFinite(estimate_usd)) throw new Error('estimate_usd must be a number')
      const cost = refused ? 0 : (typeof actual_usd === 'number' && Number.isFinite(actual_usd) ? actual_usd : estimate_usd)
      return tx(() => {
        db.prepare('INSERT INTO spend (grant_id, ts, model, estimate_usd, actual_usd, status, refused) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(g.id, now(), model == null ? null : String(model).slice(0, 100), estimate_usd, actual_usd ?? null, status ?? null, refused == null ? null : String(refused).slice(0, 200))
        if (cost) db.prepare('UPDATE grants SET spent_usd = spent_usd + ? WHERE id = ?').run(cost, g.id)
        writeAudit({
          actor: g.agent, action: refused ? 'proxy.refuse' : 'proxy.call', secret: g.secret, grant_id: g.id, request_id: g.request_id,
          cost_usd: cost, detail: { model, status, refused, estimate_usd },
        })
        return { spent_usd: grantRow(g.id).spent_usd, today: spentToday(g.id) }
      })
    },

    spentToday,

    // Calls that went out in the last minute, for the proxy's rate limit.
    callsLastMinute: grantId => db.prepare('SELECT COUNT(*) AS n FROM spend WHERE grant_id = ? AND refused IS NULL AND ts >= ?')
      .get(grantId, new Date(Date.now() - 60000).toISOString()).n,

    // Revoked and expired are final; active and paused move between each other.
    setStatus(grantId, status, actor = 'owner') {
      if (!GRANT_STATUS.includes(status)) throw new Error('unknown grant status')
      const g = needGrant(grantId)
      if (status === 'revoked') return vault.revoke(grantId, actor)
      if (g.status === 'revoked' || g.status === 'expired') throw new Error(`grant is ${g.status}`)
      if (g.status === status) return publicGrant(g)
      if (status === 'active' && g.expires <= now()) { markExpired(g); throw new Error('grant is expired') }
      tx(() => {
        db.prepare('UPDATE grants SET status = ? WHERE id = ?').run(status, g.id)
        writeAudit({ actor, action: 'grant.status', secret: g.secret, grant_id: g.id, request_id: g.request_id, detail: { from: g.status, to: status } })
      })
      return publicGrant(grantRow(g.id))
    },

    audit({ limit = 100, secret, agent } = {}) {
      const where = [], args = []
      if (secret) { where.push('secret = ?'); args.push(secret) }
      if (agent) {
        where.push('(actor = ? OR grant_id IN (SELECT id FROM grants WHERE agent = ?) OR request_id IN (SELECT id FROM requests WHERE agent = ?))')
        args.push(agent, agent, agent)
      }
      const n = Math.max(1, Math.min(1000, Number(limit) || 100))
      return db.prepare(`SELECT * FROM audit ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY seq DESC LIMIT ?`).all(...args, n).map(r => ({ ...r }))
    },

    auditHead: () => db.prepare('SELECT seq, hash FROM audit ORDER BY seq DESC LIMIT 1').get() ?? { seq: 0, hash: GENESIS },

    // Walks the chain from the start. An edited row fails its hash, a deleted
    // middle row breaks the next row's prev_hash or the seq run, and a deleted
    // last row shows up as sqlite_sequence being ahead of the last seq.
    verifyAudit() {
      let prev = GENESIS, expect = 1
      for (const row of db.prepare('SELECT * FROM audit ORDER BY seq').iterate()) {
        if (row.seq !== expect || row.prev_hash !== prev || row.hash !== rowHash(prev, row)) return { ok: false, brokenAt: Math.min(row.seq, expect) }
        prev = row.hash
        expect++
      }
      const used = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'audit'").get()?.seq ?? 0
      if (used >= expect) return { ok: false, brokenAt: expect }
      return { ok: true, brokenAt: null }
    },

    close() {
      if (masterKey) { masterKey.fill(0); masterKey = null }
      db.close()
    },
  }
  return vault
}
