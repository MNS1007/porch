// The vault's routes on porch's main server, for agents with a porch token.
// These may be reached through Funnel, so they only list names, take requests and
// hand an approved handle to its own agent once. They never approve anything.
//   GET  /v1/vault                   -> api.list   (?as=<member> for a manager)
//   POST /v1/vault/requests          -> api.request
//   GET  /v1/vault/requests/:id      -> api.status
// Returns true when it answered, false when the path is not one of these.

const MAX_BODY = 16 * 1024

export async function handleVaultHttp(req, res, agent, api) {
  const url = new URL(req.url, 'http://localhost')
  const path = url.pathname.replace(/\/+$/, '')
  try {
    if (path === '/v1/vault' && req.method === 'GET') {
      return send(res, 200, api.list(agent, { as: url.searchParams.get('as') || undefined }))
    }
    if (path === '/v1/vault/requests' && req.method === 'POST') {
      return send(res, 201, api.request(agent, parseJson(await readBody(req))))
    }
    const m = path.match(/^\/v1\/vault\/requests\/(\d{1,12})$/)
    if (m && req.method === 'GET') return send(res, 200, api.status(agent, Number(m[1])))
    return false
  } catch (err) {
    // Our own errors carry a status and a fixed message. Anything else gets a
    // plain message, so no stray text (or value) leaks out.
    return send(res, err.status || 500, { error: err.status ? err.message : 'The vault could not do that.' })
  }
}

function send(res, code, obj) {
  // A status answer can carry a handle: never let anything cache it.
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(obj))
  return true
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', c => {
      data += c
      if (data.length > MAX_BODY) { reject(Object.assign(new Error('Body too large'), { status: 413 })); req.destroy() }
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

function parseJson(body) {
  try {
    const v = JSON.parse(body || '{}')
    if (v && typeof v === 'object' && !Array.isArray(v)) return v
  } catch {}
  throw Object.assign(new Error('Body must be a JSON object'), { status: 400 })
}
