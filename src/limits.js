// Simple in-memory limits for when porch is reachable from the internet.

const WINDOW_MS = 60_000

// Requests per minute for each agent.
export function rateLimiter(perMinute) {
  const hits = new Map() // agent -> timestamps
  return agent => {
    const now = Date.now()
    const list = (hits.get(agent) || []).filter(t => now - t < WINDOW_MS)
    list.push(now)
    hits.set(agent, list)
    return list.length <= perMinute
  }
}

// Slows down token guessing: too many bad tokens from one address locks it out for a while.
export function badTokenGuard({ maxFailures = 10, windowMs = 10 * 60_000, lockMs = 15 * 60_000 } = {}) {
  const failures = new Map() // ip -> { times, lockedUntil }
  return {
    locked(ip) {
      const f = failures.get(ip)
      return !!f && f.lockedUntil > Date.now()
    },
    fail(ip) {
      const now = Date.now()
      const f = failures.get(ip) || { times: [], lockedUntil: 0 }
      f.times = f.times.filter(t => now - t < windowMs)
      f.times.push(now)
      if (f.times.length >= maxFailures) { f.lockedUntil = now + lockMs; f.times = [] }
      failures.set(ip, f)
    },
  }
}

export function clientIp(req) {
  // Tailscale Funnel and most proxies pass the real address in X-Forwarded-For.
  const fwd = req.headers['x-forwarded-for']
  return (fwd ? String(fwd).split(',')[0] : req.socket.remoteAddress || '').trim()
}
