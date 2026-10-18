// Finish pipeline: transcribe -> caption cards -> music bed -> mix -> burn in -> encode.
// Shared by the CLI (`npm run finish -- <file>`) and the OnAir Finish panel (via the Vite plugin).
// Every heavy step is cached in .finish/<take>/ so a rerun with the same inputs costs nothing.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { captionStates, checkWords, fixNames, punctuate, groupWords, retext, wordsFromSegments, CADENCE, DEFAULT_BASELINE, STYLES } from './captions.js'
import { renderMusic, MOODS } from './music.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CAPTIONS_SRC = join(ROOT, 'finish', 'captions.js')
if (existsSync(join(ROOT, '.env'))) process.loadEnvFile(join(ROOT, '.env'))

export const TRANSCRIBER = 'openai/whisper-1'
/** Whisper list price, USD per audio minute. */
export const WHISPER_USD_PER_MIN = 0.006
export const DEFAULTS = { captions: true, style: 'pop', music: true, mood: 'wonder', musicDb: 24 }
export { STYLES, MOODS }

const noop = () => {}

function run(cmd, args, { onLine, input } = {}) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    const out = []
    let err = ''
    let buf = ''
    p.stdout.on('data', (d) => {
      out.push(d)
      if (onLine) {
        buf += d.toString()
        const lines = buf.split('\n')
        buf = lines.pop()
        lines.forEach(onLine)
      }
    })
    p.stderr.on('data', (d) => { err += d.toString(); if (err.length > 200_000) err = err.slice(-100_000) })
    p.on('error', rej)
    p.on('close', (code) => (code === 0 ? res({ stdout: Buffer.concat(out), stderr: err }) : rej(new Error(`${cmd} exited ${code}: ${err.slice(-1500)}`))))
    if (input) p.stdin.end(input)
    else p.stdin.end()
  })
}

/** ffmpeg with `-progress`, reporting 0..1 against `durationSec`. */
function ffmpeg(args, durationSec, onPct = noop) {
  return run('ffmpeg', ['-hide_banner', '-y', '-nostats', '-progress', 'pipe:1', ...args], {
    onLine: (l) => {
      const m = /^out_time_us=(\d+)/.exec(l)
      if (m && durationSec) onPct(Math.min(1, Number(m[1]) / 1e6 / durationSec))
    },
  })
}

export async function probe(input) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,avg_frame_rate:format=duration', '-of', 'json', input])
  const j = JSON.parse(stdout.toString())
  const v = j.streams.find((s) => s.codec_type === 'video')
  const a = j.streams.find((s) => s.codec_type === 'audio')
  if (!v) throw new Error('No video stream')
  return { width: v.width, height: v.height, durationSec: Number(j.format.duration), hasAudio: !!a, videoCodec: v.codec_name, avgFps: v.avg_frame_rate }
}

export function workDirFor(input) {
  const st = statSync(input)
  const id = `${basename(input).replace(/\.[^.]+$/, '')}-${createHash('sha1').update(`${resolve(input)}|${st.size}|${st.mtimeMs}`).digest('hex').slice(0, 8)}`
  const dir = join(ROOT, '.finish', id)
  mkdirSync(dir, { recursive: true })
  return dir
}

function cached(path, make) {
  if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8'))
  return Promise.resolve(make()).then((v) => { writeFileSync(path, JSON.stringify(v, null, 1)); return v })
}

/** Mono ~64 kbps AAC, the way Camera Shy sends clip audio to the recogniser. */
async function extractAudio(input, dir) {
  const out = join(dir, 'speech.m4a')
  if (!existsSync(out)) await run('ffmpeg', ['-hide_banner', '-y', '-v', 'error', '-i', input, '-vn', '-ac', '1', '-ar', '24000', '-c:a', 'aac', '-b:a', '64k', out])
  return out
}

/** Pauses in the speech track as [start, end] seconds: chunk cut points and word trimming. */
async function silences(audioPath) {
  const { stderr } = await run('ffmpeg', ['-hide_banner', '-nostats', '-i', audioPath, '-af', 'silencedetect=n=-35dB:d=0.3', '-f', 'null', '-'])
  const cuts = []
  let open = null
  for (const l of stderr.split('\n')) {
    const a = /silence_start: ([\d.]+)/.exec(l)
    const b = /silence_end: ([\d.]+)/.exec(l)
    if (a) open = Number(a[1])
    if (b && open != null) { cuts.push([open, Number(b[1])]); open = null }
  }
  return cuts
}

/**
 * Whisper stretches a word over the pause beside it, which holds a card (and its lit word) on
 * screen through the silence. Cut any detected pause out of a word and keep its longest part.
 */
function trimToSpeech(words, pauses) {
  let trimmed = 0
  const out = words.map((w) => {
    let spans = [[w.startMs, w.endMs]]
    for (const [a, b] of pauses) {
      const pa = Math.round(a * 1000) + 60
      const pb = Math.round(b * 1000) - 60
      if (pb - pa < 200) continue
      spans = spans.flatMap(([x, y]) => (pb <= x || pa >= y ? [[x, y]] : [[x, Math.min(y, pa)], [Math.max(x, pb), y]].filter(([u, v]) => v - u > 0)))
    }
    if (!spans.length) return w
    const best = spans.reduce((m, sp) => (sp[1] - sp[0] > m[1] - m[0] ? sp : m))
    if (best[1] - best[0] < 120) return w
    if (best[0] !== w.startMs || best[1] !== w.endMs) trimmed++
    return { ...w, startMs: best[0], endMs: best[1] }
  })
  return { words: out, trimmed }
}

/** Chunks of about `target` seconds, cut in the nearest pause (never shorter than 6 s). */
function planChunks(cuts, durationSec, target = 15) {
  const bounds = [0]
  while (durationSec - bounds[bounds.length - 1] > target * 1.4) {
    const want = bounds[bounds.length - 1] + target
    const near = cuts.filter((c) => c > bounds[bounds.length - 1] + 6 && Math.abs(c - want) < target * 0.4)
    bounds.push(near.length ? near.reduce((x, y) => (Math.abs(y - want) < Math.abs(x - want) ? y : x)) : want)
  }
  bounds.push(durationSec)
  return bounds.slice(1).map((b, i) => [bounds[i], b])
}

/**
 * Word timings from whisper-1 through the AI Gateway (Camera Shy's call). Long takes go up in
 * ~30 s chunks cut in pauses, the clip length Camera Shy sends: on a whole 2-minute take whisper
 * tidies speech (it dropped "kind of", "right?", "you know"), so captions stopped matching the voice.
 */
export async function transcribe(input, dir, durationSec) {
  return cached(join(dir, 'words.v4.json'), async () => {
    if (!process.env.AI_GATEWAY_API_KEY) throw new Error('AI_GATEWAY_API_KEY is missing: copy .env.example to .env and fill it in')
    const audioPath = await extractAudio(input, dir)
    const pauses = await silences(audioPath)
    const chunks = planChunks(pauses.map(([a, b]) => (a + b) / 2), durationSec)
    const { gateway } = await import('@ai-sdk/gateway')
    const { transcribe: aiTranscribe } = await import('ai')
    const results = await Promise.all(chunks.map(async ([a, b], i) => {
      const part = join(dir, `speech-${i}.m4a`)
      await run('ffmpeg', ['-hide_banner', '-y', '-v', 'error', '-i', audioPath, '-ss', a.toFixed(3), '-to', b.toFixed(3), '-c:a', 'aac', '-b:a', '64k', part])
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 90_000)
      try {
        const r = await aiTranscribe({
          model: gateway.transcription(TRANSCRIBER),
          audio: new Uint8Array(readFileSync(part)),
          // Word granularity is the point; English named; no `prompt` (Whisper transcribes it).
          providerOptions: { openai: { timestampGranularities: ['word'], language: 'en' } },
          maxRetries: 1,
          abortSignal: ctrl.signal,
        })
        const words = wordsFromSegments(r.segments).map((w) => ({ ...w, startMs: w.startMs + Math.round(a * 1000), endMs: w.endMs + Math.round(a * 1000) }))
        return { text: r.text.trim(), words }
      } finally {
        clearTimeout(timer)
      }
    }))
    const { words, trimmed } = trimToSpeech(results.flatMap((r) => r.words), pauses)
    // A chunk cut mid-sentence ends in a period whisper invented; drop it when the next chunk carries on in lower case.
    const text = results.map((r, i) => (/^[a-z]/.test(results[i + 1]?.text ?? '') ? r.text.replace(/[.]$/, '') : r.text)).join(' ')
    const check = checkWords(words, durationSec * 1000)
    if (check.reject) throw new Error(`Word timings refused (${check.reject}): ${JSON.stringify(check)}`)
    return { model: TRANSCRIBER, chunks, text, words, check: { ...check, trimmed }, costUsd: +(durationSec / 60 * WHISPER_USD_PER_MIN).toFixed(4) }
  })
}

/**
 * Where the camera is, per half second. OnAir's Stack layout has a hard horizontal seam between
 * the world (top) and the camera (bottom); when one is found, captions sit just above it so they
 * never cover the face. Without a seam (Hook, Tall PiP, Bubble, World) they use the default line.
 */
export async function detectLayout(input, dir, meta) {
  return cached(join(dir, 'layout.json'), async () => {
    const w = 54
    const h = 96
    const { stdout } = await run('ffmpeg', ['-v', 'error', '-i', input, '-an', '-vf', `fps=2,scale=${w}:${h}:flags=area`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'])
    const frame = w * h * 3 // Stack's seam scores ~250; Hook's hoodie stripes and hands stay under ~120
    const samples = []
    for (let f = 0; f * frame + frame <= stdout.length; f++) {
      const o = f * frame
      const diff = []
      for (let r = 0; r < h - 1; r++) {
        const col = []
        for (let c = 0; c < w; c++) {
          const a = o + (r * w + c) * 3
          const b = a + w * 3
          col.push(Math.abs(stdout[a] - stdout[b]) + Math.abs(stdout[a + 1] - stdout[b + 1]) + Math.abs(stdout[a + 2] - stdout[b + 2]))
        }
        col.sort((x, y) => x - y)
        diff.push(col[Math.floor(w / 2)])
      }
      let best = -1
      let bestV = 0
      for (let r = Math.round(h * 0.33); r < Math.round(h * 0.8); r++) if (diff[r] > bestV) { bestV = diff[r]; best = r }
      const sorted = [...diff].sort((x, y) => x - y)
      const typical = sorted[Math.floor(sorted.length / 2)] + 1
      const seam = bestV >= 160 && bestV / typical >= 12 ? (best + 1) / h : null
      samples.push({ t: f / 2, seam, score: bestV, typical })
    }
    return { fps: 2, samples }
  })
}

/** The last line's baseline for a card spanning [a, b] ms. */
function baselineFor(layout, a, b) {
  if (!layout) return DEFAULT_BASELINE
  const inside = layout.samples.filter((s) => s.t * 1000 >= a - 250 && s.t * 1000 <= b + 250)
  const seams = inside.filter((s) => s.seam).map((s) => s.seam)
  if (!inside.length || seams.length * 2 < inside.length) return DEFAULT_BASELINE
  seams.sort((x, y) => x - y)
  const seam = seams[Math.floor(seams.length / 2)]
  return Math.min(DEFAULT_BASELINE, seam - 0.022)
}

export function buildPhrases(words, style = 'pop', layout = null, text = '') {
  const cadence = { ...CADENCE, maxWords: STYLES[style]?.maxWords ?? CADENCE.maxWords }
  return groupWords(fixNames(punctuate(words, text)), cadence).map((p) => ({ ...p, baseline: baselineFor(layout, p.startMs, p.untilMs) }))
}

/** Transcribe and lay out a take. Cheap on rerun. */
export async function analyze(input, { style = DEFAULTS.style, onProgress = noop } = {}) {
  input = resolve(input)
  const meta = await probe(input)
  if (!meta.hasAudio) throw new Error('This take has no audio track')
  const dir = workDirFor(input)
  onProgress({ stage: 'transcribe', pct: 0, msg: 'Transcribing (whisper-1, word timings)' })
  const [tx, layout] = await Promise.all([
    // A take with no usable speech still gets music and loudness, just no captions.
    transcribe(input, dir, meta.durationSec).catch((e) => ({ model: TRANSCRIBER, text: '', words: [], costUsd: 0, error: String(e?.message ?? e) })),
    detectLayout(input, dir, meta),
  ])
  onProgress({ stage: 'transcribe', pct: 1, msg: tx.error ? `No captions: ${tx.error}` : `${tx.words.length} words` })
  const phrases = buildPhrases(tx.words, style, layout, tx.text)
  return { input, dir, meta, transcript: tx, layout, phrases }
}

/** Accept phrases from the UI, with optional edited `text` per card. */
export function applyEdits(phrases) {
  return phrases
    .map((p) => (typeof p.text === 'string' ? retext(p, p.text) : p))
    .filter((p) => p.words.length)
}

async function measure(file, filter = '') {
  const { stderr } = await run('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-vn', '-af', `${filter}ebur128=peak=true`, '-f', 'null', '-'])
  const tail = stderr.slice(stderr.lastIndexOf('Summary:'))
  const num = (re) => Number(re.exec(tail)?.[1])
  return { lufs: num(/I:\s+(-?[\d.]+) LUFS/), lra: num(/LRA:\s+([\d.]+) LU/), truePeak: num(/Peak:\s+(-?[\d.]+) dBFS/) }
}

/** Voice + ducked music bed, then two-pass loudnorm to -14 LUFS / -1.5 dBTP. */
async function mixAudio(input, dir, meta, music, onPct) {
  const D = meta.durationSec
  const pre = join(dir, 'mix-pre.wav')
  const out = join(dir, 'mix.wav')
  const voice = await measure(input)
  let musicInfo = null
  if (music.enabled) {
    const bed = join(dir, `music-${music.mood}-${Math.ceil(D)}.wav`)
    if (!existsSync(bed)) renderMusic(bed, Math.ceil(D), music.mood)
    const bedL = await measure(bed)
    const targetMusic = voice.lufs - music.db
    const gain = +(targetMusic - bedL.lufs).toFixed(2)
    musicInfo = { mood: music.mood, underVoiceDb: music.db, gainDb: gain }
    const fc = [
      '[0:a]aresample=48000,aformat=channel_layouts=stereo,asplit=2[v][sc]',
      `[1:a]atrim=0:${D.toFixed(3)},volume=${gain}dB,afade=t=in:d=2,afade=t=out:st=${Math.max(0, D - 3).toFixed(3)}:d=3[m0]`,
      '[m0][sc]sidechaincompress=threshold=0.02:ratio=5:attack=60:release=700:knee=4[m]',
      '[v][m]amix=inputs=2:normalize=0:duration=first[mix]',
    ].join(';')
    await ffmpeg(['-i', input, '-i', bed, '-filter_complex', fc, '-map', '[mix]', '-c:a', 'pcm_s16le', pre], D, (p) => onPct(p * 0.6))
  } else {
    await ffmpeg(['-i', input, '-vn', '-af', 'aresample=48000,aformat=channel_layouts=stereo', '-c:a', 'pcm_s16le', pre], D, (p) => onPct(p * 0.6))
  }
  const target = 'I=-14:TP=-1.5:LRA=11'
  const { stderr } = await run('ffmpeg', ['-hide_banner', '-nostats', '-i', pre, '-af', `loudnorm=${target}:print_format=json`, '-f', 'null', '-'])
  const j = JSON.parse(stderr.slice(stderr.lastIndexOf('{'), stderr.lastIndexOf('}') + 1))
  onPct(0.8)
  await run('ffmpeg', ['-hide_banner', '-y', '-v', 'error', '-i', pre, '-af',
    `loudnorm=${target}:measured_I=${j.input_i}:measured_TP=${j.input_tp}:measured_LRA=${j.input_lra}:measured_thresh=${j.input_thresh}:offset=${j.target_offset}:linear=true,aresample=48000`,
    '-c:a', 'pcm_s16le', out])
  onPct(1)
  return { path: out, voice, music: musicInfo }
}

/** Render every caption state to a transparent PNG in headless Chromium, with the shared draw code. */
async function renderCaptionFrames(phrases, style, meta, dir, onPct) {
  const capDir = join(dir, 'caps')
  rmSync(capDir, { recursive: true, force: true })
  mkdirSync(capDir, { recursive: true })
  const karaoke = STYLES[style]?.karaoke ?? true
  const states = captionStates(phrases, karaoke)
  const { chromium } = await import('playwright')
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    const src = readFileSync(CAPTIONS_SRC, 'utf8')
    await page.setContent(`<!doctype html><canvas id="c" width="${meta.width}" height="${meta.height}"></canvas><script type="module">${src}\nwindow.__cap = { drawCard }; window.__ready = true</script>`)
    await page.waitForFunction(() => window.__ready === true)
    const batch = 24
    for (let i = 0; i < states.length; i += batch) {
      const chunk = states.slice(i, i + batch).map((s) => ({ phrase: phrases[s.phrase], active: s.active }))
      const urls = await page.evaluate(async ({ chunk, style, W, H }) => {
        const c = document.getElementById('c')
        const ctx = c.getContext('2d')
        return chunk.map(({ phrase, active }) => {
          ctx.clearRect(0, 0, W, H)
          window.__cap.drawCard(ctx, phrase, active, style, { width: W, height: H }, typeof phrase.baseline === 'number' ? phrase.baseline : 0.765)
          return c.toDataURL('image/png')
        })
      }, { chunk, style, W: meta.width, H: meta.height })
      urls.forEach((u, k) => writeFileSync(join(capDir, `s${String(i + k).padStart(5, '0')}.png`), Buffer.from(u.split(',')[1], 'base64')))
      onPct(Math.min(1, (i + batch) / states.length))
    }
    const blank = await page.evaluate(({ W, H }) => { const c = document.getElementById('c'); c.getContext('2d').clearRect(0, 0, W, H); return c.toDataURL('image/png') }, { W: meta.width, H: meta.height })
    writeFileSync(join(capDir, 'blank.png'), Buffer.from(blank.split(',')[1], 'base64'))
  } finally {
    await browser.close()
  }
  // A concat list on integer milliseconds, so durations can't drift against the audio.
  const lines = ['ffconcat version 1.0']
  let cursor = 0
  const endMs = Math.round(meta.durationSec * 1000)
  const push = (file, ms) => { if (ms > 0) { lines.push(`file '${file}'`, `duration ${(ms / 1000).toFixed(3)}`); cursor += ms } }
  states.forEach((s, i) => {
    const a = Math.max(cursor, Math.round(s.startMs))
    const b = Math.min(endMs, Math.round(s.endMs))
    if (b <= a) return
    push('blank.png', a - cursor)
    push(`s${String(i).padStart(5, '0')}.png`, b - a)
  })
  push('blank.png', Math.max(1, endMs - cursor))
  lines.push(`file 'blank.png'`)
  const list = join(capDir, 'list.ffconcat')
  writeFileSync(list, lines.join('\n') + '\n')
  return { list, states: states.length }
}

export function defaultOutput(input) {
  return join(dirname(input), `${basename(input).replace(/\.[^.]+$/, '')}-final.mp4`)
}

/**
 * Render the finished reel. `opts.phrases` (edited cards) is optional; without it the cards come
 * from the transcript. Returns paths and loudness numbers.
 */
export async function render(input, opts = {}, onProgress = noop) {
  const o = { ...DEFAULTS, ...opts }
  const an = await analyze(input, { style: o.style, onProgress })
  const { meta, dir } = an
  const output = resolve(o.output ?? defaultOutput(an.input))
  if (output === an.input) throw new Error('Output would overwrite the original')
  const phrases = o.phrases ? applyEdits(o.phrases) : an.phrases
  const step = (stage, msg) => (pct) => onProgress({ stage, pct, msg })

  onProgress({ stage: 'mix', pct: 0, msg: o.music ? `Music: ${o.mood}, ${o.musicDb} dB under the voice` : 'Normalising audio' })
  const mix = await mixAudio(an.input, dir, meta, { enabled: o.music, mood: o.mood, db: o.musicDb }, step('mix', 'Mixing audio'))

  let caps = null
  if (o.captions && phrases.length) {
    onProgress({ stage: 'captions', pct: 0, msg: 'Drawing caption cards' })
    caps = await renderCaptionFrames(phrases, o.style, meta, dir, step('captions', 'Drawing caption cards'))
  }

  onProgress({ stage: 'encode', pct: 0, msg: 'Encoding H.264, 30 fps CFR' })
  const tmp = `${output}.part.mp4`
  const args = ['-i', an.input, '-i', mix.path]
  let vf
  if (caps) {
    args.push('-f', 'concat', '-safe', '0', '-i', caps.list)
    vf = '[0:v]fps=30,format=yuv420p[b];[2:v]fps=30,format=rgba[c];[b][c]overlay=0:0:eof_action=pass:format=auto,format=yuv420p[v]'
  } else {
    vf = '[0:v]fps=30,format=yuv420p[v]'
  }
  args.push('-filter_complex', vf, '-map', '[v]', '-map', '1:a',
    '-c:v', 'libx264', '-profile:v', 'high', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', '30', '-fps_mode', 'cfr',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-shortest', '-movflags', '+faststart', tmp)
  await ffmpeg(args, meta.durationSec, step('encode', 'Encoding H.264, 30 fps CFR'))
  await run('mv', [tmp, output])

  const loudness = await measure(output)
  const transcriptPath = output.replace(/\.mp4$/, '.transcript.json')
  writeFileSync(transcriptPath, JSON.stringify({
    source: an.input, output, model: an.transcript.model, costUsd: an.transcript.costUsd, text: an.transcript.text,
    words: an.transcript.words, cards: phrases.map((p) => ({ startMs: p.startMs, untilMs: p.untilMs, baseline: p.baseline, text: p.words.map((w) => w.text).join(' '), words: p.words })),
    settings: { captions: o.captions, style: o.style, music: o.music, mood: o.mood, musicDb: o.musicDb }, mix: { voice: mix.voice, music: mix.music }, loudness,
  }, null, 1))
  const result = { output, transcriptPath, durationSec: (await probe(output)).durationSec, loudness, voice: mix.voice, music: mix.music, cards: phrases.length, captionStates: caps?.states ?? 0, costUsd: an.transcript.costUsd }
  onProgress({ stage: 'done', pct: 1, msg: 'Done' })
  return result
}
