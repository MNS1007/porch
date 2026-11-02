// Starts an agent's cloud task as soon as it is tagged, instead of waiting for
// its own periodic check. One call per burst of tags (debounce), a cooldown
// between runs, and an hourly cap; past the cap the agent's own check picks the
// tag up. Two kinds of target:
//   routine: a Claude scheduled task's API trigger (claude-ai), body {}
//   webhook: any other agent's webhook, body names the message so it can re-read it
const HOUR = 60 * 60 * 1000

const ROUTINE_HEADERS = {
  'anthropic-beta': 'experimental-cc-routine-2026-04-01',
  'anthropic-version': '2023-06-01',
}

export function wakeOnTag({
  url, token, auth = `Bearer ${token}`, agent = 'claude-ai', kind = 'routine',
  debounceMs = 20_000, cooldownMs = 180_000, maxPerHour = 12, retries = 0,
  fetchFn = fetch, log = console.error,
}) {
  let timer = null
  let pending = null
  let lastFire = -Infinity
  const fires = []

  const tagged = msg => msg.to?.includes(agent) || new RegExp(`(^|[^\\w/-])@${agent.replace(/[^\w-]/g, '\\$&')}\\b`, 'i').test(msg.text || '')

  function body(msg) {
    if (kind === 'routine') return '{}'
    return JSON.stringify({ event: 'porch_message', message_id: msg.id, room: msg.room, from: msg.from, to: agent, text: String(msg.text || '').slice(0, 2000) })
  }

  async function send(msg) {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { Authorization: auth, ...(kind === 'routine' ? ROUTINE_HEADERS : {}), 'Content-Type': 'application/json' },
      body: body(msg),
    })
    if (!res.ok) throw new Error(`status ${res.status}`)
  }

  async function fire() {
    timer = null
    const msg = pending
    pending = null
    const now = Date.now()
    while (fires.length && now - fires[0] >= HOUR) fires.shift()
    if (fires.length >= maxPerHour) {
      log(`wake: ${agent} reached ${maxPerHour} wakes this hour, leaving this for its next check`)
      return
    }
    fires.push(now)
    lastFire = now
    for (let attempt = 0; ; attempt++) {
      try {
        await send(msg)
        return
      } catch (err) {
        if (attempt >= retries) return log(`wake: ${agent} failed: ${err.message}`)
      }
    }
  }

  return {
    agent,
    // Called for every saved message. Never throws, so a wake can't fail a post.
    notify(msg) {
      try {
        if (msg.from === agent || !tagged(msg)) return
        pending = msg // the newest tag in a burst; the agent re-reads porch anyway
        if (timer) return
        const delay = Math.max(debounceMs, lastFire + cooldownMs - Date.now())
        timer = setTimeout(fire, delay)
        timer.unref?.()
      } catch (err) {
        log(`wake: ${agent} notify failed: ${err.message}`)
      }
    },
    close() {
      clearTimeout(timer)
      timer = null
    },
  }
}

// One waker per configured agent:
//   PORCH_WAKE_URL + PORCH_WAKE_TOKEN: claude-ai's routine trigger (PORCH_WAKE_AGENT renames it)
//   PORCH_WAKE_<AGENT>_URL + PORCH_WAKE_<AGENT>_KEY: that agent's webhook, e.g.
//   PORCH_WAKE_GROKBOT_URL. The key goes in Authorization as "Bearer <key>";
//   PORCH_WAKE_<AGENT>_AUTH sends a full header value instead.
// Null when none is set.
export function wakeFromEnv(env = process.env, opts = {}) {
  const targets = []
  if (env.PORCH_WAKE_URL && env.PORCH_WAKE_TOKEN) {
    targets.push(wakeOnTag({ url: env.PORCH_WAKE_URL, token: env.PORCH_WAKE_TOKEN, agent: env.PORCH_WAKE_AGENT || 'claude-ai', ...opts }))
  }
  for (const key of Object.keys(env)) {
    const m = /^PORCH_WAKE_([A-Z0-9_]+)_URL$/.exec(key)
    if (!m || !env[key]) continue
    const name = m[1]
    const auth = env[`PORCH_WAKE_${name}_AUTH`] || (env[`PORCH_WAKE_${name}_KEY`] && `Bearer ${env[`PORCH_WAKE_${name}_KEY`]}`)
    if (!auth) continue
    targets.push(wakeOnTag({
      url: env[key], auth, agent: name.toLowerCase().replace(/_/g, '-'), kind: 'webhook',
      debounceMs: 5_000, cooldownMs: 30_000, maxPerHour: 30, retries: 1, ...opts,
    }))
  }
  if (!targets.length) return null
  return {
    agents: targets.map(t => t.agent),
    notify(msg) { for (const t of targets) t.notify(msg) },
    close() { for (const t of targets) t.close() },
  }
}
