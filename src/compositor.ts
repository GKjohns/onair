// Layout math and canvas drawing. Pure apart from the ctx it is handed.

export type Layout = 'cam' | 'stack' | 'tall' | 'bubble' | 'world' | 'free' | 'pip' | 'side'
export type Corner = 'br' | 'bl' | 'tl' | 'tr'
export type Src = 'cam' | 'world'
export const CORNERS: Corner[] = ['br', 'bl', 'tl', 'tr']
/** Hotkeys 1-6 map onto these, per aspect. Vertical-first for 9:16, 1:1 and 4:5. */
export const VERTICAL: Layout[] = ['cam', 'stack', 'tall', 'bubble', 'world', 'free']
export const LANDSCAPE: Layout[] = ['pip', 'side', 'stack', 'cam', 'world', 'free']
export const isLandscape = (s: { W: number; H: number }) => s.W > s.H
export const isReel = (s: { W: number; H: number }) => s.H / s.W > 1.6
export const layoutsFor = (s: { W: number; H: number }) => (isLandscape(s) ? LANDSCAPE : VERTICAL)
export const label = (l: Layout, s: { W: number; H: number }) =>
  ({ cam: isLandscape(s) ? 'Camera' : 'Hook', stack: 'Stack', tall: 'Tall PiP', bubble: 'Bubble', world: 'World', free: 'Free', pip: 'Corner PiP', side: 'Side by side' })[l]

/** A box on the output canvas: px rect, corner radius, opacity, and the source focus point (0..1). */
export interface Box { x: number; y: number; w: number; h: number; r: number; a: number; fx: number; fy: number }
export interface Crop { t: number; b: number; l: number; r: number }
export interface Frame { src: CanvasImageSource; w: number; h: number }
export interface Focus { x: number; y: number }

export interface Scene {
  W: number
  H: number
  layout: Layout
  corner: Corner
  pipScale: number // 1 = default card/PiP/bubble size
  card: '3:4' | '9:16' // Tall PiP shape
  split: number // stack: share of height for the top region
  swap: boolean // stack: camera on top instead of world
  free: { x: number; y: number; w: number; h: number } // normalized 0..1
  focus: Partial<Record<Layout, { cam: Focus; world: Focus }>>
  mirror: boolean
  camZoom: number
  camRotate: 0 | 90 | 270
  worldCrop: Crop
  worldFit: 'cover' | 'blur'
  lowerThird: boolean
  guides: boolean
}

export interface Targets { world: Box; cam: Box }

export const DEFAULT_FOCUS = { cam: { x: 0.5, y: 0.33 }, world: { x: 0.5, y: 0.5 } }
export const focusOf = (s: Scene, l = s.layout) => s.focus[l] ?? (s.focus[l] = structuredClone(DEFAULT_FOCUS))

/** Reels/LinkedIn vertical UI: top bar, bottom caption, right button rail. Zero outside 9:16. */
export function safeZone(s: { W: number; H: number }) {
  return isReel(s)
    ? { top: 0.14 * s.H, bottom: 0.2 * s.H, rail: 0.12 * s.W, railTop: 0.45 * s.H }
    : { top: 0, bottom: 0, rail: 0, railTop: s.H }
}

function inCorner(s: Scene, w: number, h: number): { x: number; y: number } {
  const m = 0.035 * Math.min(s.W, s.H)
  const z = safeZone(s)
  const top = s.corner === 'tl' || s.corner === 'tr'
  const left = s.corner === 'bl' || s.corner === 'tl'
  const y = top ? z.top + m : s.H - z.bottom - h - m
  // Bottom-right cards clear the right-edge button rail.
  const x = left ? m : s.W - w - m - (top ? 0 : z.rail)
  return { x, y }
}

/** The small camera box for the current aspect: PiP in landscape, a tall card in vertical. */
export function cardBox(s: Scene, kind: 'pip' | 'tall' | 'bubble' = isLandscape(s) ? 'pip' : 'tall'): Omit<Box, 'fx' | 'fy'> {
  const m = Math.min(s.W, s.H)
  let w: number, h: number, r: number
  if (kind === 'pip') { w = 0.27 * s.W * s.pipScale; h = w * 9 / 16; r = 0.022 * m }
  else if (kind === 'tall') { w = 0.38 * s.W * s.pipScale; h = w * (s.card === '9:16' ? 16 / 9 : 4 / 3); r = 0.03 * m }
  else { w = h = 0.3 * Math.min(s.W, s.H) * s.pipScale; r = w / 2 }
  return { ...inCorner(s, w, h), w, h, r, a: 1 }
}

export function targets(s: Scene): Targets {
  const { W, H } = s
  const f = focusOf(s)
  const box = (x: number, y: number, w: number, h: number, src: Src, r = 0, a = 1): Box =>
    ({ x, y, w, h, r, a, fx: f[src].x, fy: f[src].y })
  const fullW = box(0, 0, W, H, 'world')
  const card = (kind: 'pip' | 'tall' | 'bubble'): Box => ({ ...cardBox(s, kind), fx: f.cam.x, fy: f.cam.y })
  switch (s.layout) {
    case 'pip': return { world: fullW, cam: card('pip') }
    case 'tall': return { world: fullW, cam: card('tall') }
    case 'bubble': return { world: fullW, cam: card('bubble') }
    case 'side':
      return isLandscape(s)
        ? { world: box(0, 0, W / 2, H, 'world'), cam: box(W / 2, 0, W / 2, H, 'cam') }
        : { world: box(0, 0, W, H / 2, 'world'), cam: box(0, H / 2, W, H / 2, 'cam') }
    case 'stack': {
      const top = Math.round(H * s.split)
      // Swap keeps the world's share and moves the camera above it.
      return s.swap
        ? { cam: box(0, 0, W, H - top, 'cam'), world: box(0, H - top, W, top, 'world') }
        : { world: box(0, 0, W, top, 'world'), cam: box(0, top, W, H - top, 'cam') }
    }
    case 'cam': return { world: fullW, cam: box(0, 0, W, H, 'cam') }
    case 'world': {
      // Camera shrinks and fades toward its card spot.
      const p = card(isLandscape(s) ? 'pip' : 'tall')
      return { world: fullW, cam: { ...p, x: p.x + p.w * 0.2, y: p.y + p.h * 0.2, w: p.w * 0.6, h: p.h * 0.6, a: 0 } }
    }
    case 'free': {
      const r = s.free
      return { world: fullW, cam: box(r.x * W, r.y * H, r.w * W, r.h * H, 'cam', 0.03 * Math.min(W, H)) }
    }
  }
}

export const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
const lerp = (a: number, b: number, t: number) => a + (b - a) * t
export const lerpBox = (a: Box, b: Box, t: number): Box => ({
  x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), w: lerp(a.w, b.w, t), h: lerp(a.h, b.h, t),
  r: lerp(a.r, b.r, t), a: lerp(a.a, b.a, t), fx: lerp(a.fx, b.fx, t), fy: lerp(a.fy, b.fy, t),
})
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

/** The part of a source that a cover-fit box shows, centred on the box's focus point. */
export function coverWindow(fw: number, fh: number, b: Box, crop: Crop, zoom = 1) {
  const cx = crop.l * fw, cy = crop.t * fh
  const cw = Math.max(1, fw * (1 - crop.l - crop.r)), ch = Math.max(1, fh * (1 - crop.t - crop.b))
  const k = Math.max(b.w / cw, b.h / ch) * zoom
  const vw = Math.min(cw, b.w / k), vh = Math.min(ch, b.h / k)
  const sx = clamp(cx + b.fx * cw - vw / 2, cx, cx + cw - vw)
  const sy = clamp(cy + b.fy * ch - vh / 2, cy, cy + ch - vh)
  return { sx, sy, vw, vh, cx, cy, cw, ch }
}

function roundRect(ctx: CanvasRenderingContext2D, b: Box) {
  ctx.beginPath()
  ctx.roundRect(b.x, b.y, b.w, b.h, Math.max(0, Math.min(b.r, b.w / 2, b.h / 2)))
}

const blurCanvas = document.createElement('canvas')
const blurCtx = blurCanvas.getContext('2d')!

function drawSource(
  ctx: CanvasRenderingContext2D, f: Frame | null, b: Box,
  opts: { crop: Crop; fit: 'cover' | 'blur'; mirror: boolean; zoom: number; label: string },
) {
  if (b.a < 0.01 || b.w < 2 || b.h < 2) return
  const circle = b.r >= Math.min(b.w, b.h) / 2 - 0.5
  ctx.save()
  ctx.globalAlpha = b.a
  if (b.r > 1) {
    ctx.save()
    ctx.shadowColor = 'rgba(0,0,0,0.45)'
    ctx.shadowBlur = Math.min(b.r, 40) * 2
    ctx.shadowOffsetY = Math.min(b.r, 40) * 0.5
    ctx.fillStyle = '#000'
    roundRect(ctx, b)
    ctx.fill()
    ctx.restore()
  }
  ctx.save()
  roundRect(ctx, b)
  ctx.clip()
  ctx.fillStyle = '#10131a'
  ctx.fillRect(b.x, b.y, b.w, b.h)

  if (!f || !f.w || !f.h) {
    const g = ctx.createLinearGradient(b.x, b.y, b.x + b.w, b.y + b.h)
    g.addColorStop(0, '#1d2433')
    g.addColorStop(1, '#2a1f3d')
    ctx.fillStyle = g
    ctx.fillRect(b.x, b.y, b.w, b.h)
    ctx.fillStyle = 'rgba(255,255,255,0.55)'
    ctx.font = `600 ${Math.max(14, Math.min(b.w, b.h) * 0.08)}px system-ui, sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(opts.label, b.x + b.w / 2, b.y + b.h / 2)
  } else {
    if (opts.mirror) {
      ctx.translate(b.x + b.w / 2, 0)
      ctx.scale(-1, 1)
      ctx.translate(-(b.x + b.w / 2), 0)
    }
    const w = coverWindow(f.w, f.h, b, opts.crop, opts.zoom)
    if (opts.fit === 'cover') {
      ctx.drawImage(f.src, w.sx, w.sy, w.vw, w.vh, b.x, b.y, b.w, b.h)
    } else {
      // Fit the whole source, with a blurred cover copy behind it. Blur at low res: cheap.
      blurCanvas.width = 96
      blurCanvas.height = Math.max(8, Math.round((96 * b.h) / b.w))
      blurCtx.filter = 'blur(4px)'
      blurCtx.drawImage(f.src, w.sx, w.sy, w.vw, w.vh, -8, -8, blurCanvas.width + 16, blurCanvas.height + 16)
      ctx.drawImage(blurCanvas, b.x, b.y, b.w, b.h)
      ctx.fillStyle = 'rgba(0,0,0,0.3)'
      ctx.fillRect(b.x, b.y, b.w, b.h)
      const k = Math.min(b.w / w.cw, b.h / w.ch)
      const dw = w.cw * k, dh = w.ch * k
      ctx.drawImage(f.src, w.cx, w.cy, w.cw, w.ch, b.x + (b.w - dw) / 2, b.y + (b.h - dh) / 2, dw, dh)
    }
  }
  ctx.restore()
  if (circle && b.w > 8) {
    ctx.lineWidth = Math.max(3, b.w * 0.012)
    ctx.strokeStyle = 'rgba(255,255,255,0.9)'
    roundRect(ctx, b)
    ctx.stroke()
  }
  ctx.restore()
}

function drawLowerThird(ctx: CanvasRenderingContext2D, s: Scene, cam: Box, t: number) {
  if (t <= 0.01) return
  const m = Math.min(s.W, s.H)
  const circle = cam.r >= Math.min(cam.w, cam.h) / 2 - 0.5
  // Sit inside the camera box when it is a big rectangle, else bottom-left of the frame.
  const frame: Box = { x: 0, y: 0, w: s.W, h: s.H, r: 0, a: 1, fx: 0, fy: 0 }
  const anchor = cam.a > 0.5 && cam.w > m * 0.25 && !circle ? cam : frame
  const bottom = Math.min(anchor.y + anchor.h, s.H - safeZone(s).bottom)
  const size = Math.max(16, Math.min(anchor.h * 0.07, m * 0.042))
  ctx.save()
  ctx.font = `650 ${size}px system-ui, -apple-system, sans-serif`
  const text = 'Kyle Johnson'
  const tw = ctx.measureText(text).width
  const pad = size * 0.6
  const w = tw + pad * 2 + size * 0.25, h = size * 1.9
  const inset = Math.max(Math.min(anchor.r, 40), size) * 0.9
  const x = anchor.x + inset - (1 - t) * (w * 0.4)
  const y = bottom - h - inset
  ctx.globalAlpha = t * (anchor === cam ? cam.a : 1)
  ctx.fillStyle = 'rgba(12,14,20,0.72)'
  ctx.beginPath()
  ctx.roundRect(x, y, w, h, size * 0.35)
  ctx.fill()
  ctx.fillStyle = '#f5b544'
  ctx.fillRect(x, y + h * 0.2, size * 0.18, h * 0.6)
  ctx.fillStyle = '#fff'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, x + pad + size * 0.25, y + h / 2 + size * 0.03)
  ctx.restore()
}

export function render(
  ctx: CanvasRenderingContext2D, s: Scene, cur: Targets,
  world: Frame | null, cam: Frame | null, lowerT: number,
) {
  ctx.fillStyle = '#0b0d12'
  ctx.fillRect(0, 0, s.W, s.H)
  drawSource(ctx, world, cur.world, { crop: s.worldCrop, fit: s.worldFit, mirror: false, zoom: 1, label: 'Voice World' })
  const none = { t: 0, b: 0, l: 0, r: 0 }
  drawSource(ctx, cam, cur.cam, { crop: none, fit: 'cover', mirror: s.mirror, zoom: s.camZoom, label: 'Camera' })
  drawLowerThird(ctx, s, cur.cam, lowerT)
}
