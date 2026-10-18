// Drive the Finish panel end to end against the running dev server.
//   node scripts/verify-finish.mjs <short-take.mp4> [outDir]
// Picks the file (upload path), edits the first card, renders with music, then re-opens the same
// take through the "just recorded" path. Prints JSON and writes screenshots to outDir.
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const clip = resolve(process.argv[2] ?? '')
const out = resolve(process.argv[3] ?? 'verify-out/finish')
mkdirSync(out, { recursive: true })
const URL = process.env.ONAIR_URL ?? 'http://localhost:3094'

const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
const report = {}

await page.goto(URL)
await page.click('#finishBtn')
await page.waitForSelector('#finish:not([hidden])')

// 1. Pick a file from disk: it uploads to recordings/ and transcribes.
await page.setInputFiles('#fFile', clip)
await page.waitForFunction(() => document.querySelectorAll('.fcard').length > 0, null, { timeout: 120_000 })
report.cards = await page.$$eval('.fcard input', (els) => els.map((e) => e.value))
report.status = await page.textContent('#fStatus')

// 2. Edit the first card (different word count, so timings get spread).
const edited = 'LOOKS LIKE WE GOT A CRAB'
await page.fill('.fcard input >> nth=0', edited)
const firstStart = await page.evaluate(() => window.__finish.cards[0].startMs)
await page.evaluate((t) => { const v = document.getElementById('fVideo'); v.currentTime = t / 1000 + 0.25 }, firstStart)
await page.waitForTimeout(800)
await page.screenshot({ path: `${out}/finish-panel.png` })

// 3. Options, then render.
await page.selectOption('#fMood', 'calm')
await page.$eval('#fLevel', (el) => { el.value = '26'; el.dispatchEvent(new Event('input')) })
await page.click('#fRender')
await page.waitForSelector('#fResult a', { timeout: 300_000 })
report.result = await page.textContent('#fStatus')
report.download = await page.getAttribute('#fResult a', 'href')
const dl = await page.evaluate(async (href) => { const r = await fetch(href, { method: 'GET', headers: { range: 'bytes=0-15' } }); return { status: r.status, disposition: r.headers.get('content-disposition'), range: r.headers.get('content-range') } }, report.download)
report.downloadCheck = dl
await page.screenshot({ path: `${out}/finish-done.png` })

// 4. The "just recorded" path: hand the panel a Blob as the recorder would.
await page.click('#fClose')
await page.evaluate(async (path) => {
  const blob = await (await fetch(`/api/finish/file?path=${encodeURIComponent(path)}`)).blob()
  window.__finish.offerFinish(blob, 'onair-verify-after-take.mp4')
}, await page.evaluate(() => window.__finish.source.path))
report.finishLastVisible = await page.isVisible('#finishLast')
await page.click('#finishLast')
await page.waitForFunction(() => window.__finish.source?.name === 'onair-verify-after-take.mp4' && document.querySelectorAll('.fcard').length > 0, null, { timeout: 120_000 })
report.afterTakeCards = await page.$$eval('.fcard', (els) => els.length)
report.errors = errors
console.log(JSON.stringify(report, null, 2))
await browser.close()
