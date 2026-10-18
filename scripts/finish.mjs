#!/usr/bin/env node
// Finish a take from the command line: captions + music + loudness, same pipeline as the UI.
//   npm run finish -- ~/Downloads/onair-....mp4 [--style pop|plate|clean] [--mood wonder|calm|warm]
//                     [--music-db 24] [--no-captions] [--no-music] [--out path.mp4] [--analyze]
import { analyze, render, DEFAULTS } from '../finish/pipeline.mjs'

const argv = process.argv.slice(2)
const input = argv.find((a) => !a.startsWith('--') && !/^-?\d/.test(a) && !['pop', 'plate', 'clean', 'wonder', 'calm', 'warm'].includes(a))
const flag = (name) => argv.includes(`--${name}`)
const val = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined }
if (!input) { console.error('usage: npm run finish -- <take.mp4> [--style pop] [--mood wonder] [--music-db 24] [--no-captions] [--no-music] [--out x.mp4] [--analyze]'); process.exit(1) }

const log = ({ stage, pct, msg }) => process.stderr.write(`\r[${stage}] ${msg ?? ''} ${Math.round(pct * 100)}%      `)
if (flag('analyze')) {
  const a = await analyze(input, { style: val('style') ?? DEFAULTS.style, onProgress: log })
  console.log(`\n${a.transcript.words.length} words, ${a.phrases.length} cards, $${a.transcript.costUsd}`)
  for (const p of a.phrases) console.log(`${(p.startMs / 1000).toFixed(2).padStart(7)}-${(p.untilMs / 1000).toFixed(2).padEnd(7)} y=${p.baseline.toFixed(3)} ${p.words.map((w) => w.text).join(' ')}`)
} else {
  const r = await render(input, {
    style: val('style') ?? DEFAULTS.style, mood: val('mood') ?? DEFAULTS.mood, musicDb: Number(val('music-db') ?? DEFAULTS.musicDb),
    captions: !flag('no-captions'), music: !flag('no-music'), output: val('out'),
  }, log)
  console.log(`\n${JSON.stringify(r, null, 2)}`)
}
