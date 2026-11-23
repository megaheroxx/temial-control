const TOKEN_KEY = 'temial-control-token'
const FIELDS = ['temperature', 'duration', 'volume', 'preWashTime']
const LOG_SIZE = 100

const devices = new Map()
let presets = []

const $ = (selector, root = document) => root.querySelector(selector)
const form = $('#brew-form')
const message = $('#form-message')

// --- API --------------------------------------------------------------------

function readToken() {
  try { return localStorage.getItem(TOKEN_KEY) || '' } catch { return '' }
}

function storeToken(value) {
  try { localStorage.setItem(TOKEN_KEY, value) } catch { /* private mode */ }
}

async function api(path, options = {}, retry = true) {
  const token = readToken()
  const res = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  })
  if (res.status === 401 && retry) {
    const entered = prompt('API-Token (APP_TOKEN) eingeben:')
    if (entered) {
      storeToken(entered)
      return api(path, options, false)
    }
  }
  if (res.status === 204) return null
  const body = await res.json()
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`)
  return body
}

// --- Rendering --------------------------------------------------------------

const formatTime = (ms) => new Date(ms).toLocaleTimeString('de-DE')

function formatDuration(seconds) {
  const s = Math.max(0, Math.round(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function el(tag, props = {}, text) {
  const node = Object.assign(document.createElement(tag), props)
  if (text !== undefined) node.textContent = text
  return node
}

function renderDevices() {
  const container = $('#devices')
  if (devices.size === 0) return

  container.replaceChildren(...[...devices.values()].map(renderDevice))
  renderDeviceSelect()
}

function renderDevice(state) {
  const card = $('#device-template').content.firstElementChild.cloneNode(true)
  $('.serial', card).textContent = `Temial ${state.serialNumber}`

  const pill = $('.state', card)
  pill.textContent = state.connected ? 'online' : 'offline'
  pill.classList.add(state.connected ? 'online' : 'offline')

  const status = state.deviceStatus
  if (status) {
    const checks = [
      [status.lidClosed, 'Deckel geschlossen'],
      [status.chamberPresent, 'Brühkammer eingesetzt'],
      [status.enoughFreshWater, 'Genug Frischwasser'],
      [status.wasteWaterTankPresent, 'Abwassertank eingesetzt'],
      [!status.wasteWaterTankFull, 'Abwassertank nicht voll'],
    ]
    $('.checks', card).replaceChildren(
      ...checks.map(([ok, label]) => el('li', { className: ok ? 'ok' : 'bad' }, label)),
    )
  }

  const brew = state.brewStatus
  if (brew && brew.remainingTotalTime > 0 && Date.now() - state.brewStatusAt < 60_000) {
    const total = brew.estimatedTimePrewash + brew.estimatedTimeHeating + brew.estimatedTimeBrewing
    const progress = total > 0 ? 1 - brew.remainingTotalTime / total : 0
    $('.brew', card).hidden = false
    $('.bar', card).style.width = `${Math.min(100, Math.max(0, progress * 100))}%`

    const stats = [
      ['Tee', state.lastBrew?.name ?? `#${brew.teaId}`],
      ['Temperatur', `${brew.temperature} °C`],
      ['Verbleibend', formatDuration(brew.remainingTotalTime)],
      ['Gepumpt', `${brew.pumpedVolume} ml`],
      ['Phase', String(brew.phase)],
    ]
    $('.brew-stats', card).replaceChildren(...stats.map(([label, value]) => {
      const row = el('div')
      row.append(el('dt', {}, label), el('dd', {}, value))
      return row
    }))
  }

  const meta = []
  if (status?.softwareVersion) meta.push(`Firmware ${status.softwareVersion}`)
  if (status?.WiFiSSID) meta.push(`WLAN ${status.WiFiSSID} (${status.wiFiSignalStrength})`)
  if (status?.waterHardness) meta.push(`Wasserhärte ${status.waterHardness}`)
  meta.push(`zuletzt gesehen ${formatTime(state.lastSeen)}`)
  $('.meta', card).textContent = meta.join(' · ')

  return card
}

function renderDeviceSelect() {
  const select = form.elements.device
  const current = select.value
  const online = [...devices.values()].filter((d) => d.connected)
  select.replaceChildren(...online.map((d) => el('option', { value: d.serialNumber }, d.serialNumber)))
  if (online.some((d) => d.serialNumber === current)) select.value = current
  form.querySelector('[type=submit]').disabled = online.length === 0
}

function renderPresets(selectedId = form.elements.preset.value) {
  const select = form.elements.preset
  select.replaceChildren(
    el('option', { value: '' }, '– eigenes Rezept –'),
    ...presets.map((p) => el('option', { value: p.id }, p.name)),
  )
  select.value = presets.some((p) => p.id === selectedId) ? selectedId : ''
  $('#delete-preset').hidden = !select.value
}

function addLog(entry) {
  const item = el('li')
  item.append(el('time', {}, formatTime(entry.time)), `${entry.serialNumber}  ${entry.type}`)
  const log = $('#log')
  log.prepend(item)
  while (log.children.length > LOG_SIZE) log.lastElementChild.remove()
}

function showMessage(text, kind) {
  message.textContent = text
  message.className = kind
}

// --- Form -------------------------------------------------------------------

function readRecipe() {
  const recipe = { name: form.elements.name.value.trim() }
  for (const field of FIELDS) recipe[field] = Number(form.elements[field].value)
  return recipe
}

form.elements.preset.addEventListener('change', () => {
  const preset = presets.find((p) => p.id === form.elements.preset.value)
  $('#delete-preset').hidden = !preset
  if (!preset) return
  form.elements.name.value = preset.name
  for (const field of FIELDS) form.elements[field].value = preset[field]
})

form.addEventListener('submit', async (event) => {
  event.preventDefault()
  const serial = form.elements.device.value
  try {
    await api(`/api/devices/${encodeURIComponent(serial)}/brew`, {
      method: 'POST',
      body: JSON.stringify(readRecipe()),
    })
    showMessage(`Brühbefehl an ${serial} gesendet.`, 'success')
  } catch (err) {
    showMessage(err.message, 'error')
  }
})

$('#save-preset').addEventListener('click', async () => {
  if (!form.reportValidity()) return
  try {
    const preset = await api('/api/presets', { method: 'POST', body: JSON.stringify(readRecipe()) })
    presets.push(preset)
    renderPresets(preset.id)
    showMessage(`Preset „${preset.name}“ gespeichert.`, 'success')
  } catch (err) {
    showMessage(err.message, 'error')
  }
})

$('#delete-preset').addEventListener('click', async () => {
  const id = form.elements.preset.value
  const preset = presets.find((p) => p.id === id)
  if (!preset || !confirm(`Preset „${preset.name}“ löschen?`)) return
  try {
    await api(`/api/presets/${encodeURIComponent(id)}`, { method: 'DELETE' })
    presets = presets.filter((p) => p.id !== id)
    renderPresets('')
    showMessage(`Preset „${preset.name}“ gelöscht.`, 'success')
  } catch (err) {
    showMessage(err.message, 'error')
  }
})

// --- Live updates -----------------------------------------------------------

function connectEvents() {
  const token = readToken()
  const source = new EventSource('/api/events' + (token ? `?token=${encodeURIComponent(token)}` : ''))
  const pill = $('#connection')

  source.addEventListener('open', () => {
    pill.textContent = 'live'
    pill.className = 'pill online'
  })
  source.addEventListener('error', () => {
    pill.textContent = 'getrennt – verbinde neu …'
    pill.className = 'pill offline'
  })
  source.addEventListener('snapshot', (event) => {
    const { devices: list, log } = JSON.parse(event.data)
    devices.clear()
    for (const state of list) devices.set(state.serialNumber, state)
    $('#log').replaceChildren()
    for (const entry of log) addLog(entry)
    renderDevices()
  })
  source.addEventListener('device', (event) => {
    const state = JSON.parse(event.data)
    devices.set(state.serialNumber, state)
    renderDevices()
  })
  source.addEventListener('log', (event) => addLog(JSON.parse(event.data)))
}

async function init() {
  try {
    // Also triggers the token prompt before the event stream opens.
    const { limits } = await api('/api/config')
    for (const field of FIELDS) {
      form.elements[field].min = limits[field].min
      form.elements[field].max = limits[field].max
    }
    presets = await api('/api/presets')
    renderPresets()
  } catch (err) {
    showMessage(err.message, 'error')
  }
  renderDeviceSelect()
  connectEvents()
  // Re-render periodically so stale brew progress disappears.
  setInterval(renderDevices, 15_000)
}

init()
