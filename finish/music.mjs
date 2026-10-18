// Procedural ambient bed: a slow pad under a sparse bell arpeggio, through a delay and a small
// Schroeder reverb. Synthesised from sine partials, so it is ours outright (no samples, no
// licence). Deterministic per (mood, duration), so a rerun renders the same file.
import { writeFileSync } from 'node:fs'

const SR = 48000

const midi = (n) => 440 * 2 ** ((n - 69) / 12)

/** Moods: chord voicings (MIDI), seconds per chord, arpeggio density, brightness. */
export const MOODS = {
  wonder: {
    label: 'Wonder (bright pad + bells)',
    chords: [
      [50, 57, 62, 66, 69, 76], // Dmaj9-ish
      [47, 54, 59, 62, 66, 73], // Bm11
      [43, 50, 55, 59, 66, 69], // Gmaj7/9
      [45, 52, 57, 61, 64, 71], // A add9
    ],
    chordSec: 8, arpEvery: 0.5, arpProb: 0.55, arpOct: 12, cutoff: 2400, bell: 0.16, pad: 0.22,
  },
  calm: {
    label: 'Calm (pad only, slow)',
    chords: [
      [48, 55, 60, 64, 67], // Cmaj
      [45, 52, 57, 60, 64], // Am
      [41, 48, 53, 57, 64], // Fmaj7
      [43, 50, 55, 59, 62], // G
    ],
    chordSec: 10, arpEvery: 1.5, arpProb: 0.25, arpOct: 12, cutoff: 1500, bell: 0.08, pad: 0.26,
  },
  warm: {
    label: 'Warm (low, gentle pulse)',
    chords: [
      [41, 48, 52, 57, 60, 64], // Fmaj7
      [38, 45, 50, 53, 57, 64], // Dm9
      [46, 53, 57, 62, 65], // Bbmaj7
      [48, 55, 60, 62, 67], // Csus2
    ],
    chordSec: 8, arpEvery: 0.75, arpProb: 0.45, arpOct: 0, cutoff: 1800, bell: 0.12, pad: 0.24,
  },
}

function rng(seed) {
  let s = seed >>> 0
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296)
}

/** Render `durationSec` of `mood` to a 48 kHz stereo 16-bit WAV at `outPath`. */
export function renderMusic(outPath, durationSec, mood = 'wonder') {
  const m = MOODS[mood] ?? MOODS.wonder
  const N = Math.ceil((durationSec + 1) * SR)
  const L = new Float32Array(N)
  const R = new Float32Array(N)
  const rand = rng(0x5eed + Math.round(durationSec * 10) + mood.length * 977)

  // Pad: each chord fades in over 3 s and out over 3 s, overlapping its neighbours.
  const fadeS = 3
  const nChords = Math.ceil(durationSec / m.chordSec) + 1
  for (let c = 0; c < nChords; c++) {
    const notes = m.chords[c % m.chords.length]
    const t0 = c * m.chordSec - fadeS / 2
    const t1 = t0 + m.chordSec + fadeS
    const i0 = Math.max(0, Math.floor(t0 * SR))
    const i1 = Math.min(N, Math.floor(t1 * SR))
    for (const [k, n] of notes.entries()) {
      const f = midi(n)
      const pan = 0.5 + (k / Math.max(1, notes.length - 1) - 0.5) * 0.6
      const amp = (m.pad / notes.length) * (n < 48 ? 1.15 : 1)
      const det = [0.9977, 1.0023] // about +-4 cents
      const ph = [rand() * 6.28, rand() * 6.28]
      const lfoF = 0.07 + rand() * 0.08
      const lfoP = rand() * 6.28
      for (let i = i0; i < i1; i++) {
        const t = i / SR
        const local = t - t0
        const env = Math.min(1, local / fadeS, (t1 - t) / fadeS)
        const e = env * env * (3 - 2 * env) * (0.8 + 0.2 * Math.sin(6.283 * lfoF * t + lfoP))
        let v = 0
        for (let d = 0; d < 2; d++) {
          const w = 6.283185 * f * det[d] * t + ph[d]
          v += Math.sin(w) + 0.22 * Math.sin(2 * w) + 0.07 * Math.sin(3 * w)
        }
        v *= amp * e * 0.5
        L[i] += v * (1 - pan)
        R[i] += v * pan
      }
    }
  }

  // One-pole low-pass on the pad for warmth.
  const a = Math.exp((-2 * Math.PI * m.cutoff) / SR)
  let yl = 0
  let yr = 0
  for (let i = 0; i < N; i++) { yl = (1 - a) * L[i] + a * yl; yr = (1 - a) * R[i] + a * yr; L[i] = yl; R[i] = yr }

  // Bells: a sparse arpeggio over the current chord, soft attack, long exponential tail.
  const bl = new Float32Array(N)
  const br = new Float32Array(N)
  for (let t = 2; t < durationSec - 2; t += m.arpEvery) {
    if (rand() > m.arpProb) continue
    const chord = m.chords[Math.floor((t + fadeS / 2) / m.chordSec) % m.chords.length]
    const upper = chord.slice(Math.floor(chord.length / 2))
    const n = upper[Math.floor(rand() * upper.length)] + m.arpOct
    const f = midi(n)
    const vel = m.bell * (0.55 + rand() * 0.45)
    const pan = 0.25 + rand() * 0.5
    const i0 = Math.floor(t * SR)
    const len = Math.min(N - i0, Math.floor(3.5 * SR))
    for (let j = 0; j < len; j++) {
      const tt = j / SR
      const env = Math.min(1, tt / 0.012) * Math.exp(-tt * 1.6)
      const v = vel * env * (Math.sin(6.283185 * f * tt) + 0.25 * Math.exp(-tt * 4) * Math.sin(6.283185 * f * 2.01 * tt))
      bl[i0 + j] += v * (1 - pan)
      br[i0 + j] += v * pan
    }
  }

  // Ping-pong delay on the bells (3/8 s), then mix in.
  const dly = Math.floor(0.375 * SR)
  for (let i = dly; i < N; i++) { bl[i] += br[i - dly] * 0.38; br[i] += bl[i - dly] * 0.38 }
  for (let i = 0; i < N; i++) { L[i] += bl[i]; R[i] += br[i] }

  // Small Schroeder reverb (4 combs + 2 allpasses per side), 30% wet.
  const verb = (x, offs) => {
    const y = new Float32Array(N)
    for (const [d, g] of [[1557, 0.84], [1617, 0.83], [1491, 0.85], [1422, 0.84]]) {
      const D = Math.floor((d + offs) * (SR / 44100))
      const buf = new Float32Array(D)
      let p = 0
      for (let i = 0; i < N; i++) { const o = buf[p]; buf[p] = x[i] + o * g; y[i] += o * 0.25; p = (p + 1) % D }
    }
    for (const d of [556, 441]) {
      const D = Math.floor((d + offs) * (SR / 44100))
      const buf = new Float32Array(D)
      let p = 0
      for (let i = 0; i < N; i++) { const b = buf[p]; const v = y[i] + b * 0.5; buf[p] = v; y[i] = b - v * 0.5; p = (p + 1) % D }
    }
    return y
  }
  const wl = verb(L, 0)
  const wr = verb(R, 23)
  for (let i = 0; i < N; i++) { L[i] = L[i] * 0.75 + wl[i] * 0.3; R[i] = R[i] * 0.75 + wr[i] * 0.3 }

  // Normalise to -3 dBFS peak and write 16-bit PCM.
  let peak = 1e-9
  for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]))
  const g = 0.708 / peak
  const buf = Buffer.alloc(44 + N * 4)
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + N * 4, 4); buf.write('WAVE', 8); buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24)
  buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(N * 4, 40)
  for (let i = 0; i < N; i++) {
    buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(L[i] * g * 32767))), 44 + i * 4)
    buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(R[i] * g * 32767))), 46 + i * 4)
  }
  writeFileSync(outPath, buf)
  return outPath
}
