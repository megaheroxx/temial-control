import {
  CheckWifiConnection, DeviceConnection, GetSerialNumberMessage, GetSSIDListMessage, IDontUnderstand,
  LoadSSIDMessage, SerialNumberMessage, SSIDListMessage,
} from '@freemial/connect'

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

export function parseQR(qr: unknown): ParsedQR {
  const parts = typeof qr === 'string' ? qr.trim().split(':') : []
  const [identifier, serialNumber, wifiStatus, countryCode, pairingCode] = parts
  if (parts.length !== 5 || !identifier || !serialNumber || !wifiStatus || !countryCode || !pairingCode) {
    throw new SetupError('QR-Code hat nicht das erwartete Format (5 Teile, getrennt durch Doppelpunkte)')
  }
  if (Buffer.byteLength(pairingCode) !== 32) {
    throw new SetupError('Pairing-Code im QR-Code ist ungültig. QR-Code bitte neu anzeigen lassen.')
  }
  return { serialNumber, pairingCode }
}

export function validateConfigure(input: unknown): ConfigureRequest {
  if (typeof input !== 'object' || input === null) throw new SetupError('Anfrage muss ein Objekt sein')
  const { qr, ssid, key, baseHost, securityType } = input as Record<string, unknown>
  parseQR(qr)

  const text = (value: unknown, name: string, min: number, max: number) => {
    if (typeof value !== 'string') throw new SetupError(`${name} fehlt`)
    if (!PRINTABLE_ASCII.test(value)) {
      throw new SetupError(`${name} enthält Umlaute oder Sonderzeichen. Das Freemial-Protokoll überträgt nur ASCII korrekt.`)
    }
    if (value.length < min || value.length > max) throw new SetupError(`${name} muss ${min}–${max} Zeichen lang sein`)
    return value
  }

  const request: ConfigureRequest = {
    qr: (qr as string).trim(),
    ssid: text(ssid, 'WLAN-Name', 1, SSID_MAX),
    key: text(key ?? '', 'WLAN-Passwort', 0, KEY_MAX),
    baseHost: text(typeof baseHost === 'string' ? baseHost.trim() : baseHost, 'Server-Adresse', 1, BASE_HOST_MAX),
  }
  if (!/^https?:\/\/[^/\s]+$/.test(request.baseHost)) {
    throw new SetupError('Server-Adresse muss wie http://192.168.178.20:3000 aussehen (ohne Pfad)')
  }
  if (securityType !== undefined && securityType !== null) {
    if (typeof securityType !== 'number' || !SECURITY_TYPES[securityType]) throw new SetupError('Unbekannter Sicherheitstyp')
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
  scan(qr: unknown): Promise<ScanResult> {
    const parsed = parseQR(qr)
    return this.#exclusive(parsed, async (conn, step) => {
      const serialMatches = await this.#checkSerial(conn, parsed, step)
      const networks = await this.#scanNetworks(conn, step)
      return { serialNumber: parsed.serialNumber, serialMatches, networks }
    })
  }

  /** Sends Wi-Fi credentials and server address to the device. */
  configure(request: ConfigureRequest): Promise<ConfigureResult> {
    const parsed = parseQR(request.qr)
    return this.#exclusive(parsed, async (conn, step) => {
      await this.#checkSerial(conn, parsed, step)
      const networks = await this.#scanNetworks(conn, step)

      const visible = networks.find((network) => network.ssid === request.ssid)
      const securityType = visible?.securityType ?? request.securityType
      if (securityType === undefined) {
        throw new SetupError(`Die Temial sieht das WLAN „${request.ssid}“ nicht. Bei versteckten Netzen den Sicherheitstyp angeben.`)
      }

      step(`Sende WLAN „${request.ssid}“ und Server ${request.baseHost} …`)
      const message = new LoadSSIDMessage({ ssid: request.ssid, securityType, key: request.key, baseHost: request.baseHost })
      try {
        const reply = await exchange(conn, message, CheckWifiConnection, CONFIRM_TIMEOUT_MS)
        step(reply.bool ? 'Temial hat die Konfiguration bestätigt' : 'Temial hat die Konfiguration empfangen')
        return { serialNumber: parsed.serialNumber, confirmed: reply.bool }
      } catch (err) {
        // The device often drops its hotspot right away to join the new Wi-Fi.
        if (err instanceof ConnectionClosed || err instanceof ReplyTimeout) {
          step('Konfiguration gesendet, Temial wechselt ins WLAN')
          return { serialNumber: parsed.serialNumber, confirmed: false }
        }
        throw err
      }
    })
  }

  async #exclusive<T>(parsed: ParsedQR, work: (conn: DeviceConnection, step: (text: string) => void) => Promise<T>): Promise<T> {
    if (this.#busy) throw new SetupError('Es läuft bereits eine Einrichtung')
    this.#busy = true
    const step = (text: string) => this.#onStep(parsed.serialNumber, text)
    let conn: DeviceConnection | undefined
    try {
      step(`Verbinde mit der Temial unter ${this.#target.host}:${this.#target.port} …`)
      conn = await connect(parsed, this.#target)
      step('Verbunden')
      return await work(conn, step)
    } catch (err) {
      step(`Fehler: ${err instanceof Error ? err.message : String(err)}`)
      throw err
    } finally {
      conn?.destroy()
      this.#busy = false
    }
  }

  async #checkSerial(conn: DeviceConnection, parsed: ParsedQR, step: (text: string) => void) {
    const reply = await exchange(conn, new GetSerialNumberMessage(), SerialNumberMessage, SERIAL_TIMEOUT_MS)
    const matches = reply.serialNumber === parsed.serialNumber
    step(matches ? `Seriennummer ${reply.serialNumber} passt zum QR-Code` : `Achtung: Gerät meldet Seriennummer ${reply.serialNumber}`)
    return matches
  }

  async #scanNetworks(conn: DeviceConnection, step: (text: string) => void): Promise<WifiNetwork[]> {
    step('Temial sucht WLANs (bis zu 30 Sekunden) …')
    const reply = await exchange(conn, new GetSSIDListMessage(), SSIDListMessage, SCAN_TIMEOUT_MS)
    const networks = reply.ssidList
      .filter((network) => network.ssid)
      .sort((a, b) => b.signalStrength - a.signalStrength)
    step(`${networks.length} WLAN(s) gefunden`)
    return networks
  }
}

class ConnectionClosed extends SetupError {}
class ReplyTimeout extends SetupError {}

function connect(parsed: ParsedQR, target: SetupTarget): Promise<DeviceConnection> {
  const hotspot = `Temial-${parsed.serialNumber.slice(-5)}`
  return new Promise((resolve, reject) => {
    const qrValue = `x:${parsed.serialNumber}:x:x:${parsed.pairingCode}`
    const conn = new DeviceConnection({ qrValue, ...target })
    // Keep a listener so late socket errors never crash the process.
    conn.on('error', () => {})
    conn.setTimeout(CONNECT_TIMEOUT_MS)

    const fail = () => {
      conn.destroy()
      reject(new SetupError(`Temial nicht erreichbar. Ist dieser Rechner mit dem WLAN „${hotspot}“ verbunden?`))
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
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(new ReplyTimeout('Keine Antwort der Temial (Zeitüberschreitung)')), timeoutMs)
    const onMessage = (reply: unknown) => {
      if (reply instanceof Expected) done(null, reply)
      else if (reply instanceof IDontUnderstand) done(new SetupError('Die Temial hat die Anfrage nicht verstanden. QR-Code neu anzeigen lassen.'))
    }
    const onClose = () => done(new ConnectionClosed('Die Temial hat die Verbindung beendet. Meist passt der QR-Code nicht mehr. Bitte neu anzeigen lassen.'))

    function done(err: Error | null, value?: T) {
      clearTimeout(timer)
      conn.off('message', onMessage)
      conn.off('close', onClose)
      if (err) reject(err)
      else resolve(value as T)
    }

    conn.on('message', onMessage)
    conn.on('close', onClose)
    conn.sendMessage(message).catch((err: Error) => done(new SetupError(`Senden fehlgeschlagen: ${err.message}`)))
  })
}
