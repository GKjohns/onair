// The Finish API, mounted on the Vite dev server so OnAir stays a single `npm run dev`.
// Local only: it reads and writes files under ~/Downloads, recordings/ and .finish/.
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { analyze, render, DEFAULTS, MOODS, STYLES, defaultOutput } from './pipeline.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DOWNLOADS = join(homedir(), 'Downloads')
const RECORDINGS = join(ROOT, 'recordings')
const ALLOWED = [DOWNLOADS, RECORDINGS, join(ROOT, '.finish'), join(ROOT, 'verify-out')]
const jobs = new Map()

function allowed(p) {
  const abs = resolve(p)
  return ALLOWED.some((root) => abs === root || abs.startsWith(root + '/')) ? abs : null
}

function send(res, code, body) {
  res.statusCode = code
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(body))
}

async function readJson(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
}

function listTakes() {
  const out = []
  for (const dir of [DOWNLOADS, RECORDINGS]) {
    if (!existsSync(dir)) continue
    for (const f of readdirSync(dir)) {
      if (!/^onair.*\.(mp4|webm)$/i.test(f) || /-final\.mp4$/i.test(f) || f.endsWith('.part.mp4')) continue
      const p = join(dir, f)
      const st = statSync(p)
      const finished = defaultOutput(p)
      out.push({ path: p, name: f, size: st.size, mtimeMs: st.mtimeMs, dir: dir === DOWNLOADS ? 'Downloads' : 'recordings', finished: existsSync(finished) ? finished : null })
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

/** Serve a file with Range support, so <video> can seek a 150 MB take without loading it. */
function serveFile(req, res, path, download) {
  const { size } = statSync(path)
  res.setHeader('accept-ranges', 'bytes')
  res.setHeader('content-type', path.endsWith('.webm') ? 'video/webm' : path.endsWith('.json') ? 'application/json' : 'video/mp4')
  if (download) res.setHeader('content-disposition', `attachment; filename="${basename(path)}"`)
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '')
  if (m) {
    const start = m[1] ? Number(m[1]) : size - Number(m[2])
    const end = m[1] && m[2] ? Math.min(size - 1, Number(m[2])) : size - 1
    res.statusCode = 206
    res.setHeader('content-range', `bytes ${start}-${end}/${size}`)
    res.setHeader('content-length', end - start + 1)
    createReadStream(path, { start, end }).pipe(res)
  } else {
    res.setHeader('content-length', size)
    createReadStream(path).pipe(res)
  }
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://x')
  const route = url.pathname.replace(/\/+$/, '')
  try {
    if (req.method === 'GET' && route === '/options') {
      return send(res, 200, {
        defaults: DEFAULTS,
        styles: Object.fromEntries(Object.entries(STYLES).map(([k, v]) => [k, v.label])),
        moods: Object.fromEntries(Object.entries(MOODS).map(([k, v]) => [k, v.label])),
        hasKey: !!process.env.AI_GATEWAY_API_KEY,
      })
    }
    if (req.method === 'GET' && route === '/takes') return send(res, 200, { takes: listTakes() })

    if (req.method === 'POST' && route === '/upload') {
      const name = basename(url.searchParams.get('name') || `onair-upload-${Date.now()}.mp4`).replace(/[^\w.-]/g, '_')
      mkdirSync(RECORDINGS, { recursive: true })
      const dest = join(RECORDINGS, name)
      await new Promise((ok, fail) => { const ws = createWriteStream(dest); req.pipe(ws); ws.on('finish', ok); ws.on('error', fail); req.on('error', fail) })
      return send(res, 200, { path: dest, name, size: statSync(dest).size })
    }

    if (req.method === 'POST' && route === '/analyze') {
      const body = await readJson(req)
      const path = allowed(body.path ?? '')
      if (!path || !existsSync(path)) return send(res, 400, { error: 'Pick a take under ~/Downloads or recordings/' })
      const a = await analyze(path, { style: body.style ?? DEFAULTS.style })
      return send(res, 200, {
        path, meta: a.meta, phrases: a.phrases, words: a.transcript.words.length, costUsd: a.transcript.costUsd, model: a.transcript.model, transcriptError: a.transcript.error ?? null,
        output: defaultOutput(path),
      })
    }

    if (req.method === 'POST' && route === '/render') {
      const body = await readJson(req)
      const path = allowed(body.path ?? '')
      if (!path || !existsSync(path)) return send(res, 400, { error: 'Unknown take' })
      const id = randomUUID()
      const job = { id, state: 'running', stage: 'start', pct: 0, msg: 'Starting', result: null, error: null }
      jobs.set(id, job)
      render(path, { ...body.options, phrases: body.phrases }, (p) => Object.assign(job, p))
        .then((r) => Object.assign(job, { state: 'done', pct: 1, result: r }))
        .catch((e) => Object.assign(job, { state: 'error', error: String(e?.message ?? e) }))
      return send(res, 200, { id })
    }

    const jm = /^\/job\/([\w-]+)$/.exec(route)
    if (req.method === 'GET' && jm) {
      const job = jobs.get(jm[1])
      return job ? send(res, 200, job) : send(res, 404, { error: 'No such job' })
    }

    if (req.method === 'GET' && route === '/file') {
      const path = allowed(url.searchParams.get('path') ?? '')
      if (!path || !existsSync(path)) return send(res, 404, { error: 'Not found' })
      return serveFile(req, res, path, url.searchParams.has('download'))
    }
    send(res, 404, { error: 'Unknown route' })
  } catch (e) {
    console.error('[finish]', e)
    send(res, 500, { error: String(e?.message ?? e) })
  }
}

export default function finishPlugin() {
  return {
    name: 'onair-finish',
    configureServer(server) {
      server.middlewares.use('/api/finish', (req, res) => { handle(req, res) })
    },
  }
}
