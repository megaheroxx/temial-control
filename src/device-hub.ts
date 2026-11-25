import { EventEmitter } from 'node:events'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  bindStatusMessage, brewTeaMessage, parseDeviceMessage, remoteTeaMessage,
  DEFAULT_START_DELAY, type BindContent, type BrewAction, type InfusionStep, type BrewRecipe, type BrewStatus, type DeviceStatus, type VersionInfo,
} from './protocol.ts'

export type DeviceState = {
  serialNumber: string
  connected: boolean
  connectedAt: number | null
  lastSeen: number
  deviceStatus: DeviceStatus | null
  brewStatus: BrewStatus | null
  brewStatusAt: number | null
  versions: VersionInfo | null
  lastBrew: (BrewRecipe & { sentAt: number }) | null
  /** Set by our own pause/resume commands; the device's paused state is not known. */
  paused: boolean
  /** Running multi-infusion brew: index of the current infusion (0-based) and total count. */
  session: (InfusionStep & { name: string }) | null
  /** A brew planned for later (timer); cleared once the device starts brewing or it is cancelled. */
  scheduled: { name: string, startsAt: number } | null
}

/** A brew that started; used for the history. */
export type BrewStart = {
  serialNumber: string
  name: string
  temperature: number | null
  duration: number | null
  volume: number | null
  infusion?: string
  source: 'app' | 'device'
  /** When brewing actually starts (later than now for a timer). */
  startsAt: number
}

export type LogEntry = {
  time: number
  serialNumber: string
  type: string
  detail?: unknown
}

const HEARTBEAT_MS = 30_000
/** A brew status older than this means the brew is over. */
const BREW_STALE_MS = 60_000
/** A brew status this soon after our own command belongs to that command. */
const COMMAND_MATCH_MS = 90_000
const LOG_SIZE = 100

/**
 * Accepts WebSocket connections from Temial devices and keeps their latest state.
 * Emits 'device' (DeviceState) on every state change, 'log' (LogEntry) for every event,
 * 'brewStarted' (BrewStart) and 'brewEnded' (serialNumber, 'done' | 'cancelled') for the history.
 */
export class DeviceHub extends EventEmitter {
  readonly #wss = new WebSocketServer({ noServer: true })
  readonly #devices = new Map<string, DeviceState>()
  readonly #sockets = new Map<string, WebSocket>()
  readonly #log: LogEntry[] = []
  /** Full recipes of running multi-infusion brews, keyed by serial number. */
  readonly #sessions = new Map<string, BrewRecipe>()

  constructor() {
    super()
    this.#wss.on('connection', (ws, req) => this.#onConnection(ws, req))
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    this.#wss.handleUpgrade(req, socket, head, (ws) => this.#wss.emit('connection', ws, req))
  }

  list(): DeviceState[] {
    return [...this.#devices.values()]
  }

  get(serialNumber: string): DeviceState | undefined {
    return this.#devices.get(serialNumber)
  }

  recentLog(): LogEntry[] {
    return [...this.#log]
  }

  /** Sends a brew command (first infusion of the recipe). Returns false if the device is not connected. */
  brew(serialNumber: string, recipe: BrewRecipe, startInSeconds = DEFAULT_START_DELAY): boolean {
    const total = 1 + (recipe.infusions?.length ?? 0)
    if (!this.#sendBrew(serialNumber, recipe, { index: 0, total }, startInSeconds)) return false
    if (total > 1) this.#sessions.set(serialNumber, recipe)
    else this.#sessions.delete(serialNumber)
    return true
  }

  /** Starts the next infusion of a multi-infusion brew. */
  nextInfusion(serialNumber: string): 'sent' | 'no-session' | 'not-connected' {
    const recipe = this.#sessions.get(serialNumber)
    const session = this.#devices.get(serialNumber)?.session
    if (!recipe || !session || session.index + 1 >= session.total) return 'no-session'
    const index = session.index + 1
    const step = recipe.infusions![index - 1]
    const infusion = { ...recipe, temperature: step.temperature, duration: step.duration, preWashTime: 0 }
    return this.#sendBrew(serialNumber, infusion, { index, total: session.total }) ? 'sent' : 'not-connected'
  }

  /** Ends a multi-infusion brew; the original app sent remoteTea "done" here. */
  finishInfusions(serialNumber: string): boolean {
    const ws = this.#sockets.get(serialNumber)
    const state = this.#devices.get(serialNumber)
    if (!ws || !state?.connected) return false
    ws.send(JSON.stringify(remoteTeaMessage(serialNumber, 'done')))
    this.#endSession(state)
    this.record(serialNumber, 'infusionsDone')
    this.emit('device', state)
    return true
  }

  #sendBrew(serialNumber: string, recipe: BrewRecipe, step: InfusionStep, startInSeconds = DEFAULT_START_DELAY): boolean {
    const ws = this.#sockets.get(serialNumber)
    const state = this.#devices.get(serialNumber)
    if (!ws || !state?.connected) return false

    ws.send(JSON.stringify(brewTeaMessage(serialNumber, recipe, step, startInSeconds)))
    const startsAt = Date.now() + startInSeconds * 1000
    state.scheduled = startInSeconds > DEFAULT_START_DELAY ? { name: recipe.name, startsAt } : null
    const { infusions: _infusions, ...single } = recipe
    state.lastBrew = { ...single, sentAt: Date.now() }
    state.paused = false
    state.session = step.total > 1 ? { ...step, name: recipe.name } : null
    const infusion = step.total > 1 ? `${step.index + 1}/${step.total}` : undefined
    this.record(serialNumber, 'brewCommand', infusion ? { ...single, infusion } : single)
    this.emit('brewStarted', {
      serialNumber, name: single.name, temperature: single.temperature, duration: single.duration,
      volume: single.volume, infusion, source: 'app', startsAt,
    } satisfies BrewStart)
    this.emit('device', state)
    return true
  }

  #endSession(state: DeviceState) {
    state.session = null
    this.#sessions.delete(state.serialNumber)
  }

  /** Cancels, pauses or resumes the running brew. Returns false if the device is not connected. */
  control(serialNumber: string, action: BrewAction): boolean {
    const ws = this.#sockets.get(serialNumber)
    const state = this.#devices.get(serialNumber)
    if (!ws || !state?.connected) return false

    ws.send(JSON.stringify(remoteTeaMessage(serialNumber, action)))
    state.paused = action === 'pause'
    if (action === 'cancel') {
      this.#endSession(state)
      state.scheduled = null
      this.emit('brewEnded', serialNumber, 'cancelled')
    }
    this.record(serialNumber, 'brewControl', action)
    this.emit('device', state)
    return true
  }

  close() {
    for (const ws of this.#wss.clients) ws.terminate()
    this.#wss.close()
  }

  #onConnection(ws: WebSocket, req: IncomingMessage) {
    const url = new URL(req.url ?? '/', 'http://device')
    let serialNumber = url.searchParams.get('deviceId') || null
    if (serialNumber) this.#attach(serialNumber, ws)

    let alive = true
    ws.on('pong', () => { alive = true })
    const heartbeat = setInterval(() => {
      if (!alive) return ws.terminate()
      alive = false
      ws.ping()
    }, HEARTBEAT_MS)

    ws.on('error', (err) => console.error('device socket error', serialNumber, err.message))

    ws.on('message', (data) => {
      const message = parseDeviceMessage(data.toString())
      if (!message) {
        this.record(serialNumber ?? '?', 'invalid', data.toString().slice(0, 200))
        return
      }
      if (serialNumber !== message.serialNumber) {
        serialNumber = message.serialNumber
        this.#attach(serialNumber, ws)
      }
      this.#handleMessage(ws, message.serialNumber, message.op, message.content)
    })

    ws.on('close', () => {
      clearInterval(heartbeat)
      if (!serialNumber || this.#sockets.get(serialNumber) !== ws) return
      this.#sockets.delete(serialNumber)
      const state = this.#devices.get(serialNumber)
      if (state) {
        state.connected = false
        state.connectedAt = null
        this.record(serialNumber, 'disconnected')
        this.emit('device', state)
      }
    })
  }

  #attach(serialNumber: string, ws: WebSocket) {
    const previous = this.#sockets.get(serialNumber)
    if (previous && previous !== ws) previous.terminate()
    this.#sockets.set(serialNumber, ws)

    const state = this.#state(serialNumber)
    state.connected = true
    state.connectedAt = Date.now()
    this.record(serialNumber, 'connected')
    this.emit('device', state)
  }

  #handleMessage(ws: WebSocket, serialNumber: string, op: string, content: unknown) {
    const state = this.#state(serialNumber)

    switch (op) {
      case 'bind': {
        const { code } = (content ?? {}) as Partial<BindContent>
        if (typeof code === 'string') {
          ws.send(JSON.stringify(bindStatusMessage(serialNumber, code, 'BOUND')))
        }
        this.record(serialNumber, 'bind')
        break
      }
      case 'checkUpdate':
        state.versions = content as VersionInfo
        this.record(serialNumber, 'checkUpdate', content)
        break
      case 'deviceStatus':
        state.deviceStatus = content as DeviceStatus
        this.record(serialNumber, 'deviceStatus')
        break
      case 'brewStatus': {
        const brew = content as BrewStatus
        const wasBrewing = Boolean(state.brewStatus && state.brewStatus.remainingTotalTime > 0
          && Date.now() - (state.brewStatusAt ?? 0) < BREW_STALE_MS)
        // A timer brew starts long after the command, so it counts as ours while it is scheduled.
        const fromCommand = state.scheduled !== null
          || (state.lastBrew !== null && Date.now() - state.lastBrew.sentAt < COMMAND_MATCH_MS)
        if (brew?.remainingTotalTime > 0) state.scheduled = null
        // A brew we did not start: someone pressed start at the Temial itself.
        if (!wasBrewing && !fromCommand && brew?.remainingTotalTime > 0) {
          this.emit('brewStarted', {
            serialNumber,
            name: 'An der Temial gestartet',
            temperature: typeof brew.temperature === 'number' ? Math.round(brew.temperature) : null,
            duration: brew.estimatedTimeBrewing ?? null,
            volume: null,
            source: 'device',
            startsAt: Date.now(),
          } satisfies BrewStart)
        }
        state.brewStatus = brew
        state.brewStatusAt = Date.now()
        this.record(serialNumber, 'brewStatus')
        break
      }
      case 'brewingComplete':
        // Sent by the device when a brew ends; mark it finished right away instead of waiting for staleness.
        if (state.brewStatus) state.brewStatus = { ...state.brewStatus, remainingTotalTime: 0 }
        state.paused = false
        this.record(serialNumber, 'brewingComplete', content)
        this.emit('brewEnded', serialNumber, 'done')
        break
      case 'messageCountRequest':
        break
      default:
        this.record(serialNumber, 'unhandled:' + op, content)
    }

    this.emit('device', state)
  }

  #state(serialNumber: string): DeviceState {
    let state = this.#devices.get(serialNumber)
    if (!state) {
      state = {
        serialNumber,
        connected: false,
        connectedAt: null,
        lastSeen: Date.now(),
        deviceStatus: null,
        brewStatus: null,
        brewStatusAt: null,
        versions: null,
        lastBrew: null,
        paused: false,
        session: null,
        scheduled: null,
      }
      this.#devices.set(serialNumber, state)
    }
    state.lastSeen = Date.now()
    return state
  }

  /** Adds an entry to the event log (also used for setup progress). */
  record(serialNumber: string, type: string, detail?: unknown) {
    const entry: LogEntry = { time: Date.now(), serialNumber, type, detail }
    this.#log.push(entry)
    if (this.#log.length > LOG_SIZE) this.#log.shift()
    console.log(new Date(entry.time).toISOString(), serialNumber, type)
    this.emit('log', entry)
  }
}
