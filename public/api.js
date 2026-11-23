const TOKEN_KEY = 'temial-control-token'

export function readToken() {
  try { return localStorage.getItem(TOKEN_KEY) || '' } catch { return '' }
}

function storeToken(value) {
  try { localStorage.setItem(TOKEN_KEY, value) } catch { /* private mode */ }
}

export async function api(path, options = {}, retry = true) {
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

export function el(tag, props = {}, text) {
  const node = Object.assign(document.createElement(tag), props)
  if (text !== undefined) node.textContent = text
  return node
}
