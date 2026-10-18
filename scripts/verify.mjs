// Smoke test with fake media devices. Needs the dev server running (npm run dev).
// Usage: node scripts/verify.mjs [outDir] [--chrome]   (--chrome uses installed Google Chrome, which can record MP4)
import { chromium } from 'playwright'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const URL = process.env.ONAIR_URL ?? 'http://localhost:3094'
const args = process.argv.slice(2)
const out = args.find((a) => !a.startsWith('--')) ?? 'verify-out'
const useChrome = args.includes('--chrome')
mkdirSync(out, { recursive: true })

const browser = await chromium.launch({
  channel: useChrome ? 'chrome' : undefined,
  headless: !args.includes('--headed'),
  args: [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--auto-select-desktop-capture-source=Entire screen',
    '--auto-select-tab-capture-source-by-title=Fake Voice World',
    '--autoplay-policy=no-user-gesture-required',
  ],
})
const context = await browser.newContext({ viewport: { width: 1600, height: 950 }, acceptDownloads: true })
await context.grantPermissions(['camera', 'microphone'], { origin: URL })

// A stand-in "Voice World" tab with motion and a tone, for tab capture.
const fake = await context.newPage()
await fake.setContent(`<title>Fake Voice World</title><body style="margin:0;background:#123">
  <canvas id=c width=1280 height=720 style="width:100vw;height:100vh"></canvas>
  <script>const c=document.getElementById('c').getContext('2d');let t=0;
  setInterval(()=>{t++;const g=c.createLinearGradient(0,0,1280,720);g.addColorStop(0,'#2b6');g.addColorStop(1,'#26b');
  c.fillStyle=g;c.fillRect(0,0,1280,720);c.fillStyle='#fc4';c.beginPath();c.arc(640+300*Math.sin(t/20),360,80,0,7);c.fill();
  c.fillStyle='#fff';c.font='bold 64px sans-serif';c.fillText('Fake Voice World '+t,60,100)},33);
  try{const a=new AudioContext();const o=a.createOscillator();o.connect(a.destination);o.start()}catch{}</script></body>`)

const page = await context.newPage()
const errors = []
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
page.on('pageerror', (e) => errors.push(String(e)))
await page.goto(`${URL}/?countdown=1`)
await page.waitForTimeout(1500)

const results = { errors, shots: [] }
const shot = async (name) => {
  const p = join(out, `${name}.png`)
  await page.screenshot({ path: p })
  results.shots.push(p)
}

// Tab capture
await page.click('#shareBtn')
await page.waitForTimeout(1500)
results.tabInfo = await page.textContent('#tabInfo')
results.camInfo = await page.textContent('#camInfo')

for (const preset of ['1920x1080', '1080x1920', '1080x1080', '1080x1350']) {
  await page.click(`#presets [data-p="${preset}"]`)
  const size = await page.$eval('#out', (c) => `${c.width}x${c.height}`)
  if (size !== preset) errors.push(`preset ${preset} gave canvas ${size}`)
  for (const [i, layout] of ['pip', 'side', 'stack', 'cam', 'world', 'free'].entries()) {
    if (preset !== '1920x1080' && !['pip', 'stack', 'side'].includes(layout)) continue
    await page.keyboard.press(String(i + 1))
    await page.waitForTimeout(550)
    const on = await page.$eval('#layouts .on', (b) => b.dataset.l)
    if (on !== layout) errors.push(`hotkey ${i + 1} selected ${on}`)
    await shot(`${preset}-${layout}`)
  }
}

// Free mode: drag the camera box, then resize from its corner
await page.click('#presets [data-p="1920x1080"]')
await page.keyboard.press('6')
await page.waitForTimeout(500)
const before = await page.evaluate(() => ({ ...window.__onair.scene.free }))
const fb = await page.locator('#freebox').boundingBox()
await page.mouse.move(fb.x + fb.width / 2, fb.y + fb.height / 2)
await page.mouse.down()
await page.mouse.move(fb.x + fb.width / 2 - 200, fb.y + fb.height / 2 - 120, { steps: 8 })
await page.mouse.up()
await page.waitForTimeout(150)
const hb = await page.locator('#freebox .handle').boundingBox()
await page.mouse.move(hb.x + 8, hb.y + 8)
await page.mouse.down()
await page.mouse.move(hb.x + 108, hb.y + 48, { steps: 8 })
await page.mouse.up()
const after = await page.evaluate(() => ({ ...window.__onair.scene.free }))
results.freeDrag = { before, after }
if (!(after.x < before.x && after.w > before.w)) errors.push('free drag/resize did not change the camera box')
await shot('free-dragged')

// Mid-transition frame, P corner cycle, lower third
await page.click('#presets [data-p="1920x1080"]')
await page.keyboard.press('1')
await page.waitForTimeout(500)
await page.keyboard.press('p')
await page.waitForTimeout(180)
await shot('transition-mid')
await page.waitForTimeout(400)
await page.keyboard.press('l')
await page.waitForTimeout(600)
await shot('pip-corner-bl-lowerthird')

// Record ~3 s
const dl = page.waitForEvent('download', { timeout: 20000 })
await page.keyboard.press('r')
await page.waitForTimeout(1300)
await page.keyboard.press('2') // layout switch mid-recording
await page.waitForTimeout(1200)
await shot('recording')
await page.keyboard.press('1')
await page.waitForTimeout(1000)
await page.keyboard.press('r')
const download = await dl
const file = join(out, download.suggestedFilename())
await download.saveAs(file)
const buf = readFileSync(file)
results.recording = {
  file,
  bytes: buf.length,
  last: await page.evaluate(() => window.__onair.last),
  container: buf.subarray(4, 8).toString() === 'ftyp' ? 'mp4' : buf.readUInt32BE(0) === 0x1a45dfa3 ? 'webm' : 'unknown',
}
await shot('after-record')
console.log(JSON.stringify(results, null, 2))
await browser.close()
process.exit(errors.length || !buf.length ? 1 : 0)
