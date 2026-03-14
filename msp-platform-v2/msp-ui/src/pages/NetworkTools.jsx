/**
 * Network Discovery — unified launcher for network recon tasks.
 * Tasks: arp_scan, ping_sweep, netbios_scan, ntp_check, lldp_neighbors, wol
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { api } from '../lib/api'
import {
  Network, Radar, Cpu, Clock, Layers, Zap,
  Play, ChevronDown, ChevronRight, Loader2,
  CheckCircle, AlertTriangle, Server, Wifi,
  Monitor, HardDrive, MapPin
} from 'lucide-react'

// ── Task definitions ──────────────────────────────────────────────────────────

const NET_TASKS = [
  {
    id: 'run_arp_scan',
    label: 'ARP Scan',
    icon: Radar,
    description: 'Fast Layer-2 host discovery using ARP — finds everything on the local subnet',
    color: '#06b6d4',
    defaultPayload: { interface: 'eth0', timeout: 10 },
    fields: [
      { key: 'interface', label: 'Interface', type: 'interface', placeholder: 'eth0' },
      { key: 'timeout',   label: 'Timeout (seconds)', type: 'number', min: 1, max: 60 },
    ],
    renderResult: ArpResult,
  },
  {
    id: 'run_ping_sweep',
    label: 'Ping Sweep',
    icon: Radar,
    description: 'ICMP ping across a subnet or range to find live hosts',
    color: '#22c55e',
    defaultPayload: { network: '', timeout: 1, concurrency: 50 },
    fields: [
      { key: 'network', label: 'Network (CIDR)', type: 'text', placeholder: '192.168.1.0/24' },
      { key: 'timeout', label: 'Timeout per host (s)', type: 'number', min: 0.1, max: 5 },
    ],
    renderResult: PingSweepResult,
  },
  {
    id: 'run_netbios_scan',
    label: 'NetBIOS / NBNS Scan',
    icon: Monitor,
    description: 'Discover Windows machine names, workgroups, and domain controllers via NBNS',
    color: '#a78bfa',
    defaultPayload: { targets: [], timeout: 2 },
    fields: [
      { key: 'targets', label: 'Targets (IPs or CIDRs)', type: 'hostlist',
        placeholder: '192.168.1.0/24' },
      { key: 'timeout', label: 'Per-host timeout (s)', type: 'number', min: 0.5, max: 10 },
    ],
    renderResult: NetbiosResult,
  },
  {
    id: 'run_lldp_neighbors',
    label: 'LLDP / CDP Neighbor Discovery',
    icon: Layers,
    description: 'Passively capture LLDP and CDP frames to map connected switches, APs, and phones',
    color: '#f97316',
    defaultPayload: { interface: 'eth0', duration: 35 },
    fields: [
      { key: 'interface', label: 'Interface', type: 'interface', placeholder: 'eth0' },
      { key: 'duration',  label: 'Listen duration (seconds)', type: 'number', min: 10, max: 120 },
    ],
    renderResult: LldpResult,
    note: 'LLDP frames are sent every 30s — set duration to at least 35s to catch one cycle.',
  },
  {
    id: 'run_ntp_check',
    label: 'NTP Sync Check',
    icon: Clock,
    description: 'Verify agent clock offset against public NTP servers and check local sync status',
    color: '#eab308',
    defaultPayload: { warn_offset_ms: 500 },
    fields: [
      { key: 'warn_offset_ms', label: 'Warn if offset exceeds (ms)', type: 'number', min: 10, max: 10000 },
    ],
    renderResult: NtpResult,
  },
  {
    id: 'run_wol',
    label: 'Wake-on-LAN',
    icon: Zap,
    description: 'Send magic packets to wake devices on the local subnet',
    color: '#ec4899',
    defaultPayload: { targets: [], count: 3 },
    fields: [
      { key: 'targets', label: 'MAC addresses (one per line)', type: 'hostlist',
        placeholder: 'AA:BB:CC:DD:EE:FF\n11:22:33:44:55:66' },
      { key: 'count', label: 'Packets per target', type: 'number', min: 1, max: 10 },
    ],
    renderResult: WolResult,
  },
]

// ── Result renderers ──────────────────────────────────────────────────────────

function ArpResult({ result }) {
  const hosts = result.hosts || []
  return (
    <div>
      <SummaryRow items={[
        { label: 'Hosts found', value: hosts.length },
        { label: 'Interface', value: result.interface },
      ]} />
      {hosts.length > 0 && (
        <HostTable columns={['IP', 'MAC', 'Vendor']} rows={hosts.map(h => [
          h.ip, h.mac, h.vendor || '—'
        ])} />
      )}
    </div>
  )
}

function PingSweepResult({ result }) {
  const alive = (result.hosts || []).filter(h => h.alive)
  return (
    <div>
      <SummaryRow items={[
        { label: 'Total hosts', value: result.total },
        { label: 'Alive', value: alive.length },
        { label: 'Duration', value: `${result.duration_ms}ms` },
      ]} />
      {alive.length > 0 && (
        <HostTable columns={['IP', 'RTT (ms)', 'PTR']} rows={alive.map(h => [
          h.ip, h.rtt_ms?.toFixed(1) ?? '—', h.ptr || '—'
        ])} />
      )}
    </div>
  )
}

function NetbiosResult({ result }) {
  const found = result.hosts_found || 0
  return (
    <div>
      <SummaryRow items={[
        { label: 'Queried', value: result.hosts_queried },
        { label: 'Found', value: found },
      ]} />
      {(result.hosts || []).filter(h => h.names?.length).length > 0 && (
        <HostTable
          columns={['IP', 'Hostname', 'Workgroup', 'MAC', 'DC']}
          rows={(result.hosts || []).filter(h => h.names?.length).map(h => [
            h.ip, h.hostname || '—', h.workgroup || '—',
            h.mac || '—',
            h.is_dc ? '✓' : '',
          ])}
        />
      )}
    </div>
  )
}

function LldpResult({ result }) {
  const neighbors = result.neighbors || []
  return (
    <div>
      <SummaryRow items={[
        { label: 'Neighbors', value: neighbors.length },
        { label: 'Interface', value: result.interface },
        { label: 'Listen time', value: `${result.duration_s}s` },
      ]} />
      {neighbors.length === 0 && (
        <div style={{ fontSize: 13, color: '#4b5563', padding: '8px 0' }}>
          No LLDP/CDP frames received. Ensure the upstream switch has LLDP enabled.
        </div>
      )}
      {neighbors.map((nb, i) => (
        <div key={i} style={{
          background: '#111827', border: '1px solid #1e2530', borderRadius: 8,
          padding: '12px 16px', marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4,
        }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Layers size={14} color="#f97316" />
            <span style={{ fontWeight: 600, color: '#e5e7eb', fontSize: 14 }}>
              {nb.system_name || nb.device_id || 'Unknown neighbor'}
            </span>
            <span style={{ fontSize: 11, color: '#4b5563', fontFamily: 'JetBrains Mono, monospace' }}>{nb.protocol}</span>
          </div>
          {nb.port_id && <KV k="Port" v={nb.port_id} />}
          {nb.port_description && <KV k="Port desc" v={nb.port_description} />}
          {nb.system_description && <KV k="Description" v={nb.system_description} />}
          {nb.mgmt_address && <KV k="Mgmt IP" v={nb.mgmt_address} />}
          {nb.chassis_id && <KV k="Chassis ID" v={nb.chassis_id} />}
          {nb.capabilities?.length > 0 && <KV k="Capabilities" v={nb.capabilities.join(', ')} />}
        </div>
      ))}
    </div>
  )
}

function NtpResult({ result }) {
  const statusColor = result.status === 'ok' ? '#22c55e' : result.status === 'drifted' ? '#f97316' : '#ef4444'
  return (
    <div>
      <SummaryRow items={[
        { label: 'Status', value: result.status?.toUpperCase(), color: statusColor },
        { label: 'Avg offset', value: result.avg_offset_ms != null ? `${result.avg_offset_ms}ms` : '—' },
        { label: 'Warn threshold', value: `${result.warn_offset_ms}ms` },
      ]} />
      {result.local_sync && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 11, color: '#4b5563', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>Local Sync</div>
          <KV k="Synchronized" v={result.local_sync.synchronized ? 'Yes' : 'No'} />
          {result.local_sync.source && <KV k="Source" v={result.local_sync.source} />}
          {result.local_sync.offset_ms != null && <KV k="Offset" v={`${result.local_sync.offset_ms}ms`} />}
        </div>
      )}
      {result.server_results?.length > 0 && (
        <HostTable
          columns={['NTP Server', 'Reachable', 'RTT (ms)', 'Offset (ms)', 'Stratum']}
          rows={result.server_results.map(s => [
            s.server,
            s.reachable ? '✓' : '✗',
            s.rtt_ms ?? '—',
            s.offset_ms ?? '—',
            s.stratum ?? '—',
          ])}
        />
      )}
    </div>
  )
}

function WolResult({ result }) {
  return (
    <div>
      <SummaryRow items={[
        { label: 'Targets', value: result.targets },
        { label: 'Sent', value: result.sent },
      ]} />
      <HostTable
        columns={['MAC', 'Broadcast', 'Sent', 'Packets']}
        rows={(result.results || []).map(r => [
          r.mac, r.broadcast, r.sent ? '✓' : '✗', r.packets_sent ?? r.error ?? '—'
        ])}
      />
    </div>
  )
}

// ── Shared sub-components ─────────────────────────────────────────────────────

function SummaryRow({ items }) {
  return (
    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
      {items.map((item, i) => (
        <div key={i} style={{
          background: '#0a0c0f', border: '1px solid #1e2530', borderRadius: 6,
          padding: '5px 12px', display: 'flex', gap: 8, alignItems: 'baseline',
        }}>
          <span style={{ fontSize: 16, fontWeight: 700, color: item.color || '#e5e7eb', fontFamily: 'JetBrains Mono, monospace' }}>{item.value}</span>
          <span style={{ fontSize: 11, color: '#4b5563', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{item.label}</span>
        </div>
      ))}
    </div>
  )
}

function HostTable({ columns, rows }) {
  return (
    <div style={{ overflowX: 'auto', marginTop: 8 }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily: 'JetBrains Mono, monospace' }}>
        <thead>
          <tr>
            {columns.map(c => (
              <th key={c} style={{ textAlign: 'left', padding: '6px 10px', color: '#4b5563', borderBottom: '1px solid #1e2530', fontWeight: 600, textTransform: 'uppercase', fontSize: 10, letterSpacing: '0.08em' }}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} style={{ borderBottom: '1px solid #111827' }}>
              {row.map((cell, j) => (
                <td key={j} style={{ padding: '7px 10px', color: '#9ca3af' }}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function KV({ k, v }) {
  return (
    <div style={{ display: 'flex', gap: 12, fontSize: 12 }}>
      <span style={{ color: '#4b5563', minWidth: 100, fontFamily: 'JetBrains Mono, monospace' }}>{k}</span>
      <span style={{ color: '#9ca3af', fontFamily: 'JetBrains Mono, monospace', wordBreak: 'break-all' }}>{v}</span>
    </div>
  )
}

// ── Payload form ──────────────────────────────────────────────────────────────

function PayloadForm({ task, payload, onChange, interfaces }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {task.fields.map(f => {
        if (f.type === 'hostlist') return (
          <label key={f.key} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 12, color: '#6b7280', fontFamily: 'JetBrains Mono, monospace' }}>{f.label}</span>
            <textarea
              rows={3}
              placeholder={f.placeholder}
              value={Array.isArray(payload[f.key]) ? payload[f.key].join('\n') : payload[f.key] || ''}
              onChange={e => onChange({ ...payload, [f.key]: e.target.value.split('\n').map(s => s.trim()).filter(Boolean) })}
              style={{ background: '#0a0c0f', border: '1px solid #1e2530', borderRadius: 6, color: '#e5e7eb', padding: '8px 10px', fontSize: 12, fontFamily: 'JetBrains Mono, monospace', resize: 'vertical' }}
            />
          </label>
        )

        if (f.type === 'interface') return (
          <label key={f.key} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 12, color: '#6b7280', fontFamily: 'JetBrains Mono, monospace' }}>{f.label}</span>
            {interfaces && interfaces.length > 0 ? (
              <select
                value={payload[f.key] ?? ''}
                onChange={e => onChange({ ...payload, [f.key]: e.target.value })}
                style={{ background: '#0a0c0f', border: '1px solid #1e2530', borderRadius: 6, color: '#e5e7eb', padding: '7px 10px', fontSize: 13, fontFamily: 'JetBrains Mono, monospace', outline: 'none', cursor: 'pointer' }}
              >
                {interfaces.map(name => <option key={name} value={name}>{name}</option>)}
              </select>
            ) : (
              <input
                type="text"
                placeholder={f.placeholder || 'eth0'}
                value={payload[f.key] ?? ''}
                onChange={e => onChange({ ...payload, [f.key]: e.target.value })}
                style={{ background: '#0a0c0f', border: '1px solid #1e2530', borderRadius: 6, color: '#e5e7eb', padding: '7px 10px', fontSize: 13, fontFamily: 'JetBrains Mono, monospace' }}
              />
            )}
          </label>
        )

        return (
          <label key={f.key} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 12, color: '#6b7280', fontFamily: 'JetBrains Mono, monospace' }}>{f.label}</span>
            <input
              type={f.type === 'number' ? 'number' : 'text'}
              min={f.min} max={f.max} step={f.min < 1 ? 0.1 : 1}
              placeholder={f.placeholder || ''}
              value={payload[f.key] ?? ''}
              onChange={e => onChange({ ...payload, [f.key]: f.type === 'number' ? Number(e.target.value) : e.target.value })}
              style={{ background: '#0a0c0f', border: '1px solid #1e2530', borderRadius: 6, color: '#e5e7eb', padding: '7px 10px', fontSize: 13, fontFamily: 'JetBrains Mono, monospace' }}
            />
          </label>
        )
      })}
    </div>
  )
}

// ── Task panel ────────────────────────────────────────────────────────────────

function TaskPanel({ task, deviceId, interfaces }) {
  const [expanded, setExpanded] = useState(false)
  const [payload, setPayload]   = useState({ ...task.defaultPayload })
  const [running, setRunning]   = useState(false)
  const [result, setResult]     = useState(null)
  const [error, setError]       = useState(null)
  const pollRef = useRef(null)
  const Icon = task.icon
  const ResultRenderer = task.renderResult

  // When interface list arrives, update payload for interface fields if still on default
  useEffect(() => {
    const hasIfaceField = task.fields.some(f => f.type === 'interface')
    if (!hasIfaceField || !interfaces || interfaces.length === 0) return
    setPayload(prev => {
      const cur = prev.interface
      if (!cur || cur === 'eth0' || !interfaces.includes(cur)) {
        return { ...prev, interface: interfaces[0] }
      }
      return prev
    })
  }, [interfaces, task.fields])

  const launch = useCallback(async () => {
    if (!deviceId) { setError('Select a device first'); return }
    setRunning(true); setResult(null); setError(null)
    try {
      const { task_id } = await api.issueTask(deviceId, {
        task_type: task.id,
        payload,
        timeout_seconds: task.id === 'run_lldp_neighbors' ? payload.duration + 20 : 120,
      })
      pollRef.current = setInterval(async () => {
        try {
          const tasks = await api.getTasks(deviceId)
          const t = tasks.find(t => t.id === task_id)
          if (t?.status === 'completed') {
            clearInterval(pollRef.current)
            setRunning(false); setResult(t.result)
          } else if (t?.status === 'failed' || t?.status === 'timeout') {
            clearInterval(pollRef.current)
            setRunning(false); setError(t.error || t.status)
          }
        } catch {}
      }, 2500)
    } catch (e) {
      setRunning(false); setError(e.message)
    }
  }, [deviceId, payload, task])

  useEffect(() => () => clearInterval(pollRef.current), [])

  return (
    <div style={{ background: '#0d1117', border: '1px solid #1e2530', borderRadius: 12, overflow: 'hidden' }}>
      <div onClick={() => setExpanded(e => !e)} style={{
        display: 'flex', alignItems: 'center', gap: 14, padding: '15px 20px', cursor: 'pointer', userSelect: 'none',
      }}>
        <div style={{
          width: 34, height: 34, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: `${task.color}18`, border: `1px solid ${task.color}40`, flexShrink: 0,
        }}>
          <Icon size={15} color={task.color} />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#f3f4f6' }}>{task.label}</div>
          <div style={{ fontSize: 12, color: '#374151', marginTop: 2 }}>{task.description}</div>
        </div>
        {running && <Loader2 size={15} color="#06b6d4" style={{ animation: 'spin 1s linear infinite' }} />}
        {result && !running && <CheckCircle size={15} color="#22c55e" />}
        {error && !running && <AlertTriangle size={15} color="#ef4444" />}
        {expanded ? <ChevronDown size={15} color="#374151" /> : <ChevronRight size={15} color="#374151" />}
      </div>

      {expanded && (
        <div style={{ borderTop: '1px solid #1e2530', padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {task.note && (
            <div style={{ fontSize: 12, color: '#6b7280', background: '#0a1020', border: '1px solid #1e2530', borderRadius: 6, padding: '8px 12px' }}>
              ℹ️ {task.note}
            </div>
          )}
          <PayloadForm task={task} payload={payload} onChange={setPayload} interfaces={interfaces} />
          <button onClick={launch} disabled={running} style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
            padding: '9px 20px', borderRadius: 8, border: 'none', cursor: running ? 'not-allowed' : 'pointer',
            background: running ? '#1e2530' : task.color, color: running ? '#4b5563' : '#000',
            fontWeight: 700, fontSize: 13, transition: 'all 0.15s',
          }}>
            {running ? <><Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> Running…</> : <><Play size={14} /> Run</>}
          </button>
          {error && (
            <div style={{ background: '#1a0a0a', border: '1px solid #7f1d1d', borderRadius: 8, padding: '10px 14px', color: '#ef4444', fontSize: 13, fontFamily: 'JetBrains Mono, monospace' }}>{error}</div>
          )}
          {result && <ResultRenderer result={result} />}
        </div>
      )}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function NetworkToolsPage() {
  const [devices,    setDevices]    = useState([])
  const [deviceId,   setDeviceId]   = useState('')
  const [loading,    setLoading]    = useState(true)
  const [interfaces, setInterfaces] = useState([])

  useEffect(() => {
    api.getDevices({ status: 'active' })
      .then(data => {
        const d = Array.isArray(data) ? data : (data.devices || [])
        setDevices(d)
        if (d.length === 1) setDeviceId(d[0].id)
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    if (!deviceId) { setInterfaces([]); return }
    api.getAllTasks({ device_id: deviceId, task_type: 'get_sysinfo', status: 'completed', limit: 1 })
      .then(data => {
        const tasks  = Array.isArray(data) ? data : (data.tasks || [])
        const ifaces = tasks[0]?.result?.interfaces
        if (Array.isArray(ifaces) && ifaces.length > 0) {
          setInterfaces(ifaces.map(i => (typeof i === 'string' ? i : i.name)).filter(Boolean))
        } else {
          setInterfaces([])
        }
      })
      .catch(() => setInterfaces([]))
  }, [deviceId])

  return (
    <div style={{ padding: '28px 32px', maxWidth: 900, margin: '0 auto' }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>

      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 28 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
            <Network size={22} color="#06b6d4" />
            <h1 style={{ fontSize: 22, fontWeight: 700, color: '#f3f4f6', fontFamily: 'Syne, sans-serif', margin: 0 }}>
              Network Tools
            </h1>
          </div>
          <p style={{ fontSize: 13, color: '#4b5563', margin: 0 }}>
            ARP scan, ping sweep, NetBIOS enumeration, LLDP topology, NTP sync, and Wake-on-LAN
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
      </div>

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}>
          <Loader2 size={24} color="#06b6d4" style={{ animation: 'spin 1s linear infinite' }} />
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {NET_TASKS.map(task => (
            <TaskPanel key={task.id} task={task} deviceId={deviceId} interfaces={interfaces} />
          ))}
        </div>
      )}
    </div>
  )
}
