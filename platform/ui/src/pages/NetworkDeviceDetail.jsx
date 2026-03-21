/**
 * Network Device Detail — full history and scan runner for a single discovered device.
 * Route: /network-device/:mac
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { api } from '../lib/api'
import {
  ArrowLeft, RefreshCw, ScanLine, ChevronDown, ChevronRight,
  CheckCircle, Shield, Globe, Server, Wifi, FileText,
  Pencil, Check, X, Clock, AlertTriangle, Terminal, Monitor,
} from 'lucide-react'

// ── Helpers ────────────────────────────────────────────────────────────────────

function fmt(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

function timeSince(iso) {
  if (!iso) return '—'
  const secs = Math.floor((Date.now() - new Date(iso)) / 1000)
  if (secs < 60)   return `${secs}s ago`
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`
  return `${Math.floor(secs / 86400)}d ago`
}

const COMMON_PORTS = {
  21: 'FTP', 22: 'SSH', 23: 'Telnet', 25: 'SMTP', 53: 'DNS',
  80: 'HTTP', 110: 'POP3', 143: 'IMAP', 443: 'HTTPS', 445: 'SMB',
  3389: 'RDP', 5900: 'VNC', 8080: 'HTTP-alt', 8443: 'HTTPS-alt',
  3306: 'MySQL', 5432: 'PostgreSQL', 6379: 'Redis', 27017: 'MongoDB',
  1433: 'MSSQL', 5985: 'WinRM', 9200: 'Elasticsearch', 2375: 'Docker',
}

const SCAN_TYPES = [
  {
    id: 'port_scan',
    label: 'Port Scan',
    icon: ScanLine,
    color: '#06b6d4',
    desc: 'TCP connect scan — no root required',
    fields: [
      { key: 'ports', label: 'Port Range', placeholder: '1-1024', default: '1-1024' },
    ],
  },
  {
    id: 'banner_grab',
    label: 'Banner Grab',
    icon: Terminal,
    color: '#a78bfa',
    desc: 'Read service banners from open ports',
    fields: [
      { key: 'ports', label: 'Ports (comma-separated)', placeholder: '22,80,443', default: '' },
    ],
  },
  {
    id: 'nmap_scan',
    label: 'Nmap Scan',
    icon: Globe,
    color: '#f59e0b',
    desc: 'Nmap service/OS detection (requires nmap on agent)',
    fields: [
      {
        key: 'scan_type', label: 'Scan Type', type: 'select',
        options: ['quick', 'service', 'os'], default: 'service',
      },
      { key: 'ports', label: 'Port Range (optional)', placeholder: '1-1024', default: '' },
    ],
  },
  {
    id: 'vuln_scan',
    label: 'Vuln Scan',
    icon: Shield,
    color: '#ef4444',
    desc: 'Nmap NSE vulnerability scripts',
    fields: [
      {
        key: 'intensity', label: 'Intensity', type: 'select',
        options: ['safe', 'default', 'aggressive'], default: 'safe',
      },
      { key: 'ports', label: 'Ports (optional, overrides defaults)', placeholder: '80,443,8080', default: '' },
    ],
  },
  {
    id: 'ssl_check',
    label: 'SSL Check',
    icon: Server,
    color: '#22c55e',
    desc: 'Certificate validity, expiry, cipher check',
    fields: [
      { key: 'port', label: 'Port', placeholder: '443', default: '443' },
    ],
  },
  {
    id: 'smb_enum',
    label: 'SMB Enum',
    icon: Wifi,
    color: '#fb923c',
    desc: 'Enumerate SMB shares, null sessions, OS banner',
    fields: [
      { key: 'username', label: 'Username (blank = null session)', placeholder: '', default: '' },
      { key: 'password', label: 'Password', placeholder: '', default: '', password: true },
    ],
  },
  {
    id: 'windows_probe',
    label: 'Windows Probe',
    icon: Monitor,
    color: '#0078d4',
    desc: 'Agentless Windows inventory & security posture via WinRM',
    fields: [
      { key: 'username', label: 'Username', placeholder: 'Administrator', default: '' },
      { key: 'password', label: 'Password', placeholder: '', default: '', password: true },
      { key: 'port',     label: 'WinRM Port', placeholder: '5985', default: '5985' },
    ],
  },
]

const iconBtn = { background: 'none', border: 'none', cursor: 'pointer', padding: 2, display: 'flex', alignItems: 'center' }

// ── Scan type card ─────────────────────────────────────────────────────────────

function ScanCard({ scanDef, device, onStart, running }) {
  const [open,   setOpen]   = useState(false)
  const [fields, setFields] = useState(() =>
    Object.fromEntries(scanDef.fields.map(f => [f.key, f.default ?? '']))
  )
  const [error, setError]   = useState('')

  const Icon = scanDef.icon

  const start = () => {
    setError('')
    if (!device.source_device_id) { setError('No source agent — run a network scan first'); return }
    if (!device.ip) { setError('Device has no IP address'); return }
    onStart(scanDef, fields)
    setOpen(false)
  }

  return (
    <div style={{
      background: 'var(--bg-surface)', border: `1px solid ${open ? scanDef.color + '55' : 'var(--bg-border)'}`,
      borderRadius: 10, overflow: 'hidden',
      transition: 'border-color 0.15s',
    }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: 10,
          padding: '12px 14px', background: 'none', border: 'none', cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        <Icon size={16} color={scanDef.color} style={{ flexShrink: 0 }} />
        <span style={{ fontSize: 13, color: 'var(--input-text)', fontWeight: 600, flex: 1 }}>{scanDef.label}</span>
        {running ? (
          <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: scanDef.color }}>
            <RefreshCw size={10} style={{ animation: 'spin 1s linear infinite' }} />
            Running…
          </span>
        ) : (
          open ? <ChevronDown size={13} color="var(--label-color)" /> : <ChevronRight size={13} color="var(--label-color)" />
        )}
      </button>

      {open && !running && (
        <div style={{ padding: '0 14px 14px', borderTop: '1px solid #1a2030' }}>
          <p style={{ fontSize: 11, color: 'var(--label-color)', margin: '10px 0 12px', fontFamily: 'JetBrains Mono, monospace' }}>
            {scanDef.desc}
          </p>
          {scanDef.fields.map(f => (
            <div key={f.key} style={{ marginBottom: 10 }}>
              <label style={{ display: 'block', fontSize: 10, color: 'var(--btn-ghost-color)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                {f.label}
              </label>
              {f.type === 'select' ? (
                <select
                  value={fields[f.key]}
                  onChange={e => setFields(prev => ({ ...prev, [f.key]: e.target.value }))}
                  style={{
                    width: '100%', background: 'var(--bg-base)', border: '1px solid var(--bg-border)',
                    borderRadius: 6, color: 'var(--input-text)', padding: '6px 8px', fontSize: 12,
                    fontFamily: 'JetBrains Mono, monospace', outline: 'none',
                  }}
                >
                  {f.options.map(o => <option key={o} value={o}>{o}</option>)}
                </select>
              ) : (
                <input
                  type={f.password ? 'password' : 'text'}
                  value={fields[f.key]}
                  onChange={e => setFields(prev => ({ ...prev, [f.key]: e.target.value }))}
                  placeholder={f.placeholder}
                  style={{
                    width: '100%', boxSizing: 'border-box',
                    background: 'var(--bg-base)', border: '1px solid var(--bg-border)', borderRadius: 6,
                    color: 'var(--input-text)', padding: '6px 8px', fontSize: 12,
                    fontFamily: 'JetBrains Mono, monospace', outline: 'none',
                  }}
                />
              )}
            </div>
          ))}
          {error && <div style={{ fontSize: 11, color: 'var(--sev-critical-color)', marginBottom: 8 }}>{error}</div>}
          <button
            onClick={start}
            style={{
              background: scanDef.color + '22', border: `1px solid ${scanDef.color}55`,
              borderRadius: 6, color: scanDef.color, padding: '6px 14px',
              cursor: 'pointer', fontSize: 12, fontWeight: 600, width: '100%',
            }}
          >
            Run {scanDef.label}
          </button>
        </div>
      )}
    </div>
  )
}

// ── Scan result viewer ─────────────────────────────────────────────────────────

function ScanResult({ record }) {
  const [expanded, setExpanded] = useState(false)
  const def = SCAN_TYPES.find(t => t.id === record.scan_type) || {}
  const Icon = def.icon || ScanLine
  const color = def.color || '#06b6d4'

  const failed = record.status === 'failed'

  return (
    <div style={{
      background: 'var(--bg-base)', border: `1px solid ${failed ? '#450a0a' : '#1a2030'}`,
      borderRadius: 8, marginBottom: 8, overflow: 'hidden',
    }}>
      <button
        onClick={() => setExpanded(e => !e)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: 8,
          padding: '10px 12px', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left',
        }}
      >
        <Icon size={13} color={failed ? '#ef4444' : color} style={{ flexShrink: 0 }} />
        <span style={{ fontSize: 12, color: failed ? 'var(--sev-critical-color)' : 'var(--input-text)', flex: 1, fontWeight: 500 }}>
          {def.label || record.scan_type}
          {record.port_range && (
            <span style={{ color: 'var(--label-color)', fontWeight: 400 }}> · {record.port_range}</span>
          )}
        </span>
        <span style={{ fontSize: 11, color: 'var(--label-color)', fontFamily: 'JetBrains Mono, monospace' }}>
          {fmt(record.scanned_at)}
        </span>
        {failed && <AlertTriangle size={11} color="#ef4444" style={{ marginLeft: 4 }} />}
        {expanded ? <ChevronDown size={11} color="var(--label-color)" /> : <ChevronRight size={11} color="var(--label-color)" />}
      </button>

      {expanded && (
        <div style={{ borderTop: '1px solid #1a2030', padding: '10px 12px' }}>
          {failed ? (
            <div style={{ fontSize: 12, color: 'var(--sev-critical-color)', fontFamily: 'JetBrains Mono, monospace' }}>
              {record.error || 'Scan failed'}
            </div>
          ) : (
            <ScanResultBody record={record} color={color} />
          )}
        </div>
      )}
    </div>
  )
}

function ScanResultBody({ record, color }) {
  const r = record.result || {}

  if (record.scan_type === 'port_scan') {
    const ports = r.open_ports || []
    return (
      <div>
        <div style={{ fontSize: 11, color: 'var(--label-color)', marginBottom: 8 }}>
          Scanned {r.ports_scanned ?? '?'} ports · {ports.length} open
        </div>
        {ports.length === 0 ? (
          <span style={{ fontSize: 12, color: 'var(--label-color)', fontFamily: 'JetBrains Mono, monospace' }}>No open ports found</span>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
            {ports.map(p => (
              <span key={p} style={{
                background: 'var(--bg-surface)', border: '1px solid var(--bg-border)', borderRadius: 4,
                padding: '2px 7px', fontSize: 11, fontFamily: 'JetBrains Mono, monospace',
                color: 'var(--input-text)',
              }}>
                <span style={{ color, fontWeight: 600 }}>{p}</span>
                {COMMON_PORTS[p] && <span style={{ color: 'var(--label-color)' }}> {COMMON_PORTS[p]}</span>}
              </span>
            ))}
          </div>
        )}
      </div>
    )
  }

  if (record.scan_type === 'banner_grab') {
    const results = r.results || []
    return (
      <div>
        {results.length === 0 ? (
          <span style={{ fontSize: 12, color: 'var(--label-color)' }}>No banners captured</span>
        ) : results.map((item, i) => (
          <div key={i} style={{ marginBottom: 10, fontFamily: 'JetBrains Mono, monospace' }}>
            <div style={{ fontSize: 11, color: color, marginBottom: 3 }}>
              {item.host}:{item.port}
              {COMMON_PORTS[item.port] && <span style={{ color: 'var(--label-color)' }}> ({COMMON_PORTS[item.port]})</span>}
            </div>
            <pre style={{
              background: 'var(--bg-base)', border: '1px solid var(--bg-border)', borderRadius: 4,
              padding: '6px 10px', fontSize: 11, color: 'var(--btn-ghost-color)', margin: 0,
              overflowX: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all',
            }}>
              {item.banner || <span style={{ color: 'var(--label-color)' }}>(no banner)</span>}
            </pre>
          </div>
        ))}
      </div>
    )
  }

  if (record.scan_type === 'ssl_check') {
    const certs = r.results || []
    return (
      <div>
        {certs.map((c, i) => (
          <div key={i} style={{ marginBottom: 12, fontFamily: 'JetBrains Mono, monospace' }}>
            <div style={{ fontSize: 11, color: color, marginBottom: 6 }}>{c.host}:{c.port}</div>
            <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: '3px 12px', fontSize: 11 }}>
              {[
                ['Subject', c.subject],
                ['Issuer', c.issuer],
                ['Expires', c.expiry ? fmt(c.expiry) : '—'],
                ['Days left', c.days_remaining != null ? c.days_remaining : '—'],
                ['Status', c.status],
              ].map(([k, v]) => (
                <>
                  <span key={k + 'k'} style={{ color: 'var(--label-color)' }}>{k}</span>
                  <span key={k + 'v'} style={{ color: c.days_remaining < 30 && k === 'Days left' ? 'var(--sev-critical-color)' : 'var(--input-text)' }}>{String(v ?? '—')}</span>
                </>
              ))}
            </div>
          </div>
        ))}
      </div>
    )
  }

  if (record.scan_type === 'smb_enum') {
    const hosts = r.results || []
    return (
      <div style={{ fontFamily: 'JetBrains Mono, monospace' }}>
        {hosts.map((h, i) => (
          <div key={i} style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 11, color: color, marginBottom: 4 }}>{h.host}</div>
            {h.os && <div style={{ fontSize: 11, color: 'var(--btn-ghost-color)', marginBottom: 4 }}>OS: {h.os}</div>}
            {h.shares && h.shares.length > 0 && (
              <div>
                <div style={{ fontSize: 10, color: 'var(--label-color)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>Shares</div>
                {h.shares.map((s, j) => (
                  <div key={j} style={{ fontSize: 11, color: s.guest_accessible ? 'var(--sev-critical-color)' : 'var(--btn-ghost-color)', marginBottom: 2 }}>
                    {s.name} {s.guest_accessible ? '⚠ guest' : ''}
                    {s.comment && <span style={{ color: 'var(--label-color)' }}> — {s.comment}</span>}
                  </div>
                ))}
              </div>
            )}
            {h.null_session && (
              <div style={{ fontSize: 11, color: 'var(--sev-critical-color)', marginTop: 4 }}>⚠ Null session available</div>
            )}
          </div>
        ))}
      </div>
    )
  }

  // Generic: nmap_scan, vuln_scan, or anything else — pretty-print JSON
  return (
    <pre style={{
      background: 'var(--bg-base)', border: '1px solid var(--bg-border)', borderRadius: 4,
      padding: '10px 12px', fontSize: 11, color: 'var(--btn-ghost-color)', margin: 0,
      overflowX: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all',
      maxHeight: 420, overflowY: 'auto',
    }}>
      {JSON.stringify(r, null, 2)}
    </pre>
  )
}

// ── Notes editor ───────────────────────────────────────────────────────────────

function NotesEditor({ mac, initialNotes, onSaved }) {
  const [value,   setValue]   = useState(initialNotes || '')
  const [saving,  setSaving]  = useState(false)
  const [saved,   setSaved]   = useState(false)
  const timerRef = useRef(null)

  // Auto-save 1.5s after user stops typing
  const handleChange = (e) => {
    setValue(e.target.value)
    setSaved(false)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => save(e.target.value), 1500)
  }

  const save = async (text) => {
    setSaving(true)
    try {
      await api.updateDeviceNotes(mac, text || null)
      setSaved(true)
      onSaved && onSaved(text)
    } catch (_) {}
    setSaving(false)
  }

  useEffect(() => () => timerRef.current && clearTimeout(timerRef.current), [])

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <FileText size={14} color="var(--label-color)" />
        <span style={{ fontSize: 12, color: 'var(--label-color)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Notes</span>
        {saving && <span style={{ fontSize: 11, color: 'var(--label-color)', marginLeft: 'auto' }}>Saving…</span>}
        {!saving && saved && <span style={{ fontSize: 11, color: '#22c55e', marginLeft: 'auto' }}>Saved</span>}
      </div>
      <textarea
        value={value}
        onChange={handleChange}
        placeholder="Add notes about this device — purpose, owner, known issues…"
        rows={4}
        style={{
          width: '100%', boxSizing: 'border-box',
          background: 'var(--bg-base)', border: '1px solid var(--bg-border)', borderRadius: 8,
          color: 'var(--input-text)', padding: '10px 12px', fontSize: 12,
          fontFamily: 'JetBrains Mono, monospace', outline: 'none', resize: 'vertical',
          lineHeight: 1.6,
        }}
        onFocus={e => e.target.style.borderColor = '#1e3a4a'}
        onBlur={e  => e.target.style.borderColor = 'var(--bg-border)'}
      />
    </div>
  )
}

// ── Inline label editor ────────────────────────────────────────────────────────

function InlineLabelEdit({ device, onSave }) {
  const [editing, setEditing] = useState(false)
  const [value,   setValue]   = useState(device.label || '')

  const commit = async () => {
    await onSave(value.trim() || null)
    setEditing(false)
  }

  if (editing) return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <input
        autoFocus value={value}
        onChange={e => setValue(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false) }}
        style={{
          background: 'var(--bg-base)', border: '1px solid var(--bg-border)', borderRadius: 4,
          color: 'var(--input-text)', padding: '3px 8px', fontSize: 14, fontFamily: 'Syne, sans-serif',
          outline: 'none', width: 200,
        }}
      />
      <button onClick={commit} style={iconBtn}><Check size={12} color="#22c55e" /></button>
      <button onClick={() => setEditing(false)} style={iconBtn}><X size={12} color="var(--btn-ghost-color)" /></button>
    </span>
  )

  return (
    <span
      onClick={() => setEditing(true)}
      title="Click to edit label"
      style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}
    >
      <span style={{ fontSize: 20, fontWeight: 700, color: device.label ? 'var(--input-text)' : 'var(--label-color)', fontFamily: 'Syne, sans-serif' }}>
        {device.label || device.ip || device.mac}
      </span>
      <Pencil size={11} color="var(--label-color)" />
    </span>
  )
}

// ── Main page ──────────────────────────────────────────────────────────────────

export default function NetworkDeviceDetailPage() {
  const { mac }    = useParams()
  const navigate   = useNavigate()

  const [device,   setDevice]   = useState(null)
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState('')
  const [running,  setRunning]  = useState({})   // scanType -> taskId
  const [filter,   setFilter]   = useState('all')

  const pollTimers = useRef({})

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const data = await api.getDiscoveredDevice(mac)
      setDevice(data)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [mac])

  useEffect(() => { load() }, [load])
  useEffect(() => () => Object.values(pollTimers.current).forEach(t => clearTimeout(t)), [])

  // ── Task dispatch + poll ───────────────────────────────────────────────────

  const buildPayload = (scanDef, fields) => {
    const ip = device.ip
    switch (scanDef.id) {
      case 'port_scan':
        return { task_type: 'run_port_scan', payload: { target: ip, ports: fields.ports || '1-1024', timeout: 1, concurrency: 100 } }
      case 'banner_grab': {
        const portList = (fields.ports || '22,80,443').split(',').map(p => parseInt(p.trim(), 10)).filter(Boolean)
        return { task_type: 'run_banner_grab', payload: { targets: portList.map(p => ({ host: ip, port: p })), timeout: 5 } }
      }
      case 'nmap_scan': {
        const p = { task_type: 'run_nmap_scan', payload: { targets: [ip], scan_type: fields.scan_type || 'service' } }
        if (fields.ports) p.payload.ports = fields.ports
        return p
      }
      case 'vuln_scan': {
        const p = { task_type: 'run_vuln_scan', payload: { targets: [ip], intensity: fields.intensity || 'safe' } }
        if (fields.ports) p.payload.ports = fields.ports
        return p
      }
      case 'ssl_check':
        return { task_type: 'run_ssl_check', payload: { targets: [{ host: ip, port: parseInt(fields.port || '443', 10) }] } }
      case 'smb_enum':
        return { task_type: 'run_smb_enum', payload: { targets: [ip], username: fields.username || '', password: fields.password || '' } }
      case 'windows_probe':
        return { task_type: 'run_windows_probe', payload: { target: ip, username: fields.username || '', password: fields.password || '', port: parseInt(fields.port || '5985', 10) } }
      default:
        return null
    }
  }

  const startScan = async (scanDef, fields) => {
    const taskPayload = buildPayload(scanDef, fields)
    if (!taskPayload) return
    try {
      const task = await api.issueTask(device.source_device_id, taskPayload)
      setRunning(prev => ({ ...prev, [scanDef.id]: { taskId: task.task_id, fields } }))
      schedulePoll(scanDef, task.task_id, fields)
    } catch (e) {
      setError(`Failed to start ${scanDef.label}: ${e.message}`)
    }
  }

  const schedulePoll = (scanDef, taskId, fields) => {
    pollTimers.current[scanDef.id] = setTimeout(() => pollTask(scanDef, taskId, fields), 3000)
  }

  const pollTask = async (scanDef, taskId, fields) => {
    try {
      const task = await api.getTask(taskId)
      if (task.status === 'completed') {
        const portRange = scanDef.id === 'port_scan' ? (fields.ports || '1-1024') : undefined
        await api.saveScanRecord(mac, {
          scan_type: scanDef.id,
          target_ip: device.ip,
          port_range: portRange,
          task_id: taskId,
          status: 'completed',
          result: task.result,
        })
        setRunning(prev => { const n = { ...prev }; delete n[scanDef.id]; return n })
        await load()  // refresh device + scans
      } else if (task.status === 'failed') {
        await api.saveScanRecord(mac, {
          scan_type: scanDef.id,
          target_ip: device.ip,
          task_id: taskId,
          status: 'failed',
          error: task.error || 'Task failed',
        })
        setRunning(prev => { const n = { ...prev }; delete n[scanDef.id]; return n })
        await load()
      } else {
        schedulePoll(scanDef, taskId, fields)
      }
    } catch (_) {
      setRunning(prev => { const n = { ...prev }; delete n[scanDef.id]; return n })
    }
  }

  // ── Inline updates ─────────────────────────────────────────────────────────

  const saveLabel = async (label) => {
    const updated = await api.setDeviceLabel(mac, label)
    setDevice(prev => ({ ...prev, ...updated }))
  }

  const toggleKnown = async () => {
    const updated = await api.toggleDeviceKnown(mac)
    setDevice(prev => ({ ...prev, ...updated }))
  }

  // ── Filter scans ───────────────────────────────────────────────────────────

  const scans = device?.scans || []
  const filteredScans = filter === 'all' ? scans : scans.filter(s => s.scan_type === filter)
  const scanTypesPresent = [...new Set(scans.map(s => s.scan_type))]

  // ── Render ─────────────────────────────────────────────────────────────────

  if (loading) return (
    <div style={{ padding: '80px 0', textAlign: 'center', color: 'var(--label-color)' }}>
      <RefreshCw size={28} style={{ animation: 'spin 1s linear infinite', display: 'inline-block', color: 'var(--bg-border)' }} />
      <p style={{ marginTop: 12, fontSize: 13 }}>Loading device…</p>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  )

  if (error && !device) return (
    <div style={{ padding: '60px 32px' }}>
      <button onClick={() => navigate('/network-history')} style={{ ...iconBtn, gap: 6, color: 'var(--label-color)', fontSize: 13, marginBottom: 20 }}>
        <ArrowLeft size={14} /> Back to Device History
      </button>
      <div style={{ background: '#1a0a0a', border: '1px solid #450a0a', borderRadius: 8, padding: '12px 16px', color: 'var(--sev-critical-color)' }}>{error}</div>
    </div>
  )

  return (
    <div style={{ padding: '28px 32px', maxWidth: 1200, margin: '0 auto' }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>

      {/* Back nav */}
      <button
        onClick={() => navigate('/network-history')}
        style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--label-color)', fontSize: 13, marginBottom: 20, padding: 0 }}
      >
        <ArrowLeft size={14} /> Back to Device History
      </button>

      {/* ── Device header ── */}
      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--bg-border)', borderRadius: 12, padding: '20px 24px', marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 240 }}>
            <InlineLabelEdit device={device} onSave={saveLabel} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 6, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13, color: '#06b6d4', fontFamily: 'JetBrains Mono, monospace' }}>{device.ip || '—'}</span>
              <span style={{ fontSize: 11, color: 'var(--label-color)', fontFamily: 'JetBrains Mono, monospace' }}>{device.mac}</span>
              {device.hostname && (
                <span style={{ fontSize: 11, color: 'var(--label-color)', fontFamily: 'JetBrains Mono, monospace' }}>{device.hostname}</span>
              )}
            </div>
            {device.vendor && (
              <div style={{ fontSize: 12, color: 'var(--label-color)', marginTop: 4 }}>{device.vendor}</div>
            )}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8 }}>
            <button
              onClick={toggleKnown}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                background: device.known ? 'var(--green-dim)' : 'var(--bg-base)',
                border: `1px solid ${device.known ? '#166534' : 'var(--bg-border)'}`,
                borderRadius: 6, padding: '5px 12px', cursor: 'pointer',
                color: device.known ? '#22c55e' : 'var(--label-color)', fontSize: 12,
              }}
            >
              <CheckCircle size={12} />
              {device.known ? 'Known device' : 'Mark as known'}
            </button>
            <button
              onClick={load}
              style={{ display: 'flex', alignItems: 'center', gap: 5, background: 'none', border: '1px solid var(--bg-border)', borderRadius: 6, color: 'var(--label-color)', padding: '4px 10px', cursor: 'pointer', fontSize: 11 }}
            >
              <RefreshCw size={10} style={loading ? { animation: 'spin 1s linear infinite' } : undefined} />
              Refresh
            </button>
          </div>
        </div>

        {/* Meta row */}
        <div style={{ display: 'flex', gap: 24, marginTop: 16, paddingTop: 14, borderTop: '1px solid #1a2030', flexWrap: 'wrap' }}>
          {[
            ['First seen', fmt(device.first_seen)],
            ['Last seen', fmt(device.last_seen)],
            ['Total scans', scans.length],
            ['Open ports', device.open_ports?.length != null ? device.open_ports.length : '—'],
          ].map(([k, v]) => (
            <div key={k}>
              <div style={{ fontSize: 10, color: 'var(--label-color)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 2 }}>{k}</div>
              <div style={{ fontSize: 13, color: 'var(--input-text)', fontFamily: 'JetBrains Mono, monospace' }}>{String(v)}</div>
            </div>
          ))}
        </div>
      </div>

      {error && (
        <div style={{ background: '#1a0a0a', border: '1px solid #450a0a', borderRadius: 8, padding: '10px 14px', marginBottom: 16, color: 'var(--sev-critical-color)', fontSize: 13 }}>
          {error}
        </div>
      )}

      {/* ── Two-column layout ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: 20, alignItems: 'start' }}>

        {/* Left: notes + scan history */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

          {/* Notes */}
          <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--bg-border)', borderRadius: 12, padding: '18px 20px' }}>
            <NotesEditor mac={mac} initialNotes={device.notes} />
          </div>

          {/* Scan history */}
          <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--bg-border)', borderRadius: 12, padding: '18px 20px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
              <Clock size={14} color="var(--label-color)" />
              <span style={{ fontSize: 12, color: 'var(--label-color)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                Scan History
              </span>
              <span style={{ fontSize: 11, color: 'var(--bg-border)', marginLeft: 2 }}>({scans.length})</span>

              {/* Type filter pills */}
              <div style={{ display: 'flex', gap: 6, marginLeft: 'auto', flexWrap: 'wrap' }}>
                {['all', ...scanTypesPresent].map(t => {
                  const def = SCAN_TYPES.find(s => s.id === t)
                  return (
                    <button
                      key={t}
                      onClick={() => setFilter(t)}
                      style={{
                        background: filter === t ? (def?.color + '22' || 'var(--bg-border)') : 'none',
                        border: `1px solid ${filter === t ? (def?.color + '55' || 'var(--label-color)') : 'var(--bg-border)'}`,
                        borderRadius: 4, padding: '2px 8px', cursor: 'pointer',
                        color: filter === t ? (def?.color || 'var(--input-text)') : 'var(--label-color)',
                        fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em',
                      }}
                    >
                      {t === 'all' ? 'All' : (def?.label || t)}
                    </button>
                  )
                })}
              </div>
            </div>

            {filteredScans.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--bg-border)' }}>
                <Clock size={36} style={{ marginBottom: 10 }} />
                <p style={{ fontSize: 13, color: 'var(--label-color)' }}>
                  {scans.length === 0 ? 'No scans recorded yet' : 'No scans match this filter'}
                </p>
              </div>
            ) : (
              filteredScans.map(r => <ScanResult key={r.id} record={r} />)
            )}
          </div>
        </div>

        {/* Right: run scan panel */}
        <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--bg-border)', borderRadius: 12, padding: '18px 20px', position: 'sticky', top: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
            <ScanLine size={14} color="#06b6d4" />
            <span style={{ fontSize: 12, color: 'var(--label-color)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              Run Scan
            </span>
            {!device.source_device_id && (
              <span style={{ fontSize: 10, color: '#f59e0b', marginLeft: 'auto' }}>⚠ no agent</span>
            )}
          </div>

          <div style={{ fontSize: 12, color: 'var(--label-color)', fontFamily: 'JetBrains Mono, monospace', marginBottom: 14 }}>
            Target: <span style={{ color: '#06b6d4' }}>{device.ip || '—'}</span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {SCAN_TYPES.map(def => (
              <ScanCard
                key={def.id}
                scanDef={def}
                device={device}
                onStart={startScan}
                running={!!running[def.id]}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
