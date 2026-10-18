// Layout math and canvas drawing. Pure apart from the ctx it is handed.

export type Layout = 'pip' | 'side' | 'stack' | 'cam' | 'world' | 'free'
export type Corner = 'br' | 'bl' | 'tl' | 'tr'
export const LAYOUTS: Layout[] = ['pip', 'side', 'stack', 'cam', 'world', 'free']
export const CORNERS: Corner[] = ['br', 'bl', 'tl', 'tr']

/** A box on the output canvas: position/size in px, corner radius, opacity. */
export interface Box { x: number; y: number; w: number; h: number; r: number; a: number }
/** Fractions trimmed off each edge of a source before fitting. */
export interface Crop { t: number; b: number; l: number; r: number }
export interface Frame { src: CanvasImageSource; w: number; h: number }

export interface Scene {
  W: number
  H: number
  layout: Layout
  corner: Corner
  pipScale: number // 1 = default PiP size
  free: { x: number; y: number; w: number; h: number } // normalized 0..1
  mirror: boolean
  camZoom: number
  worldCrop: Crop
  worldFit: 'cover' | 'contain'
  lowerThird: boolean
}

export interface Targets { world: Box; cam: Box }

const full = (W: number, H: number): Box => ({ x: 0, y: 0, w: W, h: H, r: 0, a: 1 })

export function pipBox(s: Scene): Box {
  const { W, H } = s
  const landscape = W >= H
  const w = (landscape ? 0.27 : 0.42) * W * s.pipScale
  const h = w * (landscape ? 9 / 16 : 5 / 4)
  const m = 0.035 * Math.min(W, H)
  const x = s.corner === 'bl' || s.corner === 'tl' ? m : W - w - m
  const y = s.corner === 'tl' || s.corner === 'tr' ? m : H - h - m
  return { x, y, w, h, r: 0.022 * Math.min(W, H), a: 1 }
}

export function targets(s: Scene): Targets {
  const { W, H } = s
  switch (s.layout) {
    case 'pip':
      return { world: full(W, H), cam: pipBox(s) }
    case 'side':
      // Half and half along the long axis: left/right in landscape, world-over-camera in portrait.
      return W >= H
        ? { world: { ...full(W, H), w: W / 2 }, cam: { ...full(W, H), x: W / 2, w: W / 2 } }
        : { world: { ...full(W, H), h: H / 2 }, cam: { ...full(W, H), y: H / 2, h: H / 2 } }
    case 'stack':
      return { cam: { ...full(W, H), h: H * 0.4 }, world: { ...full(W, H), y: H * 0.4, h: H * 0.6 } }
    case 'cam':
      return { world: full(W, H), cam: full(W, H) }
    case 'world': {
      // Camera shrinks and fades toward its PiP spot.
      const p = pipBox(s)
      return { world: full(W, H), cam: { x: p.x + p.w * 0.2, y: p.y + p.h * 0.2, w: p.w * 0.6, h: p.h * 0.6, r: p.r, a: 0 } }
    }
    case 'free': {
      const f = s.free
      return { world: full(W, H), cam: { x: f.x * W, y: f.y * H, w: f.w * W, h: f.h * H, r: 0.022 * Math.min(W, H), a: 1 } }
    }
  }
}

export const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
const lerp = (a: number, b: number, t: number) => a + (b - a) * t
export const lerpBox = (a: Box, b: Box, t: number): Box => ({
  x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), w: lerp(a.w, b.w, t),
  h: lerp(a.h, b.h, t), r: lerp(a.r, b.r, t), a: lerp(a.a, b.a, t),
})

function roundRect(ctx: CanvasRenderingContext2D, b: Box) {
  ctx.beginPath()
  ctx.roundRect(b.x, b.y, b.w, b.h, Math.max(0, Math.min(b.r, b.w / 2, b.h / 2)))
}

function drawSource(
  ctx: CanvasRenderingContext2D, f: Frame | null, b: Box,
  opts: { crop: Crop; fit: 'cover' | 'contain'; mirror: boolean; label: string },
) {
  if (b.a < 0.01 || b.w < 2 || b.h < 2) return
  ctx.save()
  ctx.globalAlpha = b.a
  if (b.r > 1) {
    ctx.save()
    ctx.shadowColor = 'rgba(0,0,0,0.45)'
    ctx.shadowBlur = b.r * 2
    ctx.shadowOffsetY = b.r * 0.5
    ctx.fillStyle = '#000'
    roundRect(ctx, b)
    ctx.fill()
    ctx.restore()
  }
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
    const c = opts.crop
    const cx = c.l * f.w, cy = c.t * f.h
    const cw = Math.max(1, f.w * (1 - c.l - c.r)), ch = Math.max(1, f.h * (1 - c.t - c.b))
    if (opts.mirror) {
      ctx.translate(b.x + b.w / 2, 0)
      ctx.scale(-1, 1)
      ctx.translate(-(b.x + b.w / 2), 0)
    }
    if (opts.fit === 'cover') {
      const k = Math.max(b.w / cw, b.h / ch)
      const vw = b.w / k, vh = b.h / k
      ctx.drawImage(f.src, cx + (cw - vw) / 2, cy + (ch - vh) / 2, vw, vh, b.x, b.y, b.w, b.h)
    } else {
      const k = Math.min(b.w / cw, b.h / ch)
      const dw = cw * k, dh = ch * k
      ctx.drawImage(f.src, cx, cy, cw, ch, b.x + (b.w - dw) / 2, b.y + (b.h - dh) / 2, dw, dh)
    }
  }
  ctx.restore()
}

function drawLowerThird(ctx: CanvasRenderingContext2D, s: Scene, cam: Box, t: number) {
  if (t <= 0.01) return
  const m = Math.min(s.W, s.H)
  // Sit inside the camera box when it is visible, else bottom-left of the frame.
  const anchor = cam.a > 0.5 && cam.w > m * 0.25 ? cam : full(s.W, s.H)
  const size = Math.max(16, Math.min(anchor.h * 0.07, m * 0.042))
  ctx.save()
  ctx.font = `650 ${size}px system-ui, -apple-system, sans-serif`
  const text = 'Kyle Johnson'
  const tw = ctx.measureText(text).width
  const pad = size * 0.6
  const w = tw + pad * 2 + size * 0.25, h = size * 1.9
  const x = anchor.x + Math.max(anchor.r, size) * 0.9 - (1 - t) * (w * 0.4)
  const y = anchor.y + anchor.h - h - Math.max(anchor.r, size) * 0.9
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
  drawSource(ctx, world, cur.world, { crop: s.worldCrop, fit: s.worldFit, mirror: false, label: 'Voice World' })
  const z = (1 - 1 / s.camZoom) / 2
  drawSource(ctx, cam, cur.cam, { crop: { t: z, b: z, l: z, r: z }, fit: 'cover', mirror: s.mirror, label: 'Camera' })
  drawLowerThird(ctx, s, cur.cam, lowerT)
}
