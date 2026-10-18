// Capture sources, the audio mixer, and the recorder.
import type { Frame } from './compositor'

/**
 * Holds the latest frame of a video track. Uses MediaStreamTrackProcessor where available
 * (Chrome) so frames keep flowing while this tab is in the background; falls back to a <video>.
 */
export class VideoSource {
  private frame: VideoFrame | null = null
  private video: HTMLVideoElement | null = null
  private stopped = false

  constructor(readonly stream: MediaStream, onEnded: () => void) {
    const track = stream.getVideoTracks()[0]
    track.addEventListener('ended', onEnded)
    const Processor = (window as any).MediaStreamTrackProcessor
    if (Processor) {
      const reader = new Processor({ track }).readable.getReader()
      ;(async () => {
        while (!this.stopped) {
          const { value, done } = await reader.read()
          if (done) break
          this.frame?.close()
          this.frame = value
        }
        this.frame?.close()
        this.frame = null
      })().catch(() => {})
    } else {
      const v = document.createElement('video')
      Object.assign(v, { muted: true, playsInline: true, autoplay: true, srcObject: stream })
      v.style.cssText = 'position:fixed;width:2px;height:2px;opacity:0;pointer-events:none'
      document.body.append(v)
      v.play().catch(() => {})
      this.video = v
    }
  }

  get current(): Frame | null {
    if (this.frame) return { src: this.frame, w: this.frame.displayWidth, h: this.frame.displayHeight }
    const v = this.video
    if (v && v.videoWidth) return { src: v, w: v.videoWidth, h: v.videoHeight }
    return null
  }

  get size() {
    const s = this.stream.getVideoTracks()[0]?.getSettings()
    return s ? `${s.width}×${s.height}@${Math.round(s.frameRate ?? 0)}` : ''
  }

  stop() {
    this.stopped = true
    this.stream.getTracks().forEach((t) => t.stop())
    this.frame?.close()
    this.frame = null
    this.video?.remove()
  }
}

type Channel = { gain: GainNode; analyser: AnalyserNode; node?: MediaStreamAudioSourceNode; buf: Float32Array<ArrayBuffer> }

/** Mixes mic + tab audio into one MediaStream track, with per-channel gain and meters. */
export class Mixer {
  readonly ctx = new AudioContext({ sampleRate: 48000 })
  readonly dest = this.ctx.createMediaStreamDestination()
  private ch: Record<'mic' | 'tab', Channel>

  constructor() {
    const make = (): Channel => {
      const gain = this.ctx.createGain()
      const analyser = this.ctx.createAnalyser()
      analyser.fftSize = 1024
      gain.connect(analyser)
      gain.connect(this.dest)
      return { gain, analyser, buf: new Float32Array(analyser.fftSize) }
    }
    this.ch = { mic: make(), tab: make() }
  }

  setInput(name: 'mic' | 'tab', stream: MediaStream | null) {
    const c = this.ch[name]
    c.node?.disconnect()
    c.node = undefined
    if (stream?.getAudioTracks().length) {
      c.node = this.ctx.createMediaStreamSource(stream)
      c.node.connect(c.gain)
    }
    this.ctx.resume().catch(() => {})
  }

  setGain(name: 'mic' | 'tab', v: number) { this.ch[name].gain.gain.value = v }

  /** Peak level 0..1 on a rough dB scale (-60 dB .. 0 dB). */
  level(name: 'mic' | 'tab') {
    const c = this.ch[name]
    c.analyser.getFloatTimeDomainData(c.buf)
    let peak = 0
    for (const s of c.buf) peak = Math.max(peak, Math.abs(s))
    const db = 20 * Math.log10(peak || 1e-6)
    return Math.max(0, Math.min(1, (db + 60) / 60))
  }
}

const TYPES = [
  'video/mp4;codecs=avc1.640028,mp4a.40.2',
  'video/mp4;codecs=avc1,mp4a.40.2',
  'video/mp4;codecs=avc1,mp4a',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
]
export const pickMimeType = () => TYPES.find((t) => MediaRecorder.isTypeSupported(t)) ?? ''

export function startRecorder(stream: MediaStream, onDone: (blob: Blob, mime: string) => void) {
  const mimeType = pickMimeType()
  const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 12_000_000, audioBitsPerSecond: 192_000 })
  const chunks: Blob[] = []
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data)
  rec.onstop = () => onDone(new Blob(chunks, { type: rec.mimeType || mimeType }), rec.mimeType || mimeType)
  rec.start(1000)
  return rec
}

export function download(blob: Blob, mime: string) {
  const ext = mime.includes('mp4') ? 'mp4' : 'webm'
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  const name = `onair-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}.${ext}`
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000)
  return name
}
