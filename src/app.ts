import { timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { DeviceHub, type DeviceState, type LogEntry } from './device-hub.ts'
import { PresetStore } from './presets.ts'
import { LIMITS, validateRecipe } from './validation.ts'

export type AppOptions = {
  dataDir: string
  /** If set, every /api request must carry this token. The device WebSocket stays open. */
  token?: string
}

const PUBLIC_DIR = join(import.meta.dirname, '..', 'public')
const STATIC_FILES: Record<string, [file: string, type: string]> = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
}
const MAX_BODY = 10_000
const SSE_KEEPALIVE_MS = 25_000

class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export async function createApp({ dataDir, token }: AppOptions) {
  const hub = new DeviceHub()
  const presets = new PresetStore(dataDir)
  await presets.load()

  const server = createServer(async (req, res) => {
    try {
      await route(req, res)
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500
      if (status === 500) console.error(err)
      sendJson(res, status, { error: err instanceof HttpError ? err.message : 'Interner Fehler' })
    }
  })

  // Temials connect via WebSocket upgrade on any path (with ?deviceId=<serial>).
  server.on('upgrade', (req, socket, head) => hub.handleUpgrade(req, socket, head))

  function close(): Promise<void> {
    hub.close()
    const closed = new Promise<void>((resolve) => server.close(() => resolve()))
    server.closeAllConnections()
    return closed
  }

  async function route(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname

    if (!path.startsWith('/api/')) {
      const entry = STATIC_FILES[path]
      if (!entry || req.method !== 'GET') throw new HttpError(404, 'Nicht gefunden')
      res.writeHead(200, { 'Content-Type': entry[1], 'Cache-Control': 'no-cache' })
      res.end(await readFile(join(PUBLIC_DIR, entry[0])))
      return
    }

    if (token && !isAuthorized(req, url, token)) throw new HttpError(401, 'Token fehlt oder ist falsch')

    const segments = path.split('/').filter(Boolean).slice(1).map(decodeURIComponent)
    const key = `${req.method} /${segments.map((s, i) => (i === 1 ? ':id' : s)).join('/')}`

    switch (key) {
      case 'GET /config':
        return sendJson(res, 200, { limits: LIMITS })

      case 'GET /devices':
        return sendJson(res, 200, hub.list())

      case 'POST /devices/:id/brew': {
        const result = validateRecipe(await readJson(req))
        if (!result.ok) return sendJson(res, 400, { error: result.errors.join(', ') })
        if (!hub.get(segments[1])) throw new HttpError(404, 'Gerät unbekannt')
        if (!hub.brew(segments[1], result.recipe)) throw new HttpError(409, 'Gerät ist nicht verbunden')
        return sendJson(res, 202, { sent: true })
      }

      case 'GET /presets':
        return sendJson(res, 200, presets.list())

      case 'POST /presets': {
        const result = validateRecipe(await readJson(req))
        if (!result.ok) return sendJson(res, 400, { error: result.errors.join(', ') })
        return sendJson(res, 201, await presets.add(result.recipe))
      }

      case 'DELETE /presets/:id':
        if (!(await presets.remove(segments[1]))) throw new HttpError(404, 'Preset unbekannt')
        res.writeHead(204).end()
        return

      case 'GET /events':
        return streamEvents(req, res)
    }

    throw new HttpError(404, 'Nicht gefunden')
  }

  function streamEvents(req: IncomingMessage, res: ServerResponse) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)

    send('snapshot', { devices: hub.list(), log: hub.recentLog() })
    const onDevice = (state: DeviceState) => send('device', state)
    const onLog = (entry: LogEntry) => send('log', entry)
    hub.on('device', onDevice)
    hub.on('log', onLog)
    const keepalive = setInterval(() => res.write(': keepalive\n\n'), SSE_KEEPALIVE_MS)

    const cleanup = () => {
      clearInterval(keepalive)
      hub.off('device', onDevice)
      hub.off('log', onLog)
    }
    req.on('close', cleanup)
  }

  return { server, hub, presets, close }
}

function isAuthorized(req: IncomingMessage, url: URL, token: string): boolean {
  const header = req.headers.authorization
  // EventSource cannot send headers, so the token may also come as ?token=
  const given = header?.startsWith('Bearer ') ? header.slice(7) : url.searchParams.get('token')
  if (!given) return false
  const a = Buffer.from(given)
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw new HttpError(413, 'Anfrage zu groß')
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'Ungültiges JSON')
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  if (res.headersSent) return res.end()
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}
