// Device protocol of the former Temial cloud, as reverse-engineered by the Freemial project:
// https://github.com/freemial/freemial-ts (packages/freemial-server, AGPL-3.0-or-later).
// The envelope fields below are copied from that known-good reference implementation.

export type DeviceStatus = {
  lidClosed: boolean
  chamberPresent: boolean
  enoughFreshWater: boolean
  wasteWaterTankPresent: boolean
  wasteWaterTankFull: boolean
  positionElevator: number
  positionOutlet: number
  deviceState: number
  activityState: number
  remoteState: number
  descaling: number
  cleaningShort: number
  cleaningLong: number
  timer: number
  WiFiSSID: string
  wiFiSignalStrength: number
  filterUsed: boolean
  filterChange: number
  waterHardness: string
  softwareVersion: string
  hardwareVersion: string
  userId: number
}

export type BrewStatus = {
  temperature: number
  multibrew: number
  currentTimePrewash: number
  currentTimeHeating: number
  currentTimeBrewing: number
  pumpedVolume: number
  estimatedRemainingVolumeFreshWater: number
  teaId: number
  userId: number
  estimatedTimePrewash: number
  estimatedTimeHeating: number
  estimatedTimeBrewing: number
  remainingTotalTime: number
  phase: number
}

export type VersionInfo = Record<string, string>

export type BindContent = {
  serialNumber: string
  code: string
}

/** A brew recipe; units are seconds, °C and ml. */
/** Temperature and steeping time of an infusion after the first one. */
export type Infusion = {
  temperature: number
  duration: number
}

export type BrewRecipe = {
  name: string
  temperature: number
  duration: number
  volume: number
  preWashTime: number
  /** Further infusions of the same leaves (2nd, 3rd, …); volume stays, there is no pre-wash. */
  infusions?: Infusion[]
}

/** Position within a multi-infusion brew ("Aufguss index+1 von total"). */
export type InfusionStep = { index: number, total: number }

export type DeviceMessage = {
  op: string
  serialNumber: string
  content: unknown
}

/** Parses a raw frame sent by a Temial. Returns null for anything that is not a valid envelope. */
export function parseDeviceMessage(raw: string): DeviceMessage | null {
  let message: unknown
  try {
    message = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof message !== 'object' || message === null) return null

  const { op, senderId, content } = message as Record<string, unknown>
  if (typeof op !== 'string' || typeof senderId !== 'string') return null

  const serialNumber = senderId.split('://')[1]
  if (!serialNumber) return null

  return { op, serialNumber, content }
}

function envelope(deviceId: string, op: string, content: unknown, durable = true) {
  return {
    messageId: null,
    receiverId: 'device://' + deviceId,
    senderId: 'broker://device',
    clientId: null,
    mime: 'application/json',
    creationDate: Date.now(),
    dispatchDate: null,
    changeDate: null,
    timeout: 1800000,
    useCaseId: null,
    redelivered: 0,
    durable,
    async: false,
    messageStatus: 'Pending',
    destinationTopic: null,
    scheduledDelay: 0,
    softwareVersion: null,
    op,
    content,
  }
}

export function bindStatusMessage(deviceId: string, code: string, state: 'BOUND' | 'REQUESTED') {
  return envelope(deviceId, 'bindingStatus', {
    bindingId: 6805,
    deviceId,
    userId: null,
    state,
    changeDate: Date.now(),
    code,
    name: null,
    user: null,
  })
}

/**
 * Actions for a running brew. Names and message shape come from the original Vorwerk app
 * (RemoteTeaMessage / Device.Action); the cloud forwarded app messages to the device unchanged.
 */
export const BREW_ACTIONS = ['cancel', 'pause', 'resume'] as const
export type BrewAction = typeof BREW_ACTIONS[number]

/** "done" ends a multi-infusion session, as the original app did after the last infusion. */
export function remoteTeaMessage(deviceId: string, action: BrewAction | 'done') {
  // userId 0 matches the userId our brewTea messages use.
  return envelope(deviceId, 'remoteTea', { action, userId: 0 })
}

export function brewTeaMessage(deviceId: string, recipe: BrewRecipe, step: InfusionStep = { index: 0, total: 1 }) {
  // The device only knows the fields of a single infusion.
  const { infusions: _infusions, ...fields } = recipe
  return envelope(deviceId, 'brewTea', {
    ...fields,
    changeDate: Date.now(),
    color: '#b1b2b3',
    description: 'tea description',
    increment: step.index,
    increments: step.total,
    presetId: 0,
    qrCode: null,
    startInSeconds: 10,
    teaId: -20,
    timerId: 0,
    uniqueId: 123,
    userId: 0,
  })
}
