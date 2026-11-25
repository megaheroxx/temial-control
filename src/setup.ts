import {
  CheckWifiConnection, DeviceConnection, GetSerialNumberMessage, GetSSIDListMessage, IDontUnderstand,
  LoadSSIDMessage, SerialNumberMessage, SSIDListMessage,
} from '@freemial/connect'
import { translator, type Translate } from './i18n.ts'

// First-time setup of a Temial over its own hotspot, following the flow of the Freemial CLI:
// connect → serial number → Wi-Fi scan → send Wi-Fi credentials and server address.
// The machine running this app must be connected to the device's "Temial-xxxxx" Wi-Fi meanwhile.

export type SetupTarget = { host: string, port: number }

export type WifiNetwork = { ssid: string, securityType: number, signalStrength: number }

export type ScanResult = { serialNumber: string, serialMatches: boolean, networks: WifiNetwork[] }

export type ConfigureRequest = {
  qr: string
  ssid: string
  key: string
  baseHost: string
  /** Only needed for networks the device cannot see (hidden SSIDs). */
  securityType?: number
}

export type ConfigureResult = { serialNumber: string, confirmed: boolean }

export type StepListener = (serialNumber: string, step: string) => void

export class SetupError extends Error {}

export const SECURITY_TYPES = ['NONE', 'WEP', 'WPA', 'WPA2', 'WPA2MIXED'] as const

const DEFAULT_TARGET: SetupTarget = { host: '192.168.1.1', port: 4478 }
const CONNECT_TIMEOUT_MS = 10_000
const SERIAL_TIMEOUT_MS = 10_000
const SCAN_TIMEOUT_MS = 30_000
const CONFIRM_TIMEOUT_MS = 30_000

// Field sizes of the LoadSSID frame. The library writes the character count as length byte,
// so only ASCII is transferred correctly.
const SSID_MAX = 32
const KEY_MAX = 63
const BASE_HOST_MAX = 64
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/

export type ParsedQR = { serialNumber: string, pairingCode: string }

const ENGLISH = translator('en')

export function parseQR(qr: unknown, t: Translate = ENGLISH): ParsedQR {
  const parts = typeof qr === 'string' ? qr.trim().split(':') : []
  const [identifier, serialNumber, wifiStatus, countryCode, pairingCode] = parts
  if (parts.length !== 5 || !identifier || !serialNumber || !wifiStatus || !countryCode || !pairingCode) {
    throw new SetupError(t('setup.qrFormat'))
  }
  if (Buffer.byteLength(pairingCode) !== 32) {
    throw new SetupError(t('setup.pairingCode'))
  }
  return { serialNumber, pairingCode }
}

export function validateConfigure(input: unknown, t: Translate = ENGLISH): ConfigureRequest {
  if (typeof input !== 'object' || input === null) throw new SetupError(t('setup.notObject'))
  const { qr, ssid, key, baseHost, securityType } = input as Record<string, unknown>
  parseQR(qr, t)

  const text = (value: unknown, field: string, min: number, max: number) => {
    if (typeof value !== 'string') throw new SetupError(t('setup.fieldMissing', { field }))
    if (!PRINTABLE_ASCII.test(value)) throw new SetupError(t('setup.fieldAscii', { field }))
    if (value.length < min || value.length > max) throw new SetupError(t('setup.fieldLength', { field, min, max }))
    return value
  }

  const request: ConfigureRequest = {
    qr: (qr as string).trim(),
    ssid: text(ssid, t('setup.field.ssid'), 1, SSID_MAX),
    key: text(key ?? '', t('setup.field.key'), 0, KEY_MAX),
    baseHost: text(typeof baseHost === 'string' ? baseHost.trim() : baseHost, t('setup.field.baseHost'), 1, BASE_HOST_MAX),
  }
  if (!/^https?:\/\/[^/\s]+$/.test(request.baseHost)) throw new SetupError(t('setup.baseHost'))
  if (securityType !== undefined && securityType !== null) {
    if (typeof securityType !== 'number' || !SECURITY_TYPES[securityType]) throw new SetupError(t('setup.securityType'))
    request.securityType = securityType
  }
  return request
}

/** Runs one setup at a time against the device hotspot. */
export class DeviceSetup {
  readonly #target: SetupTarget
  readonly #onStep: StepListener
  #busy = false

  constructor(onStep: StepListener, target: SetupTarget = DEFAULT_TARGET) {
    this.#onStep = onStep
    this.#target = target
  }

  get busy() {
    return this.#busy
  }

  /** Connects to the device and lists the Wi-Fi networks it can see. */
  scan(qr: unknown, t: Translate = ENGLISH): Promise<ScanResult> {
    const parsed = parseQR(qr, t)
    return this.#exclusive(parsed, t, async (conn, step) => {
      const serialMatches = await this.#checkSerial(conn, parsed, step, t)
      const networks = await this.#scanNetworks(conn, step, t)
      return { serialNumber: parsed.serialNumber, serialMatches, networks }
    })
  }

  /** Sends Wi-Fi credentials and server address to the device. */
  configure(request: ConfigureRequest, t: Translate = ENGLISH): Promise<ConfigureResult> {
    const parsed = parseQR(request.qr, t)
    return this.#exclusive(parsed, t, async (conn, step) => {
      await this.#checkSerial(conn, parsed, step, t)
      const networks = await this.#scanNetworks(conn, step, t)

      const visible = networks.find((network) => network.ssid === request.ssid)
      const securityType = visible?.securityType ?? request.securityType
      if (securityType === undefined) {
        throw new SetupError(t('setup.ssidNotVisible', { ssid: request.ssid }))
      }

      step(t('step.sending', { ssid: request.ssid, baseHost: request.baseHost }))
      const message = new LoadSSIDMessage({ ssid: request.ssid, securityType, key: request.key, baseHost: request.baseHost })
      try {
        const reply = await exchange(conn, message, CheckWifiConnection, CONFIRM_TIMEOUT_MS, t)
        step(t(reply.bool ? 'step.confirmed' : 'step.received'))
        return { serialNumber: parsed.serialNumber, confirmed: reply.bool }
      } catch (err) {
        // The device often drops its hotspot right away to join the new Wi-Fi.
        if (err instanceof ConnectionClosed || err instanceof ReplyTimeout) {
          step(t('step.switching'))
          return { serialNumber: parsed.serialNumber, confirmed: false }
        }
        throw err
      }
    })
  }

  async #exclusive<T>(
    parsed: ParsedQR,
    t: Translate,
    work: (conn: DeviceConnection, step: (text: string) => void) => Promise<T>,
  ): Promise<T> {
    if (this.#busy) throw new SetupError(t('error.setupBusy'))
    this.#busy = true
    const step = (text: string) => this.#onStep(parsed.serialNumber, text)
    let conn: DeviceConnection | undefined
    try {
      step(t('step.connecting', { target: `${this.#target.host}:${this.#target.port}` }))
      conn = await connect(parsed, this.#target, t)
      step(t('step.connected'))
      return await work(conn, step)
    } catch (err) {
      step(t('step.error', { message: err instanceof Error ? err.message : String(err) }))
      throw err
    } finally {
      conn?.destroy()
      this.#busy = false
    }
  }

  async #checkSerial(conn: DeviceConnection, parsed: ParsedQR, step: (text: string) => void, t: Translate) {
    const reply = await exchange(conn, new GetSerialNumberMessage(), SerialNumberMessage, SERIAL_TIMEOUT_MS, t)
    const matches = reply.serialNumber === parsed.serialNumber
    step(t(matches ? 'step.serialMatches' : 'step.serialMismatch', { serial: reply.serialNumber }))
    return matches
  }

  async #scanNetworks(conn: DeviceConnection, step: (text: string) => void, t: Translate): Promise<WifiNetwork[]> {
    step(t('step.scanning'))
    const reply = await exchange(conn, new GetSSIDListMessage(), SSIDListMessage, SCAN_TIMEOUT_MS, t)
    const networks = reply.ssidList
      .filter((network) => network.ssid)
      .sort((a, b) => b.signalStrength - a.signalStrength)
    step(t('step.networksFound', { count: networks.length }))
    return networks
  }
}

class ConnectionClosed extends SetupError {}
class ReplyTimeout extends SetupError {}

function connect(parsed: ParsedQR, target: SetupTarget, t: Translate): Promise<DeviceConnection> {
  const hotspot = `Temial-${parsed.serialNumber.slice(-5)}`
  return new Promise((resolve, reject) => {
    const qrValue = `x:${parsed.serialNumber}:x:x:${parsed.pairingCode}`
    const conn = new DeviceConnection({ qrValue, ...target })
    // Keep a listener so late socket errors never crash the process.
    conn.on('error', () => {})
    conn.setTimeout(CONNECT_TIMEOUT_MS)

    const fail = () => {
      conn.destroy()
      reject(new SetupError(t('setup.unreachable', { hotspot })))
    }
    conn.once('timeout', fail)
    conn.once('error', fail)
    conn.once('connect', () => {
      conn.setTimeout(0)
      conn.off('timeout', fail)
      conn.off('error', fail)
      resolve(conn)
    })
  })
}

function exchange<T>(
  conn: DeviceConnection,
  message: GetSerialNumberMessage | GetSSIDListMessage | LoadSSIDMessage,
  Expected: new (...args: never[]) => T,
  timeoutMs: number,
  t: Translate,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(new ReplyTimeout(t('setup.timeout'))), timeoutMs)
    const onMessage = (reply: unknown) => {
      if (reply instanceof Expected) done(null, reply)
      else if (reply instanceof IDontUnderstand) done(new SetupError(t('setup.notUnderstood')))
    }
    const onClose = () => done(new ConnectionClosed(t('setup.closed')))

    function done(err: Error | null, value?: T) {
      clearTimeout(timer)
      conn.off('message', onMessage)
      conn.off('close', onClose)
      if (err) reject(err)
      else resolve(value as T)
    }

    conn.on('message', onMessage)
    conn.on('close', onClose)
    conn.sendMessage(message).catch((err: Error) => done(new SetupError(t('setup.sendFailed', { reason: err.message }))))
  })
}
