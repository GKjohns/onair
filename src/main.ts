import './style.css'
import {
  CORNERS, LAYOUTS, ease, lerpBox, pipBox, render, targets,
  type Layout, type Scene, type Targets,
} from './compositor'
import { Mixer, VideoSource, download, pickMimeType, startRecorder } from './media'
import { mountNotes } from './notes'

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
const KEY = 'onair.scene.v1'
const FPS = 30
const TRANSITION_MS = 400
const COUNTDOWN = Number(new URLSearchParams(location.search).get('countdown') ?? 3)

// ---------- state ----------
const defaults: Scene = {
  W: 1920, H: 1080, layout: 'pip', corner: 'br', pipScale: 1,
  free: { x: 0.6, y: 0.55, w: 0.33, h: 0.35 }, mirror: false, camZoom: 1,
  worldCrop: { t: 0, b: 0, l: 0, r: 0 }, worldFit: 'cover', lowerThird: false,
}
const scene: Scene = (() => {
  try { return { ...defaults, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') } } catch { return { ...defaults } }
})()
const prefs: { cam?: string; mic?: string; micProc?: boolean } = (() => {
  try { return JSON.parse(localStorage.getItem(KEY + '.dev') ?? '{}') } catch { return {} }
})()
const persist = () => {
  try {
    localStorage.setItem(KEY, JSON.stringify(scene))
    localStorage.setItem(KEY + '.dev', JSON.stringify(prefs))
  } catch {}
}

let cam: VideoSource | null = null
let tab: VideoSource | null = null
let micStream: MediaStream | null = null
const mixer = new Mixer()

const canvas = $<HTMLCanvasElement>('out')
const ctx = canvas.getContext('2d', { alpha: false })!

// ---------- animation ----------
let cur: Targets = targets(scene)
let from: Targets = cur
let animStart = 0
let lowerT = scene.lowerThird ? 1 : 0

function setLayout(l: Layout) {
  if (l === 'free' && scene.layout !== 'free') {
    // Start free mode from wherever the camera is now.
    const c = cur.cam
    const b = c.a > 0.5 && c.w < scene.W * 0.7 && c.h < scene.H * 0.7 ? c : pipBox(scene)
    scene.free = { x: b.x / scene.W, y: b.y / scene.H, w: b.w / scene.W, h: b.h / scene.H }
  }
  from = cur
  animStart = performance.now()
  scene.layout = l
  persist()
  syncUI()
}

function tick() {
  const t = Math.min(1, (performance.now() - animStart) / TRANSITION_MS)
  const target = targets(scene)
  const k = ease(t)
  cur = { world: lerpBox(from.world, target.world, k), cam: lerpBox(from.cam, target.cam, k) }
  lowerT += ((scene.lowerThird ? 1 : 0) - lowerT) * 0.18
  render(ctx, scene, cur, tab?.current ?? null, cam?.current ?? null, lowerT)
  updateFreebox()
  $('micMeter').style.width = `${mixer.level('mic') * 100}%`
  $('tabMeter').style.width = `${mixer.level('tab') * 100}%`
  if (state === 'recording') $('elapsed').textContent = fmt(performance.now() - recStart)
}

// Worker-driven clock: rAF stops and main-thread timers get throttled when this tab is
// in the background, which is exactly when Kyle is talking to Voice World.
const clock = new Worker(URL.createObjectURL(new Blob(
  [`setInterval(() => postMessage(0), ${1000 / FPS})`], { type: 'text/javascript' })))
clock.onmessage = tick

// ---------- output size + preview fit ----------
function setSize(W: number, H: number) {
  scene.W = W
  scene.H = H
  canvas.width = W
  canvas.height = H
  cur = from = targets(scene)
  persist()
  fitPreview()
  syncUI()
}

function fitPreview() {
  const box = $('stageFit').getBoundingClientRect()
  const k = Math.min(box.width / scene.W, box.height / scene.H)
  const f = $('frame')
  f.style.width = `${scene.W * k}px`
  f.style.height = `${scene.H * k}px`
}
new ResizeObserver(fitPreview).observe($('stageFit'))

// ---------- free mode drag ----------
const freebox = $('freebox')
function updateFreebox() {
  const show = scene.layout === 'free'
  freebox.style.display = show ? 'block' : 'none'
  if (!show) return
  const k = canvas.clientWidth / scene.W
  const b = cur.cam
  Object.assign(freebox.style, { left: `${b.x * k}px`, top: `${b.y * k}px`, width: `${b.w * k}px`, height: `${b.h * k}px` })
}
freebox.addEventListener('pointerdown', (e) => {
  e.preventDefault()
  const resize = (e.target as HTMLElement).classList.contains('handle')
  const k = canvas.clientWidth / scene.W
  const start = { ...scene.free }
  const sx = e.clientX, sy = e.clientY
  const aspect = (start.w * scene.W) / (start.h * scene.H)
  freebox.setPointerCapture(e.pointerId)
  const move = (ev: PointerEvent) => {
    const dx = (ev.clientX - sx) / k / scene.W
    const dy = (ev.clientY - sy) / k / scene.H
    const f = scene.free
    if (resize) {
      f.w = Math.max(0.08, Math.min(1 - f.x, start.w + dx))
      f.h = ev.shiftKey ? (f.w * scene.W) / aspect / scene.H : Math.max(0.08, Math.min(1 - f.y, start.h + dy))
    } else {
      f.x = Math.max(0, Math.min(1 - f.w, start.x + dx))
      f.y = Math.max(0, Math.min(1 - f.h, start.y + dy))
    }
    animStart = 0 // follow the pointer directly
  }
  const up = () => {
    freebox.removeEventListener('pointermove', move)
    freebox.removeEventListener('pointerup', up)
    persist()
  }
  freebox.addEventListener('pointermove', move)
  freebox.addEventListener('pointerup', up)
})

// ---------- devices ----------
async function listDevices() {
  let devs = await navigator.mediaDevices.enumerateDevices()
  if (!devs.some((d) => d.label)) {
    const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: true }).catch(() => null)
    s?.getTracks().forEach((t) => t.stop())
    devs = await navigator.mediaDevices.enumerateDevices()
  }
  const fill = (sel: HTMLSelectElement, kind: MediaDeviceKind, saved?: string, prefer?: RegExp) => {
    const list = devs.filter((d) => d.kind === kind)
    sel.replaceChildren(...list.map((d, i) => new Option(d.label || `${kind} ${i + 1}`, d.deviceId)))
    const pick = list.find((d) => d.deviceId === saved) ?? list.find((d) => prefer?.test(d.label)) ?? list[0]
    if (pick) sel.value = pick.deviceId
  }
  fill($('camSel'), 'videoinput', prefs.cam, /cam ?link|elgato/i)
  fill($('micSel'), 'audioinput', prefs.mic)
}

async function startCamera() {
  cam?.stop()
  cam = null
  const id = $<HTMLSelectElement>('camSel').value
  try {
    const s = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: id ? { exact: id } : undefined, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
    })
    cam = new VideoSource(s, () => { $('camInfo').textContent = '(ended)' })
    $('camInfo').textContent = cam.size
    prefs.cam = id
    persist()
  } catch (err) {
    $('camInfo').textContent = `(${(err as Error).name})`
  }
}

async function startMic() {
  micStream?.getTracks().forEach((t) => t.stop())
  const id = $<HTMLSelectElement>('micSel').value
  const proc = $<HTMLInputElement>('micProc').checked
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: id ? { exact: id } : undefined, echoCancellation: proc, noiseSuppression: proc, autoGainControl: proc },
    })
    mixer.setInput('mic', micStream)
    prefs.mic = id
    prefs.micProc = proc
    persist()
  } catch {
    mixer.setInput('mic', null)
  }
}

async function shareTab() {
  try {
    const s = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: 'browser', frameRate: { ideal: 30 }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: { suppressLocalAudioPlayback: false, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      preferCurrentTab: false, selfBrowserSurface: 'exclude', systemAudio: 'include', surfaceSwitching: 'include',
      monitorTypeSurfaces: 'exclude',
    } as DisplayMediaStreamOptions)
    tab?.stop()
    tab = new VideoSource(s, () => {
      tab = null
      mixer.setInput('tab', null)
      $('tabInfo').textContent = 'Sharing stopped.'
      $('shareBtn').textContent = 'Share Voice World tab'
    })
    mixer.setInput('tab', s)
    const audio = s.getAudioTracks().length > 0
    $('tabInfo').textContent = `${tab.size}${audio ? ' · tab audio on' : ' · NO tab audio (re-share with "Also share tab audio")'}`
    $('shareBtn').textContent = 'Re-share tab'
  } catch (err) {
    $('tabInfo').textContent = `Share cancelled (${(err as Error).name}).`
  }
}

// ---------- recording ----------
type RecState = 'idle' | 'countdown' | 'recording'
let state: RecState = 'idle'
let recorder: MediaRecorder | null = null
let recStart = 0
let countdownTimer = 0
const fmt = (ms: number) => {
  const s = Math.floor(ms / 1000)
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

function setState(s: RecState) {
  state = s
  document.body.dataset.rec = s
  $('recBtn').textContent = s === 'idle' ? 'Record' : s === 'countdown' ? 'Cancel' : 'Stop'
  if (s !== 'countdown') $('countdown').textContent = ''
  syncUI()
}

function toggleRecord() {
  if (state === 'recording') return recorder?.stop()
  if (state === 'countdown') { clearInterval(countdownTimer); return setState('idle') }
  mixer.ctx.resume().catch(() => {})
  let n = COUNTDOWN
  if (n <= 0) return beginRecording()
  setState('countdown')
  $('countdown').textContent = String(n)
  countdownTimer = window.setInterval(() => {
    n -= 1
    if (n > 0) $('countdown').textContent = String(n)
    else { clearInterval(countdownTimer); beginRecording() }
  }, 1000)
}

function beginRecording() {
  const stream = new MediaStream([
    ...canvas.captureStream(FPS).getVideoTracks(),
    ...mixer.dest.stream.getAudioTracks(),
  ])
  recorder = startRecorder(stream, (blob, mime) => {
    const name = download(blob, mime)
    ;(window as any).__onair.last = { size: blob.size, mime, name }
    $('mimeInfo').textContent = `Saved ${name} · ${(blob.size / 1e6).toFixed(1)} MB`
    stream.getVideoTracks().forEach((t) => t.stop())
    recorder = null
    setState('idle')
  })
  recStart = performance.now()
  $('elapsed').textContent = '00:00'
  setState('recording')
}

// ---------- UI wiring ----------
function syncUI() {
  document.querySelectorAll<HTMLButtonElement>('#layouts [data-l]').forEach((b) => b.classList.toggle('on', b.dataset.l === scene.layout))
  document.querySelectorAll<HTMLButtonElement>('#presets [data-p]').forEach((b) => {
    b.classList.toggle('on', b.dataset.p === `${scene.W}x${scene.H}`)
    b.disabled = state !== 'idle'
  })
  document.querySelectorAll<HTMLButtonElement>('#fit [data-f]').forEach((b) => b.classList.toggle('on', b.dataset.f === scene.worldFit))
  $('cornerName').textContent = { br: '↘', bl: '↙', tl: '↖', tr: '↗' }[scene.corner]
  const c = scene.worldCrop
  ;([['cropT', c.t], ['cropB', c.b], ['cropL', c.l], ['cropR', c.r], ['camZoom', scene.camZoom], ['pipScale', scene.pipScale]] as const)
    .forEach(([id, v]) => { $<HTMLInputElement>(id).value = String(v) })
  $<HTMLInputElement>('mirror').checked = scene.mirror
  $<HTMLInputElement>('lowerThird').checked = scene.lowerThird
}

function cycleCorner() {
  scene.corner = CORNERS[(CORNERS.indexOf(scene.corner) + 1) % CORNERS.length]
  if (scene.layout !== 'pip') setLayout('pip')
  else { from = cur; animStart = performance.now() }
  persist()
  syncUI()
}

const bindRange = (id: string, set: (v: number) => void) =>
  $<HTMLInputElement>(id).addEventListener('input', (e) => { set(Number((e.target as HTMLInputElement).value)); persist() })
bindRange('cropT', (v) => (scene.worldCrop.t = v))
bindRange('cropB', (v) => (scene.worldCrop.b = v))
bindRange('cropL', (v) => (scene.worldCrop.l = v))
bindRange('cropR', (v) => (scene.worldCrop.r = v))
bindRange('camZoom', (v) => (scene.camZoom = v))
bindRange('pipScale', (v) => { scene.pipScale = v; animStart = 0 })
bindRange('micGain', (v) => mixer.setGain('mic', v))
bindRange('tabGain', (v) => mixer.setGain('tab', v))
$('cropReset').onclick = () => { scene.worldCrop = { t: 0, b: 0, l: 0, r: 0 }; persist(); syncUI() }
$<HTMLInputElement>('mirror').onchange = (e) => { scene.mirror = (e.target as HTMLInputElement).checked; persist() }
$<HTMLInputElement>('lowerThird').onchange = (e) => { scene.lowerThird = (e.target as HTMLInputElement).checked; persist() }
$<HTMLInputElement>('micProc').checked = prefs.micProc ?? false
$('micProc').onchange = startMic
$('camSel').onchange = startCamera
$('micSel').onchange = startMic
$('shareBtn').onclick = shareTab
$('recBtn').onclick = toggleRecord
$('cornerBtn').onclick = cycleCorner
document.querySelectorAll<HTMLButtonElement>('#layouts [data-l]').forEach((b) => (b.onclick = () => setLayout(b.dataset.l as Layout)))
document.querySelectorAll<HTMLButtonElement>('#presets [data-p]').forEach((b) => (b.onclick = () => {
  const [w, h] = b.dataset.p!.split('x').map(Number)
  setSize(w, h)
}))
document.querySelectorAll<HTMLButtonElement>('#fit [data-f]').forEach((b) => (b.onclick = () => {
  scene.worldFit = b.dataset.f as Scene['worldFit']
  persist()
  syncUI()
}))
// Buttons shouldn't keep focus, so Space always means record.
document.addEventListener('click', (e) => (e.target as HTMLElement).closest('button')?.blur())
document.addEventListener('pointerdown', () => mixer.ctx.resume().catch(() => {}), { once: true })

window.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement
  if (t.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(t.tagName) || e.metaKey || e.ctrlKey || e.altKey) return
  const k = e.key.toLowerCase()
  if (k >= '1' && k <= '6') setLayout(LAYOUTS[Number(k) - 1])
  else if (k === 'p') cycleCorner()
  else if (k === ' ' || k === 'r') toggleRecord()
  else if (k === 'escape' && state === 'countdown') toggleRecord()
  else if (k === 'm') { scene.mirror = !scene.mirror; persist(); syncUI() }
  else if (k === 'l') { scene.lowerThird = !scene.lowerThird; persist(); syncUI() }
  else return
  e.preventDefault()
})

// ---------- boot ----------
mountNotes($('notes'))
setSize(scene.W, scene.H)
$('mimeInfo').textContent = `Records as ${pickMimeType() || 'browser default'} · 12 Mbps`
;(window as any).__onair = { scene, setLayout, setSize, get state() { return state }, last: null as unknown }
listDevices().then(() => Promise.all([startCamera(), startMic()]))
navigator.mediaDevices.addEventListener('devicechange', () => listDevices())
