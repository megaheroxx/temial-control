import { api, el } from './api.js'
import { t } from './i18n.js'

const $ = (selector) => document.querySelector(selector)
const form = $('#setup-form')
const steps = $('#setup-steps')
const message = $('#setup-message')
const video = $('#qr-video')

let securityTypes = []
let running = false
let cameraStream = null

// --- QR code ----------------------------------------------------------------

function parseQR(value) {
  const parts = value.trim().split(':')
  if (parts.length !== 5 || parts.some((part) => !part)) return null
  return { serialNumber: parts[1] }
}

function updateQRInfo() {
  const parsed = parseQR(form.elements.qr.value)
  const hotspot = parsed ? `Temial-${parsed.serialNumber.slice(-5)}` : 'Temial-xxxxx'
  $('#hotspot').textContent = hotspot
  $('#qr-info').textContent = form.elements.qr.value.trim() === ''
    ? ''
    : parsed
      ? t('setup.qrInfo', { serial: parsed.serialNumber, hotspot })
      : t('setup.qrInvalid')
}

function setQR(value) {
  form.elements.qr.value = value
  updateQRInfo()
}

let jsQRLoaded = null
function loadJsQR() {
  jsQRLoaded ??= new Promise((resolve, reject) => {
    const script = el('script', { src: '/vendor/jsQR.js' })
    script.onload = () => resolve(window.jsQR)
    script.onerror = () => reject(new Error(t('setup.qrLoadFailed')))
    document.head.append(script)
  })
  return jsQRLoaded
}

function decode(jsQR, source, width, height) {
  const scale = Math.min(1, 1600 / Math.max(width, height))
  const canvas = el('canvas', { width: Math.round(width * scale), height: Math.round(height * scale) })
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height)
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
  return jsQR(data, canvas.width, canvas.height)?.data ?? null
}

$('#qr-photo').addEventListener('change', async (event) => {
  const file = event.target.files[0]
  event.target.value = ''
  if (!file) return
  try {
    const jsQR = await loadJsQR()
    const bitmap = await createImageBitmap(file)
    const value = decode(jsQR, bitmap, bitmap.width, bitmap.height)
    if (!value) throw new Error(t('setup.qrNotFound'))
    setQR(value)
    showMessage(t('setup.qrFound'), 'success')
  } catch (err) {
    showMessage(err.message, 'error')
  }
})

// Live camera only works in a secure context (https or localhost).
if (navigator.mediaDevices?.getUserMedia) $('#qr-camera').hidden = false

$('#qr-camera').addEventListener('click', async () => {
  if (cameraStream) return stopCamera()
  try {
    const jsQR = await loadJsQR()
    cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
    video.srcObject = cameraStream
    video.hidden = false
    await video.play()
    $('#qr-camera').textContent = t('setup.cameraStop')

    const scan = () => {
      if (!cameraStream) return
      const value = video.videoWidth ? decode(jsQR, video, video.videoWidth, video.videoHeight) : null
      if (value) {
        setQR(value)
        showMessage(t('setup.qrFound'), 'success')
        stopCamera()
      } else {
        setTimeout(scan, 250)
      }
    }
    scan()
  } catch (err) {
    stopCamera()
    showMessage(t('setup.cameraUnavailable', { reason: err.message }), 'error')
  }
})

function stopCamera() {
  cameraStream?.getTracks().forEach((track) => track.stop())
  cameraStream = null
  video.srcObject = null
  video.hidden = true
  $('#qr-camera').textContent = t('setup.camera')
}

form.elements.qr.addEventListener('input', updateQRInfo)

// --- Setup ------------------------------------------------------------------

function showMessage(text, kind = '') {
  message.textContent = text
  message.className = kind
}

// fetch() rejects with a TypeError ("Failed to fetch", "NetworkError …", "Load failed") when the server is unreachable.
function showSetupError(err) {
  if (!(err instanceof TypeError)) return showMessage(err.message, 'error')
  message.className = 'error'
  message.replaceChildren(
    t('setup.lostServer'),
    navigator.userAgent.includes('TemialControlApp/')
      ? el('a', { href: 'app://setup', className: 'button primary' }, t('setup.lostServerApp'))
      : t('setup.lostServerHint'),
  )
}

function setRunning(value) {
  running = value
  for (const button of form.querySelectorAll('button')) button.disabled = value
  if (value) {
    steps.replaceChildren()
    showMessage('')
  }
}

document.addEventListener('temial:log', (event) => {
  if (running && event.detail.type === 'setup') steps.append(el('li', {}, event.detail.detail))
})

function fillNetworks(networks) {
  $('#ssid-list').replaceChildren(...networks.map((network) =>
    el('option', { value: network.ssid }, `${securityTypes[network.securityType] ?? '?'}, Signal ${network.signalStrength}`)))
  if (!form.elements.ssid.value && networks[0]) form.elements.ssid.value = networks[0].ssid
}

$('#setup-scan').addEventListener('click', async () => {
  if (!form.elements.qr.reportValidity()) return
  setRunning(true)
  try {
    const result = await api('/api/setup/scan', { method: 'POST', body: JSON.stringify({ qr: form.elements.qr.value }) })
    fillNetworks(result.networks)
    showMessage(t('setup.networksFound', { count: result.networks.length }), 'success')
  } catch (err) {
    showSetupError(err)
  } finally {
    setRunning(false)
  }
})

form.addEventListener('submit', async (event) => {
  event.preventDefault()
  const securityType = form.elements.securityType.value
  setRunning(true)
  try {
    const result = await api('/api/setup/configure', {
      method: 'POST',
      body: JSON.stringify({
        qr: form.elements.qr.value,
        ssid: form.elements.ssid.value,
        key: form.elements.key.value,
        baseHost: form.elements.baseHost.value,
        securityType: securityType === '' ? null : Number(securityType),
      }),
    })
    form.elements.key.value = ''
    showMessage(
      t(result.confirmed ? 'setup.done' : 'setup.sent') + t('setup.reconnect'),
      'success',
    )
  } catch (err) {
    showSetupError(err)
  } finally {
    setRunning(false)
  }
})

async function init() {
  try {
    const info = await api('/api/setup')
    securityTypes = info.securityTypes
    form.elements.securityType.append(...securityTypes.map((name, value) => el('option', { value }, name)))
    $('#basehost-list').replaceChildren(...info.baseHosts.map((value) => el('option', { value })))
    if (!form.elements.baseHost.value && info.baseHosts[0]) form.elements.baseHost.value = info.baseHosts[0]
  } catch (err) {
    showMessage(err.message, 'error')
  }
  if (location.hash === '#setup') $('#setup details').open = true
  document.querySelector('a[href="#setup"]')?.addEventListener('click', () => { $('#setup details').open = true })
}

init()
