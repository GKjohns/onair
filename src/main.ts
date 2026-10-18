import './style.css'
import {
  CORNERS, cardBox, coverWindow, ease, focusOf, isLandscape, isReel, label, layoutsFor, lerpBox, render, targets,
  type Box, type Focus, type Frame, type Layout, type Scene, type Src, type Targets,
} from './compositor'
import { Mixer, VideoSource, download, pickMimeType, startRecorder } from './media'
import { mountNotes } from './notes'
import { initFinish, offerFinish } from './finish'

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
const KEY = 'onair.scene.v2'
const FPS = 30
const TRANSITION_MS = 400
const COUNTDOWN = Number(new URLSearchParams(location.search).get('countdown') ?? 3)
const NO_CROP = { t: 0, b: 0, l: 0, r: 0 }

// ---------- state ----------
const defaults: Scene = {
  W: 1080, H: 1920, layout: 'tall', corner: 'br', pipScale: 1, card: '3:4', split: 0.58, swap: false,
  free: { x: 0.45, y: 0.5, w: 0.38, h: 0.28 }, focus: {}, mirror: false, camZoom: 1, camRotate: 0,
  worldCrop: { ...NO_CROP }, worldFit: 'cover', lowerThird: false, guides: true,
}
const scene: Scene = (() => {
  try { return { ...defaults, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') } } catch { return { ...defaults } }
})()
const prefs: { cam?: string; mic?: string; micProc?: boolean; cam4k?: boolean; vwUrl?: string } = (() => {
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

// ---------- frames (camera rotation for a camera mounted on its side) ----------
const rotC = document.createElement('canvas')
const rotX = rotC.getContext('2d')!
function camFrame(): Frame | null {
  const f = cam?.current ?? null
  if (!f || !scene.camRotate) return f
  if (rotC.width !== f.h || rotC.height !== f.w) { rotC.width = f.h; rotC.height = f.w }
  rotX.setTransform(1, 0, 0, 1, 0, 0)
  if (scene.camRotate === 90) { rotX.translate(f.h, 0); rotX.rotate(Math.PI / 2) }
  else { rotX.translate(0, f.w); rotX.rotate(-Math.PI / 2) }
  rotX.drawImage(f.src, 0, 0, f.w, f.h)
  return { src: rotC, w: f.h, h: f.w }
}
let lastCam: Frame | null = null
let lastWorld: Frame | null = null

// ---------- animation ----------
let cur: Targets = targets(scene)
let from: Targets = cur
let animStart = 0
let lowerT = scene.lowerThird ? 1 : 0

function setLayout(l: Layout) {
  if (l === 'free' && scene.layout !== 'free') {
    // Start free mode from wherever the camera is now, or from the card spot.
    const c = cur.cam
    const b = c.a > 0.5 && c.w < scene.W * 0.7 && c.h < scene.H * 0.7 ? c : cardBox(scene)
    scene.free = { x: b.x / scene.W, y: b.y / scene.H, w: b.w / scene.W, h: b.h / scene.H }
    focusOf(scene, 'free').cam = { ...focusOf(scene).cam }
  }
  from = cur
  animStart = performance.now()
  scene.layout = l
  persist()
  syncUI()
}
const reanimate = () => { from = cur; animStart = performance.now() }

function tick() {
  const t = Math.min(1, (performance.now() - animStart) / TRANSITION_MS)
  const target = targets(scene)
  const k = ease(t)
  cur = { world: lerpBox(from.world, target.world, k), cam: lerpBox(from.cam, target.cam, k) }
  lowerT += ((scene.lowerThird ? 1 : 0) - lowerT) * 0.18
  lastCam = camFrame()
  lastWorld = tab?.current ?? null
  render(ctx, scene, cur, lastWorld, lastCam, lowerT)
  updateOverlays()
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
  if (!layoutsFor(scene).includes(scene.layout)) {
    const map: Partial<Record<Layout, Layout>> = { pip: 'tall', side: 'stack', tall: 'pip', bubble: 'pip' }
    scene.layout = map[scene.layout] ?? 'world'
  }
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
const viewScale = () => canvas.clientWidth / scene.W

// ---------- preview-only overlays: free box, crop minimap, safe zones ----------
const freebox = $('freebox')
const mini = $<HTMLCanvasElement>('mini')
const miniX = mini.getContext('2d')!
function place(el: HTMLElement, b: { x: number; y: number; w: number; h: number }) {
  const k = viewScale()
  Object.assign(el.style, { left: `${b.x * k}px`, top: `${b.y * k}px`, width: `${b.w * k}px`, height: `${b.h * k}px` })
}
function updateOverlays() {
  const free = scene.layout === 'free'
  freebox.style.display = free ? 'block' : 'none'
  if (free) place(freebox, cur.cam)

  $('guideBox').style.display = scene.guides && isReel(scene) ? 'block' : 'none'

  // Minimap of the full captured world, with the part the box keeps outlined.
  const f = lastWorld, b = cur.world
  const w = f && coverWindow(f.w, f.h, b, scene.worldCrop)
  const cropped = !!w && (w.vw < f!.w * 0.97 || w.vh < f!.h * 0.97)
  const hidden = scene.layout === 'cam' // camera covers the world
  const show = !!f && cropped && !hidden && scene.worldFit === 'cover' && b.a > 0.5 && b.w * viewScale() > 140
  mini.style.display = show ? 'block' : 'none'
  if (!show || !f || !w) return
  const max = 120
  const mk = Math.min(max / f.w, max / f.h)
  const mw = Math.round(f.w * mk), mh = Math.round(f.h * mk)
  if (mini.width !== mw || mini.height !== mh) { mini.width = mw; mini.height = mh }
  const k = viewScale()
  Object.assign(mini.style, { left: `${b.x * k + 8}px`, top: `${b.y * k + 8}px` })
  miniX.drawImage(f.src, 0, 0, mw, mh)
  miniX.fillStyle = 'rgba(0,0,0,0.6)'
  const x = w.sx * mk, y = w.sy * mk, ww = w.vw * mk, hh = w.vh * mk
  miniX.fillRect(0, 0, mw, y)
  miniX.fillRect(0, y + hh, mw, mh - y - hh)
  miniX.fillRect(0, y, x, hh)
  miniX.fillRect(x + ww, y, mw - x - ww, hh)
  miniX.strokeStyle = '#f5b544'
  miniX.lineWidth = 2
  miniX.strokeRect(x + 1, y + 1, ww - 2, hh - 2)
}

// ---------- panning a source inside its box (focus point) ----------
function windowFor(src: Src) {
  const f = src === 'cam' ? lastCam : lastWorld
  if (!f) return null
  const b: Box = targets(scene)[src]
  return { b, w: coverWindow(f.w, f.h, b, src === 'world' ? scene.worldCrop : NO_CROP, src === 'cam' ? scene.camZoom : 1) }
}
function clampAxis(v: number, visible: number, total: number) {
  if (visible >= total - 0.5) return v
  const half = visible / (2 * total)
  return Math.max(half, Math.min(1 - half, v))
}
/** Pan by output-pixel deltas, as if dragging the picture. */
function panBy(src: Src, dx: number, dy: number) {
  const r = windowFor(src)
  if (!r) return
  const { b, w } = r
  const F: Focus = focusOf(scene)[src]
  const sgn = src === 'cam' && scene.mirror ? -1 : 1
  if (dx) F.x = clampAxis(F.x - (sgn * dx * (w.vw / b.w)) / w.cw, w.vw, w.cw)
  if (dy) F.y = clampAxis(F.y - (dy * (w.vh / b.h)) / w.ch, w.vh, w.ch)
  syncSliders()
}

const frameEl = $('frame')
frameEl.addEventListener('pointerdown', (e) => {
  if (e.target !== canvas && e.target !== mini) return
  const k = viewScale()
  const rect = canvas.getBoundingClientRect()
  const px = (e.clientX - rect.left) / k, py = (e.clientY - rect.top) / k
  const inBox = (b: Box) => b.a > 0.5 && px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h
  const src: Src | null = scene.layout !== 'free' && inBox(cur.cam) ? 'cam' : inBox(cur.world) ? 'world' : null
  if (!src) return
  e.preventDefault()
  frameEl.setPointerCapture(e.pointerId)
  let lx = e.clientX, ly = e.clientY
  const move = (ev: PointerEvent) => {
    panBy(src, (ev.clientX - lx) / k, (ev.clientY - ly) / k)
    lx = ev.clientX
    ly = ev.clientY
  }
  const up = () => {
    frameEl.removeEventListener('pointermove', move)
    frameEl.removeEventListener('pointerup', up)
    persist()
  }
  frameEl.addEventListener('pointermove', move)
  frameEl.addEventListener('pointerup', up)
})

// ---------- free mode drag ----------
freebox.addEventListener('pointerdown', (e) => {
  e.preventDefault()
  e.stopPropagation()
  const resize = (e.target as HTMLElement).classList.contains('handle')
  const k = viewScale()
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
      f.h = ev.shiftKey ? (f.w * scene.W) / aspect / scene.H : Math.max(0.05, Math.min(1 - f.y, start.h + dy))
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
  const big = $<HTMLInputElement>('cam4k').checked
  try {
    const s = await navigator.mediaDevices.getUserMedia({
      video: {
        deviceId: id ? { exact: id } : undefined, frameRate: { ideal: 30 },
        width: { ideal: big ? 3840 : 1920 }, height: { ideal: big ? 2160 : 1080 },
      },
    })
    cam = new VideoSource(s, () => { $('camInfo').textContent = '(ended)' })
    $('camInfo').textContent = cam.size
    prefs.cam = id
    prefs.cam4k = big
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
      video: { displaySurface: 'browser', frameRate: { ideal: 30 }, width: { max: 2560 }, height: { max: 2560 } },
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

// Open Voice World in its own window shaped like the world box, so three.js renders that
// aspect natively instead of us cropping a 16:9 tab.
let vwWin: Window | null = null
function worldWindowSize() {
  const t = targets(scene).world
  const aspect = t.w / t.h
  let h = Math.min(screen.availHeight - 80, 1200)
  let w = Math.round(h * aspect)
  if (w > screen.availWidth - 40) { w = screen.availWidth - 40; h = Math.round(w / aspect) }
  return { w, h, aspect }
}
function openVoiceWorld() {
  const url = $<HTMLInputElement>('vwUrl').value.trim() || 'http://localhost:3091'
  prefs.vwUrl = url
  persist()
  const { w, h } = worldWindowSize()
  if (vwWin && !vwWin.closed) vwWin.close()
  vwWin = window.open(url, 'onair-voiceworld', `popup,width=${w},height=${h},left=40,top=40`)
  $('openInfo').textContent = vwWin
    ? `Opened a ${w}×${h} window. Now share it: Chrome Tab list, "Also share tab audio".`
    : 'Popup blocked. Allow popups for localhost:3094.'
}
const ratioName = (a: number) =>
  ([['9:16', 9 / 16], ['4:5', 4 / 5], ['1:1', 1], ['16:9', 16 / 9]] as const).find(([, v]) => Math.abs(v - a) < 0.02)?.[0] ?? `${a.toFixed(2)}:1`

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
    offerFinish(blob, name)
    stream.getVideoTracks().forEach((t) => t.stop())
    recorder = null
    setState('idle')
  })
  recStart = performance.now()
  $('elapsed').textContent = '00:00'
  setState('recording')
}

// ---------- UI wiring ----------
let builtFor = ''
function buildLayoutButtons() {
  const key = `${isLandscape(scene)}`
  if (key === builtFor) return
  builtFor = key
  const btns = layoutsFor(scene).map((l, i) => {
    const b = document.createElement('button')
    b.dataset.l = l
    b.innerHTML = `<kbd>${i + 1}</kbd> ${label(l, scene)}`
    b.onclick = () => setLayout(l)
    return b
  })
  const corner = document.createElement('button')
  corner.innerHTML = '<kbd>P</kbd> Corner <span id="cornerName"></span>'
  corner.onclick = cycleCorner
  $('layouts').replaceChildren(...btns, corner)
}

function syncSliders() {
  const F = focusOf(scene).cam
  $<HTMLInputElement>('faceX').value = String(F.x)
  $<HTMLInputElement>('faceY').value = String(F.y)
}

function syncUI() {
  buildLayoutButtons()
  document.querySelectorAll<HTMLButtonElement>('#layouts [data-l]').forEach((b) => b.classList.toggle('on', b.dataset.l === scene.layout))
  document.querySelectorAll<HTMLButtonElement>('#presets [data-p]').forEach((b) => {
    b.classList.toggle('on', b.dataset.p === `${scene.W}x${scene.H}`)
    b.disabled = state !== 'idle'
  })
  document.querySelectorAll<HTMLButtonElement>('#fit [data-f]').forEach((b) => b.classList.toggle('on', b.dataset.f === scene.worldFit))
  document.querySelectorAll<HTMLButtonElement>('#cardShape [data-c]').forEach((b) => b.classList.toggle('on', b.dataset.c === scene.card))
  $('cornerName').textContent = { br: '↘', bl: '↙', tl: '↖', tr: '↗' }[scene.corner]
  $('layoutName').textContent = label(scene.layout, scene)
  const c = scene.worldCrop
  ;([['cropT', c.t], ['cropB', c.b], ['cropL', c.l], ['cropR', c.r], ['camZoom', scene.camZoom], ['pipScale', scene.pipScale], ['split', scene.split]] as const)
    .forEach(([id, v]) => { $<HTMLInputElement>(id).value = String(v) })
  syncSliders()
  $<HTMLInputElement>('mirror').checked = scene.mirror
  $<HTMLInputElement>('lowerThird').checked = scene.lowerThird
  $<HTMLInputElement>('swap').checked = scene.swap
  $<HTMLInputElement>('guides').checked = scene.guides
  $<HTMLSelectElement>('camRotate').value = String(scene.camRotate)
  const { w, h, aspect } = worldWindowSize()
  $('openVw').textContent = `Open Voice World window (${ratioName(aspect)})`
  $('openVw').title = `Opens a ${w}×${h} window matching the ${label(scene.layout, scene)} world box`
}

function cycleCorner() {
  scene.corner = CORNERS[(CORNERS.indexOf(scene.corner) + 1) % CORNERS.length]
  if (!['pip', 'tall', 'bubble'].includes(scene.layout)) setLayout(isLandscape(scene) ? 'pip' : 'tall')
  else reanimate()
  persist()
  syncUI()
}

const toggle = (k: 'mirror' | 'lowerThird' | 'swap' | 'guides') => {
  scene[k] = !scene[k]
  if (k === 'swap') reanimate()
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
bindRange('split', (v) => { scene.split = v; animStart = 0; syncUI() })
bindRange('faceX', (v) => (focusOf(scene).cam.x = v))
bindRange('faceY', (v) => (focusOf(scene).cam.y = v))
bindRange('micGain', (v) => mixer.setGain('mic', v))
bindRange('tabGain', (v) => mixer.setGain('tab', v))
$('cropReset').onclick = () => { scene.worldCrop = { ...NO_CROP }; focusOf(scene).world = { x: 0.5, y: 0.5 }; persist(); syncUI() }
$('mirror').onchange = () => toggle('mirror')
$('lowerThird').onchange = () => toggle('lowerThird')
$('swap').onchange = () => toggle('swap')
$('guides').onchange = () => toggle('guides')
$('camRotate').onchange = (e) => { scene.camRotate = Number((e.target as HTMLSelectElement).value) as Scene['camRotate']; persist() }
$<HTMLInputElement>('micProc').checked = prefs.micProc ?? false
$<HTMLInputElement>('cam4k').checked = prefs.cam4k ?? false
$<HTMLInputElement>('vwUrl').value = prefs.vwUrl ?? 'http://localhost:3091'
$('vwUrl').onchange = () => { prefs.vwUrl = $<HTMLInputElement>('vwUrl').value.trim(); persist() }
$('micProc').onchange = startMic
$('cam4k').onchange = startCamera
$('camSel').onchange = startCamera
$('micSel').onchange = startMic
$('shareBtn').onclick = shareTab
$('openVw').onclick = openVoiceWorld
$('recBtn').onclick = toggleRecord
document.querySelectorAll<HTMLButtonElement>('#presets [data-p]').forEach((b) => (b.onclick = () => {
  const [w, h] = b.dataset.p!.split('x').map(Number)
  setSize(w, h)
}))
document.querySelectorAll<HTMLButtonElement>('#fit [data-f]').forEach((b) => (b.onclick = () => {
  scene.worldFit = b.dataset.f as Scene['worldFit']
  persist()
  syncUI()
}))
document.querySelectorAll<HTMLButtonElement>('#cardShape [data-c]').forEach((b) => (b.onclick = () => {
  scene.card = b.dataset.c as Scene['card']
  reanimate()
  persist()
  syncUI()
}))
// Buttons shouldn't keep focus, so Space always means record.
document.addEventListener('click', (e) => (e.target as HTMLElement).closest('button')?.blur())
document.addEventListener('pointerdown', () => mixer.ctx.resume().catch(() => {}), { once: true })

window.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement
  if (t.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(t.tagName) || e.metaKey || e.ctrlKey || e.altKey) return
  if (document.body.dataset.finish === 'open') return
  const k = e.key.toLowerCase()
  const step = (e.shiftKey ? 120 : 30) * (scene.W / 1080)
  const arrows: Record<string, [number, number]> = { arrowleft: [step, 0], arrowright: [-step, 0], arrowup: [0, step], arrowdown: [0, -step] }
  if (k >= '1' && k <= '6') setLayout(layoutsFor(scene)[Number(k) - 1])
  else if (k in arrows) { panBy('world', ...arrows[k]); persist() }
  else if (k === 'p') cycleCorner()
  else if (k === ' ' || k === 'r') toggleRecord()
  else if (k === 'escape' && state === 'countdown') toggleRecord()
  else if (k === 'm') toggle('mirror')
  else if (k === 'l') toggle('lowerThird')
  else if (k === 's') toggle('swap')
  else if (k === 'g') toggle('guides')
  else return
  e.preventDefault()
})

// ---------- boot ----------
mountNotes($('notes'))
setSize(scene.W, scene.H)
$('mimeInfo').textContent = `Records as ${pickMimeType() || 'browser default'} · 12 Mbps`
;(window as any).__onair = { scene, setLayout, setSize, layoutsFor: () => layoutsFor(scene), get state() { return state }, last: null as unknown }
initFinish()
$('finishLast').onclick = () => { $('finishBtn').click(); $('fLast').click() }
listDevices().then(() => Promise.all([startCamera(), startMic()]))
navigator.mediaDevices.addEventListener('devicechange', () => listDevices())
