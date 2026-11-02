// One SQLite file holds everything: messages, agents and their tokens,
// groups and DMs, and how far each agent has read.
import { DatabaseSync } from 'node:sqlite'
import { createHash, randomBytes } from 'node:crypto'
import { Docs, DOCS_SCHEMA } from './memory.js'

export const KINDS = ['note', 'briefing', 'question', 'answer', 'alert']
export const PRIORITIES = ['low', 'normal', 'high']
export const EVERYONE = 'general'
const MAX_TEXT = 8000
// Group names are one part. Agent names may add one "/member" part for a family,
// for example claude-code/renfort is the renfort session of claude-code.
const NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/
const PART = '[a-z0-9][a-z0-9_-]{0,39}'
const AGENT = new RegExp(`^${PART}(?:/${PART})?$`)
const DM = new RegExp(`^dm:(${PART}(?:/${PART})?)\\+(${PART}(?:/${PART})?)$`)

const hash = token => createHash('sha256').update(token).digest('hex')

export function openDb(path, { owner = process.env.PORCH_OWNER || 'me' } = {}) {
  const db = new DatabaseSync(path)
  const hadReads = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'reads'").get()
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
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
    -- Groups and DMs. A room with messages but no row here is an open group.
    CREATE TABLE IF NOT EXISTS rooms (
      name TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      title TEXT,
      members TEXT,
      created_by TEXT,
      created TEXT NOT NULL
    );
    -- The last message each agent has seen in each room, for unread counts.
    CREATE TABLE IF NOT EXISTS reads (
      agent TEXT NOT NULL,
      room TEXT NOT NULL,
      last_id INTEGER NOT NULL,
      PRIMARY KEY (agent, room)
    );
  `)
  db.exec(DOCS_SCHEMA)
  // Archived groups are hidden from the list but keep their messages.
  if (!db.prepare("SELECT 1 FROM pragma_table_info('rooms') WHERE name = 'archived'").get()) {
    db.exec('ALTER TABLE rooms ADD COLUMN archived INTEGER NOT NULL DEFAULT 0')
  }
  // Agents that speak for others: acts holds the name patterns a token may act
  // for, managed_by marks a member that has no token and is spoken for.
  for (const col of ['acts', 'managed_by']) {
    if (!db.prepare("SELECT 1 FROM pragma_table_info('agents') WHERE name = ?").get(col)) db.exec(`ALTER TABLE agents ADD COLUMN ${col} TEXT`)
  }
  const store = new Store(db, owner)
  // First start after the upgrade: everything already posted counts as read.
  if (!hadReads) for (const a of store.agents()) store.seedReads(a.name)
  return store
}

class Store {
  constructor(db, owner) {
    this.db = db
    this.owner = owner
    this.docs = new Docs(db)
    this.loadRooms()
  }

  // The CLI may change groups while the hub runs, so reload when another connection wrote.
  fresh() {
    const v = this.db.prepare('PRAGMA data_version').get().data_version
    if (v !== this.version) { this.version = v; this.loadRooms() }
  }

  loadRooms() {
    this.meta = new Map(this.db.prepare('SELECT * FROM rooms').all().map(r => [r.name, {
      name: r.name, type: r.type, title: r.title, members: r.members ? JSON.parse(r.members) : null, archived: !!r.archived,
    }]))
    // manager name -> the members it speaks for
    this.managed = new Map()
    for (const r of this.db.prepare('SELECT name, managed_by FROM agents WHERE managed_by IS NOT NULL').all()) {
      if (!this.managed.has(r.managed_by)) this.managed.set(r.managed_by, new Set())
      this.managed.get(r.managed_by).add(r.name)
    }
  }

  // The members this agent speaks for.
  membersOf(name) {
    this.fresh()
    return this.managed.get(name) || new Set()
  }

  // Which name patterns a token may act for: "claude-code/*" or an exact name.
  setActs(name, patterns) {
    for (const p of patterns) if (!PATTERN.test(p)) throw new Error(`"${p}" is not a pattern. Use family/* or a name.`)
    return this.db.prepare('UPDATE agents SET acts = ? WHERE name = ? AND managed_by IS NULL')
      .run(patterns.length ? JSON.stringify(patterns) : null, name).changes > 0
  }

  // Add a member that the manager speaks for. Doing it again changes nothing.
  addMember(manager, name) {
    name = String(name || '').trim().toLowerCase()
    if (!AGENT.test(name)) throw withStatus(400, 'Agent names use lowercase letters, digits, - and _, with at most one / for a family.')
    if (!actsFor(manager, name)) throw withStatus(403, `This token cannot act for "${name}".`)
    const cur = this.db.prepare('SELECT managed_by FROM agents WHERE name = ?').get(name)
    if (cur && cur.managed_by === manager.name) return this.agent(name)
    if (cur) throw withStatus(409, cur.managed_by ? `"${name}" is spoken for by ${cur.managed_by}.` : `"${name}" has its own token.`)
    this.db.prepare('INSERT INTO agents (name, token_hash, rooms, can_post, created, managed_by) VALUES (?, ?, ?, 0, ?, ?)')
      .run(name, 'managed:' + name, '[]', new Date().toISOString(), manager.name)
    this.seedReads(name)
    this.loadRooms()
    return this.agent(name)
  }

  // Remove a member. Its messages and DMs stay.
  removeMember(manager, name) {
    if (!actsFor(manager, name)) throw withStatus(403, `This token cannot act for "${name}".`)
    const gone = this.db.prepare('DELETE FROM agents WHERE name = ? AND managed_by = ?').run(name, manager.name).changes > 0
    if (!gone) throw withStatus(404, `${manager.name} does not speak for "${name}".`)
    this.loadRooms()
    return { ok: true }
  }

  // The member a manager posts as, checked: in its patterns and registered by it.
  speakAs(manager, name) {
    name = String(name || '').trim().toLowerCase()
    if (!actsFor(manager, name)) throw withStatus(403, `This token cannot act for "${name}".`)
    if (!this.membersOf(manager.name).has(name)) throw withStatus(403, `"${name}" is not registered. POST /v1/agents {"name": "${name}"} first.`)
    this.db.prepare('UPDATE agents SET last_seen = ? WHERE name = ?').run(new Date().toISOString(), name)
    return { name, rooms: manager.rooms, canPost: manager.canPost, owner: false, acts: [], managedBy: manager.name }
  }

  agent(name) {
    return this.agents().find(a => a.name === name) || null
  }

  // Hide a group from the list, or bring it back. An open room with no row gets one.
  setArchived(name, archived) {
    name = roomName(name)
    if (name === EVERYONE) throw new Error('Everyone cannot be archived.')
    if (name.startsWith('dm:')) throw new Error('Only groups can be archived.')
    const known = this.meta.has(name) || this.db.prepare('SELECT 1 FROM messages WHERE room = ? LIMIT 1').get(name)
    if (!known) throw new Error(`No group named "${name}".`)
    this.db.prepare(`INSERT INTO rooms (name, type, archived, created) VALUES (?, 'group', ?, ?)
      ON CONFLICT(name) DO UPDATE SET archived = excluded.archived`).run(name, archived ? 1 : 0, new Date().toISOString())
    this.loadRooms()
    return this.room(name)
  }

  // Agents and tokens

  addAgent(name, { rooms = ['*'], canPost = true } = {}) {
    if (!AGENT.test(name)) throw new Error('Agent names use lowercase letters, digits, - and _, up to 40 characters, with at most one / for a family (claude-code/renfort).')
    const managed = this.db.prepare('SELECT managed_by FROM agents WHERE name = ? AND managed_by IS NOT NULL').get(name)
    if (managed) throw new Error(`"${name}" is spoken for by ${managed.managed_by}. Remove it there first.`)
    const token = 'porch_' + randomBytes(24).toString('base64url')
    this.db.prepare('INSERT INTO agents (name, token_hash, rooms, can_post, created) VALUES (?, ?, ?, ?, ?)')
      .run(name, hash(token), JSON.stringify(rooms), canPost ? 1 : 0, new Date().toISOString())
    this.seedReads(name)
    return token
  }

  // A new reader starts with nothing unread.
  seedReads(name) {
    this.db.prepare('INSERT OR IGNORE INTO reads (agent, room, last_id) SELECT ?, room, MAX(id) FROM messages GROUP BY room').run(name)
  }

  setRooms(name, rooms) {
    return this.db.prepare('UPDATE agents SET rooms = ? WHERE name = ?').run(JSON.stringify(rooms), name).changes > 0
  }

  removeAgent(name) {
    return this.db.prepare('DELETE FROM agents WHERE name = ?').run(name).changes > 0
  }

  hasAgent(name) {
    return !!this.db.prepare('SELECT 1 FROM agents WHERE name = ?').get(name)
  }

  agents() {
    return this.db.prepare('SELECT name, rooms, can_post, created, last_seen, acts, managed_by FROM agents ORDER BY name').all()
      .map(a => ({
        name: a.name, ...family(a.name), rooms: JSON.parse(a.rooms), canPost: !!a.can_post, created: a.created, lastSeen: a.last_seen,
        acts: a.acts ? JSON.parse(a.acts) : [], managed_by: a.managed_by || null,
      }))
  }

  // Rename an agent everywhere and keep its history: its token, the messages it
  // sent, "to" lists, group members, its DM rooms and read state. One transaction,
  // so it is safe while the hub runs.
  renameAgent(from, to) {
    to = String(to || '').trim().toLowerCase()
    if (!this.hasAgent(from)) throw new Error(`No agent named "${from}".`)
    if (from === this.owner) throw new Error('That is the owner. Set PORCH_OWNER instead of renaming it.')
    if (!AGENT.test(to)) throw new Error('Agent names use lowercase letters, digits, - and _, up to 40 characters, with at most one / for a family.')
    if (this.hasAgent(to)) throw new Error(`"${to}" already exists.`)
    const db = this.db
    const swap = list => [...new Set(list.map(n => n === from ? to : n))]
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare('UPDATE agents SET name = ? WHERE name = ?').run(to, from)
      db.prepare('UPDATE agents SET managed_by = ? WHERE managed_by = ?').run(to, from)
      db.prepare("UPDATE agents SET token_hash = ? WHERE name = ? AND token_hash LIKE 'managed:%'").run('managed:' + to, to)
      db.prepare('UPDATE messages SET sender = ? WHERE sender = ?').run(to, from)
      const addressed = db.prepare("SELECT id, recipients FROM messages WHERE EXISTS (SELECT 1 FROM json_each(recipients) WHERE value = ?)").all(from)
      const setTo = db.prepare('UPDATE messages SET recipients = ? WHERE id = ?')
      for (const m of addressed) setTo.run(JSON.stringify(swap(JSON.parse(m.recipients))), m.id)
      // DM rooms get the new name, and their messages and read state move with them.
      const dms = new Set([
        ...db.prepare("SELECT name FROM rooms WHERE type = 'dm'").all().map(r => r.name),
        ...db.prepare("SELECT DISTINCT room AS name FROM messages WHERE room LIKE 'dm:%'").all().map(r => r.name),
      ])
      for (const old of dms) {
        const pair = old.slice(3).split('+')
        if (!pair.includes(from)) continue
        const other = pair.find(n => n !== from)
        const room = dmName(other, to)
        db.prepare('UPDATE messages SET room = ? WHERE room = ?').run(room, old)
        db.prepare('UPDATE OR IGNORE reads SET room = ? WHERE room = ?').run(room, old)
        db.prepare('DELETE FROM reads WHERE room = ?').run(old)
        if (db.prepare('SELECT 1 FROM rooms WHERE name = ?').get(room)) db.prepare('DELETE FROM rooms WHERE name = ?').run(old)
        else db.prepare('UPDATE rooms SET name = ?, members = ? WHERE name = ?').run(room, JSON.stringify([other, to].sort()), old)
      }
      for (const g of db.prepare("SELECT name, members FROM rooms WHERE type = 'group' AND members IS NOT NULL").all()) {
        const members = JSON.parse(g.members)
        if (members.includes(from)) db.prepare('UPDATE rooms SET members = ? WHERE name = ?').run(JSON.stringify(swap(members).sort()), g.name)
      }
      db.prepare('UPDATE rooms SET created_by = ? WHERE created_by = ?').run(to, from)
      db.prepare('UPDATE doc_versions SET author = ? WHERE author = ?').run(to, from)
      db.prepare('UPDATE OR IGNORE reads SET agent = ? WHERE agent = ?').run(to, from)
      db.prepare('DELETE FROM reads WHERE agent = ?').run(from)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
    this.loadRooms()
    return to
  }

  agentForToken(token) {
    if (!token) return null
    const a = this.db.prepare('SELECT name, rooms, can_post, acts FROM agents WHERE token_hash = ? AND managed_by IS NULL').get(hash(token))
    if (!a) return null
    this.db.prepare('UPDATE agents SET last_seen = ? WHERE name = ?').run(new Date().toISOString(), a.name)
    return { name: a.name, rooms: JSON.parse(a.rooms), canPost: !!a.can_post, owner: a.name === this.owner, acts: a.acts ? JSON.parse(a.acts) : [] }
  }

  // Rooms, groups and DMs

  // A group whose members are ["*"] is open to every agent, whatever its token lists.
  // Everyone (general) is always like that.
  room(name) {
    this.fresh()
    if (name === EVERYONE) return { name, type: 'group', title: 'Everyone', members: ['*'] }
    return this.meta.get(name) || { name, type: name.startsWith('dm:') ? 'dm' : 'group', title: null, members: null }
  }

  // The owner, tokens with every room, tokens that list the room, and members may read.
  // Looked up on every check, so a new group member gets messages on an open stream.
  // A manager also reads the DMs and groups of the members it speaks for.
  canRead(agent, name) {
    if (agent.owner || agent.rooms.includes('*') || agent.rooms.includes(name)) return true
    const r = this.room(name)
    return isMember(r, agent.name) || [...this.membersOf(agent.name)].some(m => isMember(r, m) || (r.type === 'dm' && name.slice(3).split('+').includes(m)))
  }

  // A message is visible if its room is, or if it is addressed to a member the reader speaks for.
  canSee(agent, msg) {
    if (this.canRead(agent, msg.room)) return true
    const mine = this.membersOf(agent.name)
    return msg.to.some(n => mine.has(n))
  }

  // Only the two members, and the owner, write in a DM.
  canPost(agent, name) {
    if (name.startsWith('dm:')) return agent.owner || name.slice(3).split('+').includes(agent.name)
    return this.canRead(agent, name)
  }

  // Rooms this agent may read, or null for all of them.
  readable(agent) {
    if (agent.owner || agent.rooms.includes('*')) return null
    this.fresh()
    const names = [agent.name, ...this.membersOf(agent.name)]
    const mine = [...this.meta.values()].filter(r => names.some(n => isMember(r, n))).map(r => r.name)
    return [...new Set([EVERYONE, ...agent.rooms, ...mine])]
  }

  saveRoom({ name, type, title = null, members = null, by = null }) {
    this.db.prepare(`INSERT INTO rooms (name, type, title, members, created_by, created) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET title = excluded.title, members = excluded.members`)
      .run(name, type, title, members ? JSON.stringify(members) : null, by, new Date().toISOString())
    this.loadRooms()
    return this.room(name)
  }

  // Make a group, or change its title and members. Members must be registered agents.
  saveGroup({ name, title, members }, by) {
    name = String(name || '').trim().toLowerCase().replace(/\s+/g, '-')
    if (!NAME.test(name)) throw new Error('Group names use lowercase letters, digits, - and _, up to 40 characters.')
    if (name === EVERYONE) throw new Error('Everyone always includes every agent.')
    if (this.meta.get(name)?.type === 'dm') throw new Error('That name is taken.')
    let list = [...new Set(arr(members).map(m => m.trim().toLowerCase()))].sort()
    if (list.includes('*')) list = ['*']
    const unknown = list.filter(m => m !== '*' && !this.hasAgent(m))
    if (unknown.length) throw new Error(`No agent named ${unknown.join(', ')}.`)
    return this.saveRoom({ name, type: 'group', title: String(title || '').trim().slice(0, 80) || null, members: list, by })
  }

  // The DM room between two agents, saved on first use.
  openDm(a, b) {
    const name = roomName(dmName(a, b))
    if (!this.meta.has(name)) {
      for (const n of [a, b]) if (!this.hasAgent(n)) throw new Error(`No agent named ${n}.`)
      this.saveRoom({ name, type: 'dm', members: [a, b].sort(), by: a })
    }
    return this.room(name)
  }

  markRead(agent, room, id) {
    this.db.prepare(`INSERT INTO reads (agent, room, last_id) VALUES (?, ?, ?)
      ON CONFLICT(agent, room) DO UPDATE SET last_id = MAX(last_id, excluded.last_id)`).run(agent, room, Number(id) || 0)
  }

  // Conversations for one reader, newest activity first, each with its last
  // message and how many messages from others the reader has not seen.
  // The owner gets every one. Agents get open groups they can read, and the
  // groups and DMs they belong to.
  // Archived groups are left out unless asked for; then they carry archived: true.
  conversations(agent, { archived = false } = {}) {
    const agentNames = new Set(this.agents().map(a => a.name))
    const last = new Map(this.db.prepare('SELECT m.* FROM messages m JOIN (SELECT MAX(id) AS id FROM messages GROUP BY room) x ON x.id = m.id').all()
      .map(r => [r.room, toMessage(r)]))
    // A manager's list also holds its members' conversations, and what it posted for them is not unread.
    const names = [agent.name, ...this.membersOf(agent.name)]
    const unread = new Map(this.db.prepare(`SELECT m.room, COUNT(*) AS n FROM messages m LEFT JOIN reads r ON r.agent = ? AND r.room = m.room
      WHERE m.id > COALESCE(r.last_id, 0) AND m.sender NOT IN (${names.map(() => '?').join(',')}) GROUP BY m.room`).all(agent.name, ...names).map(r => [r.room, r.n]))
    const out = []
    const tokenRooms = agent.rooms.filter(r => r !== '*')
    for (const name of new Set([EVERYONE, ...tokenRooms, ...this.meta.keys(), ...last.keys()])) {
      if (!this.canRead(agent, name)) continue
      const r = this.room(name)
      if (!agent.owner && r.members && !names.some(n => isMember(r, n))) continue
      if (r.archived && !archived) continue
      let title = r.title || (r.type === 'dm' ? dmTitle(name, agent.name) : name)
      // A group named like an agent reads "#anton", so it is not taken for the DM.
      if (r.type === 'group' && agentNames.has(title.toLowerCase())) title = '#' + title
      out.push({
        room: name,
        type: r.type,
        title,
        archived: !!r.archived,
        members: r.members,
        // For a DM you are in: the other agent and its family.
        with: r.type === 'dm' && name.slice(3).split('+').includes(agent.name) ? withWhom(name, agent.name) : null,
        lastId: last.get(name)?.id || 0,
        last: last.get(name) || null,
        unread: unread.get(name) || 0,
      })
    }
    return out.sort((a, b) => b.lastId - a.lastId || a.title.localeCompare(b.title))
  }

  // Messages

  post(sender, msg) {
    const room = roomName(msg.room)
    // Posting into an archived group brings it back, so nothing goes unseen.
    if (this.meta.get(room)?.archived) this.setArchived(room, false)
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
  // alsoTo: names whose addressed messages are visible outside those rooms
  list({ rooms = null, alsoTo = [], room, after = 0, from, to, q, reply_to, limit = 50 } = {}) {
    const where = ['m.id > ?']
    const args = [Number(after) || 0]
    if (room) { where.push('m.room = ?'); args.push(room) }
    if (rooms) {
      const inRooms = `m.room IN (${rooms.map(() => '?').join(',') || "''"})`
      if (alsoTo.length) {
        where.push(`(${inRooms} OR EXISTS (SELECT 1 FROM json_each(m.recipients) WHERE value IN (${alsoTo.map(() => '?').join(',')})))`)
        args.push(...rooms, ...alsoTo)
      } else { where.push(inRooms); args.push(...rooms) }
    }
    if (from) { where.push('m.sender = ?'); args.push(from) }
    if (to) { where.push('EXISTS (SELECT 1 FROM json_each(m.recipients) WHERE value = ?)'); args.push(to) }
    if (reply_to) { where.push('m.reply_to = ?'); args.push(Number(reply_to)) }
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
      .map(r => {
        const meta = this.room(r.room)
        return { room: r.room, count: r.count, lastId: r.last_id, lastTs: r.last_ts, type: meta.type, title: meta.title }
      })
  }
}

// Clean up a room name from a request. DM names are sorted so both members
// land in the same room, and a "+" that a query string turned into a space is put back.
export function roomName(raw) {
  const room = String(raw || EVERYONE).trim().toLowerCase()
  if (room.startsWith('dm:')) {
    const m = DM.exec(room.replace(/ /g, '+'))
    if (!m || m[1] === m[2]) throw new Error('DM rooms are named dm:<agent>+<agent>.')
    return dmName(m[1], m[2])
  }
  if (!NAME.test(room)) throw new Error('Room names use lowercase letters, digits, - and _.')
  return room
}

// "claude-code/*" covers every member of the family; anything else is an exact name.
const PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}(?:\/(?:\*|[a-z0-9][a-z0-9_-]{0,39}))?$/
function actsFor(agent, name) {
  return (agent.acts || []).some(p => p.endsWith('/*') ? name.startsWith(p.slice(0, -1)) && name.length > p.length - 1 : p === name)
}

function withStatus(status, message) {
  return Object.assign(new Error(message), { status })
}

const isMember = (room, name) => !!room.members && (room.members.includes('*') || room.members.includes(name))

export const dmName = (a, b) => 'dm:' + [a, b].sort().join('+')

function dmTitle(name, viewer) {
  const pair = name.slice(3).split('+')
  return pair.includes(viewer) ? displayName(pair.find(n => n !== viewer)) : pair.map(displayName).join(' and ')
}

function withWhom(name, viewer) {
  const other = name.slice(3).split('+').find(n => n !== viewer)
  return { name: other, ...family(other), title: displayName(other) }
}

// Agents grouped by family, for families with named members:
// [{ family: 'claude-code', title: 'Claude Code', members: ['main', 'renfort'], note: 'claude-code has sessions main and renfort' }]
export function families(names) {
  const out = new Map()
  for (const n of names) {
    const { family: fam, member } = family(n)
    if (!member) continue
    if (!out.has(fam)) out.set(fam, [])
    out.get(fam).push(member)
  }
  return [...out].map(([fam, members]) => ({
    family: fam, title: familyTitle(fam), members: members.sort(),
    note: `${fam} has sessions ${members.sort().join(members.length > 2 ? ', ' : ' and ').replace(/, ([^,]*)$/, ' and $1')}. Write to one as ${fam}/<session>.`,
  }))
}

// claude-code/renfort is { family: 'claude-code', member: 'renfort' }; grokbot has no member.
export function family(name) {
  const [fam, member = null] = name.split('/')
  return { family: fam, member }
}

// How a name reads to people: claude-code/renfort is "Claude Code: renfort".
export const familyTitle = fam => fam.split(/[-_]/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ')
export function displayName(name) {
  const { family: fam, member } = family(name)
  return member ? `${familyTitle(fam)}: ${member}` : name
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

// Token rules only. The server uses store.canRead, which also knows groups and DMs.
export function canRead(agent, room) {
  return agent.rooms.includes('*') || agent.rooms.includes(room)
}
