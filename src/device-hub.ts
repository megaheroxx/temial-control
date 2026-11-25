import { EventEmitter } from 'node:events'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  bindStatusMessage, brewTeaMessage, parseDeviceMessage, remoteTeaMessage,
  type BindContent, type BrewAction, type BrewRecipe, type BrewStatus, type DeviceStatus, type VersionInfo,
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
}

export type LogEntry = {
  time: number
  serialNumber: string
  type: string
  detail?: unknown
}

const HEARTBEAT_MS = 30_000
const LOG_SIZE = 100

/**
 * Accepts WebSocket connections from Temial devices and keeps their latest state.
 * Emits 'device' (DeviceState) on every state change and 'log' (LogEntry) for every event.
 */
export class DeviceHub extends EventEmitter {
  readonly #wss = new WebSocketServer({ noServer: true })
  readonly #devices = new Map<string, DeviceState>()
  readonly #sockets = new Map<string, WebSocket>()
  readonly #log: LogEntry[] = []

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

  /** Sends a brew command. Returns false if the device is not connected. */
  brew(serialNumber: string, recipe: BrewRecipe): boolean {
    const ws = this.#sockets.get(serialNumber)
    const state = this.#devices.get(serialNumber)
    if (!ws || !state?.connected) return false

    ws.send(JSON.stringify(brewTeaMessage(serialNumber, recipe)))
    state.lastBrew = { ...recipe, sentAt: Date.now() }
    state.paused = false
    this.record(serialNumber, 'brewCommand', recipe)
    this.emit('device', state)
    return true
  }

  /** Cancels, pauses or resumes the running brew. Returns false if the device is not connected. */
  control(serialNumber: string, action: BrewAction): boolean {
    const ws = this.#sockets.get(serialNumber)
    const state = this.#devices.get(serialNumber)
    if (!ws || !state?.connected) return false

    ws.send(JSON.stringify(remoteTeaMessage(serialNumber, action)))
    state.paused = action === 'pause'
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
      case 'brewStatus':
        state.brewStatus = content as BrewStatus
        state.brewStatusAt = Date.now()
        this.record(serialNumber, 'brewStatus')
        break
      case 'brewingComplete':
        // Sent by the device when a brew ends; mark it finished right away instead of waiting for staleness.
        if (state.brewStatus) state.brewStatus = { ...state.brewStatus, remainingTotalTime: 0 }
        state.paused = false
        this.record(serialNumber, 'brewingComplete', content)
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
