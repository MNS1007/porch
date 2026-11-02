// Shared documents, starting with "memory": one living document about the owner
// that every agent reads and keeps up to date. The text never says who wrote what;
// the history table keeps each version with its author so the owner can look back.

const MAX_DOC = 64 * 1024
const NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/

export const DOCS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS docs (
    name TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    version INTEGER NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS doc_versions (
    name TEXT NOT NULL,
    version INTEGER NOT NULL,
    text TEXT NOT NULL,
    author TEXT NOT NULL,
    ts TEXT NOT NULL,
    PRIMARY KEY (name, version)
  );
`

export class Docs {
  constructor(db) { this.db = db }

  // A document that was never written reads as empty, version 0.
  get(name) {
    checkName(name)
    const d = this.db.prepare('SELECT text, version, updated_at FROM docs WHERE name = ?').get(name)
    return d ? { name, text: d.text, version: d.version, updated_at: d.updated_at } : { name, text: '', version: 0, updated_at: null }
  }

  // Replace the whole text. baseVersion must be the version the writer read.
  replace(name, text, baseVersion, author) {
    if (!Number.isInteger(baseVersion)) throw withStatus(400, 'base_version is required: send the version you read.')
    return this.write(name, author, cur => {
      if (baseVersion !== cur.version) throw conflict(cur)
      return text
    })
  }

  // Replace one section, found by its exact heading line, or add it at the end.
  patchSection(name, heading, body, baseVersion, author) {
    heading = String(heading || '').trim()
    if (!/^#{1,6} \S/.test(heading)) throw withStatus(400, 'section must be a markdown heading, for example "## How Nithin thinks".')
    return this.write(name, author, cur => {
      if (Number.isInteger(baseVersion) && baseVersion !== cur.version) throw conflict(cur)
      return replaceSection(cur.text, heading, String(body ?? ''))
    })
  }

  // Bring back an old version as a new one, so nothing is lost.
  restore(name, version, author) {
    const old = this.version(name, version)
    if (!old) throw withStatus(404, `No version ${version}.`)
    return this.write(name, author, () => old.text)
  }

  history(name) {
    checkName(name)
    return this.db.prepare('SELECT version, author, ts, length(text) AS length FROM doc_versions WHERE name = ? ORDER BY version DESC').all(name)
      .map(v => ({ version: v.version, author: v.author, ts: v.ts, length: v.length }))
  }

  version(name, version) {
    checkName(name)
    const v = this.db.prepare('SELECT version, text, author, ts FROM doc_versions WHERE name = ? AND version = ?').get(name, Number(version))
    return v ? { name, ...v } : null
  }

  // Read, change and save in one transaction, so two writers cannot both win.
  write(name, author, change) {
    checkName(name)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const cur = this.get(name)
      const text = String(change(cur)).replace(/\r\n/g, '\n').trim() + '\n'
      if (text.length > MAX_DOC) throw withStatus(413, `The document can be up to ${MAX_DOC / 1024} KB.`)
      const version = cur.version + 1
      const ts = new Date().toISOString()
      this.db.prepare(`INSERT INTO docs (name, text, version, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET text = excluded.text, version = excluded.version, updated_at = excluded.updated_at`).run(name, text, version, ts)
      this.db.prepare('INSERT INTO doc_versions (name, version, text, author, ts) VALUES (?, ?, ?, ?, ?)').run(name, version, text, author, ts)
      this.db.exec('COMMIT')
      return { name, text, version, updated_at: ts }
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }
}

// A section runs from its heading to the next heading of the same or a higher
// level. Lines inside ``` fences are never taken for headings.
export function replaceSection(doc, heading, body) {
  const level = heading.match(/^#+/)[0].length
  const lines = doc.replace(/\r\n/g, '\n').split('\n')
  body = body.replace(/\r\n/g, '\n').trim()
  // A body that repeats the heading is fine.
  if (body.split('\n')[0].trim() === heading) body = body.split('\n').slice(1).join('\n').trim()
  const block = body ? [heading, '', body] : [heading]
  let fence = false, start = -1, end = lines.length
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) fence = !fence
    if (fence) continue
    const h = /^(#{1,6}) \S/.exec(lines[i])
    if (start < 0) { if (lines[i].trim() === heading) start = i }
    else if (h && h[1].length <= level) { end = i; break }
  }
  if (start < 0) return (doc.trim() ? doc.trim() + '\n\n' : '') + block.join('\n')
  const after = lines.slice(end)
  return [...lines.slice(0, start), ...block, ...(after.length ? ['', ...after] : [])].join('\n')
}

function checkName(name) {
  if (!NAME.test(String(name))) throw withStatus(400, 'Document names use lowercase letters, digits, - and _.')
}

function conflict(cur) {
  return Object.assign(withStatus(409, `Someone saved version ${cur.version} first. Read it and apply your change again.`), { current: cur })
}

function withStatus(status, message) {
  return Object.assign(new Error(message), { status })
}
