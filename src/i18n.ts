import type { IncomingMessage } from 'node:http'

export type Lang = 'en' | 'de'
export const LANGUAGES: readonly Lang[] = ['en', 'de']

type Params = Record<string, string | number>
type Messages = Record<string, (p: Params) => string>

const en = {
  // HTTP API
  'error.notFound': () => 'Not found',
  'error.unauthorized': () => 'Token missing or wrong',
  'error.internal': () => 'Internal error',
  'error.bodyTooLarge': () => 'Request too large',
  'error.invalidJson': () => 'Invalid JSON',
  'error.deviceUnknown': () => 'Unknown device',
  'error.deviceOffline': () => 'Device is not connected',
  'error.presetUnknown': () => 'Unknown preset',
  'error.startInSeconds': (p) => `startInSeconds must be between 0 and ${p.max}`,
  'error.color': () => 'color must look like #5aa846',
  'error.colorOrNull': () => 'Colour must look like #5aa846 (or null for automatic)',
  'error.action': (p) => `action must be one of ${p.actions}`,
  'error.infusionAction': () => 'action must be next or done',
  'error.noNextInfusion': () => 'No further infusion pending',
  'error.setupBusy': () => 'A setup is already running',
  // Recipe validation
  'recipe.notObject': () => 'Recipe must be an object',
  'recipe.nameMissing': () => 'name is missing',
  'recipe.nameTooLong': (p) => `name may be at most ${p.max} characters long`,
  'recipe.notInteger': (p) => `${p.key} must be a whole number`,
  'recipe.outOfRange': (p) => `${p.key} must be between ${p.min} and ${p.max} ${p.unit}`,
  'recipe.infusionsList': (p) => `infusions must be a list of at most ${p.max} further infusions`,
  'recipe.infusionInvalid': (p) => `Infusion ${p.number}: ${p.key} must be a whole number between ${p.min} and ${p.max} ${p.unit}`,
  // Device setup
  'setup.qrFormat': () => 'QR code does not have the expected format (5 parts separated by colons)',
  'setup.pairingCode': () => 'Pairing code in the QR code is invalid. Please show the QR code again.',
  'setup.notObject': () => 'Request must be an object',
  'setup.fieldMissing': (p) => `${p.field} is missing`,
  'setup.fieldAscii': (p) => `${p.field} contains umlauts or special characters. The Freemial protocol only transfers ASCII correctly.`,
  'setup.fieldLength': (p) => `${p.field} must be ${p.min}–${p.max} characters long`,
  'setup.baseHost': () => 'Server address must look like http://192.168.178.20:3000 (no path)',
  'setup.securityType': () => 'Unknown security type',
  'setup.ssidNotVisible': (p) => `The Temial cannot see the Wi-Fi “${p.ssid}”. For hidden networks, choose the security type.`,
  'setup.unreachable': (p) => `Temial not reachable. Is this computer connected to the Wi-Fi “${p.hotspot}”?`,
  'setup.notUnderstood': () => 'The Temial did not understand the request. Please show the QR code again.',
  'setup.closed': () => 'The Temial closed the connection. Usually the QR code is no longer valid – please show it again.',
  'setup.timeout': () => 'No answer from the Temial (timeout)',
  'setup.sendFailed': (p) => `Sending failed: ${p.reason}`,
  'setup.field.ssid': () => 'Wi-Fi name',
  'setup.field.key': () => 'Wi-Fi password',
  'setup.field.baseHost': () => 'Server address',
  'step.connecting': (p) => `Connecting to the Temial at ${p.target} …`,
  'step.connected': () => 'Connected',
  'step.serialMatches': (p) => `Serial number ${p.serial} matches the QR code`,
  'step.serialMismatch': (p) => `Warning: device reports serial number ${p.serial}`,
  'step.scanning': () => 'Temial is looking for Wi-Fi networks (up to 30 seconds) …',
  'step.networksFound': (p) => `${p.count} Wi-Fi network(s) found`,
  'step.sending': (p) => `Sending Wi-Fi “${p.ssid}” and server ${p.baseHost} …`,
  'step.confirmed': () => 'Temial confirmed the configuration',
  'step.received': () => 'Temial received the configuration',
  'step.switching': () => 'Configuration sent, Temial is switching to the Wi-Fi',
  'step.error': (p) => `Error: ${p.message}`,
  // Console
  'console.running': (p) => `Temial Control is running on port ${p.port}`,
  'console.baseHost': (p) => `  baseHost for the Temial: ${p.url}`,
  'console.token': () => '  API is protected by APP_TOKEN',
} satisfies Messages

export type MessageKey = keyof typeof en

const de: Record<MessageKey, (p: Params) => string> = {
  'error.notFound': () => 'Nicht gefunden',
  'error.unauthorized': () => 'Token fehlt oder ist falsch',
  'error.internal': () => 'Interner Fehler',
  'error.bodyTooLarge': () => 'Anfrage zu groß',
  'error.invalidJson': () => 'Ungültiges JSON',
  'error.deviceUnknown': () => 'Gerät unbekannt',
  'error.deviceOffline': () => 'Gerät ist nicht verbunden',
  'error.presetUnknown': () => 'Preset unbekannt',
  'error.startInSeconds': (p) => `startInSeconds muss zwischen 0 und ${p.max} liegen`,
  'error.color': () => 'color muss wie #5aa846 aussehen',
  'error.colorOrNull': () => 'Farbe muss wie #5aa846 aussehen (oder null für automatisch)',
  'error.action': (p) => `action muss eins von ${p.actions} sein`,
  'error.infusionAction': () => 'action muss next oder done sein',
  'error.noNextInfusion': () => 'Kein weiterer Aufguss offen',
  'error.setupBusy': () => 'Es läuft bereits eine Einrichtung',
  'recipe.notObject': () => 'Rezept muss ein Objekt sein',
  'recipe.nameMissing': () => 'name fehlt',
  'recipe.nameTooLong': (p) => `name darf höchstens ${p.max} Zeichen lang sein`,
  'recipe.notInteger': (p) => `${p.key} muss eine ganze Zahl sein`,
  'recipe.outOfRange': (p) => `${p.key} muss zwischen ${p.min} und ${p.max} ${p.unit} liegen`,
  'recipe.infusionsList': (p) => `infusions muss eine Liste mit höchstens ${p.max} weiteren Aufgüssen sein`,
  'recipe.infusionInvalid': (p) => `${p.number}. Aufguss: ${p.key} muss eine ganze Zahl zwischen ${p.min} und ${p.max} ${p.unit} sein`,
  'setup.qrFormat': () => 'QR-Code hat nicht das erwartete Format (5 Teile, getrennt durch Doppelpunkte)',
  'setup.pairingCode': () => 'Pairing-Code im QR-Code ist ungültig. QR-Code bitte neu anzeigen lassen.',
  'setup.notObject': () => 'Anfrage muss ein Objekt sein',
  'setup.fieldMissing': (p) => `${p.field} fehlt`,
  'setup.fieldAscii': (p) => `${p.field} enthält Umlaute oder Sonderzeichen. Das Freemial-Protokoll überträgt nur ASCII korrekt.`,
  'setup.fieldLength': (p) => `${p.field} muss ${p.min}–${p.max} Zeichen lang sein`,
  'setup.baseHost': () => 'Server-Adresse muss wie http://192.168.178.20:3000 aussehen (ohne Pfad)',
  'setup.securityType': () => 'Unbekannter Sicherheitstyp',
  'setup.ssidNotVisible': (p) => `Die Temial sieht das WLAN „${p.ssid}“ nicht. Bei versteckten Netzen den Sicherheitstyp angeben.`,
  'setup.unreachable': (p) => `Temial nicht erreichbar. Ist dieser Rechner mit dem WLAN „${p.hotspot}“ verbunden?`,
  'setup.notUnderstood': () => 'Die Temial hat die Anfrage nicht verstanden. QR-Code neu anzeigen lassen.',
  'setup.closed': () => 'Die Temial hat die Verbindung beendet. Meist passt der QR-Code nicht mehr. Bitte neu anzeigen lassen.',
  'setup.timeout': () => 'Keine Antwort der Temial (Zeitüberschreitung)',
  'setup.sendFailed': (p) => `Senden fehlgeschlagen: ${p.reason}`,
  'setup.field.ssid': () => 'WLAN-Name',
  'setup.field.key': () => 'WLAN-Passwort',
  'setup.field.baseHost': () => 'Server-Adresse',
  'step.connecting': (p) => `Verbinde mit der Temial unter ${p.target} …`,
  'step.connected': () => 'Verbunden',
  'step.serialMatches': (p) => `Seriennummer ${p.serial} passt zum QR-Code`,
  'step.serialMismatch': (p) => `Achtung: Gerät meldet Seriennummer ${p.serial}`,
  'step.scanning': () => 'Temial sucht WLANs (bis zu 30 Sekunden) …',
  'step.networksFound': (p) => `${p.count} WLAN(s) gefunden`,
  'step.sending': (p) => `Sende WLAN „${p.ssid}“ und Server ${p.baseHost} …`,
  'step.confirmed': () => 'Temial hat die Konfiguration bestätigt',
  'step.received': () => 'Temial hat die Konfiguration empfangen',
  'step.switching': () => 'Konfiguration gesendet, Temial wechselt ins WLAN',
  'step.error': (p) => `Fehler: ${p.message}`,
  'console.running': (p) => `Temial Control läuft auf Port ${p.port}`,
  'console.baseHost': (p) => `  baseHost für die Temial: ${p.url}`,
  'console.token': () => '  API ist per APP_TOKEN geschützt',
}

const CATALOGUE: Record<Lang, Record<MessageKey, (p: Params) => string>> = { en, de }

export type Translate = (key: MessageKey, params?: Params) => string

export function translator(lang: Lang): Translate {
  return (key, params = {}) => CATALOGUE[lang][key](params)
}

export function parseLang(value: string | undefined | null): Lang | undefined {
  const code = value?.trim().slice(0, 2).toLowerCase()
  return LANGUAGES.find((lang) => lang === code)
}

/** Explicit X-Language header (sent by the dashboard), then Accept-Language, then the default. */
export function requestLang(req: IncomingMessage, fallback: Lang): Lang {
  const explicit = parseLang(req.headers['x-language'] as string | undefined)
  if (explicit) return explicit
  for (const part of (req.headers['accept-language'] ?? '').split(',')) {
    const lang = parseLang(part.split(';')[0])
    if (lang) return lang
  }
  return fallback
}
