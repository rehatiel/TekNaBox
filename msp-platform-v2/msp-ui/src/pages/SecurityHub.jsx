/**
 * Security Hub — unified launcher and results view for all security-oriented tasks.
 * Tasks: ssl_check, dns_health, default_creds, cleartext_services, smb_enum
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { api } from '../lib/api'
import {
  ShieldCheck, ShieldAlert, ShieldX, Lock, Globe, Key,
  Eye, Share2, RefreshCw, Play, ChevronDown, ChevronRight,
  AlertTriangle, Info, CheckCircle, XCircle, Clock, Loader2,
  Server, Wifi, FileSearch
} from 'lucide-react'

// ── Severity helpers ──────────────────────────────────────────────────────────

const SEV = {
  critical: { color: '#ef4444', bg: '#450a0a', border: '#7f1d1d', label: 'Critical', order: 0 },
  high:     { color: '#f97316', bg: '#431407', border: '#7c2d12', label: 'High',     order: 1 },
  medium:   { color: '#eab308', bg: '#422006', border: '#713f12', label: 'Medium',   order: 2 },
  low:      { color: '#06b6d4', bg: '#0c1a1f', border: '#164e63', label: 'Low',      order: 3 },
  info:     { color: '#6b7280', bg: '#111827', border: '#1f2937', label: 'Info',     order: 4 },
}

function SevBadge({ sev }) {
  const s = SEV[sev] || SEV.info
  return (
    <span style={{
      fontSize: '11px', fontWeight: 700, letterSpacing: '0.06em',
      textTransform: 'uppercase', padding: '2px 8px', borderRadius: 4,
      color: s.color, background: s.bg, border: `1px solid ${s.border}`,
    }}>{s.label}</span>
  )
}

// ── Task definitions ──────────────────────────────────────────────────────────

const SECURITY_TASKS = [
  {
    id: 'run_ssl_check',
    label: 'SSL/TLS Certificate Check',
    icon: Lock,
    description: 'Verify cert expiry, cipher suites, and SAN coverage across hosts',
    color: '#06b6d4',
    defaultPayload: { targets: [], warn_days: 30 },
    fields: [
      { key: 'targets', label: 'Targets (host:port)', type: 'hostlist',
        placeholder: 'example.com:443\nmail.example.com:443' },
      { key: 'warn_days', label: 'Warn if expiring within (days)', type: 'number', min: 1, max: 365 },
    ],
    extractFindings: (r) => (r.results || []).filter(h => h.status !== 'ok').map(h => ({
      severity: h.status === 'expired' ? 'critical' : h.status === 'expiring_soon' ? 'high' : 'medium',
      title: h.status === 'expired' ? `Certificate expired: ${h.host}` : `Certificate expiring: ${h.host}`,
      detail: h.status === 'expiring_soon'
        ? `${h.days_remaining} days remaining. Expires ${h.expires_at?.slice(0,10)}.`
        : h.error || `Issuer: ${h.issuer}`,
    })),
  },
  {
    id: 'run_dns_health',
    label: 'DNS & Email Security',
    icon: Globe,
    description: 'SPF, DKIM, DMARC, NS consistency, and SOA serial checks',
    color: '#a78bfa',
    defaultPayload: { domain: '', check_email: true, dkim_selector: 'default' },
    fields: [
      { key: 'domain', label: 'Domain', type: 'text', placeholder: 'example.com' },
      { key: 'dkim_selector', label: 'DKIM Selector', type: 'text', placeholder: 'default' },
    ],
    extractFindings: (r) => r.findings || [],
  },
  {
    id: 'run_default_creds',
    label: 'Default Credential Check',
    icon: Key,
    description: 'Test common vendor defaults on Ubiquiti, Hikvision, Cisco, printers, IPMI, and more',
    color: '#f97316',
    defaultPayload: { targets: [], checks: ['http_basic','ubiquiti','hikvision','dahua','cisco','mikrotik','printer','ipmi'] },
    fields: [
      { key: 'targets', label: 'Targets (IPs / hostnames)', type: 'hostlist',
        placeholder: '192.168.1.1\n192.168.1.2' },
      { key: 'checks', label: 'Device Types', type: 'multicheck',
        options: ['http_basic','ubiquiti','hikvision','dahua','cisco','mikrotik','printer','ipmi'] },
    ],
    extractFindings: (r) => r.findings || [],
  },
  {
    id: 'run_cleartext_services',
    label: 'Cleartext Service Scan',
    icon: Eye,
    description: 'Detect Telnet, FTP, HTTP Basic Auth, LDAP, VNC, SNMP v1/v2, and more',
    color: '#ef4444',
    defaultPayload: { targets: [], checks: ['telnet','ftp','smtp_plain','http_basic','ldap_plain','vnc','imap_plain','pop3_plain','snmp_v1v2'] },
    fields: [
      { key: 'targets', label: 'Targets (IPs / hostnames)', type: 'hostlist',
        placeholder: '192.168.1.0/24' },
    ],
    extractFindings: (r) => r.findings || [],
  },
  {
    id: 'run_smb_enum',
    label: 'SMB Share Enumeration',
    icon: Share2,
    description: 'List shares, detect null sessions, guest access, and sensitive share names',
    color: '#22c55e',
    defaultPayload: { targets: [], username: '', password: '', domain: 'WORKGROUP' },
    fields: [
      { key: 'targets', label: 'Targets (IPs / hostnames)', type: 'hostlist',
        placeholder: '192.168.1.10\n192.168.1.11' },
      { key: 'username', label: 'Username (blank = null session)', type: 'text', placeholder: '' },
      { key: 'password', label: 'Password', type: 'password', placeholder: '' },
      { key: 'domain', label: 'Domain / Workgroup', type: 'text', placeholder: 'WORKGROUP' },
    ],
    extractFindings: (r) => r.findings || [],
    sensitiveFields: ['password'],
  },
]

// ── Payload form ──────────────────────────────────────────────────────────────

function PayloadForm({ task, payload, onChange }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {task.fields.map(f => {
        if (f.type === 'hostlist') return (
          <label key={f.key} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 12, color: '#9ca3af', fontFamily: 'JetBrains Mono, monospace' }}>{f.label}</span>
            <textarea
              rows={4}
              placeholder={f.placeholder}
              value={Array.isArray(payload[f.key]) ? payload[f.key].join('\n') : payload[f.key] || ''}
              onChange={e => onChange({ ...payload, [f.key]: e.target.value.split('\n').map(s => s.trim()).filter(Boolean) })}
              style={{
                background: '#0a0c0f', border: '1px solid #1e2530', borderRadius: 6,
                color: '#e5e7eb', padding: '8px 10px', fontSize: 12,
                fontFamily: 'JetBrains Mono, monospace', resize: 'vertical',
              }}
            />
          </label>
        )
        if (f.type === 'multicheck') return (
          <label key={f.key} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 12, color: '#9ca3af', fontFamily: 'JetBrains Mono, monospace' }}>{f.label}</span>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {f.options.map(opt => {
                const active = (payload[f.key] || []).includes(opt)
                return (
                  <button key={opt} onClick={() => {
                    const cur = payload[f.key] || []
                    onChange({ ...payload, [f.key]: active ? cur.filter(x => x !== opt) : [...cur, opt] })
                  }} style={{
                    fontSize: 11, padding: '3px 10px', borderRadius: 20, cursor: 'pointer',
                    fontFamily: 'JetBrains Mono, monospace', transition: 'all 0.15s',
                    background: active ? '#0e4155' : '#111827',
                    border: `1px solid ${active ? '#06b6d4' : '#1e2530'}`,
                    color: active ? '#06b6d4' : '#6b7280',
                  }}>{opt}</button>
                )
              })}
            </div>
          </label>
        )
        return (
          <label key={f.key} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 12, color: '#9ca3af', fontFamily: 'JetBrains Mono, monospace' }}>{f.label}</span>
            <input
              type={f.type === 'password' ? 'password' : f.type === 'number' ? 'number' : 'text'}
              placeholder={f.placeholder || ''}
              min={f.min} max={f.max}
              value={payload[f.key] ?? ''}
              onChange={e => onChange({
                ...payload,
                [f.key]: f.type === 'number' ? Number(e.target.value) : e.target.value
              })}
              style={{
                background: '#0a0c0f', border: '1px solid #1e2530', borderRadius: 6,
                color: '#e5e7eb', padding: '7px 10px', fontSize: 13,
                fontFamily: 'JetBrains Mono, monospace', outline: 'none',
              }}
            />
          </label>
        )
      })}
    </div>
  )
}

// ── Finding card ──────────────────────────────────────────────────────────────

function FindingCard({ f }) {
  const [open, setOpen] = useState(false)
  const s = SEV[f.severity] || SEV.info
  return (
    <div onClick={() => setOpen(o => !o)} style={{
      background: s.bg, border: `1px solid ${s.border}`, borderRadius: 8,
      cursor: 'pointer', overflow: 'hidden', transition: 'all 0.15s',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px' }}>
        <SevBadge sev={f.severity} />
        <span style={{ flex: 1, fontSize: 13, color: '#e5e7eb', fontWeight: 500 }}>{f.title}</span>
        {f.host && <span style={{ fontSize: 11, color: '#6b7280', fontFamily: 'JetBrains Mono, monospace' }}>{f.host}</span>}
        {open ? <ChevronDown size={14} color="#6b7280" /> : <ChevronRight size={14} color="#6b7280" />}
      </div>
      {open && (
        <div style={{ borderTop: `1px solid ${s.border}`, padding: '10px 14px' }}>
          <p style={{ fontSize: 13, color: '#9ca3af', margin: 0, lineHeight: 1.6 }}>{f.detail}</p>
        </div>
      )}
    </div>
  )
}

// ── Task panel ────────────────────────────────────────────────────────────────

function TaskPanel({ task, deviceId }) {
  const [expanded, setExpanded] = useState(false)
  const [payload, setPayload] = useState({ ...task.defaultPayload })
  const [running, setRunning]   = useState(false)
  const [taskId, setTaskId]     = useState(null)
  const [result, setResult]     = useState(null)
  const [error, setError]       = useState(null)
  const pollRef = useRef(null)

  const Icon = task.icon

  const launch = useCallback(async () => {
    if (!deviceId) { setError('Select a device first'); return }
    setRunning(true); setResult(null); setError(null)
    try {
      const { task_id } = await api.issueTask(deviceId, {
        task_type: task.id,
        payload,
        timeout_seconds: 180,
      })
      setTaskId(task_id)
      pollRef.current = setInterval(async () => {
        try {
          const tasks = await api.getTasks(deviceId)
          const t = tasks.find(t => t.id === task_id)
          if (t?.status === 'completed') {
            clearInterval(pollRef.current)
            setRunning(false)
            setResult(t.result)
          } else if (t?.status === 'failed' || t?.status === 'timeout') {
            clearInterval(pollRef.current)
            setRunning(false)
            setError(t.error || t.status)
          }
        } catch {}
      }, 2500)
    } catch (e) {
      setRunning(false)
      setError(e.message)
    }
  }, [deviceId, payload, task])

  useEffect(() => () => clearInterval(pollRef.current), [])

  const findings = result ? task.extractFindings(result) : []
  const findingsBySev = findings.slice().sort((a, b) =>
    (SEV[a.severity]?.order ?? 9) - (SEV[b.severity]?.order ?? 9)
  )

  const critCount = findings.filter(f => f.severity === 'critical').length
  const highCount = findings.filter(f => f.severity === 'high').length

  return (
    <div style={{
      background: '#0d1117', border: '1px solid #1e2530', borderRadius: 12,
      overflow: 'hidden', transition: 'border-color 0.2s',
    }}>
      {/* Header */}
      <div onClick={() => setExpanded(e => !e)} style={{
        display: 'flex', alignItems: 'center', gap: 14, padding: '16px 20px',
        cursor: 'pointer', userSelect: 'none',
      }}>
        <div style={{
          width: 36, height: 36, borderRadius: 8, display: 'flex',
          alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          background: `${task.color}18`, border: `1px solid ${task.color}40`,
        }}>
          <Icon size={16} color={task.color} />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#f3f4f6' }}>{task.label}</div>
          <div style={{ fontSize: 12, color: '#4b5563', marginTop: 2 }}>{task.description}</div>
        </div>

        {/* Status indicators */}
        {running && <Loader2 size={16} color="#06b6d4" style={{ animation: 'spin 1s linear infinite' }} />}
        {result && !running && (
          <div style={{ display: 'flex', gap: 6 }}>
            {critCount > 0 && <span style={{ fontSize: 11, background: '#450a0a', color: '#ef4444', border: '1px solid #7f1d1d', borderRadius: 4, padding: '1px 7px', fontWeight: 700 }}>{critCount} CRIT</span>}
            {highCount > 0 && <span style={{ fontSize: 11, background: '#431407', color: '#f97316', border: '1px solid #7c2d12', borderRadius: 4, padding: '1px 7px', fontWeight: 700 }}>{highCount} HIGH</span>}
            {findings.length === 0 && <CheckCircle size={16} color="#22c55e" />}
          </div>
        )}
        {error && !running && <AlertTriangle size={16} color="#ef4444" />}
        {expanded ? <ChevronDown size={16} color="#4b5563" /> : <ChevronRight size={16} color="#4b5563" />}
      </div>

      {/* Body */}
      {expanded && (
        <div style={{ borderTop: '1px solid #1e2530', padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          <PayloadForm task={task} payload={payload} onChange={setPayload} />

          <button onClick={launch} disabled={running} style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
            padding: '9px 20px', borderRadius: 8, border: 'none', cursor: running ? 'not-allowed' : 'pointer',
            background: running ? '#1e2530' : task.color, color: running ? '#4b5563' : '#000',
            fontWeight: 700, fontSize: 13, transition: 'all 0.15s',
          }}>
            {running ? <><Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> Running…</> : <><Play size={14} /> Run</>}
          </button>

          {error && (
            <div style={{ background: '#1a0a0a', border: '1px solid #7f1d1d', borderRadius: 8, padding: '10px 14px', color: '#ef4444', fontSize: 13, fontFamily: 'JetBrains Mono, monospace' }}>
              {error}
            </div>
          )}

          {result && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {/* Summary bar */}
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                {result.targets_checked !== undefined && (
                  <Stat label="Checked" value={result.targets_checked} />
                )}
                {result.findings_count !== undefined && (
                  <Stat label="Findings" value={result.findings_count} highlight={result.findings_count > 0} />
                )}
                {result.summary && Object.entries(result.summary).map(([k, v]) => (
                  <Stat key={k} label={k.replace(/_/g, ' ')} value={v} />
                ))}
              </div>

              {findingsBySev.length > 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ fontSize: 11, color: '#4b5563', textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 700 }}>Findings</div>
                  {findingsBySev.map((f, i) => <FindingCard key={i} f={f} />)}
                </div>
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#22c55e', fontSize: 13 }}>
                  <CheckCircle size={16} /> No findings — all checks passed
                </div>
              )}

              {/* Raw result toggle */}
              <RawResult result={result} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function Stat({ label, value, highlight }) {
  return (
    <div style={{
      background: '#111827', border: '1px solid #1e2530', borderRadius: 6,
      padding: '6px 12px', display: 'flex', gap: 8, alignItems: 'baseline',
    }}>
      <span style={{ fontSize: 18, fontWeight: 700, color: highlight ? '#f97316' : '#e5e7eb', fontFamily: 'JetBrains Mono, monospace' }}>{value}</span>
      <span style={{ fontSize: 11, color: '#4b5563', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</span>
    </div>
  )
}

function RawResult({ result }) {
  const [show, setShow] = useState(false)
  return (
    <div>
      <button onClick={() => setShow(s => !s)} style={{
        fontSize: 11, color: '#4b5563', background: 'none', border: 'none',
        cursor: 'pointer', padding: 0, textDecoration: 'underline', fontFamily: 'JetBrains Mono, monospace',
      }}>{show ? 'hide raw' : 'show raw json'}</button>
      {show && (
        <pre style={{
          fontSize: 11, color: '#6b7280', background: '#0a0c0f', border: '1px solid #1e2530',
          borderRadius: 6, padding: 12, overflow: 'auto', maxHeight: 300, marginTop: 8,
          fontFamily: 'JetBrains Mono, monospace',
        }}>{JSON.stringify(result, null, 2)}</pre>
      )}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function SecurityHubPage() {
  const [devices, setDevices]     = useState([])
  const [deviceId, setDeviceId]   = useState('')
  const [loading, setLoading]     = useState(true)

  useEffect(() => {
    api.getDevices({ status: 'active' })
      .then(d => { setDevices(d); if (d.length === 1) setDeviceId(d[0].id) })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const device = devices.find(d => d.id === deviceId)

  return (
    <div style={{ padding: '28px 32px', maxWidth: 900, margin: '0 auto' }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 28 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
            <ShieldCheck size={22} color="#06b6d4" />
            <h1 style={{ fontSize: 22, fontWeight: 700, color: '#f3f4f6', fontFamily: 'Syne, sans-serif', margin: 0 }}>
              Security Hub
            </h1>
          </div>
          <p style={{ fontSize: 13, color: '#4b5563', margin: 0 }}>
            Run security checks from a connected agent — certs, DNS, default credentials, cleartext services, and SMB
          </p>
        </div>
      </div>

      {/* Device selector */}
      <div style={{
        background: '#0d1117', border: '1px solid #1e2530', borderRadius: 10,
        padding: '14px 18px', marginBottom: 24, display: 'flex', alignItems: 'center', gap: 14,
      }}>
        <Server size={16} color="#06b6d4" />
        <span style={{ fontSize: 13, color: '#6b7280', fontWeight: 500, whiteSpace: 'nowrap' }}>Run from agent:</span>
        <select
          value={deviceId}
          onChange={e => setDeviceId(e.target.value)}
          style={{
            flex: 1, background: '#0a0c0f', border: '1px solid #1e2530', borderRadius: 6,
            color: deviceId ? '#e5e7eb' : '#4b5563', padding: '7px 10px', fontSize: 13,
            fontFamily: 'JetBrains Mono, monospace', outline: 'none', cursor: 'pointer',
          }}
        >
          <option value="">— select active device —</option>
          {devices.map(d => (
            <option key={d.id} value={d.id}>{d.name} ({d.last_ip || 'no IP'})</option>
          ))}
        </select>
        {device && (
          <span style={{
            fontSize: 11, padding: '3px 8px', borderRadius: 20, fontFamily: 'JetBrains Mono, monospace',
            background: '#0e2a1a', border: '1px solid #166534', color: '#4ade80',
          }}>ONLINE</span>
        )}
      </div>

      {/* Task panels */}
      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}>
          <Loader2 size={24} color="#06b6d4" style={{ animation: 'spin 1s linear infinite' }} />
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {SECURITY_TASKS.map(task => (
            <TaskPanel key={task.id} task={task} deviceId={deviceId} />
          ))}
        </div>
      )}
    </div>
  )
}
