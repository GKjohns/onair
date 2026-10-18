// Caption engine shared by the Finish UI (live preview), the render page (PNG states for ffmpeg)
// and the Node pipeline (grouping, name fixes, timing). Plain JS, no imports, so the same file
// runs in Vite, in Node, and inlined into a headless Chromium page.
//
// Timing and cadence mirror Camera Shy (camera_shy/src/app/utils/clipCaptions.ts):
// whisper-1 word timings, phrases break at 4 words, 1.6 s span, a 500 ms pause, or a
// sentence end; a phrase holds 250 ms past its last word but never past the next phrase;
// zero-length words are repaired to <= 280 ms. Sizing is min(h * 0.046, w * 0.066), centred,
// wrapped at 86% of the width, with the spoken word lit in Camera Shy's ball yellow.

export const BALL = '#facc15'
const PLATE = 'rgba(5, 8, 12, 0.72)'
const SYSTEM_STACK = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'

export const CADENCE = { maxWords: 4, maxSpanMs: 1600, gapBreakMs: 500, holdMs: 250 }
const REPAIR_WORD_MS = 280

/** Caption looks. `pop` is the reel default; `plate` is Camera Shy's Pop pack; `clean` is its Clean pack. */
export const STYLES = {
  pop: { label: 'Pop (stroke, yellow word)', weight: 800, sizeH: 0.046, sizeW: 0.066, lineHeight: 1.18, textCase: 'upper', plate: false, stroke: 0.12, karaoke: true, maxWords: 4 },
  plate: { label: 'Plate (dark box, yellow word)', weight: 800, sizeH: 0.046, sizeW: 0.066, lineHeight: 1.22, textCase: 'upper', plate: true, stroke: 0, karaoke: true, maxWords: 4 },
  clean: { label: 'Clean (white, no highlight)', weight: 650, sizeH: 0.046, sizeW: 0.066, lineHeight: 1.2, textCase: 'none', plate: false, stroke: 0.08, karaoke: false, maxWords: 5 },
}

/** Mis-hearings of names Kyle says on camera. Applied word-by-word and across word pairs. */
export const NAME_FIXES = [
  // two-word fixes first: [regex over "a b", replacement words]
  [/^(voice|voice-)[\s-]*(world|whirled|word|worlds)([.,!?…]*)$/i, (m) => ['Voice', `World${m[3]}`]],
  [/^(monument|monumental|monuments)\s+(labs?|lapse)([.,!?…'s]*)$/i, (m) => ['Monument', `Labs${m[3]}`]],
]
export const WORD_FIXES = [
  [/^voiceworld([.,!?…'s]*)$/i, (m) => `Voice World${m[1]}`],
  [/^(claud|clawed|clod|klaud|claude)([.,!?…]*|'s)$/i, (m) => `Claude${m[2]}`],
  [/^(kile|kyle)([.,!?…]*|'s)$/i, (m) => `Kyle${m[2]}`],
]

/** Whisper segments (seconds) -> words (ms): drop broken spans, repair zero-length ones. */
export function wordsFromSegments(segments) {
  const words = []
  for (const s of segments) {
    const text = String(s.text ?? '').trim()
    if (!text) continue
    const startMs = Math.round(s.startSecond * 1000)
    const endMs = Math.round(s.endSecond * 1000)
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || endMs < startMs) continue
    words.push({ text, startMs, endMs })
  }
  words.sort((a, b) => a.startMs - b.startMs)
  return words.map((w, i) => {
    if (w.endMs > w.startMs) return w
    const room = (words[i + 1]?.startMs ?? Infinity) - w.startMs
    return { ...w, endMs: w.startMs + Math.min(REPAIR_WORD_MS, Math.max(0, room)) }
  })
}

/** Camera Shy's plausibility guard: refuse a word list we can't believe. */
export function checkWords(words, windowMs) {
  const longest = words.length ? Math.max(...words.map((w) => w.endMs - w.startMs)) : 0
  const span = words.length ? words[words.length - 1].endMs - words[0].startMs : 0
  let reject = null
  if (longest > 2000) reject = 'long_word'
  else if (windowMs && span > windowMs * 1.25 + 1000) reject = 'span_overrun'
  else if (windowMs && words.length < Math.max(1, Math.floor(windowMs / 5000))) reject = 'sparse'
  return { returned: words.length, spanMs: span, longestWordMs: longest, reject }
}

/** Fix names. Pair fixes merge two words into the same two slots, so timings stay put. */
export function fixNames(words) {
  const out = words.map((w) => ({ ...w }))
  for (let i = 0; i < out.length - 1; i++) {
    const pair = `${out[i].text} ${out[i + 1].text}`
    for (const [re, fn] of NAME_FIXES) {
      const m = re.exec(pair)
      if (m) {
        const [a, b] = fn(m)
        out[i].text = a
        out[i + 1].text = b
      }
    }
  }
  for (const w of out) {
    for (const [re, fn] of WORD_FIXES) {
      const m = re.exec(w.text)
      if (m) w.text = fn(m)
    }
  }
  return out
}

const norm = (t) => t.toLowerCase().replace(/[^a-z0-9]/g, '')

/**
 * Whisper's word list has no punctuation or apostrophes; its `text` does. Walk both in order and
 * give each word its spelling from the text, so sentence ends can break cards and "y all" reads
 * "y'all". Words that can't be matched keep their own text.
 */
export function punctuate(words, text) {
  if (!text) return words
  const toks = String(text).split(/\s+/).filter(Boolean)
  const out = []
  let j = 0
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    let hit = -1
    for (let k = j; k < Math.min(toks.length, j + 6); k++) if (norm(toks[k]) === norm(w.text) && norm(w.text)) { hit = k; break }
    if (hit < 0 && words[i + 1]) {
      const both = norm(w.text + words[i + 1].text)
      for (let k = j; k < Math.min(toks.length, j + 6); k++) {
        if (norm(toks[k]) === both) {
          out.push({ text: toks[k], startMs: w.startMs, endMs: words[i + 1].endMs })
          i++
          j = k + 1
          hit = -2
          break
        }
      }
      if (hit === -2) continue
    }
    if (hit >= 0) { out.push({ ...w, text: toks[hit] }); j = hit + 1 } else out.push({ ...w })
  }
  return out
}

const endsSentence = (t) => /[.!?…]["'”’)]?$/.test(t)

/** Words -> caption cards, Camera Shy's cadence. */
export function groupWords(words, cadence = CADENCE) {
  const phrases = []
  let cur = []
  const flush = () => {
    if (!cur.length) return
    phrases.push({ words: cur, startMs: cur[0].startMs, untilMs: cur[cur.length - 1].endMs + cadence.holdMs })
    cur = []
  }
  for (const w of words) {
    const prev = cur[cur.length - 1]
    const gap = prev ? w.startMs - prev.endMs : 0
    const span = cur[0] ? w.endMs - cur[0].startMs : 0
    if (prev && (cur.length >= cadence.maxWords || span > cadence.maxSpanMs || gap > cadence.gapBreakMs || endsSentence(prev.text))) flush()
    cur.push(w)
  }
  flush()
  for (let i = 0; i < phrases.length - 1; i++) phrases[i].untilMs = Math.min(phrases[i].untilMs, phrases[i + 1].startMs)
  return phrases
}

/**
 * Apply an edited card text. Same word count keeps every timing; a different count spreads the
 * new words evenly over the card's spoken span (the honest fallback Camera Shy uses for cues).
 */
export function retext(phrase, text) {
  const parts = String(text).trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return { ...phrase, words: [] }
  if (parts.length === phrase.words.length) return { ...phrase, words: phrase.words.map((w, i) => ({ ...w, text: parts[i] })) }
  const a = phrase.words[0]?.startMs ?? phrase.startMs
  const b = phrase.words[phrase.words.length - 1]?.endMs ?? phrase.untilMs
  const per = Math.max(1, b - a) / parts.length
  return { ...phrase, words: parts.map((t, i) => ({ text: t, startMs: Math.round(a + i * per), endMs: Math.round(a + (i + 1) * per) })) }
}

/**
 * Every distinct picture the captions make, in time order: for each card, one state per stretch
 * where the lit word is constant (`active` = word index, or -1 between words).
 */
export function captionStates(phrases, karaoke = true) {
  const states = []
  phrases.forEach((p, pi) => {
    if (!p.words.length || p.untilMs <= p.startMs) return
    if (!karaoke) return states.push({ phrase: pi, active: -1, startMs: p.startMs, endMs: p.untilMs })
    const cuts = new Set([p.startMs, p.untilMs])
    for (const w of p.words) { cuts.add(Math.max(p.startMs, Math.min(p.untilMs, w.startMs))); cuts.add(Math.max(p.startMs, Math.min(p.untilMs, w.endMs))) }
    const ts = [...cuts].sort((x, y) => x - y)
    for (let i = 0; i < ts.length - 1; i++) {
      const t = ts[i]
      if (ts[i + 1] - t < 1) continue
      const active = p.words.findIndex((w) => t >= w.startMs && t < w.endMs)
      const last = states[states.length - 1]
      if (last && last.phrase === pi && last.active === active) last.endMs = ts[i + 1]
      else states.push({ phrase: pi, active, startMs: t, endMs: ts[i + 1] })
    }
  })
  return states
}

export function fontSizeFor(viewport, style) {
  const s = STYLES[style] ?? STYLES.pop
  return Math.max(10, Math.round(Math.min(viewport.height * s.sizeH, viewport.width * s.sizeW)))
}

/**
 * Draw one caption card. `active` is the lit word index (-1 for none). `baselineFrac` is where the
 * LAST line's baseline sits, as a fraction of frame height; earlier lines stack upward from it.
 */
export function drawCard(ctx, phrase, active, style, viewport, baselineFrac) {
  const s = STYLES[style] ?? STYLES.pop
  const W = viewport.width
  const H = viewport.height
  const fontSize = fontSizeFor(viewport, style)
  const lineH = Math.round(fontSize * s.lineHeight)
  ctx.save()
  ctx.font = `${s.weight} ${fontSize}px ${SYSTEM_STACK}`
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  ctx.lineJoin = 'round'
  const tokens = phrase.words.map((w, i) => {
    const text = s.textCase === 'upper' ? w.text.toUpperCase() : w.text
    return { text, i, width: ctx.measureText(text).width }
  })
  const space = ctx.measureText(' ').width
  const maxW = W * 0.86
  const lines = []
  let line = []
  let lw = 0
  for (const t of tokens) {
    const add = line.length ? space + t.width : t.width
    if (line.length && lw + add > maxW) { lines.push(line); line = []; lw = 0 }
    line.push(t)
    lw += line.length === 1 ? t.width : add
  }
  if (line.length) lines.push(line)

  const lastBaseline = Math.round(H * baselineFrac)
  const first = lastBaseline - (lines.length - 1) * lineH
  lines.forEach((ln, li) => {
    const base = first + li * lineH
    const width = ln.reduce((sum, t, k) => sum + t.width + (k ? space : 0), 0)
    let x = Math.round(W / 2 - width / 2)
    if (s.plate) {
      const px = fontSize * 0.34
      const py = fontSize * 0.2
      ctx.fillStyle = PLATE
      ctx.beginPath()
      ctx.roundRect(x - px, base - fontSize + py * 0.15 - py, width + px * 2, fontSize + py * 2, fontSize * 0.26)
      ctx.fill()
    }
    for (const [k, t] of ln.entries()) {
      if (k) x += space
      if (s.stroke) {
        ctx.shadowColor = 'transparent'
        ctx.lineWidth = Math.max(1, fontSize * s.stroke)
        ctx.strokeStyle = 'rgba(5, 8, 12, 0.85)'
        ctx.strokeText(t.text, x, base)
        ctx.shadowColor = 'rgba(5, 8, 12, 0.9)'
        ctx.shadowBlur = Math.round(fontSize * 0.28)
        ctx.shadowOffsetY = Math.round(fontSize * 0.05)
      }
      ctx.fillStyle = s.karaoke && t.i === active ? BALL : '#ffffff'
      ctx.fillText(t.text, x, base)
      ctx.shadowColor = 'transparent'
      x += t.width
    }
  })
  ctx.restore()
}

/** Where a card's last baseline goes: the card's own `baseline` if set, else the default. */
export const DEFAULT_BASELINE = 0.765
export const baselineOf = (phrase) => (typeof phrase.baseline === 'number' ? phrase.baseline : DEFAULT_BASELINE)
