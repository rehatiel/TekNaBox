/**
 * API client — thin wrapper around fetch.
 * Reads/writes token from localStorage.
 * All calls use relative paths — nginx proxies /v1/* to the api container.
 */

const BASE = ''

export function getToken() {
  return localStorage.getItem('msp_token')
}

export function getOperator() {
  try { return JSON.parse(localStorage.getItem('msp_operator')) } catch { return null }
}

export function setToken(token) {
  localStorage.setItem('msp_token', token)
}

export function clearToken() {
  localStorage.removeItem('msp_token')
  localStorage.removeItem('msp_operator')
}

export function setOperator(op) {
  localStorage.setItem('msp_operator', JSON.stringify(op))
}

async function request(method, path, body, options = {}) {
  const headers = { 'Content-Type': 'application/json' }
  const token = getToken()
  if (token) headers['Authorization'] = `Bearer ${token}`

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    ...options,
  })

  if (res.status === 401) {
    clearToken()
    window.location.href = '/login'
    throw new Error('Unauthorized')
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }))
    throw new Error(err.detail || `HTTP ${res.status}`)
  }

  if (res.status === 204) return null
  return res.json()
}

const get  = (path)        => request('GET', path)
const post = (path, body)  => request('POST', path, body)
const del   = (path)        => request('DELETE', path)
const patch = (path, body)  => request('PATCH', path, body)

// ── Auth ──────────────────────────────────────────────────────────────────────
export const api = {
  login: (email, password) => post('/v1/auth/login', { email, password }),
  getWsTicket: () => post('/v1/ws-ticket', {}),

  // ── MSPs ────────────────────────────────────────────────────────────────────
  getMsps:       ()       => get('/v1/msps'),
  createMsp:     (data)   => post('/v1/msps', data),

  // ── Operators ───────────────────────────────────────────────────────────────
  getOperators:   ()      => get('/v1/operators'),
  createOperator: (data)  => post('/v1/operators', data),
  updateOperator: (id, data) => patch(`/v1/operators/${id}`, data),
  revokeOperator: (id)    => del(`/v1/operators/${id}`),

  // ── Customers ───────────────────────────────────────────────────────────────
  getCustomers:  ()       => get('/v1/customers'),
  createCustomer:(data)   => post('/v1/customers', data),

  // ── Sites ───────────────────────────────────────────────────────────────────
  getSites:      (customerId) => get(`/v1/sites${customerId ? `?customer_id=${customerId}` : ''}`),
  createSite:    (data)   => post('/v1/sites', data),

  // ── Devices ─────────────────────────────────────────────────────────────────
  getDevices:    (params = {}) => {
    const q = new URLSearchParams(params).toString()
    return get(`/v1/devices${q ? `?${q}` : ''}`)
  },
  createDevice:  (data)   => post('/v1/devices', data),
  revokeDevice:  (id, reason) => post(`/v1/devices/${id}/revoke${reason ? `?reason=${encodeURIComponent(reason)}` : ''}`),
  resetDevice:   (id, reason) => post(`/v1/devices/${id}/reset${reason ? `?reason=${encodeURIComponent(reason)}` : ''}`),
  deleteDevice:  (id)         => del(`/v1/devices/${id}`),

  // ── Tasks ────────────────────────────────────────────────────────────────────
  getTasks:      (deviceId) => get(`/v1/devices/${deviceId}/tasks`),
  getAllTasks:    (params = {}) => {
    const q = new URLSearchParams(params).toString()
    return get(`/v1/tasks${q ? `?${q}` : ''}`)
  },
  issueTask:     (deviceId, data) => post(`/v1/devices/${deviceId}/tasks`, data),
  getTaskTypes:  () => get('/v1/task-types'),

  // ── Releases ─────────────────────────────────────────────────────────────────
  getReleases:   ()       => get('/v1/releases'),
  triggerRollout:(id, params) => {
    const q = new URLSearchParams(params).toString()
    return post(`/v1/releases/${id}/rollout?${q}`)
  },
  revokeRelease: (id, reason) => post(`/v1/releases/${id}/revoke${reason ? `?reason=${encodeURIComponent(reason)}` : ''}`),

  uploadRelease: async (params, file) => {
    const token = getToken()
    const q = new URLSearchParams(params).toString()
    const form = new FormData()
    form.append('artifact', file)
    const res = await fetch(`${BASE}/v1/releases?${q}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
      body: form,
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }))
      throw new Error(err.detail || `HTTP ${res.status}`)
    }
    return res.json()
  },

  // ── Audit ─────────────────────────────────────────────────────────────────
  getAudit: (params = {}) => {
    const q = new URLSearchParams(params).toString()
    return get(`/v1/audit${q ? `?${q}` : ''}`)
  },

  // ── Monitoring ────────────────────────────────────────────────────────────
  getUptimeSummary: (hours = 24) => get(`/v1/monitoring/uptime?hours=${hours}`),
  getDeviceUptime:  (id, hours = 24) => get(`/v1/monitoring/devices/${id}/uptime?hours=${hours}`),
  getDeviceRtt:     (id, target, hours = 4) => get(`/v1/monitoring/devices/${id}/rtt?target=${encodeURIComponent(target)}&hours=${hours}`),
  getMonitorTargets: (deviceId) =>
    get(`/v1/monitoring/targets${deviceId ? `?device_id=${deviceId}` : ''}`),
  createMonitorTarget: (body) => post('/v1/monitoring/targets', body),
  deleteMonitorTarget: (id) => del(`/v1/monitoring/targets/${id}`),

  // ── Generic helpers ───────────────────────────────────────────────────────
  get:    (path) => get(path),
  post:   (path, body) => post(path, body),
  patch:  (path, body) => patch(path, body),
}
