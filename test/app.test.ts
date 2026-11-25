import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { WebSocket } from 'ws'
import { createApp } from '../src/app.ts'

const SERIAL = '424242'
const TOKEN = 'secret-token'
const recipe = { name: 'Sencha', temperature: 80, duration: 120, volume: 300, preWashTime: 0 }

let app: Awaited<ReturnType<typeof createApp>>
let dataDir: string
let base: string
let device: WebSocket

const auth = { Authorization: `Bearer ${TOKEN}` }

function nextMessage(ws: WebSocket): Promise<any> {
  return once(ws, 'message').then(([data]) => JSON.parse(data.toString()))
}

function sendFromDevice(op: string, content: unknown) {
  device.send(JSON.stringify({ op, senderId: `device://${SERIAL}`, content }))
}

async function waitFor(check: () => boolean) {
  for (let i = 0; i < 50 && !check(); i++) await new Promise((r) => setTimeout(r, 10))
  assert.ok(check(), 'condition not reached')
}

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'temial-control-'))
  app = await createApp({ dataDir, token: TOKEN })
  app.server.listen(0, '127.0.0.1')
  await once(app.server, 'listening')
  const { port } = app.server.address() as AddressInfo
  base = `http://127.0.0.1:${port}`

  device = new WebSocket(`ws://127.0.0.1:${port}/?deviceId=${SERIAL}`)
  await once(device, 'open')
})

after(async () => {
  device.close()
  await app.close()
  await rm(dataDir, { recursive: true, force: true })
})

test('API rejects requests without the token', async () => {
  const res = await fetch(`${base}/api/devices`)
  assert.equal(res.status, 401)
  const wrong = await fetch(`${base}/api/devices`, { headers: { Authorization: 'Bearer wrong' } })
  assert.equal(wrong.status, 401)
})

test('dashboard is served without a token', async () => {
  const res = await fetch(`${base}/`)
  assert.equal(res.status, 200)
  assert.match(await res.text(), /Temial Control/)
  assert.equal((await fetch(`${base}/../package.json`)).status, 404)
})

test('bind request is answered with BOUND', async () => {
  const reply = nextMessage(device)
  sendFromDevice('bind', { serialNumber: SERIAL, code: 'PAIR1' })
  const message = await reply
  assert.equal(message.op, 'bindingStatus')
  assert.equal(message.content.state, 'BOUND')
  assert.equal(message.content.code, 'PAIR1')
})

test('device status shows up in the API', async () => {
  sendFromDevice('deviceStatus', { lidClosed: true, enoughFreshWater: false })
  await waitFor(() => app.hub.get(SERIAL)?.deviceStatus?.lidClosed === true)

  const res = await fetch(`${base}/api/devices`, { headers: auth })
  const [state] = await res.json()
  assert.equal(state.serialNumber, SERIAL)
  assert.equal(state.connected, true)
  assert.equal(state.deviceStatus.enoughFreshWater, false)
})

test('brew request is forwarded to the device', async () => {
  const received = nextMessage(device)
  const res = await fetch(`${base}/api/devices/${SERIAL}/brew`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify(recipe),
  })
  assert.equal(res.status, 202)
  const message = await received
  assert.equal(message.op, 'brewTea')
  assert.equal(message.receiverId, `device://${SERIAL}`)
  assert.partialDeepStrictEqual(message.content, recipe)
})

test('invalid brew requests are rejected', async () => {
  const post = (serial: string, body: string) => fetch(`${base}/api/devices/${serial}/brew`, { method: 'POST', headers: auth, body })
  assert.equal((await post(SERIAL, JSON.stringify({ ...recipe, temperature: 150 }))).status, 400)
  assert.equal((await post(SERIAL, '{broken')).status, 400)
  assert.equal((await post('unknown', JSON.stringify(recipe))).status, 404)
})

test('presets can be listed, added and removed', async () => {
  const list = async () => (await fetch(`${base}/api/presets`, { headers: auth })).json()
  const initial = await list()
  assert.ok(initial.length > 0, 'default presets are seeded')

  const created = await (await fetch(`${base}/api/presets`, { method: 'POST', headers: auth, body: JSON.stringify(recipe) })).json()
  assert.equal(created.name, 'Sencha')
  assert.equal((await list()).length, initial.length + 1)

  const del = await fetch(`${base}/api/presets/${created.id}`, { method: 'DELETE', headers: auth })
  assert.equal(del.status, 204)
  assert.equal((await list()).length, initial.length)
})

test('preset colour can be set and reset', async () => {
  const [preset] = await (await fetch(`${base}/api/presets`, { headers: auth })).json()
  const patch = (id: string, body: unknown) =>
    fetch(`${base}/api/presets/${id}`, { method: 'PATCH', headers: auth, body: JSON.stringify(body) })

  const coloured = await patch(preset.id, { color: '#8E4B8E' })
  assert.equal(coloured.status, 200)
  assert.equal((await coloured.json()).color, '#8E4B8E')
  const stored = (await (await fetch(`${base}/api/presets`, { headers: auth })).json())[0]
  assert.equal(stored.color, '#8E4B8E')

  assert.equal((await patch(preset.id, { color: 'lila' })).status, 400)
  assert.equal((await patch('unbekannt', { color: '#000000' })).status, 404)

  const reset = await (await patch(preset.id, { color: null })).json()
  assert.equal('color' in reset, false)
})

test('disconnect marks the device offline and brewing returns 409', async () => {
  device.close()
  await waitFor(() => app.hub.get(SERIAL)?.connected === false)
  const res = await fetch(`${base}/api/devices/${SERIAL}/brew`, { method: 'POST', headers: auth, body: JSON.stringify(recipe) })
  assert.equal(res.status, 409)
})
