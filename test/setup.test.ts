import assert from 'node:assert/strict'
import { createCipheriv, createDecipheriv } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type AddressInfo, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, test } from 'node:test'
import { createApp } from '../src/app.ts'
import { translator } from '../src/i18n.ts'
import { DeviceSetup, validateConfigure } from '../src/setup.ts'

const SERIAL = '2104118837'
const PAIRING = 'abcdefghijklmnopqrstuvwxyz012345'
const QR = `1:${SERIAL}:0:DE:${PAIRING}`
const NETWORKS = [
  { ssid: 'Nachbar', securityType: 3, signalStrength: 40 },
  { ssid: 'Heimnetz', securityType: 4, signalStrength: 80 },
]

type ReceivedConfig = { ssid: string, securityType: number, key: string, baseHost: string }

/** Simulates the Temial hotspot protocol (AES-256-CTR, frames as documented by Freemial). */
class FakeTemial {
  server: Server
  configs: ReceivedConfig[] = []
  /** What to do after receiving the Wi-Fi config. */
  onConfig: 'confirm' | 'disconnect' = 'confirm'

  constructor() {
    this.server = createServer((socket) => {
      const iv = Buffer.alloc(16)
      const decipher = createDecipheriv('aes-256-ctr', Buffer.from(PAIRING), iv)
      const cipher = createCipheriv('aes-256-ctr', Buffer.from(PAIRING), iv)
      const reply = (type: number, payload: Buffer) =>
        socket.write(cipher.update(Buffer.concat([Buffer.from([0, 0, type, payload.length, 0]), payload])))

      socket.on('data', (data) => {
        const frame = decipher.update(data)
        assert.equal(frame.subarray(0, 2).toString(), 'CT')

        switch (frame[2]) {
          case 1: {
            const payload = Buffer.alloc(8)
            payload.writeBigInt64LE(BigInt(SERIAL))
            return reply(2, payload)
          }
          case 3: {
            const chunks = NETWORKS.map((network) => {
              const chunk = Buffer.alloc(36)
              chunk[1] = network.ssid.length
              chunk.write(network.ssid, 2)
              chunk[34] = network.securityType
              chunk[35] = network.signalStrength
              return chunk
            })
            return reply(4, Buffer.concat([Buffer.from([0]), ...chunks]))
          }
          case 5: {
            this.configs.push({
              ssid: frame.subarray(6, 6 + frame[5]).toString(),
              securityType: frame[38],
              key: frame.subarray(40, 40 + frame[39]).toString(),
              baseHost: frame.subarray(105, 105 + frame[104]).toString(),
            })
            if (this.onConfig === 'disconnect') return socket.destroy()
            return reply(6, Buffer.from([1]))
          }
        }
      })
    })
  }

  get port() {
    return (this.server.address() as AddressInfo).port
  }
}

const temial = new FakeTemial()
let app: Awaited<ReturnType<typeof createApp>>
let dataDir: string
let base: string

const post = (path: string, body: unknown) =>
  fetch(`${base}${path}`, { method: 'POST', body: JSON.stringify(body) })

before(async () => {
  temial.server.listen(0, '127.0.0.1')
  await once(temial.server, 'listening')

  dataDir = await mkdtemp(join(tmpdir(), 'temial-setup-'))
  app = await createApp({ dataDir, setupTarget: { host: '127.0.0.1', port: temial.port }, baseHost: 'http://10.0.0.5:3000' })
  app.server.listen(0, '127.0.0.1')
  await once(app.server, 'listening')
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
})

beforeEach(() => {
  temial.configs = []
  temial.onConfig = 'confirm'
})

after(async () => {
  await app.close()
  temial.server.close()
  await rm(dataDir, { recursive: true, force: true })
})

test('setup info suggests the configured baseHost', async () => {
  const info = await (await fetch(`${base}/api/setup`)).json()
  assert.deepEqual(info.baseHosts, ['http://10.0.0.5:3000'])
  assert.equal(info.securityTypes[4], 'WPA2MIXED')
  assert.equal(info.busy, false)
})

test('scan returns the networks seen by the device, strongest first', async () => {
  const res = await post('/api/setup/scan', { qr: QR })
  assert.equal(res.status, 200)
  const result = await res.json()
  assert.equal(result.serialNumber, SERIAL)
  assert.equal(result.serialMatches, true)
  assert.deepEqual(result.networks.map((n: { ssid: string }) => n.ssid), ['Heimnetz', 'Nachbar'])
})

test('configure sends Wi-Fi credentials and server address', async () => {
  const res = await post('/api/setup/configure', { qr: QR, ssid: 'Heimnetz', key: 'geheim123', baseHost: 'http://10.0.0.5:3000' })
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { serialNumber: SERIAL, confirmed: true })
  assert.deepEqual(temial.configs, [{ ssid: 'Heimnetz', securityType: 4, key: 'geheim123', baseHost: 'http://10.0.0.5:3000' }])

  const steps = app.hub.recentLog().filter((entry) => entry.type === 'setup').map((entry) => entry.detail)
  assert.ok(steps.includes('Temial confirmed the configuration'))
})

test('configure counts a disconnect after sending as success', async () => {
  temial.onConfig = 'disconnect'
  const res = await post('/api/setup/configure', { qr: QR, ssid: 'Heimnetz', key: 'geheim123', baseHost: 'http://10.0.0.5:3000' })
  assert.deepEqual(await res.json(), { serialNumber: SERIAL, confirmed: false })
  assert.equal(temial.configs.length, 1)
})

test('hidden networks need an explicit security type', async () => {
  const body = { qr: QR, ssid: 'Versteckt', key: 'geheim123', baseHost: 'http://10.0.0.5:3000' }
  const without = await post('/api/setup/configure', body)
  assert.equal(without.status, 400)
  assert.match((await without.json()).error, /cannot see the Wi-Fi “Versteckt”/)
  assert.equal(temial.configs.length, 0)

  const withType = await post('/api/setup/configure', { ...body, securityType: 3 })
  assert.equal(withType.status, 200)
  assert.equal(temial.configs[0].securityType, 3)
})

test('invalid setup requests are rejected before contacting the device', async () => {
  const valid = { qr: QR, ssid: 'Heimnetz', key: 'geheim123', baseHost: 'http://10.0.0.5:3000' }
  for (const [change, pattern] of [
    [{ qr: 'kein-qr' }, /format/],
    [{ qr: `1:${SERIAL}:0:DE:kurz` }, /Pairing code/],
    [{ ssid: 'Wohnzimmer-Ä' }, /umlauts/],
    [{ key: 'x'.repeat(64) }, /Wi-Fi password/],
    [{ baseHost: '10.0.0.5:3000' }, /Server address/],
    [{ baseHost: 'http://10.0.0.5:3000/pfad' }, /Server address/],
    [{ securityType: 9 }, /security type/],
  ] as const) {
    assert.throws(() => validateConfigure({ ...valid, ...change }), pattern)
  }
  const res = await post('/api/setup/configure', { ...valid, ssid: '' })
  assert.equal(res.status, 400)
  assert.equal(temial.configs.length, 0)
})

test('unreachable device names the hotspot to join', async () => {
  const closed = createServer()
  closed.listen(0, '127.0.0.1')
  await once(closed, 'listening')
  const port = (closed.address() as AddressInfo).port
  await new Promise((resolve) => closed.close(resolve))

  const setup = new DeviceSetup(() => {}, { host: '127.0.0.1', port })
  await assert.rejects(setup.scan(QR), /Wi-Fi “Temial-18837”/)
  assert.equal(setup.busy, false)
})

test('setup messages follow the requested language', async () => {
  const res = await fetch(`${base}/api/setup/configure`, {
    method: 'POST', headers: { 'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8' },
    body: JSON.stringify({ qr: QR, ssid: 'Wohnzimmer-Ä', key: 'x', baseHost: 'http://10.0.0.5:3000' }),
  })
  assert.match((await res.json()).error, /WLAN-Name enthält Umlaute/)
  const steps: string[] = []
  const setup = new DeviceSetup((_, step) => steps.push(step), { host: '127.0.0.1', port: temial.port })
  await setup.scan(QR, translator('de'))
  assert.ok(steps.includes(`Seriennummer ${SERIAL} passt zum QR-Code`))
})

test('only one setup runs at a time', async () => {
  const setup = new DeviceSetup(() => {}, { host: '127.0.0.1', port: temial.port })
  const first = setup.scan(QR)
  await assert.rejects(setup.scan(QR), /already running/)
  await first
})
