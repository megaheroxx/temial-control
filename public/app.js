import { api, el, readToken } from './api.js'

const FIELDS = ['temperature', 'duration', 'volume', 'preWashTime']
const LOG_SIZE = 100
const RING_LENGTH = 2 * Math.PI * 52

const devices = new Map()
let presets = []

const $ = (selector, root = document) => root.querySelector(selector)
const form = $('#brew-form')
const message = $('#form-message')

// Static icons for the device screen (no user data inside).
const ICONS = {
  cup: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9h13v4a6 6 0 0 1-6 6h-1a6 6 0 0 1-6-6V9Z"/><path d="M17 10h1.5a2.5 2.5 0 0 1 0 5H17"/><path d="M8 3.5c0 1 1 1 1 2s-1 1-1 2M12 3.5c0 1 1 1 1 2s-1 1-1 2"/></svg>',
  alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5v.01"/></svg>',
  offline: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3 9a14 14 0 0 1 18 0M6 12.5a9 9 0 0 1 12 0M9 16a4 4 0 0 1 6 0"/><path d="M12 19.5v.01M4 4l16 16"/></svg>',
}

// Device conditions that block brewing, in the order the device would complain.
const PROBLEMS = [
  [(s) => !s.enoughFreshWater, 'Frischwasser auffüllen'],
  [(s) => s.wasteWaterTankFull, 'Abwassertank leeren'],
  [(s) => !s.wasteWaterTankPresent, 'Abwassertank einsetzen'],
  [(s) => !s.chamberPresent, 'Brühkammer einsetzen'],
  [(s) => !s.lidClosed, 'Deckel schließen'],
]

// --- Formatting -------------------------------------------------------------

const formatTime = (ms) => new Date(ms).toLocaleTimeString('de-DE')

// The device reports values like 72.19999 °C.
const formatTemperature = (value) => `${Math.round(Number(value))} °C`

function formatDuration(seconds) {
  const s = Math.max(0, Math.round(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

const FORMATTERS = {
  temperature: (v) => `${v} °C`,
  duration: (v) => `${formatDuration(v)} min`,
  volume: (v) => `${v} ml`,
  preWashTime: (v) => `${v} s`,
}

function teaColor(preset) {
  if (preset.color) return preset.color
  const name = preset.name.toLowerCase()
  if (/grün|green|sencha|matcha|gyokuro/.test(name)) return '#5aa846'
  if (/weiß|white/.test(name)) return '#d9c98c'
  if (/oolong/.test(name)) return '#c08a2d'
  if (/rooibos|früchte|frucht/.test(name)) return '#c4502f'
  if (/kräuter|minz|kamille|herbal|ingwer/.test(name)) return '#8bb04a'
  if (/schwarz|black|assam|earl|darjeeling|ceylon/.test(name)) return '#7a4326'
  return preset.temperature <= 80 ? '#5aa846' : preset.temperature <= 90 ? '#c08a2d' : '#7a4326'
}

// --- Devices ----------------------------------------------------------------

function isBrewing(state) {
  const brew = state.brewStatus
  return Boolean(brew && brew.remainingTotalTime > 0 && Date.now() - state.brewStatusAt < 60_000)
}

function renderDevices() {
  if (devices.size === 0) return
  $('#devices').replaceChildren(...[...devices.values()].map(renderDevice))
  renderDeviceSelect()
}

function renderScreen(card, state) {
  const screen = $('.screen', card)
  const status = state.deviceStatus
  const set = (kind, icon, title, text) => {
    screen.className = `screen ${kind}`
    $('.screen-icon', card).innerHTML = icon ? ICONS[icon] : ''
    $('.screen-title', card).textContent = title
    $('.screen-text', card).textContent = text
  }

  if (!state.connected) return set('offline', 'offline', 'Offline', 'Wartet auf Verbindung')

  if (isBrewing(state)) {
    const brew = state.brewStatus
    const total = brew.estimatedTimePrewash + brew.estimatedTimeHeating + brew.estimatedTimeBrewing
    const progress = total > 0 ? Math.min(1, Math.max(0, 1 - brew.remainingTotalTime / total)) : 0
    $('.screen-ring', card).hidden = false
    $('.ring-value', card).style.strokeDashoffset = String(RING_LENGTH * (1 - progress))
    $('.ring-time', card).textContent = formatDuration(brew.remainingTotalTime)
    return set('brewing', null, state.lastBrew?.name ?? 'Tee', formatTemperature(brew.temperature))
  }

  const problem = status && PROBLEMS.find(([check]) => check(status))
  if (problem) return set('problem', 'alert', problem[1], 'Danach kann gebrüht werden.')
  if (status) return set('ready', 'cup', 'Bereit', 'Wähle einen Tee')
  return set('ready', 'cup', 'Verbunden', 'Warte auf Status …')
}

function renderDevice(state) {
  const card = $('#device-template').content.firstElementChild.cloneNode(true)
  $('.device-name', card).textContent = 'Temial'
  $('.device-sub', card).textContent = `Seriennummer ${state.serialNumber}`

  const pill = $('.state', card)
  pill.textContent = state.connected ? 'Online' : 'Offline'
  pill.classList.add(state.connected ? 'online' : 'offline')

  renderScreen(card, state)

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

  if (state.connected && isBrewing(state)) {
    const brew = state.brewStatus
    const stats = [
      ['Tee', state.lastBrew?.name ?? (brew.teaId === -20 ? 'Eigener Tee' : `Tee Nr. ${brew.teaId}`)],
      ['Temperatur', formatTemperature(brew.temperature)],
      ['Gepumpt', `${Math.round(Number(brew.pumpedVolume))} ml`],
      ['Phase', String(brew.phase)],
    ]
    const actions = $('.brew-actions', card)
    actions.hidden = false
    const pause = $('.pause-button', card)
    pause.textContent = state.paused ? 'Fortsetzen' : 'Pausieren'
    pause.addEventListener('click', () => controlBrew(state.serialNumber, state.paused ? 'resume' : 'pause'))
    $('.cancel-button', card).addEventListener('click', () => {
      if (confirm('Brühvorgang wirklich abbrechen?')) controlBrew(state.serialNumber, 'cancel')
    })
    if (state.paused) $('.ring-caption', card).textContent = 'pausiert'

    const list = $('.brew-stats', card)
    list.hidden = false
    list.replaceChildren(...stats.map(([label, value]) => {
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

async function controlBrew(serialNumber, action) {
  try {
    await api(`/api/devices/${encodeURIComponent(serialNumber)}/control`, {
      method: 'POST',
      body: JSON.stringify({ action }),
    })
  } catch (err) {
    alert(err.message)
  }
}

function renderDeviceSelect() {
  const select = form.elements.device
  const current = select.value
  const online = [...devices.values()].filter((d) => d.connected)
  select.replaceChildren(...online.map((d) => el('option', { value: d.serialNumber }, `Temial ${d.serialNumber}`)))
  if (online.some((d) => d.serialNumber === current)) select.value = current
  $('.device-picker').hidden = online.length <= 1
  form.querySelector('[type=submit]').disabled = online.length === 0
}

// --- Presets ----------------------------------------------------------------

function renderPresets(selectedId = form.elements.preset.value) {
  const select = form.elements.preset
  select.replaceChildren(
    el('option', { value: '' }, 'eigenes Rezept'),
    ...presets.map((p) => el('option', { value: p.id }, p.name)),
  )
  select.value = presets.some((p) => p.id === selectedId) ? selectedId : ''

  const tile = (id, title, subtitle, color) => {
    const button = el('button', { type: 'button', className: 'tea-tile' })
    button.setAttribute('role', 'option')
    button.dataset.id = id
    const dot = el('span', { className: 'dot' })
    if (color) dot.style.setProperty('--tea', color)
    else button.classList.add('custom')
    button.append(dot, el('strong', {}, title), el('small', {}, subtitle))
    button.addEventListener('click', () => {
      select.value = id
      select.dispatchEvent(new Event('change'))
    })
    return button
  }

  $('#tea-tiles').replaceChildren(
    ...presets.map((p) => tile(p.id, p.name, `${p.temperature} °C · ${formatDuration(p.duration)} min · ${p.volume} ml`, teaColor(p))),
    tile('', 'Eigener Tee', 'Werte selbst wählen', null),
  )
  markSelectedTile()
}

function markSelectedTile() {
  const id = form.elements.preset.value
  for (const button of document.querySelectorAll('.tea-tile')) {
    button.setAttribute('aria-selected', String(button.dataset.id === id))
  }
  $('#delete-preset').hidden = !id
  renderColors()
}

// --- Preset colours ---------------------------------------------------------

const SWATCHES = ['#5aa846', '#8bb04a', '#d9c98c', '#c08a2d', '#7a4326', '#c4502f', '#8e4b8e', '#3f7fbf']

function renderColors() {
  const preset = presets.find((p) => p.id === form.elements.preset.value)
  $('#tea-colors').hidden = !preset
  if (!preset) return

  const swatch = (label, color, value) => {
    const button = el('button', { type: 'button', className: 'swatch', title: label })
    button.setAttribute('role', 'radio')
    button.setAttribute('aria-label', label)
    button.setAttribute('aria-checked', String((preset.color ?? null) === value))
    if (color) button.style.setProperty('--swatch', color)
    else button.classList.add('auto')
    button.addEventListener('click', () => setPresetColor(preset, value))
    return button
  }

  const custom = el('label', { className: 'swatch custom', title: 'Eigene Farbe' })
  const isCustom = preset.color && !SWATCHES.includes(preset.color.toLowerCase())
  custom.setAttribute('aria-checked', String(Boolean(isCustom)))
  if (isCustom) custom.style.setProperty('--swatch', preset.color)
  const picker = el('input', { type: 'color', value: preset.color ?? teaColor(preset) })
  picker.setAttribute('aria-label', 'Eigene Farbe wählen')
  picker.addEventListener('change', () => setPresetColor(preset, picker.value))
  custom.append(picker)

  $('#swatches').replaceChildren(
    swatch('Automatisch', null, null),
    ...SWATCHES.map((color) => swatch(color, color, color)),
    custom,
  )
}

async function setPresetColor(preset, color) {
  try {
    const updated = await api(`/api/presets/${encodeURIComponent(preset.id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ color }),
    })
    presets = presets.map((p) => (p.id === updated.id ? updated : p))
    renderPresets(updated.id)
  } catch (err) {
    showMessage(err.message, 'error')
  }
}

const valueInput = (field) => $(`.slider-value[data-for="${field}"]`)

function updateOutputs() {
  for (const field of FIELDS) {
    const input = valueInput(field)
    // Do not overwrite a value the user is typing.
    if (input !== document.activeElement) input.value = FORMATTERS[field](form.elements[field].value)
  }
}

// --- Typed values next to the sliders ---------------------------------------

function parseInteger(text) {
  const value = Number.parseInt(text.replace(/[^\d]/g, ''), 10)
  return Number.isFinite(value) ? value : null
}

/** "2" → 2 min, "2,5" → 2:30, "2:30" → 2:30; returns seconds. */
function parseMinutes(text) {
  const clock = text.trim().match(/^(\d+):(\d{1,2})/)
  if (clock) return Number(clock[1]) * 60 + Number(clock[2])
  const minutes = Number.parseFloat(text.replace(',', '.').replace(/[^\d.]/g, ''))
  return Number.isFinite(minutes) ? Math.round(minutes * 60) : null
}

const EDITORS = {
  temperature: { toText: String, parse: parseInteger },
  duration: { toText: (s) => (s / 60).toLocaleString('de-DE', { maximumFractionDigits: 2 }), parse: parseMinutes },
  volume: { toText: String, parse: parseInteger },
  preWashTime: { toText: String, parse: parseInteger },
}

for (const field of FIELDS) {
  const input = valueInput(field)
  const slider = form.elements[field]
  // Range inputs clamp to min/max on their own.
  const apply = () => {
    const value = EDITORS[field].parse(input.value)
    if (value !== null) slider.value = String(value)
  }
  input.addEventListener('focus', () => {
    input.value = EDITORS[field].toText(Number(slider.value))
    input.select()
  })
  input.addEventListener('input', (event) => {
    event.stopPropagation()
    apply()
  })
  input.addEventListener('keydown', (event) => {
    // Enter would otherwise submit the form and start brewing.
    if (event.key === 'Enter') {
      event.preventDefault()
      input.blur()
    }
  })
  input.addEventListener('blur', () => {
    apply()
    updateOutputs()
  })
}

// --- Log & messages ---------------------------------------------------------

function addLog(entry) {
  const item = el('li')
  const text = entry.type === 'setup' ? `Einrichtung: ${entry.detail}` : entry.type
  item.append(el('time', {}, formatTime(entry.time)), `${entry.serialNumber}  ${text}`)
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

form.addEventListener('input', updateOutputs)

form.elements.preset.addEventListener('change', () => {
  markSelectedTile()
  const preset = presets.find((p) => p.id === form.elements.preset.value)
  if (!preset) return
  form.elements.name.value = preset.name
  for (const field of FIELDS) form.elements[field].value = preset[field]
  updateOutputs()
})

form.addEventListener('submit', async (event) => {
  event.preventDefault()
  const serial = form.elements.device.value
  try {
    await api(`/api/devices/${encodeURIComponent(serial)}/brew`, {
      method: 'POST',
      body: JSON.stringify(readRecipe()),
    })
    showMessage(`„${readRecipe().name}“ wird zubereitet.`, 'success')
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
    pill.textContent = 'Live'
    pill.className = 'status-pill online'
  })
  source.addEventListener('error', () => {
    pill.textContent = 'Getrennt'
    pill.className = 'status-pill offline'
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
  source.addEventListener('log', (event) => {
    const entry = JSON.parse(event.data)
    addLog(entry)
    // setup.js shows the setup progress next to the form.
    document.dispatchEvent(new CustomEvent('temial:log', { detail: entry }))
  })
}

async function init() {
  // Inside the Android app the native settings screen is reachable from the app bar.
  if (navigator.userAgent.includes('TemialControlApp/')) {
    $('#app-settings').hidden = false
    $('#app-setup').hidden = false
  }
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
  updateOutputs()
  renderDeviceSelect()
  connectEvents()
  // Re-render periodically so stale brew progress disappears.
  setInterval(renderDevices, 15_000)
}

init()
