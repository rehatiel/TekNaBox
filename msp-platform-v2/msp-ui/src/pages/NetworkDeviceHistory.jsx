/**
 * Network Device History — persistent record of all devices ever seen in scans.
 * Populated automatically when the Network Discovery monitoring is running.
 */

import { useState, useEffect, useCallback } from 'react'
import { api } from '../lib/api'
import {
  History, RefreshCw, CheckCircle, Trash2, X, Pencil, Check,
  Search, Filter, Eye, EyeOff,
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
            background: '#0a0c0f', border: '1px solid #1e2530', borderRadius: 4,
            color: '#e5e7eb', padding: '2px 6px', fontSize: 11,
            fontFamily: 'JetBrains Mono, monospace', width: 110, outline: 'none',
          }}
        />
        <button onClick={commit} style={iconBtn}><Check size={10} color="#22c55e" /></button>
        <button onClick={() => setEditing(false)} style={iconBtn}><X size={10} color="#6b7280" /></button>
      </span>
    )
  }

  return (
    <span
      onClick={() => setEditing(true)}
      title="Click to set label"
      style={{
        display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer',
        color: device.label ? '#9ca3af' : '#374151',
        fontSize: 11, fontFamily: 'JetBrains Mono, monospace',
      }}
    >
      {device.label || <span style={{ color: '#1e2530' }}>—</span>}
      <Pencil size={9} style={{ opacity: 0.4, flexShrink: 0 }} />
    </span>
  )
}

const iconBtn = {
  background: 'none', border: 'none', cursor: 'pointer', padding: 2,
  display: 'flex', alignItems: 'center',
}

// ── Main page ──────────────────────────────────────────────────────────────────

export default function NetworkDeviceHistoryPage() {
  const [devices,      setDevices]      = useState([])
  const [loading,      setLoading]      = useState(true)
  const [error,        setError]        = useState('')
  const [search,       setSearch]       = useState('')
  const [showUnknown,  setShowUnknown]  = useState(true)
  const [showKnown,    setShowKnown]    = useState(true)

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

  return (
    <div style={{ padding: '28px 32px', maxWidth: 1100, margin: '0 auto' }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
        <History size={22} color="#06b6d4" />
        <h1 style={{ fontSize: 22, fontWeight: 700, color: '#f3f4f6', fontFamily: 'Syne, sans-serif', margin: 0 }}>
          Device History
        </h1>
        <button
          onClick={load}
          style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 5, background: 'none', border: '1px solid #1e2530', borderRadius: 6, color: '#4b5563', padding: '4px 10px', cursor: 'pointer', fontSize: 12 }}
        >
          <RefreshCw size={11} style={loading ? { animation: 'spin 1s linear infinite' } : undefined} />
          Refresh
        </button>
      </div>
      <p style={{ fontSize: 13, color: '#4b5563', marginBottom: 24 }}>
        Persistent record of all devices seen across network discovery scans. Updated automatically while monitoring is active.
      </p>

      {error && (
        <div style={{ background: '#1a0a0a', border: '1px solid #450a0a', borderRadius: 8, padding: '10px 14px', marginBottom: 16, color: '#f87171', fontSize: 13 }}>
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
          <div key={s.label} style={{ background: '#0d1117', border: '1px solid #1e2530', borderRadius: 8, padding: '12px 16px' }}>
            <div style={{ fontSize: 24, fontWeight: 700, color: s.color, fontFamily: 'JetBrains Mono, monospace' }}>{s.value}</div>
            <div style={{ fontSize: 11, color: '#4b5563', marginTop: 2, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{s.label}</div>
          </div>
        ))}
      </div>

      {/* Filter bar */}
      <div style={{
        background: '#0d1117', border: '1px solid #1e2530', borderRadius: 10,
        padding: '10px 14px', marginBottom: 16,
        display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
      }}>
        <Filter size={13} color="#4b5563" />

        {/* Search */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: '#0a0c0f', border: '1px solid #1e2530', borderRadius: 6, padding: '5px 10px', flex: '0 0 220px' }}>
          <Search size={11} color="#4b5563" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search IP, MAC, vendor…"
            style={{ background: 'none', border: 'none', outline: 'none', color: '#e5e7eb', fontSize: 12, fontFamily: 'JetBrains Mono, monospace', width: '100%' }}
          />
          {search && (
            <button onClick={() => setSearch('')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#4b5563', padding: 0, display: 'flex' }}>
              <X size={10} />
            </button>
          )}
        </div>

        {/* Known/unknown toggles */}
        <label style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer', fontSize: 12, color: showKnown ? '#22c55e' : '#374151', userSelect: 'none' }}>
          <input type="checkbox" checked={showKnown} onChange={e => setShowKnown(e.target.checked)} style={{ accentColor: '#22c55e', width: 12, height: 12 }} />
          <Eye size={11} /> Known
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer', fontSize: 12, color: showUnknown ? '#f59e0b' : '#374151', userSelect: 'none' }}>
          <input type="checkbox" checked={showUnknown} onChange={e => setShowUnknown(e.target.checked)} style={{ accentColor: '#f59e0b', width: 12, height: 12 }} />
          <EyeOff size={11} /> Unknown
        </label>

        <span style={{ marginLeft: 'auto', fontSize: 11, color: '#374151' }}>
          {filtered.length} of {total}
        </span>
      </div>

      {/* Table */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: '60px 0', color: '#374151' }}>
          <RefreshCw size={28} style={{ animation: 'spin 1s linear infinite', display: 'inline-block', marginBottom: 12, color: '#1e2530' }} />
          <p style={{ fontSize: 13 }}>Loading device history…</p>
        </div>
      ) : filtered.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '70px 0', border: '1px dashed #1e2530', borderRadius: 10, color: '#374151' }}>
          <History size={52} color="#1e2530" style={{ marginBottom: 16 }} />
          <p style={{ fontSize: 14, marginBottom: 6 }}>
            {total === 0 ? 'No devices in history yet' : 'No devices match your filter'}
          </p>
          <p style={{ fontSize: 12, color: '#1e2530' }}>
            {total === 0
              ? 'Start Network Discovery monitoring — devices will appear here automatically.'
              : 'Try adjusting your search or filters.'}
          </p>
        </div>
      ) : (
        <div style={{ background: '#0d1117', border: '1px solid #1e2530', borderRadius: 10, overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily: 'JetBrains Mono, monospace' }}>
              <thead>
                <tr style={{ background: '#0a0c0f', borderBottom: '1px solid #1e2530' }}>
                  {['', 'IP', 'MAC', 'Vendor', 'Label', 'First seen', 'Last seen', ''].map((h, i) => (
                    <th key={i} style={{
                      textAlign: 'left', padding: '8px 12px', color: '#374151',
                      fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em',
                      fontWeight: 600, whiteSpace: 'nowrap',
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map(d => (
                  <tr key={d.mac} style={{ borderBottom: '1px solid #0a0c0f' }}>
                    {/* Status / known dot */}
                    <td style={{ padding: '8px 12px', width: 28 }}>
                      <button
                        onClick={() => toggleKnown(d.mac)}
                        title={d.known ? 'Mark unknown' : 'Mark known'}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2, display: 'flex', alignItems: 'center' }}
                      >
                        {d.known
                          ? <CheckCircle size={14} color="#22c55e" />
                          : <span style={{ width: 14, height: 14, borderRadius: '50%', border: '1.5px solid #374151', display: 'inline-block', background: '#0d1117' }} />
                        }
                      </button>
                    </td>

                    <td style={{ padding: '8px 12px', color: '#e5e7eb' }}>{d.ip || '—'}</td>
                    <td style={{ padding: '8px 12px', color: '#6b7280', fontSize: 11 }}>{d.mac}</td>
                    <td style={{ padding: '8px 12px', color: '#4b5563', maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.vendor || '—'}</td>
                    <td style={{ padding: '8px 12px', minWidth: 150 }}>
                      <LabelCell device={d} onSave={saveLabel} />
                    </td>
                    <td style={{ padding: '8px 12px', color: '#374151', whiteSpace: 'nowrap' }} title={fmt(d.first_seen)}>{timeSince(d.first_seen)}</td>
                    <td style={{ padding: '8px 12px', color: '#374151', whiteSpace: 'nowrap' }} title={fmt(d.last_seen)}>{timeSince(d.last_seen)}</td>
                    <td style={{ padding: '8px 8px', width: 32 }}>
                      <button
                        onClick={() => remove(d.mac)}
                        title="Remove from history"
                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#1e2530', padding: 2, display: 'flex', alignItems: 'center' }}
                        onMouseEnter={e => e.currentTarget.style.color = '#ef4444'}
                        onMouseLeave={e => e.currentTarget.style.color = '#1e2530'}
                      >
                        <Trash2 size={12} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
