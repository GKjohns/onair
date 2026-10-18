// Finish: captions + music for a recorded take. Talks to the Finish API on the dev server
// (finish/vite-plugin.mjs) and previews captions with the same draw code the render uses.
import { STYLES, captionStates, drawCard, retext, baselineOf, type CaptionPhrase, type StyleId } from '../finish/captions.js'

type Take = { path: string; name: string; size: number; mtimeMs: number; dir: string; finished: string | null }
type Card = CaptionPhrase & { text: string; edited: boolean }
type Job = { state: 'running' | 'done' | 'error'; stage: string; pct: number; msg: string; error: string | null; result: any }

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
const api = async (path: string, init?: RequestInit) => {
  const r = await fetch(`/api/finish${path}`, init)
  const j = await r.json()
  if (!r.ok) throw new Error(j.error ?? r.statusText)
  return j
}
const post = (path: string, body: unknown) => api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const fileUrl = (p: string, download = false) => `/api/finish/file?path=${encodeURIComponent(p)}${download ? '&download' : ''}`
const ts = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${Math.floor((ms % 1000) / 100)}`

const PREFS = 'onair.finish'
type Prefs = { captions: boolean; style: StyleId; music: boolean; mood: string; musicDb: number }
const prefs: Prefs = (() => {
  const d: Prefs = { captions: true, style: 'pop', music: true, mood: 'wonder', musicDb: 24 }
  try { return { ...d, ...JSON.parse(localStorage.getItem(PREFS) ?? '{}') } } catch { return d }
})()
const savePrefs = () => { try { localStorage.setItem(PREFS, JSON.stringify(prefs)) } catch {} }

let source: { path: string; name: string } | null = null
let cards: Card[] = []
let meta: { width: number; height: number; durationSec: number } | null = null
let analyzedStyle = ''
let lastTake: { blob: Blob; name: string } | null = null

const video = () => $<HTMLVideoElement>('fVideo')
const overlay = () => $<HTMLCanvasElement>('fOverlay')

function setStatus(msg: string, kind: '' | 'error' | 'ok' = '') {
  const el = $('fStatus')
  el.textContent = msg
  el.dataset.kind = kind
}

function open() {
  $('finish').hidden = false
  document.body.dataset.finish = 'open'
  refreshTakes()
}
function close() {
  $('finish').hidden = true
  delete document.body.dataset.finish
  video().pause()
}

async function refreshTakes() {
  const sel = $<HTMLSelectElement>('fTake')
  const { takes } = (await api('/takes')) as { takes: Take[] }
  const current = source?.path
  sel.innerHTML = '<option value="">Pick a take...</option>' + takes.map((t) =>
    `<option value="${t.path}">${t.name} · ${(t.size / 1e6).toFixed(0)} MB · ${t.dir}${t.finished ? ' · finished' : ''}</option>`).join('')
  if (current) sel.value = current
}

async function upload(blob: Blob, name: string) {
  setStatus(`Uploading ${name} (${(blob.size / 1e6).toFixed(0)} MB)...`)
  const r = await fetch(`/api/finish/upload?name=${encodeURIComponent(name)}`, { method: 'POST', body: blob })
  const j = await r.json()
  if (!r.ok) throw new Error(j.error)
  await refreshTakes()
  return j.path as string
}

async function choose(path: string, name: string) {
  source = { path, name }
  $<HTMLSelectElement>('fTake').value = path
  $('fResult').innerHTML = ''
  video().src = fileUrl(path)
  cards = []
  renderCards()
  await analyzeSource()
}

async function analyzeSource() {
  if (!source) return
  const style = prefs.style
  setStatus('Transcribing with word timings (first time takes ~10 s per 2 min)...')
  $<HTMLButtonElement>('fRender').disabled = true
  try {
    const a = await post('/analyze', { path: source.path, style })
    meta = a.meta
    analyzedStyle = style
    cards = (a.phrases as CaptionPhrase[]).map((p) => ({ ...p, text: p.words.map((w) => w.text).join(' '), edited: false }))
    renderCards()
    if (a.transcriptError) setStatus(`No captions for this take (${a.transcriptError}). Music and loudness still work.`, 'error')
    else setStatus(`${a.words} words in ${cards.length} cards · ${a.model} · about $${a.costUsd.toFixed(3)}. Fix any words, then Render.`, 'ok')
    $('fOut').textContent = `Saves to ${a.output}`
    $<HTMLButtonElement>('fRender').disabled = false
  } catch (e: any) {
    setStatus(e.message, 'error')
  }
}

function renderCards() {
  const list = $('fCards')
  list.innerHTML = ''
  cards.forEach((c, i) => {
    const row = document.createElement('div')
    row.className = 'fcard'
    row.dataset.i = String(i)
    const t = document.createElement('button')
    t.className = 'ftime'
    t.textContent = ts(c.startMs)
    t.title = 'Jump here'
    t.onclick = () => { video().currentTime = c.startMs / 1000; video().play().catch(() => {}) }
    const input = document.createElement('input')
    input.value = c.text
    input.spellcheck = true
    input.oninput = () => {
      const next = retext(c, input.value)
      cards[i] = { ...next, text: input.value, edited: true }
      row.classList.add('edited')
      drawOverlay()
    }
    row.append(t, input)
    list.append(row)
  })
}

/** The card on screen at `ms`, with its lit word: the same states the render burns in. */
function stateAt(ms: number) {
  const style = prefs.style
  const states = captionStates(cards, STYLES[style]?.karaoke ?? true)
  return states.find((s) => ms >= s.startMs && ms < s.endMs) ?? null
}

let lastActiveRow = -1
function drawOverlay() {
  const c = overlay()
  const v = video()
  if (!meta) return
  if (c.width !== meta.width) { c.width = meta.width; c.height = meta.height }
  const ctx = c.getContext('2d')!
  ctx.clearRect(0, 0, c.width, c.height)
  const s = prefs.captions ? stateAt(v.currentTime * 1000) : null
  if (s) drawCard(ctx, cards[s.phrase], s.active, prefs.style, { width: c.width, height: c.height }, baselineOf(cards[s.phrase]))
  const row = s?.phrase ?? -1
  if (row !== lastActiveRow) {
    document.querySelectorAll('.fcard.now').forEach((el) => el.classList.remove('now'))
    const el = document.querySelector(`.fcard[data-i="${row}"]`)
    el?.classList.add('now')
    if (el && !v.paused) el.scrollIntoView({ block: 'nearest' })
    lastActiveRow = row
  }
}

function loop() {
  if (!$('finish').hidden) drawOverlay()
  requestAnimationFrame(loop)
}

async function startRender() {
  if (!source) return
  $<HTMLButtonElement>('fRender').disabled = true
  $('fResult').innerHTML = ''
  const bar = $('fBar')
  bar.style.width = '0%'
  try {
    const { id } = await post('/render', {
      path: source.path,
      options: { captions: prefs.captions, style: prefs.style, music: prefs.music, mood: prefs.mood, musicDb: prefs.musicDb },
      phrases: cards.map(({ edited, text, ...p }) => (edited ? { ...p, text } : p)),
    })
    const weights: Record<string, [number, number]> = { start: [0, 0], transcribe: [0, 0.05], mix: [0.05, 0.25], captions: [0.25, 0.4], encode: [0.4, 1], done: [1, 1] }
    for (;;) {
      await new Promise((r) => setTimeout(r, 700))
      const job = (await api(`/job/${id}`)) as Job
      const [a, b] = weights[job.stage] ?? [0, 1]
      bar.style.width = `${Math.round((a + (b - a) * job.pct) * 100)}%`
      setStatus(job.msg)
      if (job.state === 'error') throw new Error(job.error ?? 'Render failed')
      if (job.state === 'done') {
        const r = job.result
        setStatus(`Done: ${r.durationSec.toFixed(1)} s · ${r.loudness.lufs} LUFS · true peak ${r.loudness.truePeak} dBFS`, 'ok')
        $('fResult').innerHTML = `<a class="button primary" href="${fileUrl(r.output, true)}">Download ${r.output.split('/').pop()}</a>
          <a class="button" href="${fileUrl(r.output)}" target="_blank">Watch</a>
          <div class="muted small">Saved to ${r.output}<br>Transcript: ${r.transcriptPath}</div>`
        refreshTakes()
        break
      }
    }
  } catch (e: any) {
    setStatus(e.message, 'error')
  } finally {
    $<HTMLButtonElement>('fRender').disabled = false
  }
}

function syncControls() {
  $<HTMLInputElement>('fCaptions').checked = prefs.captions
  $<HTMLSelectElement>('fStyle').value = prefs.style
  $<HTMLInputElement>('fMusic').checked = prefs.music
  $<HTMLSelectElement>('fMood').value = prefs.mood
  $<HTMLInputElement>('fLevel').value = String(prefs.musicDb)
  $('fLevelVal').textContent = `${prefs.musicDb} dB under voice`
  $<HTMLSelectElement>('fStyle').disabled = !prefs.captions
  $<HTMLSelectElement>('fMood').disabled = !prefs.music
  $<HTMLInputElement>('fLevel').disabled = !prefs.music
}

export async function initFinish() {
  const opts = await api('/options').catch(() => null)
  if (!opts) { $('finishBtn').title = 'Finish needs the dev server (npm run dev)'; return }
  $<HTMLSelectElement>('fStyle').innerHTML = Object.entries(opts.styles).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')
  $<HTMLSelectElement>('fMood').innerHTML = Object.entries(opts.moods).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')
  if (!opts.hasKey) setStatus('AI_GATEWAY_API_KEY is missing from onair/.env, so captions cannot be transcribed.', 'error')
  syncControls()

  $('finishBtn').onclick = open
  $('fClose').onclick = close
  $('finish').addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') close() })
  $('finish').addEventListener('keyup', (e) => e.stopPropagation())
  $<HTMLSelectElement>('fTake').onchange = (e) => {
    const sel = e.target as HTMLSelectElement
    if (sel.value) choose(sel.value, sel.selectedOptions[0].textContent ?? '')
  }
  $<HTMLInputElement>('fFile').onchange = async (e) => {
    const f = (e.target as HTMLInputElement).files?.[0]
    if (!f) return
    try { await choose(await upload(f, f.name), f.name) } catch (err: any) { setStatus(err.message, 'error') }
  }
  $('fLast').onclick = async () => {
    if (!lastTake) return
    try { await choose(await upload(lastTake.blob, lastTake.name), lastTake.name) } catch (err: any) { setStatus(err.message, 'error') }
  }
  $<HTMLInputElement>('fCaptions').onchange = (e) => { prefs.captions = (e.target as HTMLInputElement).checked; savePrefs(); syncControls() }
  $<HTMLSelectElement>('fStyle').onchange = (e) => {
    prefs.style = (e.target as HTMLSelectElement).value as StyleId
    savePrefs()
    // Styles with a different words-per-card regroup the transcript; edits are kept only when the cards stay the same.
    if (source && STYLES[prefs.style].maxWords !== STYLES[analyzedStyle as StyleId]?.maxWords) {
      if (!cards.some((c) => c.edited) || confirm('This style groups words differently, so your card edits will reset. Continue?')) analyzeSource()
    }
  }
  $<HTMLInputElement>('fMusic').onchange = (e) => { prefs.music = (e.target as HTMLInputElement).checked; savePrefs(); syncControls() }
  $<HTMLSelectElement>('fMood').onchange = (e) => { prefs.mood = (e.target as HTMLSelectElement).value; savePrefs() }
  $<HTMLInputElement>('fLevel').oninput = (e) => { prefs.musicDb = Number((e.target as HTMLInputElement).value); savePrefs(); syncControls() }
  $('fRender').onclick = startRender
  requestAnimationFrame(loop)
}

/** Called when a take stops: keep the blob and offer to finish it. */
export function offerFinish(blob: Blob, name: string) {
  lastTake = { blob, name }
  $('fLast').hidden = false
  $('fLast').textContent = `Use the take you just recorded (${name})`
  $('finishLast').hidden = false
}

;(window as any).__finish = { open, close, choose, offerFinish, get cards() { return cards }, get source() { return source } }
