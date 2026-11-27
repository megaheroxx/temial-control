import { timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { DeviceHub, type BrewStart, type DeviceState, type LogEntry } from './device-hub.ts'
import { HistoryStore } from './history.ts'
import { requestLang, translator, type Lang, type Translate } from './i18n.ts'
import { baseHostCandidates } from './network.ts'
import { PresetStore } from './presets.ts'
import {
  BREW_ACTIONS, DEFAULT_START_DELAY, DEFAULT_TEA_COLOR, MANUAL_TEA, MAX_START_DELAY, TEA_ID_PRESET, type BrewAction,
} from './protocol.ts'
import { DeviceSetup, SECURITY_TYPES, SetupError, validateConfigure, type SetupTarget } from './setup.ts'
import { LIMITS, validateRecipe } from './validation.ts'

export type AppOptions = {
  dataDir: string
  /** If set, every /api request must carry this token. The device WebSocket stays open. */
  token?: string
  /** baseHost shown in the setup form instead of the detected LAN addresses. */
  baseHost?: string
  /** Address of the device during setup; only overridden in tests. */
  setupTarget?: SetupTarget
  /** Language for requests that do not ask for one (X-Language / Accept-Language). */
  language?: Lang
}

const ROOT = join(import.meta.dirname, '..')
const JS = 'text/javascript; charset=utf-8'
const STATIC_FILES: Record<string, [file: string, type: string]> = {
  '/': ['public/index.html', 'text/html; charset=utf-8'],
  '/api.js': ['public/api.js', JS],
  '/i18n.js': ['public/i18n.js', JS],
  '/app.js': ['public/app.js', JS],
  '/setup.js': ['public/setup.js', JS],
  '/stats.js': ['public/stats.js', JS],
  '/style.css': ['public/style.css', 'text/css; charset=utf-8'],
  // Served locally because the browser has no internet while on the Temial hotspot.
  '/vendor/jsQR.js': ['node_modules/jsqr/dist/jsQR.js', JS],
}
const MAX_BODY = 10_000
const RECIPE_KEYS = ['name', 'temperature', 'duration', 'volume', 'preWashTime', 'infusions'] as const
const SSE_KEEPALIVE_MS = 25_000

class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export async function createApp({ dataDir, token, baseHost, setupTarget, language = 'en' }: AppOptions) {
  const hub = new DeviceHub()
  const presets = new PresetStore(dataDir, language)
  await presets.load()
  const history = new HistoryStore(dataDir)
  await history.load()
  hub.on('brewStarted', ({ serialNumber, startsAt, ...brew }: BrewStart) => history.start({ serialNumber, ...brew }, startsAt))
  hub.on('brewEnded', (serialNumber: string, status: 'done' | 'cancelled') => history.finish(serialNumber, status))
  const setup = new DeviceSetup((serialNumber, step) => hub.record(serialNumber, 'setup', step), setupTarget)

  const server = createServer(async (req, res) => {
    const t = translator(requestLang(req, language))
    try {
      await route(req, res, t)
    } catch (err) {
      const known = err instanceof HttpError || err instanceof SetupError
      const status = err instanceof HttpError ? err.status : known ? 400 : 500
      if (status === 500) console.error(err)
      sendJson(res, status, { error: known ? err.message : t('error.internal') })
    }
  })

  // Temials connect via WebSocket upgrade on any path (with ?deviceId=<serial>).
  server.on('upgrade', (req, socket, head) => hub.handleUpgrade(req, socket, head))

  async function close(): Promise<void> {
    hub.close()
    await history.flush()
    const closed = new Promise<void>((resolve) => server.close(() => resolve()))
    server.closeAllConnections()
    return closed
  }

  async function route(req: IncomingMessage, res: ServerResponse, t: Translate) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname

    if (!path.startsWith('/api/')) {
      const entry = STATIC_FILES[path]
      if (!entry || req.method !== 'GET') throw new HttpError(404, t('error.notFound'))
      res.writeHead(200, { 'Content-Type': entry[1], 'Cache-Control': 'no-cache' })
      res.end(await readFile(join(ROOT, entry[0])))
      return
    }

    if (token && !isAuthorized(req, url, token)) throw new HttpError(401, t('error.unauthorized'))

    const segments = path.split('/').filter(Boolean).slice(1).map(decodeURIComponent)
    const key = `${req.method} /${segments.map((s, i) => (i === 1 ? ':id' : s)).join('/')}`

    switch (key) {
      case 'GET /config':
        return sendJson(res, 200, { limits: LIMITS })

      case 'GET /devices':
        return sendJson(res, 200, hub.list())

      case 'POST /devices/:id/brew': {
        const body = await readJson(req, t)
        const result = validateRecipe(body, t)
        if (!result.ok) return sendJson(res, 400, { error: result.errors.join(', ') })
        // Optional timer: seconds until the device should start brewing.
        const { startInSeconds = DEFAULT_START_DELAY, presetId, color } = (body ?? {}) as Record<string, unknown>
        if (typeof startInSeconds !== 'number' || !Number.isInteger(startInSeconds)
          || startInSeconds < 0 || startInSeconds > MAX_START_DELAY) {
          throw new HttpError(400, t('error.startInSeconds', { max: MAX_START_DELAY }))
        }
        if (color !== undefined && (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color))) {
          throw new HttpError(400, t('error.color'))
        }
        // Brewing a saved preset: the device shows its name and colour instead of "Manual tea".
        const preset = typeof presetId === 'string' ? presets.get(presetId) : undefined
        const display = preset
          ? { teaId: TEA_ID_PRESET, color: (color as string | undefined) ?? preset.color ?? DEFAULT_TEA_COLOR }
          : MANUAL_TEA
        if (!hub.get(segments[1])) throw new HttpError(404, t('error.deviceUnknown'))
        if (!hub.brew(segments[1], result.recipe, startInSeconds, display)) throw new HttpError(409, t('error.deviceOffline'))
        return sendJson(res, 202, { sent: true })
      }

      case 'POST /devices/:id/control': {
        const { action } = ((await readJson(req, t)) ?? {}) as { action?: unknown }
        if (typeof action !== 'string' || !(BREW_ACTIONS as readonly string[]).includes(action)) {
          throw new HttpError(400, t('error.action', { actions: BREW_ACTIONS.join(', ') }))
        }
        if (!hub.get(segments[1])) throw new HttpError(404, t('error.deviceUnknown'))
        if (!hub.control(segments[1], action as BrewAction)) throw new HttpError(409, t('error.deviceOffline'))
        return sendJson(res, 202, { sent: true })
      }

      case 'POST /devices/:id/infusion': {
        const { action } = ((await readJson(req, t)) ?? {}) as { action?: unknown }
        if (action !== 'next' && action !== 'done') throw new HttpError(400, t('error.infusionAction'))
        if (!hub.get(segments[1])) throw new HttpError(404, t('error.deviceUnknown'))
        if (action === 'done') {
          if (!hub.finishInfusions(segments[1])) throw new HttpError(409, t('error.deviceOffline'))
          return sendJson(res, 202, { sent: true })
        }
        const result = hub.nextInfusion(segments[1])
        if (result === 'no-session') throw new HttpError(409, t('error.noNextInfusion'))
        if (result === 'not-connected') throw new HttpError(409, t('error.deviceOffline'))
        return sendJson(res, 202, { sent: true })
      }

      case 'GET /history': {
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 50))
        return sendJson(res, 200, history.list(limit))
      }

      case 'GET /stats':
        return sendJson(res, 200, history.stats())

      case 'GET /usage':
        return sendJson(res, 200, history.usage())

      case 'GET /presets':
        return sendJson(res, 200, presets.list())

      case 'POST /presets': {
        const result = validateRecipe(await readJson(req, t), t)
        if (!result.ok) return sendJson(res, 400, { error: result.errors.join(', ') })
        return sendJson(res, 201, await presets.add(result.recipe))
      }

      case 'PATCH /presets/:id': {
        // Partial update: any of name, temperature, duration, volume, preWashTime and color.
        const body = ((await readJson(req, t)) ?? {}) as Record<string, unknown>
        const current = presets.get(segments[1])
        if (!current) throw new HttpError(404, t('error.presetUnknown'))

        let color = current.color
        if ('color' in body) {
          const value = body.color
          if (value !== null && (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value))) {
            throw new HttpError(400, t('error.colorOrNull'))
          }
          color = value ?? undefined
        }

        const { id: _id, color: _color, ...recipe } = current
        const result = validateRecipe({ ...recipe, ...pick(body, RECIPE_KEYS) }, t)
        if (!result.ok) return sendJson(res, 400, { error: result.errors.join(', ') })
        return sendJson(res, 200, await presets.update(current.id, result.recipe, color))
      }

      case 'DELETE /presets/:id':
        if (!(await presets.remove(segments[1]))) throw new HttpError(404, t('error.presetUnknown'))
        res.writeHead(204).end()
        return

      case 'GET /events':
        return streamEvents(req, res)

      case 'GET /setup': {
        const { port } = server.address() as AddressInfo
        return sendJson(res, 200, {
          baseHosts: baseHostCandidates(port, baseHost),
          securityTypes: SECURITY_TYPES,
          busy: setup.busy,
        })
      }

      case 'POST /setup/:id': {
        const body = await readJson(req, t)
        if (setup.busy) throw new HttpError(409, t('error.setupBusy'))
        if (segments[1] === 'scan') return sendJson(res, 200, await setup.scan((body as { qr?: unknown })?.qr, t))
        if (segments[1] === 'configure') return sendJson(res, 200, await setup.configure(validateConfigure(body, t), t))
        break
      }
    }

    throw new HttpError(404, t('error.notFound'))
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

  return { server, hub, presets, history, close }
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

function pick(source: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((key) => key in source).map((key) => [key, source[key]]))
}

async function readJson(req: IncomingMessage, t: Translate): Promise<unknown> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw new HttpError(413, t('error.bodyTooLarge'))
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, t('error.invalidJson'))
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  if (res.headersSent) return res.end()
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}
