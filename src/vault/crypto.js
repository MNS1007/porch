// Key wrapping, per-secret encryption and capability handles for the vault.
// The master key is a random 32-byte AES-256 key. On disk it only exists
// wrapped: AES-256-GCM under a key that scrypt derives from the passphrase,
// and on Windows that result is also DPAPI-protected for the current user.
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto'
import { execFileSync } from 'node:child_process'

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }
const PS = 'powershell.exe'
const PS_TIMEOUT = 20000

const b64 = buf => Buffer.from(buf).toString('base64')
const unb64 = str => Buffer.from(str, 'base64')

function derive(passphrase, salt) {
  if (typeof passphrase !== 'string' || !passphrase) throw new Error('passphrase required')
  return scryptSync(passphrase.normalize('NFKC'), salt, 32, SCRYPT)
}

function seal(key, plain) {
  const nonce = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key, nonce)
  const ciphertext = Buffer.concat([c.update(plain), c.final()])
  return { ciphertext, nonce, tag: c.getAuthTag() }
}

function open(key, { ciphertext, nonce, tag }) {
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(nonce))
  d.setAuthTag(Buffer.from(tag))
  return Buffer.concat([d.update(Buffer.from(ciphertext)), d.final()])
}

// DPAPI through PowerShell. The bytes go in on stdin and come back on stdout,
// never on the command line. The input is already scrypt-wrapped, so even
// stdin never carries the raw master key.
function dpapi(op, data) {
  const script = [
    'Add-Type -AssemblyName System.Security',
    '$in = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())',
    `$out = [System.Security.Cryptography.ProtectedData]::${op}($in, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)`,
    '[Console]::Out.Write([Convert]::ToBase64String($out))',
  ].join('; ')
  const out = execFileSync(PS, ['-NoProfile', '-NonInteractive', '-Command', script], {
    input: b64(data), timeout: PS_TIMEOUT, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
  })
  const result = unb64(out.toString().trim())
  if (!result.length) throw new Error('dpapi returned nothing')
  return result
}

// Returns a self-describing string: 'dpapi:<salt>:<b64>' or 'scrypt:<salt>:<b64>',
// where the salt (not secret) is repeated in the clear for the meta table and the
// inner blob is JSON {salt, nonce, tag, ciphertext}. On Windows we try DPAPI
// (CurrentUser) on top of scrypt; if PowerShell or DPAPI fails we fall back to
// scrypt only, which is still safe but loses the tie to the Windows account.
// Pass {dpapi: false} to skip DPAPI (tests, or PORCH_VAULT_DPAPI=off).
export function wrapKey(masterKey, passphrase, { dpapi: useDpapi = defaultDpapi() } = {}) {
  if (!Buffer.isBuffer(masterKey) || masterKey.length !== 32) throw new Error('master key must be 32 bytes')
  const salt = randomBytes(16)
  const s = seal(derive(passphrase, salt), masterKey)
  const blob = Buffer.from(JSON.stringify({ salt: b64(salt), nonce: b64(s.nonce), tag: b64(s.tag), ciphertext: b64(s.ciphertext) }))
  if (useDpapi) {
    try { return `dpapi:${b64(salt)}:${b64(dpapi('Protect', blob))}` } catch { /* fall back to scrypt only */ }
  }
  return `scrypt:${b64(salt)}:${b64(blob)}`
}

// Throws on a wrong passphrase or a damaged blob. The message never says why.
export function unwrapKey(wrapped, passphrase) {
  try {
    const [kind, , body] = String(wrapped).split(':')
    let blob = unb64(body)
    if (kind === 'dpapi') blob = dpapi('Unprotect', blob)
    else if (kind !== 'scrypt') throw new Error('bad format')
    const w = JSON.parse(blob.toString())
    const key = open(derive(passphrase, unb64(w.salt)), { ciphertext: unb64(w.ciphertext), nonce: unb64(w.nonce), tag: unb64(w.tag) })
    if (key.length !== 32) throw new Error('bad key')
    return key
  } catch {
    throw new Error('could not unwrap the master key')
  }
}

// The salt inside a wrapped key, for the meta table. Not secret.
export const wrappedSalt = wrapped => String(wrapped).split(':')[1] || null

export const wrapKind = wrapped => String(wrapped).split(':')[0]

export function encrypt(masterKey, plaintext) {
  return seal(masterKey, Buffer.from(String(plaintext), 'utf8'))
}

// Returns the plaintext string. Throws a plain error if the tag fails.
export function decrypt(masterKey, parts) {
  let buf
  try { buf = open(masterKey, parts) } catch { throw new Error('could not decrypt') }
  const text = buf.toString('utf8')
  buf.fill(0)
  return text
}

export const hashHandle = handle => createHash('sha256').update(String(handle)).digest('hex')

export function newHandle() {
  const handle = 'pvh_' + randomBytes(32).toString('base64url')
  return { handle, hash: hashHandle(handle) }
}

function defaultDpapi() {
  return process.platform === 'win32' && process.env.PORCH_VAULT_DPAPI !== 'off'
}
