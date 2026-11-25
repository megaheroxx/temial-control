import { api, el, readToken } from './api.js'
import { lang, locale, setLang, t, translatePage } from './i18n.js'

const FIELDS = ['temperature', 'duration', 'volume', 'preWashTime']
const LOG_SIZE = 100
const RING_LENGTH = 2 * Math.PI * 52

const devices = new Map()
let presets = []
/** Infusions after the first one: [{ temperature, duration }]. */
let infusionSteps = []
const MAX_INFUSIONS = 5

const $ = (selector, root = document) => root.querySelector(selector)
const form = $('#brew-form')
const message = $('#form-message')

// Static icons for the device screen (no user data inside).
const ICONS = {
  cup: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9h13v4a6 6 0 0 1-6 6h-1a6 6 0 0 1-6-6V9Z"/><path d="M17 10h1.5a2.5 2.5 0 0 1 0 5H17"/><path d="M8 3.5c0 1 1 1 1 2s-1 1-1 2M12 3.5c0 1 1 1 1 2s-1 1-1 2"/></svg>',
  alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5v.01"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
  offline: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3 9a14 14 0 0 1 18 0M6 12.5a9 9 0 0 1 12 0M9 16a4 4 0 0 1 6 0"/><path d="M12 19.5v.01M4 4l16 16"/></svg>',
}

// Device conditions that block brewing, in the order the device would complain.
const PROBLEMS = [
  [(s) => !s.enoughFreshWater, 'problem.water'],
  [(s) => s.wasteWaterTankFull, 'problem.wasteFull'],
  [(s) => !s.wasteWaterTankPresent, 'problem.wasteMissing'],
  [(s) => !s.chamberPresent, 'problem.chamber'],
  [(s) => !s.lidClosed, 'problem.lid'],
]

// --- Formatting -------------------------------------------------------------

const formatTime = (ms) => new Date(ms).toLocaleTimeString(locale)
const formatClock = (ms) => new Date(ms).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })

/** "1 h 05 min" or "12 min". */
function formatCountdown(ms) {
  const minutes = Math.max(1, Math.round(ms / 60000))
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min` : `${minutes} min`
}

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

  if (!state.connected) return set('offline', 'offline', t('device.offline'), t('device.waiting'))

  if (isBrewing(state)) {
    const brew = state.brewStatus
    const total = brew.estimatedTimePrewash + brew.estimatedTimeHeating + brew.estimatedTimeBrewing
    const progress = total > 0 ? Math.min(1, Math.max(0, 1 - brew.remainingTotalTime / total)) : 0
    $('.screen-ring', card).hidden = false
    $('.ring-value', card).style.strokeDashoffset = String(RING_LENGTH * (1 - progress))
    $('.ring-time', card).textContent = formatDuration(brew.remainingTotalTime)
    return set('brewing', null, state.lastBrew?.name || t('device.tea'), formatTemperature(brew.temperature))
  }

  const problem = status && PROBLEMS.find(([check]) => check(status))
  if (problem) return set('problem', 'alert', t(problem[1]), t('device.thenBrew'))
  if (state.scheduled && state.scheduled.startsAt > Date.now()) {
    return set('ready', 'clock', t('device.scheduledTitle', { time: formatClock(state.scheduled.startsAt) }),
      t('device.scheduledText', { name: state.scheduled.name, countdown: formatCountdown(state.scheduled.startsAt - Date.now()) }))
  }
  if (state.session) {
    const { index, total } = state.session
    return set('ready', 'cup', t('device.infusionDoneTitle', { index: index + 1, total }), t(index + 1 < total ? 'device.nextReady' : 'device.enjoy'))
  }
  if (status) return set('ready', 'cup', t('device.ready'), t('device.chooseTea'))
  return set('ready', 'cup', t('device.connected'), t('device.waitingStatus'))
}

function renderDevice(state) {
  const card = $('#device-template').content.firstElementChild.cloneNode(true)
  translatePage(card)
  $('.device-name', card).textContent = t('device.name')
  $('.device-sub', card).textContent = t('device.serial', { serial: state.serialNumber })

  const pill = $('.state', card)
  pill.textContent = t(state.connected ? 'device.online' : 'device.offline')
  pill.classList.add(state.connected ? 'online' : 'offline')

  renderScreen(card, state)

  const status = state.deviceStatus
  if (status) {
    const checks = [
      [status.lidClosed, t('check.lid')],
      [status.chamberPresent, t('check.chamber')],
      [status.enoughFreshWater, t('check.water')],
      [status.wasteWaterTankPresent, t('check.wasteTank')],
      [!status.wasteWaterTankFull, t('check.wasteNotFull')],
    ]
    $('.checks', card).replaceChildren(
      ...checks.map(([ok, label]) => el('li', { className: ok ? 'ok' : 'bad' }, label)),
    )
  }

  if (state.connected && isBrewing(state)) {
    const brew = state.brewStatus
    const stats = [
      [t('device.tea'), state.lastBrew?.name || (brew.teaId === -20 || brew.teaId === -30 ? t('device.ownTea') : t('device.teaNumber', { id: brew.teaId }))],
      [t('device.temperature'), formatTemperature(brew.temperature)],
      [t('device.pumped'), `${Math.round(Number(brew.pumpedVolume))} ml`],
      [t('device.phase'), String(brew.phase)],
    ]
    const actions = $('.brew-actions', card)
    actions.hidden = false
    const pause = $('.pause-button', card)
    pause.textContent = t(state.paused ? 'device.resume' : 'device.pause')
    pause.addEventListener('click', () => controlBrew(state.serialNumber, state.paused ? 'resume' : 'pause'))
    $('.cancel-button', card).addEventListener('click', () => {
      if (confirm(t('device.confirmCancel'))) controlBrew(state.serialNumber, 'cancel')
    })
    if (state.session) $('.ring-caption', card).textContent = t('device.infusionOf', { index: state.session.index + 1, total: state.session.total })
    if (state.paused) $('.ring-caption', card).textContent = t('device.paused')

    const list = $('.brew-stats', card)
    list.hidden = false
    list.replaceChildren(...stats.map(([label, value]) => {
      const row = el('div')
      row.append(el('dt', {}, label), el('dd', {}, value))
      return row
    }))
  }

  if (state.connected && state.scheduled && state.scheduled.startsAt > Date.now() && !isBrewing(state)) {
    const box = $('.scheduled-box', card)
    box.hidden = false
    $('.scheduled-text', box).textContent = t('device.scheduledBox', { name: state.scheduled.name, time: formatClock(state.scheduled.startsAt) })
    $('.cancel-timer', box).addEventListener('click', () => {
      if (confirm(t('device.confirmCancelTimer'))) controlBrew(state.serialNumber, 'cancel')
    })
  }

  if (state.connected && state.session && !isBrewing(state)) {
    const { index, total } = state.session
    const box = $('.infusion-next', card)
    box.hidden = false
    const more = index + 1 < total
    $('.infusion-text', box).textContent = more
      ? t('device.infusionDoneBox', { name: state.session.name, index: index + 1, total })
      : t('device.allInfusionsDone', { name: state.session.name, total })
    const next = $('.next-infusion', box)
    next.hidden = !more
    next.textContent = t('device.startInfusion', { number: index + 2 })
    next.addEventListener('click', () => infusionAction(state.serialNumber, 'next'))
    $('.finish-infusions', box).addEventListener('click', () => infusionAction(state.serialNumber, 'done'))
  }

  const meta = []
  if (status?.softwareVersion) meta.push(t('device.firmware', { version: status.softwareVersion }))
  if (status?.WiFiSSID) meta.push(t('device.wifi', { ssid: status.WiFiSSID, signal: status.wiFiSignalStrength }))
  if (status?.waterHardness) meta.push(t('device.hardness', { value: status.waterHardness }))
  meta.push(t('device.lastSeen', { time: formatTime(state.lastSeen) }))
  $('.meta', card).textContent = meta.join(' · ')

  return card
}

async function infusionAction(serialNumber, action) {
  try {
    await api(`/api/devices/${encodeURIComponent(serialNumber)}/infusion`, { method: 'POST', body: JSON.stringify({ action }) })
  } catch (err) {
    alert(err.message)
  }
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
    el('option', { value: '' }, t('brew.customRecipe')),
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
    ...presets.map((p) => tile(p.id, p.name, `${p.temperature} °C · ${formatDuration(p.duration)} min · ${p.volume} ml`
      + (p.infusions?.length ? ` · ${t('brew.infusionsTile', { count: p.infusions.length + 1 })}` : ''), teaColor(p))),
    tile('', t('brew.ownTea'), t('brew.ownTeaHint'), null),
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
  updateDirty()
}

/** Shows "Update preset" while the form differs from the selected preset. */
function updateDirty() {
  const preset = presets.find((p) => p.id === form.elements.preset.value)
  const recipe = readRecipe()
  const dirty = Boolean(preset) && (['name', ...FIELDS].some((key) => recipe[key] !== preset[key])
    || JSON.stringify(recipe.infusions ?? []) !== JSON.stringify(preset.infusions ?? []))
  $('#update-preset').hidden = !dirty
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

  const custom = el('label', { className: 'swatch custom', title: t('brew.colourCustom') })
  const isCustom = preset.color && !SWATCHES.includes(preset.color.toLowerCase())
  custom.setAttribute('aria-checked', String(Boolean(isCustom)))
  if (isCustom) custom.style.setProperty('--swatch', preset.color)
  const picker = el('input', { type: 'color', value: preset.color ?? teaColor(preset) })
  picker.setAttribute('aria-label', t('brew.colourPick'))
  picker.addEventListener('change', () => setPresetColor(preset, picker.value))
  custom.append(picker)

  $('#swatches').replaceChildren(
    swatch(t('brew.colourAuto'), null, null),
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
    updateDirty()
  })
}

// --- Infusions --------------------------------------------------------------

function renderInfusions() {
  const total = infusionSteps.length + 1
  $('#infusion-count').replaceChildren(...Array.from({ length: MAX_INFUSIONS }, (_, i) => {
    const button = el('button', { type: 'button', className: 'segment' }, String(i + 1))
    button.setAttribute('role', 'radio')
    button.setAttribute('aria-checked', String(i + 1 === total))
    button.addEventListener('click', () => setInfusionCount(i + 1))
    return button
  }))

  $('#infusion-steps').replaceChildren(...infusionSteps.map((step, i) => {
    const row = el('div', { className: 'infusion-row' })
    const value = (key, label) => {
      const input = el('input', { className: 'slider-value', value: FORMATTERS[key](step[key]), inputMode: key === 'duration' ? 'decimal' : 'numeric' })
      input.setAttribute('aria-label', `${t('brew.infusionRow', { number: i + 2 })} ${label}`)
      input.addEventListener('focus', () => {
        input.value = EDITORS[key].toText(step[key])
        input.select()
      })
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          input.blur()
        }
      })
      input.addEventListener('input', (event) => event.stopPropagation())
      input.addEventListener('blur', () => {
        const parsed = EDITORS[key].parse(input.value)
        const { min, max } = form.elements[key]
        if (parsed !== null) step[key] = Math.min(Number(max), Math.max(Number(min), parsed))
        input.value = FORMATTERS[key](step[key])
        updateDirty()
      })
      return input
    }
    row.append(el('span', {}, t('brew.infusionRow', { number: i + 2 })), value('temperature', t('brew.temperature')), value('duration', t('brew.duration')))
    return row
  }))
}

/** Adds or removes infusions; new ones start like the previous one with 30 s more steeping time. */
function setInfusionCount(total) {
  while (infusionSteps.length + 1 < total) {
    const previous = infusionSteps.at(-1)
      ?? { temperature: Number(form.elements.temperature.value), duration: Number(form.elements.duration.value) }
    infusionSteps.push({ temperature: previous.temperature, duration: Math.min(1800, previous.duration + 30) })
  }
  infusionSteps.length = total - 1
  renderInfusions()
  updateDirty()
}

// --- Log & messages ---------------------------------------------------------

function addLog(entry) {
  const item = el('li')
  const text = entry.type === 'setup' ? t('log.setup', { detail: entry.detail }) : entry.type
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
  if (infusionSteps.length) recipe.infusions = infusionSteps.map((step) => ({ ...step }))
  return recipe
}

form.addEventListener('input', () => {
  updateOutputs()
  updateDirty()
})

form.elements.preset.addEventListener('change', () => {
  markSelectedTile()
  const preset = presets.find((p) => p.id === form.elements.preset.value)
  if (!preset) return
  form.elements.name.value = preset.name
  for (const field of FIELDS) form.elements[field].value = preset[field]
  infusionSteps = (preset.infusions ?? []).map((step) => ({ ...step }))
  renderInfusions()
  updateOutputs()
  updateDirty()
})

// --- Timer ------------------------------------------------------------------

let startLater = false

/** Next occurrence of the chosen clock time (today or tomorrow), or null. */
function plannedStart() {
  const [hours, minutes] = ($('#start-time').value || '').split(':').map(Number)
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null
  const start = new Date()
  start.setHours(hours, minutes, 0, 0)
  if (start.getTime() <= Date.now() + 60_000) start.setDate(start.getDate() + 1)
  return start.getTime()
}

function updateStart() {
  for (const button of document.querySelectorAll('[data-start]')) {
    button.setAttribute('aria-checked', String((button.dataset.start === 'later') === startLater))
  }
  $('#start-later').hidden = !startLater
  const start = startLater ? plannedStart() : null
  const tomorrow = start && new Date(start).getDate() !== new Date().getDate()
  $('#start-hint').textContent = start
    ? t('brew.startHint', { day: t(tomorrow ? 'brew.tomorrow' : 'brew.today'), time: formatClock(start), countdown: formatCountdown(start - Date.now()) })
    : ''
  form.querySelector('[type=submit]').textContent = start ? t('brew.planFor', { time: formatClock(start) }) : t('brew.brewNow')
}

for (const button of document.querySelectorAll('[data-start]')) {
  button.addEventListener('click', () => {
    startLater = button.dataset.start === 'later'
    if (startLater && !$('#start-time').value) {
      // Default: in 30 minutes, rounded up to 5 minutes.
      const soon = new Date(Date.now() + 30 * 60_000)
      soon.setMinutes(Math.ceil(soon.getMinutes() / 5) * 5, 0, 0)
      $('#start-time').value = formatClock(soon.getTime())
    }
    updateStart()
  })
}
$('#start-time').addEventListener('input', (event) => {
  event.stopPropagation()
  updateStart()
})
setInterval(updateStart, 30_000)

form.addEventListener('submit', async (event) => {
  event.preventDefault()
  const serial = form.elements.device.value
  const start = startLater ? plannedStart() : null
  if (startLater && !start) return showMessage(t('brew.chooseTime'), 'error')
  try {
    const body = readRecipe()
    if (start) body.startInSeconds = Math.round((start - Date.now()) / 1000)
    // A saved preset lets the Temial show its name and colour instead of "Manual tea".
    const preset = presets.find((p) => p.id === form.elements.preset.value)
    if (preset) {
      body.presetId = preset.id
      body.color = teaColor(preset)
    }
    await api(`/api/devices/${encodeURIComponent(serial)}/brew`, {
      method: 'POST',
      body: JSON.stringify(body),
    })
    showMessage(start ? t('brew.planned', { name: body.name, time: formatClock(start) }) : t('brew.brewing', { name: body.name }), 'success')
    if (start) {
      startLater = false
      updateStart()
    }
  } catch (err) {
    showMessage(err.message, 'error')
  }
})

$('#update-preset').addEventListener('click', async () => {
  const id = form.elements.preset.value
  // Only the name matters for a preset; the device picker may be empty while the Temial is offline.
  if (!id || !form.elements.name.reportValidity()) return
  try {
    const updated = await api(`/api/presets/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(readRecipe()) })
    presets = presets.map((p) => (p.id === updated.id ? updated : p))
    renderPresets(updated.id)
    showMessage(t('brew.presetUpdated', { name: updated.name }), 'success')
  } catch (err) {
    showMessage(err.message, 'error')
  }
})

$('#save-preset').addEventListener('click', async () => {
  if (!form.elements.name.reportValidity()) return
  try {
    const preset = await api('/api/presets', { method: 'POST', body: JSON.stringify(readRecipe()) })
    presets.push(preset)
    renderPresets(preset.id)
    showMessage(t('brew.presetSaved', { name: preset.name }), 'success')
  } catch (err) {
    showMessage(err.message, 'error')
  }
})

$('#delete-preset').addEventListener('click', async () => {
  const id = form.elements.preset.value
  const preset = presets.find((p) => p.id === id)
  if (!preset || !confirm(t('brew.confirmDelete', { name: preset.name }))) return
  try {
    await api(`/api/presets/${encodeURIComponent(id)}`, { method: 'DELETE' })
    presets = presets.filter((p) => p.id !== id)
    renderPresets('')
    showMessage(t('brew.presetDeleted', { name: preset.name }), 'success')
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
    pill.textContent = t('app.live')
    pill.className = 'status-pill online'
  })
  source.addEventListener('error', () => {
    pill.textContent = t('app.disconnected')
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

$('#language').addEventListener('click', () => setLang(lang === 'de' ? 'en' : 'de'))

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
  renderInfusions()
  renderDeviceSelect()
  connectEvents()
  // Re-render periodically so stale brew progress disappears.
  setInterval(renderDevices, 15_000)
}

init()
