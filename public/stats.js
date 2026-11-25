import { api, el } from './api.js'
import { locale, t } from './i18n.js'

const $ = (selector) => document.querySelector(selector)
const WEEKDAYS = t('weekdays')
/** Log entries after which the numbers may have changed. */
const REFRESH_ON = new Set(['brewCommand', 'brewingComplete', 'brewControl', 'infusionsDone'])

const cups = (n) => t('stats.cups', { n })

function formatDuration(seconds) {
  const s = Math.max(0, Math.round(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function formatWhen(time) {
  const date = new Date(time)
  const clock = date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
  const today = new Date()
  if (date.toDateString() === today.toDateString()) return t('stats.atTime', { day: t('stats.todayShort'), time: clock })
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  if (date.toDateString() === yesterday.toDateString()) return t('stats.atTime', { day: t('stats.yesterday'), time: clock })
  return `${WEEKDAYS[date.getDay()]} ${date.toLocaleDateString(locale, { day: '2-digit', month: '2-digit' })} ${clock}`
}

function renderStats(stats) {
  $('#stat-today').textContent = stats.today
  $('#stat-week').textContent = stats.week
  $('#stat-total').textContent = stats.total
  $('#stat-liters').textContent = stats.liters.toLocaleString(locale)
  $('#stats-empty').hidden = stats.total > 0
  $('#stats-body').hidden = stats.total === 0

  const max = Math.max(1, ...stats.days.map((day) => day.cups))
  const columns = stats.days.map((day, i) => {
    const date = new Date(`${day.date}T12:00:00`)
    const label = `${WEEKDAYS[date.getDay()]}, ${date.toLocaleDateString(locale, { day: '2-digit', month: '2-digit' })}: ${cups(day.cups)}`
    const column = el('div', { className: 'bar-col', tabIndex: 0 })
    column.dataset.tip = label
    column.setAttribute('aria-label', label)
    const bar = el('div', { className: day.cups ? 'bar' : 'bar empty' })
    bar.style.height = `${(day.cups / max) * 100}%`
    const isToday = i === stats.days.length - 1
    // Direct label only for today; the other values are in the tooltip and the table.
    if (isToday && day.cups) bar.append(el('span', { className: 'bar-value' }, String(day.cups)))
    column.append(el('div', { className: 'bar-track' }, ''), el('span', { className: 'bar-day' }, isToday ? t('stats.todayShort') : WEEKDAYS[date.getDay()]))
    column.firstChild.append(bar)
    return column
  })
  $('#stat-days').replaceChildren(...columns)

  $('#stat-table tbody').replaceChildren(...stats.days.map((day) => {
    const row = el('tr')
    row.append(el('td', {}, day.date), el('td', {}, String(day.cups)))
    return row
  }))

  $('#stat-favorites').replaceChildren(...stats.favorites.map((favorite) => {
    const item = el('li')
    item.append(el('span', {}, favorite.name || t('stats.deviceStarted')), el('span', { className: 'muted' }, cups(favorite.cups)))
    return item
  }))
}

function renderHistory(entries) {
  $('#history-list').replaceChildren(...entries.map((entry) => {
    const item = el('li', { className: `history-${entry.status}` })
    const details = [
      entry.temperature !== null ? `${entry.temperature} °C` : null,
      entry.duration !== null ? `${formatDuration(entry.duration)} min` : null,
      entry.volume !== null ? `${entry.volume} ml` : null,
      entry.infusion ? t('stats.infusion', { value: entry.infusion }) : null,
    ].filter(Boolean).join(' · ')
    const badge = { brewing: t('stats.badgeBrewing'), cancelled: t('stats.badgeCancelled') }[entry.status]
    const head = el('div', { className: 'history-head' })
    head.append(el('strong', {}, entry.name || t('stats.deviceStarted')))
    if (badge) head.append(el('span', { className: `badge ${entry.status}` }, badge))
    item.append(head, el('span', { className: 'muted' }, `${formatWhen(entry.time)}${details ? ' · ' + details : ''}`))
    return item
  }))
}

async function refresh() {
  try {
    const [stats, history] = await Promise.all([api('/api/stats'), api('/api/history?limit=20')])
    renderStats(stats)
    renderHistory(history)
  } catch {
    // The dashboard shows connection problems elsewhere; keep the last numbers.
  }
}

let pending = null
document.addEventListener('temial:log', (event) => {
  if (!REFRESH_ON.has(event.detail.type)) return
  clearTimeout(pending)
  pending = setTimeout(refresh, 500)
})

refresh()
