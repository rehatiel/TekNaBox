/**
 * Network Device History — persistent record of all devices ever seen in scans.
 * Populated automatically when the Network Discovery monitoring is running.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../lib/api'
import {
  History, RefreshCw, CheckCircle, Trash2, X, Pencil, Check,
  Search, Filter, Eye, EyeOff, ScanLine, ChevronDown, ChevronRight,
  ExternalLink,
} from 'lucide-react'

// ── Helpers ────────────────────────────────────────────────────────────────────

function fmt(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

function timeSince(iso) {
  if (!iso) return '—'
  const secs = Math.floor((Date.now() - new Date(iso)) / 1000)
  if (secs < 60)  return `${secs}s ago`
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`
  return `${Math.floor(secs / 86400)}d ago`
}

// Known service names for common ports
const COMMON_PORTS = {
  21: 'FTP', 22: 'SSH', 23: 'Telnet', 25: 'SMTP', 53: 'DNS',
  80: 'HTTP', 110: 'POP3', 143: 'IMAP', 443: 'HTTPS', 445: 'SMB',
  3389: 'RDP', 5900: 'VNC', 8080: 'HTTP-alt', 8443: 'HTTPS-alt',
  3306: 'MySQL', 5432: 'PostgreSQL', 6379: 'Redis', 27017: 'MongoDB',
}

// ── Inline label editor ────────────────────────────────────────────────────────

function LabelCell({ device, onSave }) {
  const [editing, setEditing] = useState(false)
  const [value, setValue]     = useState(device.label || '')

  const commit = async () => {
    await onSave(device.mac, value.trim() || null)
    setEditing(false)
  }

  if (editing) {
    return (
      <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <input
          autoFocus
          value={value}
          onChange={e => setValue(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false) }}
          style={{
            background: 'var(--bg-base)', border: '1px solid var(--bg-border)', borderRadius: 4,
            color: 'var(--input-text)', padding: '2px 6px', fontSize: 11,
            fontFamily: 'JetBrains Mono, monospace', width: 110, outline: 'none',
          }}
        />
        <button onClick={commit} style={iconBtn}><Check size={10} color="#22c55e" /></button>
        <button onClick={() => setEditing(false)} style={iconBtn}><X size={10} color="var(--btn-ghost-color)" /></button>
      </span>
    )
  }

  return (
    <span
      onClick={() => setEditing(true)}
      title="Click to set label"
      style={{
        display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer',
        color: device.label ? 'var(--btn-ghost-color)' : 'var(--label-color)',
        fontSize: 11, fontFamily: 'JetBrains Mono, monospace',
      }}
    >
      {device.label || <span style={{ color: 'var(--bg-border)' }}>—</span>}
      <Pencil size={9} style={{ opacity: 0.4, flexShrink: 0 }} />
    </span>
  )
}

const iconBtn = {
  background: 'none', border: 'none', cursor: 'pointer', padding: 2,
  display: 'flex', alignItems: 'center',
}

// ── Port Scan Modal ────────────────────────────────────────────────────────────

function ScanModal({ device, onClose, onStart }) {
  const [portRange, setPortRange] = useState('1-1024')
  const [error, setError]         = useState('')

  const start = () => {
    const val = portRange.trim()
    if (!val) { setError('Enter a port range'); return }
    if (!device.ip) { setError('Device has no IP address'); return }
    if (!device.source_device_id) { setError('No source agent available — run a network scan first'); return }
    setError('')
    onStart(device, val)
    onClose()
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 1000,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{
        background: 'var(--bg-surface)', border: '1px solid var(--bg-border)', borderRadius: 12,
        padding: '24px 28px', width: 380, boxShadow: '0 20px 60px rgba(0,0,0,0.6)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
          <ScanLine size={18} color="#06b6d4" />
          <h2 style={{ margin: 0, fontSize: 16, color: 'var(--input-text)', fontFamily: 'Syne, sans-serif' }}>
            Port Scan
          </h2>
          <button onClick={onClose} style={{ ...iconBtn, marginLeft: 'auto' }}>
            <X size={14} color="var(--btn-ghost-color)" />
          </button>
        </div>

        <div style={{ fontSize: 12, color: 'var(--label-color)', marginBottom: 16, fontFamily: 'JetBrains Mono, monospace' }}>
          Target: <span style={{ color: '#06b6d4' }}>{device.ip || '—'}</span>
          {device.label && <span style={{ color: 'var(--btn-ghost-color)' }}> ({device.label})</span>}
        </div>

        <label style={{ display: 'block', fontSize: 11, color: 'var(--btn-ghost-color)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          Port Range
        </label>
        <input
          autoFocus
          value={portRange}
          onChange={e => setPortRange(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && start()}
          placeholder="e.g. 1-1024 or 22,80,443"
          style={{
            width: '100%', boxSizing: 'border-box',
            background: 'var(--bg-base)', border: '1px solid var(--bg-border)', borderRadius: 6,
            color: 'var(--input-text)', padding: '8px 10px', fontSize: 12,
            fontFamily: 'JetBrains Mono, monospace', outline: 'none', marginBottom: 8,
          }}
        />
        <div style={{ fontSize: 11, color: 'var(--label-color)', marginBottom: 16 }}>
          Examples: <code style={{ color: 'var(--label-color)' }}>1-1024</code> &nbsp;·&nbsp;
          <code style={{ color: 'var(--label-color)' }}>22,80,443,3389</code> &nbsp;·&nbsp;
          <code style={{ color: 'var(--label-color)' }}>1-65535</code>
        </div>

        {error && (
          <div style={{ fontSize: 12, color: 'var(--sev-critical-color)', marginBottom: 12 }}>{error}</div>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{
            background: 'none', border: '1px solid var(--bg-border)', borderRadius: 6,
            color: 'var(--label-color)', padding: '6px 14px', cursor: 'pointer', fontSize: 12,
          }}>
            Cancel
          </button>
          <button onClick={start} style={{
            background: 'var(--cyan-muted)', border: '1px solid var(--cyan-DEFAULT)', borderRadius: 6,
            color: 'var(--cyan-DEFAULT)', padding: '6px 14px', cursor: 'pointer', fontSize: 12, fontWeight: 600,
          }}>
            Start Scan
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Ports expanded row ─────────────────────────────────────────────────────────

function PortsExpanded({ device, colSpan }) {
  const ports = device.open_ports || []
  return (
    <tr>
      <td colSpan={colSpan} style={{ padding: '0 12px 12px 40px', background: 'var(--bg-base)' }}>
        <div style={{
          border: '1px solid var(--bg-border)', borderRadius: 8, padding: '12px 16px',
          background: 'var(--bg-base)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <ScanLine size={12} color="#06b6d4" />
            <span style={{ fontSize: 11, color: 'var(--label-color)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              Open Ports
            </span>
            <span style={{ fontSize: 11, color: 'var(--label-color)', marginLeft: 4 }}>
              · scanned {timeSince(device.ports_scanned_at)}
            </span>
          </div>
          {ports.length === 0 ? (
            <span style={{ fontSize: 12, color: 'var(--label-color)', fontFamily: 'JetBrains Mono, monospace' }}>
              No open ports found
            </span>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {ports.map(port => (
                <span key={port} style={{
                  display: 'inline-flex', alignItems: 'center', gap: 5,
                  background: 'var(--bg-surface)', border: '1px solid var(--bg-border)', borderRadius: 5,
                  padding: '3px 8px', fontSize: 11, fontFamily: 'JetBrains Mono, monospace',
                  color: 'var(--input-text)',
                }}>
                  <span style={{ color: '#06b6d4', fontWeight: 600 }}>{port}</span>
                  {COMMON_PORTS[port] && (
                    <span style={{ color: 'var(--label-color)' }}>{COMMON_PORTS[port]}</span>
                  )}
                </span>
              ))}
            </div>
          )}
        </div>
      </td>
    </tr>
  )
}

// ── Main page ──────────────────────────────────────────────────────────────────

export default function NetworkDeviceHistoryPage() {
  const navigate = useNavigate()
  const [devices,      setDevices]      = useState([])
  const [loading,      setLoading]      = useState(true)
  const [error,        setError]        = useState('')
  const [search,       setSearch]       = useState('')
  const [showUnknown,  setShowUnknown]  = useState(true)
  const [showKnown,    setShowKnown]    = useState(true)
  const [scanModal,    setScanModal]    = useState(null)  // device to scan
  const [scanning,     setScanning]     = useState({})   // mac -> taskId
  const [expanded,     setExpanded]     = useState(null) // mac of expanded ports row

  const pollTimers = useRef({})

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const data = await api.getDiscoveredDevices()
      setDevices(Array.isArray(data) ? data : [])
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  // Clean up poll timers on unmount
  useEffect(() => {
    return () => {
      Object.values(pollTimers.current).forEach(t => clearTimeout(t))
    }
  }, [])

  const toggleKnown = async (mac) => {
    try {
      const updated = await api.toggleDeviceKnown(mac)
      setDevices(prev => prev.map(d => d.mac === mac ? updated : d))
    } catch (e) {
      setError(e.message)
    }
  }

  const saveLabel = async (mac, label) => {
    try {
      const updated = await api.setDeviceLabel(mac, label)
      setDevices(prev => prev.map(d => d.mac === mac ? updated : d))
    } catch (e) {
      setError(e.message)
    }
  }

  const remove = async (mac) => {
    try {
      await api.deleteDiscoveredDevice(mac)
      setDevices(prev => prev.filter(d => d.mac !== mac))
    } catch (e) {
      setError(e.message)
    }
  }

  // ── Port scan flow ──────────────────────────────────────────────────────────

  const startPortScan = async (device, portRange) => {
    try {
      const task = await api.issueTask(device.source_device_id, {
        task_type: 'run_port_scan',
        payload: { target: device.ip, ports: portRange, timeout: 1, concurrency: 100 },
      })
      setScanning(prev => ({ ...prev, [device.mac]: task.task_id }))
      scheduleTaskPoll(device.mac, task.task_id, device.ip, portRange)
    } catch (e) {
      setError(`Failed to start scan: ${e.message}`)
    }
  }

  const scheduleTaskPoll = (mac, taskId, ip, portRange) => {
    pollTimers.current[mac] = setTimeout(() => pollTask(mac, taskId, ip, portRange), 2000)
  }

  const pollTask = async (mac, taskId, ip, portRange) => {
    try {
      const task = await api.getTask(taskId)
      if (task.status === 'completed') {
        const ports = task.result?.open_ports ?? []
        const updated = await api.updateDevicePorts(mac, ports)
        await api.saveScanRecord(mac, {
          scan_type: 'port_scan',
          target_ip: ip,
          port_range: portRange,
          task_id: taskId,
          status: 'completed',
          result: task.result,
        })
        setDevices(prev => prev.map(d => d.mac === mac ? updated : d))
        setScanning(prev => { const n = { ...prev }; delete n[mac]; return n })
        setExpanded(mac)  // auto-expand to show results
      } else if (task.status === 'failed') {
        await api.saveScanRecord(mac, {
          scan_type: 'port_scan',
          target_ip: ip,
          port_range: portRange,
          task_id: taskId,
          status: 'failed',
          error: task.error || 'Scan failed',
        })
        setError(`Port scan failed: ${task.error || 'unknown error'}`)
        setScanning(prev => { const n = { ...prev }; delete n[mac]; return n })
      } else {
        // Still running — poll again
        scheduleTaskPoll(mac, taskId, ip, portRange)
      }
    } catch (e) {
      setScanning(prev => { const n = { ...prev }; delete n[mac]; return n })
    }
  }

  // ── Filtering ───────────────────────────────────────────────────────────────

  const q = search.trim().toLowerCase()
  const filtered = devices.filter(d => {
    if (!showUnknown && !d.known) return false
    if (!showKnown   &&  d.known) return false
    if (q) {
      const haystack = [d.mac, d.ip, d.vendor, d.hostname, d.label].join(' ').toLowerCase()
      if (!haystack.includes(q)) return false
    }
    return true
  })

  const total   = devices.length
  const known   = devices.filter(d => d.known).length
  const unknown = total - known
  const COL_COUNT = 9  // total columns in table

  return (
    <div style={{ padding: '28px 32px', maxWidth: 1200, margin: '0 auto' }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>

      {scanModal && (
        <ScanModal
          device={scanModal}
          onClose={() => setScanModal(null)}
          onStart={startPortScan}
        />
      )}

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
        <History size={22} color="#06b6d4" />
        <h1 style={{ fontSize: 22, fontWeight: 700, color: 'var(--input-text)', fontFamily: 'Syne, sans-serif', margin: 0 }}>
          Device History
        </h1>
        <button
          onClick={load}
          style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 5, background: 'none', border: '1px solid var(--bg-border)', borderRadius: 6, color: 'var(--label-color)', padding: '4px 10px', cursor: 'pointer', fontSize: 12 }}
        >
          <RefreshCw size={11} style={loading ? { animation: 'spin 1s linear infinite' } : undefined} />
          Refresh
        </button>
      </div>
      <p style={{ fontSize: 13, color: 'var(--label-color)', marginBottom: 24 }}>
        Persistent record of all devices seen across network discovery scans. Updated automatically while monitoring is active.
      </p>

      {error && (
        <div style={{ background: 'var(--sev-critical-bg)', border: '1px solid var(--sev-critical-border)', borderRadius: 8, padding: '10px 14px', marginBottom: 16, color: 'var(--sev-critical-color)', fontSize: 13 }}>
          {error}
        </div>
      )}

      {/* Stats row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 20 }}>
        {[
          { label: 'Total devices',  value: total,   color: '#06b6d4' },
          { label: 'Known',          value: known,   color: '#22c55e' },
          { label: 'Unknown',        value: unknown, color: '#f59e0b' },
        ].map(s => (
          <div key={s.label} style={{ background: 'var(--bg-surface)', border: '1px solid var(--bg-border)', borderRadius: 8, padding: '12px 16px' }}>
            <div style={{ fontSize: 24, fontWeight: 700, color: s.color, fontFamily: 'JetBrains Mono, monospace' }}>{s.value}</div>
            <div style={{ fontSize: 11, color: 'var(--label-color)', marginTop: 2, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{s.label}</div>
          </div>
        ))}
      </div>

      {/* Filter bar */}
      <div style={{
        background: 'var(--bg-surface)', border: '1px solid var(--bg-border)', borderRadius: 10,
        padding: '10px 14px', marginBottom: 16,
        display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
      }}>
        <Filter size={13} color="var(--label-color)" />

        {/* Search */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'var(--bg-base)', border: '1px solid var(--bg-border)', borderRadius: 6, padding: '5px 10px', flex: '0 0 220px' }}>
          <Search size={11} color="var(--label-color)" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search IP, MAC, vendor…"
            style={{ background: 'none', border: 'none', outline: 'none', color: 'var(--input-text)', fontSize: 12, fontFamily: 'JetBrains Mono, monospace', width: '100%' }}
          />
          {search && (
            <button onClick={() => setSearch('')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--label-color)', padding: 0, display: 'flex' }}>
              <X size={10} />
            </button>
          )}
        </div>

        {/* Known/unknown toggles */}
        <label style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer', fontSize: 12, color: showKnown ? '#22c55e' : 'var(--label-color)', userSelect: 'none' }}>
          <input type="checkbox" checked={showKnown} onChange={e => setShowKnown(e.target.checked)} style={{ accentColor: '#22c55e', width: 12, height: 12 }} />
          <Eye size={11} /> Known
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer', fontSize: 12, color: showUnknown ? '#f59e0b' : 'var(--label-color)', userSelect: 'none' }}>
          <input type="checkbox" checked={showUnknown} onChange={e => setShowUnknown(e.target.checked)} style={{ accentColor: '#f59e0b', width: 12, height: 12 }} />
          <EyeOff size={11} /> Unknown
        </label>

        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--label-color)' }}>
          {filtered.length} of {total}
        </span>
      </div>

      {/* Table */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--label-color)' }}>
          <RefreshCw size={28} style={{ animation: 'spin 1s linear infinite', display: 'inline-block', marginBottom: 12, color: 'var(--bg-border)' }} />
          <p style={{ fontSize: 13 }}>Loading device history…</p>
        </div>
      ) : filtered.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '70px 0', border: '1px dashed var(--bg-border)', borderRadius: 10, color: 'var(--label-color)' }}>
          <History size={52} color="var(--bg-border)" style={{ marginBottom: 16 }} />
          <p style={{ fontSize: 14, marginBottom: 6 }}>
            {total === 0 ? 'No devices in history yet' : 'No devices match your filter'}
          </p>
          <p style={{ fontSize: 12, color: 'var(--bg-border)' }}>
            {total === 0
              ? 'Start Network Discovery monitoring — devices will appear here automatically.'
              : 'Try adjusting your search or filters.'}
          </p>
        </div>
      ) : (
        <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--bg-border)', borderRadius: 10, overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily: 'JetBrains Mono, monospace' }}>
              <thead>
                <tr style={{ background: 'var(--bg-base)', borderBottom: '1px solid var(--bg-border)' }}>
                  {['', 'IP', 'MAC', 'Vendor', 'Label', 'Ports', 'First seen', 'Last seen', ''].map((h, i) => (
                    <th key={i} style={{
                      textAlign: 'left', padding: '8px 12px', color: 'var(--label-color)',
                      fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em',
                      fontWeight: 600, whiteSpace: 'nowrap',
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map(d => {
                  const isScanning  = !!scanning[d.mac]
                  const isExpanded  = expanded === d.mac
                  const hasPortData = d.open_ports !== null && d.open_ports !== undefined
                  const portCount   = hasPortData ? d.open_ports.length : null

                  return [
                    <tr key={d.mac} style={{ borderBottom: isExpanded ? 'none' : '1px solid var(--bg-border)' }}>
                      {/* Status / known dot */}
                      <td style={{ padding: '8px 12px', width: 28 }}>
                        <button
                          onClick={() => toggleKnown(d.mac)}
                          title={d.known ? 'Mark unknown' : 'Mark known'}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2, display: 'flex', alignItems: 'center' }}
                        >
                          {d.known
                            ? <CheckCircle size={14} color="#22c55e" />
                            : <span style={{ width: 14, height: 14, borderRadius: '50%', border: '1.5px solid var(--label-color)', display: 'inline-block', background: 'var(--bg-surface)' }} />
                          }
                        </button>
                      </td>

                      <td style={{ padding: '8px 12px', color: 'var(--input-text)' }}>{d.ip || '—'}</td>
                      <td style={{ padding: '8px 12px', color: 'var(--btn-ghost-color)', fontSize: 11 }}>{d.mac}</td>
                      <td style={{ padding: '8px 12px', color: 'var(--label-color)', maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.vendor || '—'}</td>
                      <td style={{ padding: '8px 12px', minWidth: 150 }}>
                        <LabelCell device={d} onSave={saveLabel} />
                      </td>

                      {/* Ports cell */}
                      <td style={{ padding: '8px 12px', whiteSpace: 'nowrap', width: 110 }}>
                        {isScanning ? (
                          <span style={{ display: 'flex', alignItems: 'center', gap: 5, color: '#06b6d4', fontSize: 11 }}>
                            <RefreshCw size={10} style={{ animation: 'spin 1s linear infinite' }} />
                            Scanning…
                          </span>
                        ) : hasPortData ? (
                          <button
                            onClick={() => setExpanded(isExpanded ? null : d.mac)}
                            style={{
                              display: 'flex', alignItems: 'center', gap: 4,
                              background: portCount > 0 ? 'var(--green-dim)' : 'var(--bg-base)',
                              border: `1px solid ${portCount > 0 ? 'var(--green-muted)' : 'var(--bg-border)'}`,
                              borderRadius: 5, padding: '2px 7px', cursor: 'pointer',
                              color: portCount > 0 ? 'var(--green-DEFAULT)' : 'var(--label-color)', fontSize: 11,
                            }}
                          >
                            {portCount > 0 ? portCount : 'none'}
                            {portCount > 0 && <span style={{ color: 'var(--label-color)' }}>open</span>}
                            {isExpanded
                              ? <ChevronDown size={9} />
                              : <ChevronRight size={9} />
                            }
                          </button>
                        ) : (
                          <button
                            onClick={() => d.source_device_id && d.ip ? setScanModal(d) : null}
                            title={!d.source_device_id ? 'No source agent — run a network scan first' : !d.ip ? 'No IP address' : 'Scan open ports'}
                            style={{
                              display: 'flex', alignItems: 'center', gap: 4,
                              background: 'none', border: '1px solid var(--bg-border)', borderRadius: 5,
                              padding: '2px 7px', cursor: d.source_device_id && d.ip ? 'pointer' : 'not-allowed',
                              color: d.source_device_id && d.ip ? 'var(--label-color)' : 'var(--bg-border)', fontSize: 11,
                              opacity: d.source_device_id && d.ip ? 1 : 0.4,
                            }}
                          >
                            <ScanLine size={9} />
                            Scan
                          </button>
                        )}
                      </td>

                      <td style={{ padding: '8px 12px', color: 'var(--label-color)', whiteSpace: 'nowrap' }} title={fmt(d.first_seen)}>{timeSince(d.first_seen)}</td>
                      <td style={{ padding: '8px 12px', color: 'var(--label-color)', whiteSpace: 'nowrap' }} title={fmt(d.last_seen)}>{timeSince(d.last_seen)}</td>
                      <td style={{ padding: '8px 8px', width: 64 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                          <button
                            onClick={() => navigate(`/network-device/${encodeURIComponent(d.mac)}`)}
                            title="View device details"
                            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#1e3a4a', padding: 2, display: 'flex', alignItems: 'center' }}
                            onMouseEnter={e => e.currentTarget.style.color = '#06b6d4'}
                            onMouseLeave={e => e.currentTarget.style.color = '#1e3a4a'}
                          >
                            <ExternalLink size={12} />
                          </button>
                          <button
                            onClick={() => remove(d.mac)}
                            title="Remove from history"
                            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--bg-border)', padding: 2, display: 'flex', alignItems: 'center' }}
                            onMouseEnter={e => e.currentTarget.style.color = '#ef4444'}
                            onMouseLeave={e => e.currentTarget.style.color = 'var(--bg-border)'}
                          >
                            <Trash2 size={12} />
                          </button>
                        </div>
                      </td>
                    </tr>,

                    isExpanded && hasPortData && (
                      <PortsExpanded key={`${d.mac}-ports`} device={d} colSpan={COL_COUNT} />
                    ),
                  ]
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
