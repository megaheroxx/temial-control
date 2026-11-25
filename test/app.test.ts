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

test('cancel, pause and resume are forwarded as remoteTea', async () => {
  for (const action of ['pause', 'resume', 'cancel']) {
    const received = nextMessage(device)
    const res = await fetch(`${base}/api/devices/${SERIAL}/control`, { method: 'POST', headers: auth, body: JSON.stringify({ action }) })
    assert.equal(res.status, 202)
    const message = await received
    assert.equal(message.op, 'remoteTea')
    assert.equal(message.receiverId, `device://${SERIAL}`)
    assert.deepEqual(message.content, { action, userId: 0 })
    assert.equal(app.hub.get(SERIAL)?.paused, action === 'pause')
  }
  const bad = await fetch(`${base}/api/devices/${SERIAL}/control`, { method: 'POST', headers: auth, body: JSON.stringify({ action: 'explode' }) })
  assert.equal(bad.status, 400)
})

test('brewingComplete ends the brew immediately', async () => {
  sendFromDevice('brewStatus', { remainingTotalTime: 90, temperature: 80 })
  await waitFor(() => app.hub.get(SERIAL)?.brewStatus?.remainingTotalTime === 90)
  sendFromDevice('brewingComplete', {})
  await waitFor(() => app.hub.get(SERIAL)?.brewStatus?.remainingTotalTime === 0)
  assert.ok(app.hub.recentLog().some((entry) => entry.type === 'brewingComplete'))
})

test('multiple infusions are brewed one after another', async () => {
  const multi = { ...recipe, preWashTime: 10, infusions: [{ temperature: 85, duration: 150 }, { temperature: 90, duration: 180 }] }
  const post = (path: string, body: unknown) =>
    fetch(`${base}/api/devices/${SERIAL}/${path}`, { method: 'POST', headers: auth, body: JSON.stringify(body) })

  let received = nextMessage(device)
  assert.equal((await post('brew', multi)).status, 202)
  let message = await received
  assert.partialDeepStrictEqual(message.content, { temperature: 80, duration: 120, preWashTime: 10, increment: 0, increments: 3 })
  assert.equal('infusions' in message.content, false, 'the device only gets single-infusion fields')
  assert.deepEqual(app.hub.get(SERIAL)?.session, { index: 0, total: 3, name: 'Sencha' })

  for (const [index, temperature, duration] of [[1, 85, 150], [2, 90, 180]]) {
    received = nextMessage(device)
    assert.equal((await post('infusion', { action: 'next' })).status, 202)
    message = await received
    assert.partialDeepStrictEqual(message.content, { name: 'Sencha', temperature, duration, volume: 300, preWashTime: 0, increment: index, increments: 3 })
  }
  assert.equal((await post('infusion', { action: 'next' })).status, 409, 'no fourth infusion')

  received = nextMessage(device)
  assert.equal((await post('infusion', { action: 'done' })).status, 202)
  message = await received
  assert.equal(message.op, 'remoteTea')
  assert.deepEqual(message.content, { action: 'done', userId: 0 })
  assert.equal(app.hub.get(SERIAL)?.session, null)

  // Cancelling ends a session as well.
  received = nextMessage(device); await post('brew', multi); await received
  received = nextMessage(device); await post('control', { action: 'cancel' }); await received
  assert.equal(app.hub.get(SERIAL)?.session, null)
  assert.equal((await post('infusion', { action: 'next' })).status, 409)
})

test('infusions are validated and stored with presets', async () => {
  const bad = await fetch(`${base}/api/presets`, {
    method: 'POST', headers: auth, body: JSON.stringify({ ...recipe, infusions: [{ temperature: 150, duration: 60 }] }),
  })
  assert.equal(bad.status, 400)
  assert.match((await bad.json()).error, /2\. Aufguss/)

  const created = await (await fetch(`${base}/api/presets`, {
    method: 'POST', headers: auth, body: JSON.stringify({ ...recipe, infusions: [{ temperature: 85, duration: 150 }] }),
  })).json()
  assert.deepEqual(created.infusions, [{ temperature: 85, duration: 150 }])
  const cleared = await (await fetch(`${base}/api/presets/${created.id}`, { method: 'PATCH', headers: auth, body: JSON.stringify({ infusions: [] }) })).json()
  assert.equal('infusions' in cleared, false)
  await fetch(`${base}/api/presets/${created.id}`, { method: 'DELETE', headers: auth })
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

test('preset values can be edited without touching the rest', async () => {
  const created = await (await fetch(`${base}/api/presets`, { method: 'POST', headers: auth, body: JSON.stringify(recipe) })).json()
  const patch = (body: unknown) =>
    fetch(`${base}/api/presets/${created.id}`, { method: 'PATCH', headers: auth, body: JSON.stringify(body) })

  await patch({ color: '#3f7fbf' })
  const edited = await patch({ name: 'Sencha kräftig', temperature: 85 })
  assert.equal(edited.status, 200)
  assert.deepEqual(await edited.json(), {
    id: created.id, name: 'Sencha kräftig', temperature: 85, duration: 120, volume: 300, preWashTime: 0, color: '#3f7fbf',
  })

  const invalid = await patch({ temperature: 150 })
  assert.equal(invalid.status, 400)
  const stored = (await (await fetch(`${base}/api/presets`, { headers: auth })).json()).find((p: { id: string }) => p.id === created.id)
  assert.equal(stored.temperature, 85, 'rejected update must not change the preset')

  await fetch(`${base}/api/presets/${created.id}`, { method: 'DELETE', headers: auth })
})

test('disconnect marks the device offline and brewing returns 409', async () => {
  device.close()
  await waitFor(() => app.hub.get(SERIAL)?.connected === false)
  const res = await fetch(`${base}/api/devices/${SERIAL}/brew`, { method: 'POST', headers: auth, body: JSON.stringify(recipe) })
  assert.equal(res.status, 409)
})
