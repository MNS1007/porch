// What a proxied call may cost, in USD.
//
// Prices are USD per 1M tokens, rounded and taken from memory of the providers'
// public pricing pages. They must be checked against those pages before you rely
// on them:
//   https://openai.com/api/pricing
//   https://ai.google.dev/gemini-api/docs/pricing
// Where a model has a long-prompt tier, the higher tier is used. Priority tier
// is not priced: the proxy refuses it. Only exact names match; any other name,
// a dated snapshot included, gets 'default', the most expensive row, on purpose:
// a wrong guess should refuse a call, not let it overspend. Gemini rows also
// carry an 'audio' input price, used for audio and video input.

export const PRICES = {
  openai: {
    'gpt-4o': { input: 2.5, output: 10 },
    'gpt-4o-2024-05-13': { input: 5, output: 15 },
    'gpt-4o-mini': { input: 0.15, output: 0.6 },
    'gpt-4.1': { input: 2, output: 8 },
    'gpt-4.1-mini': { input: 0.4, output: 1.6 },
    'gpt-4.1-nano': { input: 0.1, output: 0.4 },
    'gpt-5': { input: 1.25, output: 10 },
    'gpt-5-mini': { input: 0.25, output: 2 },
    'gpt-5-nano': { input: 0.05, output: 0.4 },
    'gpt-5-pro': { input: 15, output: 120 },
    'o3': { input: 2, output: 8 },
    'o3-pro': { input: 20, output: 80 },
    'o4-mini': { input: 1.1, output: 4.4 },
    'o1-pro': { input: 150, output: 600 },
    default: { input: 150, output: 600 },
  },
  gemini: {
    'gemini-2.0-flash': { input: 0.1, output: 0.4, audio: 0.7 },
    'gemini-2.5-flash': { input: 0.3, output: 2.5, audio: 1 },
    'gemini-2.5-flash-lite': { input: 0.1, output: 0.4, audio: 0.3 },
    'gemini-2.5-pro': { input: 2.5, output: 15, audio: 2.5 },
    default: { input: 5, output: 30, audio: 5 },
  },
}

// Output tokens assumed when the request sets no limit. Conservative on purpose;
// set a max tokens field to get a smaller estimate.
export const DEFAULT_MAX_OUTPUT = { openai: 32_768, gemini: 65_536 }

const TEXT_BYTES_PER_TOKEN = 3 // real text is closer to 4, so this overcounts
const MEDIA_TOKENS_FLOOR = 3_000 // per image, audio or video blob
const MEDIA_BYTES_PER_TOKEN = 200 // extra for large image and video blobs
const AUDIO_BYTES_PER_TOKEN = 30 // low-bitrate audio packs many tokens into few bytes

// Exact name, else the provider default.
export function priceFor(provider, model) {
  const table = PRICES[provider]
  if (!table) throw new Error(`Unknown provider "${provider}".`)
  const name = String(model || '').replace(/^models\//, '')
  if (Object.hasOwn(table, name) && name !== 'default') return table[name]
  return table.default
}

// Rough input tokens, split into text, media and audio. A string is a blob only
// where a provider puts one (inlineData or input_audio data, or a data: URL in
// url, image_url or file_data), never because it looks like base64: long text
// with no spaces is still text. Images get a fixed allowance plus size; audio
// and video are kept apart so Gemini can price them higher; any other blob (a
// PDF, plain text) counts as text on its decoded size, which errs high.
export function inputParts(body) {
  const t = { text: 0, media: 0, audio: 0 }
  const walk = (v, key, parent) => {
    if (typeof v === 'string') {
      const kind = blobKind(v, key, parent)
      if (kind === 'media') t.media += MEDIA_TOKENS_FLOOR + Math.ceil(v.length * 0.75 / MEDIA_BYTES_PER_TOKEN)
      else if (kind === 'audio') t.audio += MEDIA_TOKENS_FLOOR + Math.ceil(v.length * 0.75 / AUDIO_BYTES_PER_TOKEN)
      else if (kind === 'doc') t.text += Math.ceil(v.length * 0.75)
      else t.text += Buffer.byteLength(v)
    } else if (Array.isArray(v)) v.forEach(x => walk(x, key, parent))
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { t.text += k.length; walk(x, k, v) }
    else if (v != null) t.text += String(v).length
  }
  walk(body, null, null)
  return { text: Math.ceil(t.text / TEXT_BYTES_PER_TOKEN), media: t.media, audio: t.audio }
}

export function inputTokens(body) {
  const p = inputParts(body)
  return p.text + p.media + p.audio
}

const DATA_URL_KEYS = ['url', 'image_url', 'file_data']

// 'media', 'audio', 'doc' or null (plain text), for string s found at parent[key].
function blobKind(s, key, parent) {
  let mime
  if (key === 'data' && parent && (parent.mimeType || parent.mime_type)) mime = parent.mimeType || parent.mime_type
  else if (key === 'data' && parent?.format != null) mime = 'audio/' + parent.format
  else if (DATA_URL_KEYS.includes(key) && s.startsWith('data:') && s.slice(0, 200).includes(',')) mime = s.slice(5, s.indexOf(','))
  // A linked image costs the provider's image tokens, not the link's length.
  else if ((key === 'url' || key === 'image_url') && /^https?:\/\//i.test(s)) mime = 'image/linked'
  else return null
  mime = String(mime).toLowerCase()
  if (mime.startsWith('image/')) return 'media'
  if (mime.startsWith('audio/') || mime.startsWith('video/')) return 'audio'
  return 'doc'
}

// The most output the request allows, times the number of choices asked for.
export function maxOutputTokens(provider, body) {
  const b = body || {}
  if (provider === 'openai') {
    const max = num(b.max_completion_tokens) ?? num(b.max_tokens) ?? num(b.max_output_tokens) ?? DEFAULT_MAX_OUTPUT.openai
    return max * Math.max(1, num(b.n) ?? 1)
  }
  const g = b.generationConfig || b.generation_config || {}
  const max = num(g.maxOutputTokens) ?? num(g.max_output_tokens) ?? DEFAULT_MAX_OUTPUT.gemini
  const think = g.thinkingConfig || g.thinking_config || {}
  const budget = num(think.thinkingBudget) ?? num(think.thinking_budget) ?? 0
  return (max + Math.max(0, budget)) * Math.max(1, num(g.candidateCount) ?? num(g.candidate_count) ?? 1)
}

// True when the request set its own output limit.
export function hasOutputLimit(provider, body) {
  const b = body || {}
  if (provider === 'openai') return [b.max_completion_tokens, b.max_tokens, b.max_output_tokens].some(x => num(x) != null)
  const g = b.generationConfig || b.generation_config || {}
  return num(g.maxOutputTokens ?? g.max_output_tokens) != null
}

// Worst case before the call.
export function estimate(provider, model, body) {
  const p = priceFor(provider, model)
  const t = inputParts(body)
  return usd(t.text + t.media, maxOutputTokens(provider, body), p) + t.audio * (p.audio ?? p.input) / 1_000_000
}

// USD from the provider's usage block, or null when there is none. Cached
// input is billed at full price, so this errs high.
export function actual(provider, model, usage) {
  const t = tokens(provider, usage)
  if (!t) return null
  const p = priceFor(provider, model)
  // Gemini splits the prompt by modality; audio and video cost more.
  const heard = provider === 'gemini' ? Math.min(t.input, audioTokens(usage)) : 0
  return usd(t.input - heard, t.output, p) + heard * (p.audio ?? p.input) / 1_000_000
}

function audioTokens(usage) {
  const list = Array.isArray(usage.promptTokensDetails) ? usage.promptTokensDetails : []
  return list.filter(d => /^(AUDIO|VIDEO)$/i.test(String(d?.modality || ''))).reduce((a, d) => a + (num(d.tokenCount) ?? 0), 0)
}

// {input, output} from an OpenAI usage block or a Gemini usageMetadata block.
export function tokens(provider, usage) {
  if (!usage || typeof usage !== 'object') return null
  if (provider === 'openai') {
    const input = num(usage.prompt_tokens) ?? num(usage.input_tokens)
    const output = num(usage.completion_tokens) ?? num(usage.output_tokens)
    if (input == null && output == null) return null
    return { input: input ?? 0, output: output ?? 0 }
  }
  const input = num(usage.promptTokenCount)
  const output = num(usage.candidatesTokenCount)
  const thoughts = num(usage.thoughtsTokenCount)
  if (input == null && output == null && thoughts == null) return null
  return { input: (input ?? 0) + (num(usage.toolUsePromptTokenCount) ?? 0), output: (output ?? 0) + (thoughts ?? 0) }
}

const usd = (input, output, p) => (input * p.input + output * p.output) / 1_000_000

const num = x => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : null)
