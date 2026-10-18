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

// By default the "tab" is a synthetic 16:9 world (sky, ground, edge markers), so screenshots
// are readable and the crop is visible. --real-share uses Chrome's real getDisplayMedia path.
if (!args.includes('--real-share')) await context.addInitScript(() => {
  navigator.mediaDevices.getDisplayMedia = async () => {
    const c = Object.assign(document.createElement('canvas'), { width: 1600, height: 900 })
    const x = c.getContext('2d')
    let t = 0
    setInterval(() => {
      t++
      const g = x.createLinearGradient(0, 0, 0, 900); g.addColorStop(0, '#f6a35b'); g.addColorStop(0.6, '#7a5cc4'); g.addColorStop(1, '#22304f')
      x.fillStyle = g; x.fillRect(0, 0, 1600, 900)
      x.fillStyle = '#1d3b2a'; x.fillRect(0, 620, 1600, 280)
      x.fillStyle = '#ffe9a8'; x.beginPath(); x.arc(800, 300, 90, 0, 7); x.fill()
      for (let i = 0; i < 24; i++) { x.fillStyle = '#ffd36b'; x.beginPath(); x.arc((i * 67 + t * 2) % 1600, 560 - ((i * 37 + t) % 400), 9, 0, 7); x.fill() }
      x.fillStyle = '#fff'; x.font = 'bold 56px sans-serif'; x.fillText('LEFT EDGE', 30, 80); x.fillText('RIGHT EDGE', 1230, 80); x.fillText('CENTER', 690, 480)
    }, 33)
    const s = c.captureStream(30)
    const a = new AudioContext(), o = a.createOscillator(), d = a.createMediaStreamDestination()
    o.connect(d); o.start()
    return new MediaStream([...s.getVideoTracks(), ...d.stream.getAudioTracks()])
  }
})

const page = await context.newPage()
const errors = []
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
page.on('pageerror', (e) => errors.push(String(e)))
await page.goto(`${URL}/?countdown=1`)
await page.waitForTimeout(1500)

const results = { errors, shots: [] }
const shot = async (name, full = false) => {
  const p = join(out, `${name}.png`)
  await (full ? page : page.locator('#frame')).screenshot({ path: p })
  results.shots.push(p)
}

// Tab capture
await page.click('#shareBtn')
await page.waitForTimeout(1500)
results.tabInfo = await page.textContent('#tabInfo')
results.camInfo = await page.textContent('#camInfo')

const LAYOUTS = {
  vertical: ['cam', 'stack', 'tall', 'bubble', 'world', 'free'],
  landscape: ['pip', 'side', 'stack', 'cam', 'world', 'free'],
}
const pressLayout = async (set, layout, name) => {
  await page.keyboard.press(String(LAYOUTS[set].indexOf(layout) + 1))
  await page.waitForTimeout(550)
  const on = await page.$eval('#layouts .on', (b) => b.dataset.l)
  if (on !== layout) errors.push(`${name}: hotkey selected ${on}, expected ${layout}`)
  await shot(name)
}

// Default output is the 9:16 reel
results.defaultSize = await page.$eval('#out', (c) => `${c.width}x${c.height}`)
if (results.defaultSize !== '1080x1920') errors.push(`default size ${results.defaultSize}`)
for (const l of LAYOUTS.vertical) await pressLayout('vertical', l, `9x16-${l}`)
await page.keyboard.press('2')
await page.keyboard.press('s')
await page.waitForTimeout(550)
await shot('9x16-stack-swapped')
await page.keyboard.press('s')
await page.keyboard.press('3')
await page.click('#cardShape [data-c="9:16"]')
await page.waitForTimeout(550)
await shot('9x16-tall-916card')
await page.click('#cardShape [data-c="3:4"]')
await page.keyboard.press('g')
await page.waitForTimeout(200)
await shot('9x16-tall-noguides')
await page.keyboard.press('g')

// Pan the world by dragging it, then with the arrow keys
const focus = () => page.evaluate(() => JSON.parse(JSON.stringify(window.__onair.scene.focus.tall)))
const f0 = await focus()
const cb = await page.locator('#out').boundingBox()
await page.mouse.move(cb.x + cb.width * 0.3, cb.y + cb.height * 0.3)
await page.mouse.down()
await page.mouse.move(cb.x + cb.width * 0.3 + 60, cb.y + cb.height * 0.3, { steps: 6 })
await page.mouse.up()
const f1 = await focus()
await page.keyboard.press('ArrowRight')
await page.keyboard.press('ArrowRight')
const f2 = await focus()
results.pan = { start: f0.world.x, afterDrag: f1.world.x, afterArrows: f2.world.x }
if (!(f1.world.x < f0.world.x && f2.world.x > f1.world.x)) errors.push('world pan did not move the focus')
await page.waitForTimeout(200)
await shot('9x16-tall-panned-minimap')
await shot('ui-full-9x16', true)
results.minimapVisible = await page.$eval('#mini', (m) => getComputedStyle(m).display !== 'none')

// Popup sized to the world box
const [popup] = await Promise.all([context.waitForEvent('page', { timeout: 5000 }).catch(() => null), page.click('#openVw')])
if (popup) {
  await popup.waitForLoadState('domcontentloaded').catch(() => {})
  results.popup = { url: popup.url(), size: await popup.evaluate(() => `${innerWidth}x${innerHeight}`).catch(() => 'n/a') }
  await popup.close()
}
results.openInfo = await page.textContent('#openInfo')

// Free mode: drag the camera box, then resize from its corner
await page.keyboard.press('6')
await page.waitForTimeout(500)
const before = await page.evaluate(() => ({ ...window.__onair.scene.free }))
const fb = await page.locator('#freebox').boundingBox()
await page.mouse.move(fb.x + fb.width / 2, fb.y + fb.height / 2)
await page.mouse.down()
await page.mouse.move(fb.x + fb.width / 2 - 80, fb.y + fb.height / 2 - 120, { steps: 8 })
await page.mouse.up()
await page.waitForTimeout(150)
const hb = await page.locator('#freebox .handle').boundingBox()
await page.mouse.move(hb.x + 8, hb.y + 8)
await page.mouse.down()
await page.mouse.move(hb.x + 48, hb.y + 48, { steps: 8 })
await page.mouse.up()
const after = await page.evaluate(() => ({ ...window.__onair.scene.free }))
results.freeDrag = { before, after }
if (!(after.x < before.x && after.w > before.w)) errors.push('free drag/resize did not change the camera box')
await shot('9x16-free-dragged')

// Other sizes: 16:9 keeps the classic set, 4:5 and 1:1 use the vertical set
await page.click('#presets [data-p="1920x1080"]')
for (const l of LAYOUTS.landscape) await pressLayout('landscape', l, `16x9-${l}`)
for (const p of ['1080x1350', '1080x1080']) {
  await page.click(`#presets [data-p="${p}"]`)
  for (const l of ['stack', 'tall', 'bubble']) await pressLayout('vertical', l, `${p}-${l}`)
}

// Back to 9:16 for the test recording, with a transition and the name card
await page.click('#presets [data-p="1080x1920"]')
await page.keyboard.press('1')
await page.keyboard.press('l')
await page.waitForTimeout(150)
await shot('9x16-transition-mid')
await page.waitForTimeout(600)
await shot('9x16-hook-namecard')

// Record ~3 s
const dl = page.waitForEvent('download', { timeout: 20000 })
await page.keyboard.press('r')
await page.waitForTimeout(1300)
await page.keyboard.press('3') // layout switch mid-recording
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
