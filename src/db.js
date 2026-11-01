// One SQLite file holds everything: messages, agents and their tokens.
import { DatabaseSync } from 'node:sqlite'
import { createHash, randomBytes } from 'node:crypto'

export const KINDS = ['note', 'briefing', 'question', 'answer', 'alert']
export const PRIORITIES = ['low', 'normal', 'high']
const MAX_TEXT = 8000

const hash = token => createHash('sha256').update(token).digest('hex')

export function openDb(path) {
  const db = new DatabaseSync(path)
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      room TEXT NOT NULL,
      sender TEXT NOT NULL,
      kind TEXT NOT NULL,
      text TEXT NOT NULL,
      recipients TEXT NOT NULL DEFAULT '[]',
      reply_to INTEGER,
      priority TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]',
      data TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS messages_room ON messages(room, id);
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(text, content='messages', content_rowid='id');
    CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
    END;
    CREATE TABLE IF NOT EXISTS agents (
      name TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      rooms TEXT NOT NULL,
      can_post INTEGER NOT NULL,
      created TEXT NOT NULL,
      last_seen TEXT
    );
  `)
  return new Store(db)
}

class Store {
  constructor(db) { this.db = db }

  // Agents and tokens

  addAgent(name, { rooms = ['*'], canPost = true } = {}) {
    if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(name)) throw new Error('Agent names use lowercase letters, digits, - and _, up to 40 characters.')
    const token = 'porch_' + randomBytes(24).toString('base64url')
    this.db.prepare('INSERT INTO agents (name, token_hash, rooms, can_post, created) VALUES (?, ?, ?, ?, ?)')
      .run(name, hash(token), JSON.stringify(rooms), canPost ? 1 : 0, new Date().toISOString())
    return token
  }

  removeAgent(name) {
    return this.db.prepare('DELETE FROM agents WHERE name = ?').run(name).changes > 0
  }

  agents() {
    return this.db.prepare('SELECT name, rooms, can_post, created, last_seen FROM agents ORDER BY name').all()
      .map(a => ({ name: a.name, rooms: JSON.parse(a.rooms), canPost: !!a.can_post, created: a.created, lastSeen: a.last_seen }))
  }

  agentForToken(token) {
    if (!token) return null
    const a = this.db.prepare('SELECT name, rooms, can_post FROM agents WHERE token_hash = ?').get(hash(token))
    if (!a) return null
    this.db.prepare('UPDATE agents SET last_seen = ? WHERE name = ?').run(new Date().toISOString(), a.name)
    return { name: a.name, rooms: JSON.parse(a.rooms), canPost: !!a.can_post }
  }

  // Messages

  post(sender, msg) {
    const room = String(msg.room || 'general').toLowerCase()
    if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(room)) throw new Error('Room names use lowercase letters, digits, - and _.')
    const text = String(msg.text ?? '').trim()
    if (!text) throw new Error('text is required')
    const kind = KINDS.includes(msg.kind) ? msg.kind : 'note'
    const priority = PRIORITIES.includes(msg.priority) ? msg.priority : 'normal'
    const row = {
      ts: new Date().toISOString(),
      room,
      sender,
      kind,
      text: text.slice(0, MAX_TEXT),
      recipients: JSON.stringify(arr(msg.to)),
      reply_to: Number.isInteger(msg.reply_to) ? msg.reply_to : null,
      priority,
      tags: JSON.stringify(arr(msg.tags)),
      data: JSON.stringify(msg.data && typeof msg.data === 'object' ? msg.data : {}),
    }
    const { lastInsertRowid } = this.db.prepare(`INSERT INTO messages (ts, room, sender, kind, text, recipients, reply_to, priority, tags, data)
      VALUES (:ts, :room, :sender, :kind, :text, :recipients, :reply_to, :priority, :tags, :data)`).run(row)
    return this.get(Number(lastInsertRowid))
  }

  get(id) {
    const r = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id)
    return r ? toMessage(r) : null
  }

  // rooms: list the reader may see, or null for all
  list({ rooms = null, room, after = 0, from, q, limit = 50 } = {}) {
    const where = ['m.id > ?']
    const args = [Number(after) || 0]
    if (room) { where.push('m.room = ?'); args.push(room) }
    if (rooms) { where.push(`m.room IN (${rooms.map(() => '?').join(',') || "''"})`); args.push(...rooms) }
    if (from) { where.push('m.sender = ?'); args.push(from) }
    let join = ''
    if (q) {
      join = 'JOIN messages_fts f ON f.rowid = m.id'
      where.push('messages_fts MATCH ?')
      args.push(ftsQuery(q))
    }
    const n = Math.min(Math.max(Number(limit) || 50, 1), 500)
    // Newest first when searching or reading the tail; oldest first when paging forward.
    const order = after ? 'ASC' : 'DESC'
    const rows = this.db.prepare(`SELECT m.* FROM messages m ${join} WHERE ${where.join(' AND ')} ORDER BY m.id ${order} LIMIT ${n}`).all(...args)
    const out = rows.map(toMessage)
    return after ? out : out.reverse()
  }

  rooms() {
    return this.db.prepare('SELECT room, COUNT(*) AS count, MAX(id) AS last_id, MAX(ts) AS last_ts FROM messages GROUP BY room ORDER BY last_id DESC').all()
      .map(r => ({ room: r.room, count: r.count, lastId: r.last_id, lastTs: r.last_ts }))
  }
}

function toMessage(r) {
  return {
    id: r.id, ts: r.ts, room: r.room, from: r.sender, kind: r.kind, text: r.text,
    to: JSON.parse(r.recipients), reply_to: r.reply_to, priority: r.priority,
    tags: JSON.parse(r.tags), data: JSON.parse(r.data),
  }
}

function arr(v) {
  if (Array.isArray(v)) return v.map(String).slice(0, 20)
  if (typeof v === 'string' && v) return [v]
  return []
}

// Turn plain words into a safe FTS5 query: every word must match, prefix allowed.
function ftsQuery(q) {
  const words = String(q).toLowerCase().match(/[\p{L}\p{N}]+/gu) || []
  return words.slice(0, 10).map(w => `"${w}"*`).join(' ') || '""'
}

export function canRead(agent, room) {
  return agent.rooms.includes('*') || agent.rooms.includes(room)
}
