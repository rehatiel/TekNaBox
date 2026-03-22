/**
 * Monitoring — Uptime Kuma-style monitor dashboard.
 * Cards show live status, 60-tick history bar, uptime %, and RTT.
 * Click a card to expand charts and detailed metrics.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { api } from '../lib/api'
import { PageHeader, Spinner, Alert, Modal } from '../components/ui'
import {
  Plus, RefreshCw, Globe, Wifi, Server, Search as SearchIcon,
  ChevronDown, ChevronUp, Pencil, Trash2, Pause, Play,
  CheckCircle2, XCircle, Clock, AlertTriangle, Lock,
} from 'lucide-react'
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from 'recharts'
import { formatDistanceToNow, format, parseISO } from 'date-fns'

// ── Constants ─────────────────────────────────────────────────────────────────

const TYPE_META = {
  ping: { label: 'PING',  icon: Wifi,   color: '#06b6d4' },
  tcp:  { label: 'TCP',   icon: Server, color: '#8b5cf6' },
  http: { label: 'HTTP',  icon: Globe,  color: '#10b981' },
  dns:  { label: 'DNS',   icon: SearchIcon, color: '#f59e0b' },
}

const STATUS_COLOR = {
  up:      { dot: 'bg-green-DEFAULT', border: 'border-green-DEFAULT/30', text: 'text-green-DEFAULT' },
  down:    { dot: 'bg-red-DEFAULT',   border: 'border-red-DEFAULT/30',   text: 'text-red-DEFAULT'   },
  pending: { dot: 'bg-slate-500',     border: 'border-bg-border',         text: 'text-slate-500'     },
}

function monitorStatus(m) {
  if (m.last_status === null || m.last_status === undefined) return 'pending'
  return m.last_status ? 'up' : 'down'
}

function rttColor(ms) {
  if (ms == null) return 'text-slate-600'
  if (ms < 50)   return 'text-green-DEFAULT'
  if (ms < 200)  return 'text-amber-DEFAULT'
  return 'text-red-DEFAULT'
}

function formatDuration(isoDate) {
  if (!isoDate) return null
  return formatDistanceToNow(parseISO(isoDate), { addSuffix: false })
}

// ── Tick Bar ──────────────────────────────────────────────────────────────────
// Uptime Kuma-style: 60 colored squares, oldest left, newest right.

function TickBar({ ticks }) {
  const [hover, setHover] = useState(null)

  // Pad to 60 slots
  const slots = [...Array(Math.max(0, 60 - ticks.length)).fill(null), ...ticks.slice(-60)]

  function tickColor(tick) {
    if (!tick) return '#1e2533'
    if (!tick.success) return '#ef4444'
    if (tick.rtt_ms != null && tick.rtt_ms > 500) return '#f59e0b'
    return '#22c55e'
  }

  return (
    <div className="relative">
      <div className="flex gap-px items-end h-8">
        {slots.map((tick, i) => (
          <div
            key={i}
            className="flex-1 rounded-sm cursor-default transition-opacity hover:opacity-75"
            style={{
              background: tickColor(tick),
              height: tick ? `${Math.max(30, Math.min(100, tick.rtt_ms ? Math.min(tick.rtt_ms / 5, 100) : 50))}%` : '20%',
              minHeight: 4,
            }}
            onMouseEnter={() => tick && setHover({ tick, i })}
            onMouseLeave={() => setHover(null)}
          />
        ))}
      </div>
      {hover && (
        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 z-20 pointer-events-none
                        bg-bg-surface border border-bg-border rounded px-2 py-1.5 text-xs font-mono
                        shadow-xl whitespace-nowrap">
          <div className={hover.tick.success ? 'text-green-DEFAULT' : 'text-red-DEFAULT'}>
            {hover.tick.success ? '✓ Up' : '✗ Down'}
          </div>
          {hover.tick.rtt_ms != null && (
            <div className="text-slate-400">{hover.tick.rtt_ms.toFixed(1)}ms</div>
          )}
          {hover.tick.error && (
            <div className="text-red-DEFAULT text-[10px] max-w-[180px] truncate">{hover.tick.error}</div>
          )}
          <div className="text-slate-600 text-[10px]">
            {format(parseISO(hover.tick.t), 'MMM d HH:mm:ss')}
          </div>
        </div>
      )}
    </div>
  )
}

// ── RTT Chart ─────────────────────────────────────────────────────────────────

function RttChart({ checks, hours }) {
  const data = checks
    .filter(c => c.rtt_ms != null)
    .map(c => ({ t: format(parseISO(c.t), hours > 24 ? 'MMM d HH:mm' : 'HH:mm'), rtt: c.rtt_ms }))

  if (!data.length) return (
    <p className="text-xs text-slate-600 py-4 text-center">No response time data for this period.</p>
  )

  return (
    <ResponsiveContainer width="100%" height={120}>
      <AreaChart data={data} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
        <defs>
          <linearGradient id="rttGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%"  stopColor="#06b6d4" stopOpacity={0.25} />
            <stop offset="95%" stopColor="#06b6d4" stopOpacity={0}    />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#1e2533" vertical={false} />
        <XAxis dataKey="t" tick={{ fontSize: 9, fill: '#475569' }} interval="preserveStartEnd" />
        <YAxis tick={{ fontSize: 9, fill: '#475569' }} unit="ms" />
        <Tooltip
          contentStyle={{ background: '#0f1117', border: '1px solid #1e2533', fontSize: 11, borderRadius: 6 }}
          labelStyle={{ color: '#94a3b8' }}
          formatter={v => [`${v.toFixed(1)}ms`, 'RTT']}
        />
        <Area type="monotone" dataKey="rtt" stroke="#06b6d4" strokeWidth={1.5}
              fill="url(#rttGrad)" dot={false} />
      </AreaChart>
    </ResponsiveContainer>
  )
}

// ── Expanded Detail Panel ──────────────────────────────────────────────────────

function MonitorDetail({ monitor, onClose }) {
  const [data, setData]   = useState(null)
  const [hours, setHours] = useState(24)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await api.get(`/v1/monitors/${monitor.id}/checks?hours=${hours}`)
      setData(r)
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }, [monitor.id, hours])

  useEffect(() => { load() }, [load])

  return (
    <div className="border-t border-bg-border bg-bg-base px-4 py-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-3">
          <span className="text-xs text-slate-500 uppercase tracking-wider">Response Time</span>
          <div className="flex gap-1">
            {[1, 4, 24, 48, 168].map(h => (
              <button
                key={h}
                onClick={() => setHours(h)}
                className={`text-xs px-2 py-0.5 rounded transition-colors ${
                  hours === h
                    ? 'bg-cyan-dim text-cyan-DEFAULT'
                    : 'text-slate-600 hover:text-slate-400'
                }`}
              >
                {h === 168 ? '7d' : h === 1 ? '1h' : `${h}h`}
              </button>
            ))}
          </div>
        </div>
        <button onClick={onClose} className="text-slate-600 hover:text-slate-300 transition-colors">
          <ChevronUp className="w-4 h-4" />
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-24"><Spinner /></div>
      ) : data ? (
        <div className="space-y-4">
          <RttChart checks={data.checks} hours={hours} />

          {/* Stats row */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: `Uptime (${hours}h)`,  value: data.uptime_pct != null ? `${data.uptime_pct.toFixed(2)}%` : '—' },
              { label: 'Avg RTT',   value: data.avg_rtt_ms   != null ? `${data.avg_rtt_ms}ms`   : '—' },
              { label: 'Jitter',    value: data.jitter_ms    != null ? `${data.jitter_ms}ms`     : '—' },
              { label: 'Pkt Loss',  value: data.packet_loss_pct != null ? `${data.packet_loss_pct}%` : '—' },
            ].map(s => (
              <div key={s.label} className="rounded bg-bg-elevated p-2.5">
                <p className="text-xs text-slate-600 mb-0.5">{s.label}</p>
                <p className="text-sm font-mono font-600 text-slate-200">{s.value}</p>
              </div>
            ))}
          </div>

          {/* SSL expiry if HTTP */}
          {monitor.type === 'http' && (() => {
            const lastCert = data.checks.findLast?.(c => c.cert_expiry_days != null)
            if (!lastCert) return null
            const days  = lastCert.cert_expiry_days
            const color = days < 14 ? 'text-red-DEFAULT' : days < 30 ? 'text-amber-DEFAULT' : 'text-green-DEFAULT'
            return (
              <div className="flex items-center gap-2 text-xs">
                <Lock className="w-3.5 h-3.5 text-slate-500" />
                <span className="text-slate-500">SSL expires in</span>
                <span className={`font-mono font-600 ${color}`}>{days}d</span>
              </div>
            )
          })()}

          {/* Recent failures */}
          {(() => {
            const failures = data.checks.filter(c => !c.success).slice(-5).reverse()
            if (!failures.length) return null
            return (
              <div>
                <p className="text-xs text-slate-500 uppercase tracking-wider mb-2">Recent Failures</p>
                <div className="space-y-1">
                  {failures.map((f, i) => (
                    <div key={i} className="flex items-center gap-2 text-xs">
                      <XCircle className="w-3 h-3 text-red-DEFAULT shrink-0" />
                      <span className="text-slate-600 font-mono">
                        {format(parseISO(f.t), 'MMM d HH:mm:ss')}
                      </span>
                      {f.error && <span className="text-slate-500 truncate">{f.error}</span>}
                      {f.status_code && <span className="text-slate-500">HTTP {f.status_code}</span>}
                    </div>
                  ))}
                </div>
              </div>
            )
          })()}
        </div>
      ) : null}
    </div>
  )
}

// ── Monitor Card ───────────────────────────────────────────────────────────────

function MonitorCard({ monitor, onEdit, onDelete, onToggle, onRefresh }) {
  const [expanded, setExpanded] = useState(false)
  const status = monitorStatus(monitor)
  const sc     = STATUS_COLOR[status]
  const meta   = TYPE_META[monitor.type] || TYPE_META.ping
  const MetaIcon = meta.icon

  return (
    <div className={`card overflow-hidden border ${sc.border} transition-colors`}>
      {/* Main row */}
      <div
        className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-bg-elevated transition-colors select-none"
        onClick={() => setExpanded(v => !v)}
      >
        {/* Status dot */}
        <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${sc.dot} ${status === 'up' ? 'shadow-[0_0_6px_rgba(34,197,94,0.5)]' : ''}`} />

        {/* Name + type + target */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-display font-600 text-slate-200 truncate">{monitor.name}</span>
            <span
              className="text-[10px] font-mono font-600 px-1.5 py-0.5 rounded"
              style={{ background: meta.color + '20', color: meta.color }}
            >
              {meta.label}
            </span>
            {!monitor.enabled && (
              <span className="text-[10px] text-slate-600 border border-bg-border rounded px-1.5 py-0.5">
                PAUSED
              </span>
            )}
          </div>
          <p className="text-xs font-mono text-slate-600 truncate mt-0.5">
            {monitor.target}{monitor.port ? `:${monitor.port}` : ''}
            <span className="text-slate-700 ml-2">· {monitor.device_name}</span>
          </p>
        </div>

        {/* Tick bar */}
        <div className="w-32 sm:w-48 shrink-0">
          <TickBar ticks={monitor.ticks || []} />
          <div className="flex justify-between mt-0.5">
            <span className="text-[9px] text-slate-700 font-mono">older</span>
            <span className="text-[9px] text-slate-700 font-mono">now</span>
          </div>
        </div>

        {/* Uptime + RTT */}
        <div className="hidden sm:flex flex-col items-end shrink-0 w-24">
          {monitor.uptime_pct != null ? (
            <span className={`text-sm font-mono font-700 ${
              monitor.uptime_pct >= 99 ? 'text-green-DEFAULT' :
              monitor.uptime_pct >= 95 ? 'text-amber-DEFAULT' : 'text-red-DEFAULT'
            }`}>
              {monitor.uptime_pct.toFixed(2)}%
            </span>
          ) : (
            <span className="text-xs text-slate-600">—</span>
          )}
          {monitor.last_rtt_ms != null && (
            <span className={`text-xs font-mono ${rttColor(monitor.last_rtt_ms)}`}>
              {monitor.last_rtt_ms.toFixed(1)}ms
            </span>
          )}
        </div>

        {/* Status + duration */}
        <div className="hidden md:flex flex-col items-end shrink-0 w-24">
          <span className={`text-xs font-600 uppercase ${sc.text}`}>{status}</span>
          {monitor.last_status_change_at && (
            <span className="text-[10px] text-slate-600 font-mono mt-0.5">
              {formatDuration(monitor.last_status_change_at)}
            </span>
          )}
          {monitor.last_checked_at && (
            <span className="text-[10px] text-slate-700 font-mono">
              {formatDistanceToNow(parseISO(monitor.last_checked_at), { addSuffix: true })}
            </span>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1 shrink-0" onClick={e => e.stopPropagation()}>
          <button
            onClick={() => onToggle(monitor)}
            className="p-1.5 text-slate-600 hover:text-slate-300 rounded transition-colors"
            title={monitor.enabled ? 'Pause' : 'Resume'}
          >
            {monitor.enabled ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
          </button>
          <button
            onClick={() => onEdit(monitor)}
            className="p-1.5 text-slate-600 hover:text-slate-300 rounded transition-colors"
            title="Edit"
          >
            <Pencil className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => onDelete(monitor)}
            className="p-1.5 text-slate-600 hover:text-red-DEFAULT rounded transition-colors"
            title="Delete"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
          <div className="text-slate-700">
            {expanded
              ? <ChevronUp className="w-4 h-4" />
              : <ChevronDown className="w-4 h-4" />}
          </div>
        </div>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <MonitorDetail monitor={monitor} onClose={() => setExpanded(false)} />
      )}
    </div>
  )
}

// ── Add / Edit Modal ───────────────────────────────────────────────────────────

const DEFAULTS = {
  name: '', type: 'http', target: '', port: '',
  interval_seconds: 60, timeout_seconds: 10,
  http_method: 'GET', http_expected_status: 200,
  http_keyword: '', http_ignore_ssl: false,
  dns_record_type: 'A', dns_expected_value: '',
  alert_enabled: false, alert_threshold: 2,
}

function MonitorModal({ monitor, devices, onClose, onSaved }) {
  const [form, setForm]     = useState(monitor ? {
    ...DEFAULTS,
    ...monitor,
    port: monitor.port ?? '',
    http_keyword: monitor.http_keyword ?? '',
    dns_expected_value: monitor.dns_expected_value ?? '',
  } : { ...DEFAULTS, device_id: devices[0]?.id || '' })
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState('')

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  const save = async () => {
    if (!form.device_id || !form.name || !form.target) {
      setError('Device, name, and target are required'); return
    }
    setSaving(true)
    try {
      const payload = {
        ...form,
        port:             form.port ? Number(form.port) : null,
        interval_seconds: Number(form.interval_seconds),
        timeout_seconds:  Number(form.timeout_seconds),
        http_expected_status: Number(form.http_expected_status) || 200,
        alert_threshold:  Number(form.alert_threshold) || 2,
        http_keyword:         form.http_keyword || null,
        dns_expected_value:   form.dns_expected_value || null,
      }
      if (monitor) {
        await api.put(`/v1/monitors/${monitor.id}`, payload)
      } else {
        await api.post('/v1/monitors', payload)
      }
      onSaved()
      onClose()
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  const isHttp = form.type === 'http'
  const isTcp  = form.type === 'tcp'
  const isDns  = form.type === 'dns'

  return (
    <Modal title={monitor ? 'Edit Monitor' : 'Add Monitor'} onClose={onClose} width="max-w-lg">
      {error && <Alert type="error" message={error} className="mb-3" />}
      <div className="space-y-3">
        {/* Device */}
        <div>
          <label className="label">Device</label>
          <select className="input" value={form.device_id} onChange={e => set('device_id', e.target.value)}>
            {devices.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </div>

        {/* Type + Name */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Type</label>
            <select className="input" value={form.type} onChange={e => set('type', e.target.value)}>
              <option value="http">HTTP(S)</option>
              <option value="ping">Ping (ICMP)</option>
              <option value="tcp">TCP Port</option>
              <option value="dns">DNS</option>
            </select>
          </div>
          <div>
            <label className="label">Name</label>
            <input className="input" placeholder="My Server" value={form.name} onChange={e => set('name', e.target.value)} />
          </div>
        </div>

        {/* Target */}
        <div>
          <label className="label">
            {isHttp ? 'URL' : isDns ? 'Hostname' : 'Host / IP'}
          </label>
          <input
            className="input font-mono text-sm"
            placeholder={isHttp ? 'https://example.com' : isDns ? 'example.com' : '192.168.1.1'}
            value={form.target}
            onChange={e => set('target', e.target.value)}
          />
        </div>

        {/* TCP port */}
        {isTcp && (
          <div>
            <label className="label">Port</label>
            <input className="input" type="number" placeholder="80" value={form.port} onChange={e => set('port', e.target.value)} />
          </div>
        )}

        {/* HTTP options */}
        {isHttp && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">Method</label>
                <select className="input" value={form.http_method} onChange={e => set('http_method', e.target.value)}>
                  <option value="GET">GET</option>
                  <option value="HEAD">HEAD</option>
                  <option value="POST">POST</option>
                </select>
              </div>
              <div>
                <label className="label">Expected Status</label>
                <input className="input" type="number" value={form.http_expected_status} onChange={e => set('http_expected_status', e.target.value)} />
              </div>
            </div>
            <div>
              <label className="label">Keyword <span className="text-slate-600 normal-case font-400">(optional — must appear in response body)</span></label>
              <input className="input text-sm" placeholder="OK" value={form.http_keyword} onChange={e => set('http_keyword', e.target.value)} />
            </div>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={form.http_ignore_ssl} onChange={e => set('http_ignore_ssl', e.target.checked)} />
              <span className="text-sm text-slate-400">Ignore SSL certificate errors</span>
            </label>
          </div>
        )}

        {/* DNS options */}
        {isDns && (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Record Type</label>
              <select className="input" value={form.dns_record_type} onChange={e => set('dns_record_type', e.target.value)}>
                {['A', 'AAAA', 'CNAME', 'MX', 'TXT'].map(t => <option key={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Expected Value <span className="text-slate-600 font-400">(opt)</span></label>
              <input className="input text-sm font-mono" placeholder="1.2.3.4" value={form.dns_expected_value} onChange={e => set('dns_expected_value', e.target.value)} />
            </div>
          </div>
        )}

        {/* Interval + Timeout */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Check Interval</label>
            <select className="input" value={form.interval_seconds} onChange={e => set('interval_seconds', Number(e.target.value))}>
              {[30, 60, 120, 300, 600].map(s => (
                <option key={s} value={s}>{s < 60 ? `${s}s` : `${s/60} min`}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Timeout</label>
            <select className="input" value={form.timeout_seconds} onChange={e => set('timeout_seconds', Number(e.target.value))}>
              {[5, 10, 15, 30].map(s => <option key={s} value={s}>{s}s</option>)}
            </select>
          </div>
        </div>

        {/* Alerts */}
        <div className="border border-bg-border rounded p-3 space-y-2">
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={form.alert_enabled} onChange={e => set('alert_enabled', e.target.checked)} />
            <span className="text-sm text-slate-300">Send email alert when monitor goes down</span>
          </label>
          {form.alert_enabled && (
            <div className="flex items-center gap-2 pl-5">
              <span className="text-xs text-slate-500">After</span>
              <input
                type="number" min={1} max={10}
                className="input w-16 py-1 text-sm"
                value={form.alert_threshold}
                onChange={e => set('alert_threshold', Number(e.target.value))}
              />
              <span className="text-xs text-slate-500">consecutive failures</span>
            </div>
          )}
        </div>
      </div>

      <div className="flex gap-2 mt-5">
        <button onClick={onClose} className="btn-ghost flex-1">Cancel</button>
        <button onClick={save} disabled={saving} className="btn-primary flex-1">
          {saving ? 'Saving…' : monitor ? 'Save Changes' : 'Add Monitor'}
        </button>
      </div>
    </Modal>
  )
}

// ── Summary Bar ───────────────────────────────────────────────────────────────

function SummaryBar({ monitors }) {
  const up      = monitors.filter(m => m.enabled && m.last_status === true).length
  const down    = monitors.filter(m => m.enabled && m.last_status === false).length
  const pending = monitors.filter(m => m.enabled && m.last_status == null).length

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
      {[
        { label: 'Total',   value: monitors.length, color: 'text-slate-200' },
        { label: 'Up',      value: up,      color: 'text-green-DEFAULT', icon: CheckCircle2 },
        { label: 'Down',    value: down,    color: 'text-red-DEFAULT',   icon: XCircle },
        { label: 'Pending', value: pending, color: 'text-slate-500',     icon: Clock },
      ].map(s => {
        const Icon = s.icon
        return (
          <div key={s.label} className="card px-4 py-3 flex items-center gap-3">
            {Icon && <Icon className={`w-4 h-4 shrink-0 ${s.color}`} />}
            <div>
              <p className="text-xs text-slate-600">{s.label}</p>
              <p className={`font-display font-700 text-xl ${s.color}`}>{s.value}</p>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function MonitoringPage() {
  const [monitors, setMonitors] = useState([])
  const [devices, setDevices]   = useState([])
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState('')
  const [showAdd, setShowAdd]   = useState(false)
  const [editing, setEditing]   = useState(null)
  const [filter, setFilter]     = useState('all')  // all | up | down
  const pollRef = useRef(null)

  const load = useCallback(async () => {
    try {
      const [devs, mons] = await Promise.all([
        api.getDevices(),
        api.get('/v1/monitors'),
      ])
      setDevices(Array.isArray(devs) ? devs.filter(d => d.status === 'active') : [])
      setMonitors(Array.isArray(mons) ? mons : [])
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
    // Auto-refresh every 30s
    pollRef.current = setInterval(load, 30_000)
    return () => clearInterval(pollRef.current)
  }, [load])

  const deleteMonitor = async (m) => {
    if (!confirm(`Delete monitor "${m.name}"?`)) return
    try {
      await api.delete(`/v1/monitors/${m.id}`)
      load()
    } catch (e) { setError(e.message) }
  }

  const toggleMonitor = async (m) => {
    try {
      await api.patch(`/v1/monitors/${m.id}/toggle`, {})
      load()
    } catch (e) { setError(e.message) }
  }

  const filtered = monitors.filter(m => {
    if (filter === 'up')   return m.last_status === true
    if (filter === 'down') return m.last_status === false
    return true
  })

  const downCount = monitors.filter(m => m.last_status === false).length

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Monitoring"
        subtitle={`${monitors.length} monitor${monitors.length !== 1 ? 's' : ''}${downCount > 0 ? ` · ${downCount} down` : ''}`}
        actions={
          <div className="flex items-center gap-2">
            <button onClick={load} className="btn-ghost p-2" title="Refresh">
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setShowAdd(true)}
              disabled={devices.length === 0}
              className="btn-primary flex items-center gap-1.5"
              title={devices.length === 0 ? 'No active devices available' : undefined}
            >
              <Plus className="w-4 h-4" /> Add Monitor
            </button>
          </div>
        }
      />

      {error && <Alert type="error" message={error} onClose={() => setError('')} className="mb-4" />}

      {loading ? (
        <div className="flex items-center justify-center h-64"><Spinner /></div>
      ) : (
        <>
          <SummaryBar monitors={monitors} />

          {/* Filter tabs */}
          {monitors.length > 0 && (
            <div className="flex gap-1 mb-4">
              {[
                { key: 'all',  label: `All (${monitors.length})` },
                { key: 'up',   label: `Up (${monitors.filter(m => m.last_status === true).length})` },
                { key: 'down', label: `Down (${monitors.filter(m => m.last_status === false).length})` },
              ].map(f => (
                <button
                  key={f.key}
                  onClick={() => setFilter(f.key)}
                  className={`px-3 py-1.5 rounded text-xs font-display font-500 transition-colors ${
                    filter === f.key
                      ? 'bg-cyan-dim text-cyan-DEFAULT'
                      : 'text-slate-500 hover:text-slate-300 hover:bg-bg-elevated'
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
          )}

          {/* Monitor list */}
          {filtered.length === 0 ? (
            <div className="card py-16 text-center">
              <Globe className="w-10 h-10 text-slate-700 mx-auto mb-3" />
              {monitors.length === 0 ? (
                <>
                  <p className="text-slate-400 mb-1">No monitors yet</p>
                  <p className="text-xs text-slate-600">
                    {devices.length === 0
                      ? 'Connect an active device first, then add monitors.'
                      : 'Add a monitor to start tracking uptime from your devices.'}
                  </p>
                </>
              ) : (
                <p className="text-slate-500 text-sm">No monitors match this filter.</p>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              {filtered.map(m => (
                <MonitorCard
                  key={m.id}
                  monitor={m}
                  onEdit={setEditing}
                  onDelete={deleteMonitor}
                  onToggle={toggleMonitor}
                  onRefresh={load}
                />
              ))}
            </div>
          )}
        </>
      )}

      {(showAdd || editing) && (
        <MonitorModal
          monitor={editing}
          devices={devices}
          onClose={() => { setShowAdd(false); setEditing(null) }}
          onSaved={load}
        />
      )}
    </div>
  )
}
