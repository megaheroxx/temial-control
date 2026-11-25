import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bindStatusMessage, brewTeaMessage, parseDeviceMessage, remoteTeaMessage } from '../src/protocol.ts'
import { validateRecipe } from '../src/validation.ts'

test('parseDeviceMessage extracts op and serial number', () => {
  const parsed = parseDeviceMessage(JSON.stringify({ op: 'deviceStatus', senderId: 'device://12345', content: { lidClosed: true } }))
  assert.deepEqual(parsed, { op: 'deviceStatus', serialNumber: '12345', content: { lidClosed: true } })
})

test('parseDeviceMessage rejects invalid frames', () => {
  assert.equal(parseDeviceMessage('not json'), null)
  assert.equal(parseDeviceMessage('null'), null)
  assert.equal(parseDeviceMessage(JSON.stringify({ op: 'x' })), null)
  assert.equal(parseDeviceMessage(JSON.stringify({ op: 'x', senderId: 'nope' })), null)
})

test('brewTeaMessage addresses the device and carries the recipe', () => {
  const recipe = { name: 'Sencha', temperature: 80, duration: 120, volume: 300, preWashTime: 0 }
  const message = brewTeaMessage('12345', recipe)
  assert.equal(message.op, 'brewTea')
  assert.equal(message.receiverId, 'device://12345')
  assert.equal(message.senderId, 'broker://device')
  assert.equal(message.durable, true)
  assert.partialDeepStrictEqual(message.content, { ...recipe, teaId: -20, startInSeconds: 10 })
})

test('remoteTeaMessage carries the brew action like the original app', () => {
  const message = remoteTeaMessage('12345', 'cancel')
  assert.equal(message.op, 'remoteTea')
  assert.equal(message.receiverId, 'device://12345')
  assert.deepEqual(message.content, { action: 'cancel', userId: 0 })
})

test('bindStatusMessage confirms the pairing code', () => {
  const message = bindStatusMessage('12345', 'ABCD', 'BOUND')
  assert.equal(message.op, 'bindingStatus')
  assert.partialDeepStrictEqual(message.content, { deviceId: '12345', code: 'ABCD', state: 'BOUND' })
})

test('validateRecipe accepts a valid recipe and trims the name', () => {
  const result = validateRecipe({ name: '  Sencha ', temperature: 80, duration: 120, volume: 300, preWashTime: 0, extra: 1 })
  assert.deepEqual(result, { ok: true, recipe: { name: 'Sencha', temperature: 80, duration: 120, volume: 300, preWashTime: 0 } })
})

test('validateRecipe reports every problem', () => {
  const result = validateRecipe({ name: '', temperature: 120, duration: 1.5, volume: '300' })
  assert.equal(result.ok, false)
  assert.equal(!result.ok && result.errors.length, 5)
})
