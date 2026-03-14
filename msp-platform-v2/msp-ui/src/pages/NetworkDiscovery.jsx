/**
 * Network Discovery — real-time network device scanner.
 * Periodically issues ARP scans from a selected agent, detects new devices,
 * and renders a live auto-updating network diagram.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { api } from '../lib/api'
import {
  Network, Play, Square, Loader2, CheckCircle,
  AlertTriangle, Server, Eye, EyeOff, Trash2
} from 'lucide-react'

// ── Constants ──────────────────────────────────────────────────────────────────

const STORAGE_KEY = 'net-discovery-known'

const SCAN_INTERVALS = [
  { label: '30 seconds', value: 30 },
  { label: '1 minute',   value: 60 },
  { label: '2 minutes',  value: 120 },
  { label: '5 minutes',  value: 300 },
]

const sleep = ms => new Promise(r => setTimeout(r, ms))

// ── LocalStorage helpers ───────────────────────────────────────────────────────

function loadKnown() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') }
  catch { return {} }
}

function saveKnown(known) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(known)) } catch {}
}

// ── Network Diagram (SVG) ──────────────────────────────────────────────────────

function getNodePositions(count) {
  if (count === 0) return []
  const W = 700, H = 380
  const cx = W / 2, cy = H / 2

  if (count <= 10) {
    const r = Math.min(cx - 70, cy - 60)
    return Array.from({ length: count }, (_, i) => {
      const angle = (2 * Math.PI / count) * i - Math.PI / 2
      return { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) }
    })
  }

  // Two rings for > 10 devices
  const ring1Count = Math.ceil(count / 2)
  const ring2Count = count - ring1Count
  const positions = []
  const r1 = Math.min(cx - 70, cy - 60) * 0.55
  const r2 = Math.min(cx - 70, cy - 60)
  for (let i = 0; i < ring1Count; i++) {
    const a = (2 * Math.PI / ring1Count) * i - Math.PI / 2
    positions.push({ x: cx + r1 * Math.cos(a), y: cy + r1 * Math.sin(a) })
  }
  for (let i = 0; i < ring2Count; i++) {
    const a = (2 * Math.PI / ring2Count) * i - Math.PI / 2
    positions.push({ x: cx + r2 * Math.cos(a), y: cy + r2 * Math.sin(a) })
  }
  return positions
}

function NetworkDiagram({ discovered, newMacs, showOffline }) {
  const W = 700, H = 380
  const cx = W / 2, cy = H / 2

  const visible = showOffline ? discovered : discovered.filter(d => !d.offline)
  const positions = getNodePositions(visible.length)

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      style={{ width: '100%', height: '100%', display: 'block' }}
    >
      {/* Background */}
      <rect width={W} height={H} fill="#0a0c10" rx={8} />

      {/* Grid dots */}
      {Array.from({ length: 12 }, (_, col) =>
        Array.from({ length: 8 }, (_, row) => (
          <circle
            key={`${col}-${row}`}
            cx={(col + 1) * (W / 13)}
            cy={(row + 1) * (H / 9)}
            r={1}
            fill="#1a2030"
          />
        ))
      )}

      {/* Lines from center to nodes */}
      {visible.map((d, i) => {
        const { x, y } = positions[i]
        const isNew = newMacs.has(d.mac)
        const lineColor = d.offline ? '#1e2530' : isNew ? '#22c55e' : '#1e3a5f'
        return (
          <line
            key={`line-${d.mac}`}
            x1={cx} y1={cy} x2={x} y2={y}
            stroke={lineColor}
            strokeWidth={isNew ? 1.5 : 1}
            strokeOpacity={0.7}
            strokeDasharray={d.offline ? '4 4' : undefined}
          />
        )
      })}

      {/* Center gateway node */}
      <circle cx={cx} cy={cy} r={28} fill="#0f1f3a" stroke="#06b6d4" strokeWidth={2} />
      <circle cx={cx} cy={cy} r={22} fill="#0f1f3a" stroke="#06b6d430" strokeWidth={1} />
      <text x={cx} y={cy - 4} textAnchor="middle" fontSize={8} fill="#06b6d4" fontFamily="monospace" fontWeight="600">GATEWAY</text>
      <text x={cx} y={cy + 6} textAnchor="middle" fontSize={7} fill="#0e7490" fontFamily="monospace">◉ active</text>

      {/* Device nodes */}
      {visible.map((d, i) => {
        const { x, y } = positions[i]
        const isNew = newMacs.has(d.mac)
        const fillColor = d.offline ? '#111827' : isNew ? '#0f2a1a' : '#0f1e2e'
        const strokeColor = d.offline ? '#374151' : isNew ? '#22c55e' : '#1d4ed8'
        const strokeW = isNew ? 2 : 1.5
        const ipShort = d.ip ? d.ip.split('.').slice(-2).join('.') : '?'
        const vendorShort = (d.vendor || '').split(' ')[0].slice(0, 8)

        return (
          <g key={d.mac}>
            {/* Pulse ring for new devices */}
            {isNew && (
              <circle cx={x} cy={y} r={24} fill="none" stroke="#22c55e" strokeWidth={1} strokeOpacity={0.3} />
            )}
            <circle cx={x} cy={y} r={19} fill={fillColor} stroke={strokeColor} strokeWidth={strokeW} />
            <text x={x} y={y - 2} textAnchor="middle" dominantBaseline="middle" fontSize={9} fill={d.offline ? '#4b5563' : '#e5e7eb'} fontFamily="monospace">{ipShort}</text>
            {/* Vendor label below node */}
            <text x={x} y={y + 30} textAnchor="middle" fontSize={7} fill="#4b5563" fontFamily="monospace">{vendorShort}</text>
            {/* NEW badge */}
            {isNew && (
              <g>
                <rect x={x + 10} y={y - 28} width={22} height={11} rx={3} fill="#166534" stroke="#22c55e" strokeWidth={0.5} />
                <text x={x + 21} y={y - 22} textAnchor="middle" fontSize={7} fill="#4ade80" fontFamily="monospace" fontWeight="700">NEW</text>
              </g>
            )}
          </g>
        )
      })}

      {/* Legend */}
      <g transform={`translate(12, ${H - 44})`}>
        <circle cx={6} cy={6} r={5} fill="#0f1e2e" stroke="#1d4ed8" strokeWidth={1.5} />
        <text x={15} y={10} fontSize={9} fill="#4b5563" fontFamily="monospace">Known</text>
        <circle cx={6} cy={22} r={5} fill="#0f2a1a" stroke="#22c55e" strokeWidth={1.5} />
        <text x={15} y={26} fontSize={9} fill="#4b5563" fontFamily="monospace">New</text>
        <circle cx={6} cy={38} r={5} fill="#111827" stroke="#374151" strokeWidth={1.5} />
        <text x={15} y={42} fontSize={9} fill="#4b5563" fontFamily="monospace">Offline</text>
      </g>

      {/* Empty state */}
      {visible.length === 0 && (
        <text x={cx} y={cy + 50} textAnchor="middle" fontSize={13} fill="#374151" fontFamily="monospace">
          No devices discovered yet
        </text>
      )}
    </svg>
  )
}

// ── Main Page ──────────────────────────────────────────────────────────────────

export default function NetworkDiscoveryPage() {
  const [agents, setAgents]               = useState([])
  const [selectedAgent, setSelectedAgent] = useState('')
  const [iface, setIface]                 = useState('eth0')
  const [scanInterval, setScanInterval]   = useState(60)
  const [monitoring, setMonitoring]       = useState(false)
  const [scanning, setScanning]           = useState(false)
  const [discovered, setDiscovered]       = useState([])   // [{mac, ip, vendor, firstSeen, lastSeen, offline}]
  const [newMacs, setNewMacs]             = useState(new Set())
  const [lastScan, setLastScan]           = useState(null)
  const [nextScanIn, setNextScanIn]       = useState(null)
  const [scanError, setScanError]         = useState(null)
  const [showOffline, setShowOffline]     = useState(true)

  // Refs to avoid stale closures in async loop
  const loopActive        = useRef(false)
  const selectedAgentRef  = useRef(selectedAgent)
  const ifaceRef          = useRef(iface)
  const scanIntervalRef   = useRef(scanInterval)
  const knownRef          = useRef(loadKnown())
  const discoveredRef     = useRef(discovered)

  useEffect(() => { selectedAgentRef.current = selectedAgent }, [selectedAgent])
  useEffect(() => { ifaceRef.current = iface }, [iface])
  useEffect(() => { scanIntervalRef.current = scanInterval }, [scanInterval])
  useEffect(() => { discoveredRef.current = discovered }, [discovered])

  // Load active agents on mount
  useEffect(() => {
    api.getDevices({ status: 'active' })
      .then(devs => {
        const list = Array.isArray(devs) ? devs : (devs.devices || [])
        setAgents(list)
        if (list.length > 0) setSelectedAgent(list[0].id)
      })
      .catch(() => {})
  }, [])

  // Perform a single ARP scan and merge results
  const performScan = useCallback(async () => {
    const agentId = selectedAgentRef.current
    if (!agentId) return

    setScanning(true)
    setScanError(null)

    try {
      const resp = await api.issueTask(agentId, {
        task_type: 'run_arp_scan',
        payload: { interface: ifaceRef.current, timeout: 10 },
        timeout_seconds: 40,
      })
      const taskId = resp.task_id

      // Poll for completion (max 20 attempts × 2s = 40s)
      let result = null
      for (let i = 0; i < 20 && loopActive.current; i++) {
        await sleep(2000)
        const tasks = await api.getTasks(agentId)
        const t = (Array.isArray(tasks) ? tasks : (tasks.tasks || [])).find(t => t.id === taskId)
        if (!t) continue
        if (t.status === 'completed') { result = t.result; break }
        if (t.status === 'failed' || t.status === 'timeout') {
          setScanError(t.error || t.status)
          break
        }
      }

      if (result) {
        const hosts = result.hosts || []
        const now = new Date().toISOString()
        const known = knownRef.current
        const newlyFound = new Set()

        setDiscovered(prev => {
          const map = new Map(prev.map(d => [d.mac, { ...d, _seen: false }]))

          for (const h of hosts) {
            if (!h.mac) continue
            if (map.has(h.mac)) {
              const existing = map.get(h.mac)
              existing.ip = h.ip
              existing.vendor = h.vendor || existing.vendor
              existing.lastSeen = now
              existing._seen = true
              existing.offline = false
            } else {
              map.set(h.mac, {
                mac: h.mac, ip: h.ip, vendor: h.vendor || '',
                firstSeen: now, lastSeen: now, _seen: true, offline: false,
              })
            }
            if (!known[h.mac]) newlyFound.add(h.mac)
          }

          // Mark unseen hosts as offline (not gone — they may return)
          for (const d of map.values()) {
            if (!d._seen) d.offline = true
          }

          return [...map.values()]
        })

        if (newlyFound.size > 0) {
          setNewMacs(prev => new Set([...prev, ...newlyFound]))
        }

        setLastScan(now)
      }
    } catch (e) {
      setScanError(e.message || 'Scan error')
    } finally {
      setScanning(false)
    }
  }, [])

  // Monitoring loop
  const runLoop = useCallback(async () => {
    while (loopActive.current) {
      await performScan()
      if (!loopActive.current) break

      // Countdown to next scan
      const interval = scanIntervalRef.current
      for (let i = interval; i > 0; i--) {
        if (!loopActive.current) { setNextScanIn(null); return }
        setNextScanIn(i)
        await sleep(1000)
      }
      setNextScanIn(null)
    }
  }, [performScan])

  const startMonitoring = useCallback(() => {
    if (!selectedAgentRef.current) return
    loopActive.current = true
    setMonitoring(true)
    setNextScanIn(null)
    runLoop()
  }, [runLoop])

  const stopMonitoring = useCallback(() => {
    loopActive.current = false
    setMonitoring(false)
    setNextScanIn(null)
  }, [])

  // Cleanup on unmount
  useEffect(() => () => { loopActive.current = false }, [])

  const markAllKnown = () => {
    const known = knownRef.current
    for (const d of discovered) {
      known[d.mac] = { ip: d.ip, vendor: d.vendor }
    }
    knownRef.current = known
    saveKnown(known)
    setNewMacs(new Set())
  }

  const forgetDevice = (mac) => {
    const known = knownRef.current
    delete known[mac]
    knownRef.current = known
    saveKnown(known)
    setNewMacs(prev => { const s = new Set(prev); s.delete(mac); return s })
    setDiscovered(prev => prev.filter(d => d.mac !== mac))
  }

  const online  = discovered.filter(d => !d.offline)
  const offline = discovered.filter(d => d.offline)

  return (
    <div style={{ padding: '28px 32px', maxWidth: 1100, margin: '0 auto' }}>
      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes pulse-ring { 0% { r: 19; opacity: 0.6; } 100% { r: 28; opacity: 0; } }
      `}</style>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
        <Network size={22} color="#06b6d4" />
        <h1 style={{ fontSize: 22, fontWeight: 700, color: '#f3f4f6', fontFamily: 'Syne, sans-serif', margin: 0 }}>
          Network Discovery
        </h1>
        {newMacs.size > 0 && (
          <span style={{
            background: '#14532d', color: '#4ade80', border: '1px solid #166534',
            borderRadius: 9999, padding: '2px 10px', fontSize: 12, fontWeight: 600,
          }}>
            {newMacs.size} new device{newMacs.size !== 1 ? 's' : ''}
          </span>
        )}
      </div>
      <p style={{ fontSize: 13, color: '#4b5563', marginBottom: 28 }}>
        Continuously scan your network for devices. New arrivals are highlighted automatically.
      </p>

      {/* Controls bar */}
      <div style={{
        background: '#0d1117', border: '1px solid #1e2530', borderRadius: 10,
        padding: '14px 18px', marginBottom: 20,
        display: 'flex', alignItems: 'flex-end', gap: 14, flexWrap: 'wrap',
      }}>
        {/* Agent select */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <label style={{ fontSize: 11, color: '#4b5563', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Agent</label>
          <select
            value={selectedAgent}
            onChange={e => setSelectedAgent(e.target.value)}
            disabled={monitoring}
            style={{
              background: '#0a0c0f', border: '1px solid #1e2530', borderRadius: 6,
              color: '#e5e7eb', padding: '6px 10px', fontSize: 13,
              fontFamily: 'JetBrains Mono, monospace', minWidth: 200, cursor: monitoring ? 'not-allowed' : 'pointer',
            }}
          >
            <option value="">— select active device —</option>
            {agents.map(d => (
              <option key={d.id} value={d.id}>{d.name} ({d.last_ip || 'no IP'})</option>
            ))}
          </select>
        </div>

        {/* Interface */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <label style={{ fontSize: 11, color: '#4b5563', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Interface</label>
          <input
            value={iface}
            onChange={e => setIface(e.target.value)}
            disabled={monitoring}
            style={{
              background: '#0a0c0f', border: '1px solid #1e2530', borderRadius: 6,
              color: '#e5e7eb', padding: '6px 10px', fontSize: 13,
              fontFamily: 'JetBrains Mono, monospace', width: 90,
              cursor: monitoring ? 'not-allowed' : 'text',
            }}
          />
        </div>

        {/* Scan interval */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <label style={{ fontSize: 11, color: '#4b5563', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Interval</label>
          <select
            value={scanInterval}
            onChange={e => setScanInterval(Number(e.target.value))}
            disabled={monitoring}
            style={{
              background: '#0a0c0f', border: '1px solid #1e2530', borderRadius: 6,
              color: '#e5e7eb', padding: '6px 10px', fontSize: 13,
              fontFamily: 'JetBrains Mono, monospace', cursor: monitoring ? 'not-allowed' : 'pointer',
            }}
          >
            {SCAN_INTERVALS.map(i => (
              <option key={i.value} value={i.value}>{i.label}</option>
            ))}
          </select>
        </div>

        {/* Start / Stop */}
        <button
          onClick={monitoring ? stopMonitoring : startMonitoring}
          disabled={!selectedAgent}
          style={{
            display: 'flex', alignItems: 'center', gap: 7,
            padding: '7px 16px', borderRadius: 7, border: 'none',
            cursor: selectedAgent ? 'pointer' : 'not-allowed',
            fontWeight: 700, fontSize: 13,
            background: monitoring ? '#450a0a' : '#06b6d4',
            color: monitoring ? '#fca5a5' : '#000f14',
            transition: 'all 0.15s',
          }}
        >
          {monitoring
            ? <><Square size={14} /> Stop</>
            : <><Play size={14} /> Start Monitoring</>}
        </button>

        {/* Status indicators */}
        <div style={{ marginLeft: 'auto', display: 'flex', flexDirection: 'column', gap: 3, fontSize: 12, textAlign: 'right' }}>
          {scanning && (
            <span style={{ color: '#06b6d4', display: 'flex', alignItems: 'center', gap: 5, justifyContent: 'flex-end' }}>
              <Loader2 size={11} style={{ animation: 'spin 1s linear infinite' }} /> Scanning…
            </span>
          )}
          {lastScan && !scanning && (
            <span style={{ color: '#4b5563' }}>Last: {new Date(lastScan).toLocaleTimeString()}</span>
          )}
          {nextScanIn !== null && !scanning && (
            <span style={{ color: '#374151' }}>Next in {nextScanIn}s</span>
          )}
          {scanError && (
            <span style={{ color: '#ef4444', maxWidth: 200, wordBreak: 'break-word' }}>
              <AlertTriangle size={11} style={{ display: 'inline', marginRight: 3 }} />{scanError}
            </span>
          )}
        </div>
      </div>

      {/* Stats row */}
      {discovered.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 20 }}>
          {[
            { label: 'Total discovered', value: discovered.length, color: '#06b6d4' },
            { label: 'Online',           value: online.length,     color: '#22c55e' },
            { label: 'Offline',          value: offline.length,    color: '#6b7280' },
            { label: 'New devices',      value: newMacs.size,      color: '#f59e0b' },
          ].map(s => (
            <div key={s.label} style={{
              background: '#0d1117', border: '1px solid #1e2530', borderRadius: 8, padding: '12px 16px',
            }}>
              <div style={{ fontSize: 24, fontWeight: 700, color: s.color, fontFamily: 'JetBrains Mono, monospace' }}>{s.value}</div>
              <div style={{ fontSize: 11, color: '#4b5563', marginTop: 2, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{s.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Main content: diagram + table */}
      {discovered.length > 0 ? (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, alignItems: 'start' }}>
          {/* Network diagram */}
          <div style={{ background: '#0a0c10', border: '1px solid #1e2530', borderRadius: 10, overflow: 'hidden' }}>
            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '10px 14px', borderBottom: '1px solid #1e2530',
            }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                Network Map
              </span>
              <button
                onClick={() => setShowOffline(v => !v)}
                style={{ display: 'flex', alignItems: 'center', gap: 5, background: 'none', border: 'none', cursor: 'pointer', fontSize: 11, color: '#4b5563' }}
              >
                {showOffline ? <EyeOff size={12} /> : <Eye size={12} />}
                {showOffline ? 'Hide offline' : 'Show offline'}
              </button>
            </div>
            <NetworkDiagram discovered={discovered} newMacs={newMacs} showOffline={showOffline} />
          </div>

          {/* Device table */}
          <div style={{ background: '#0d1117', border: '1px solid #1e2530', borderRadius: 10, overflow: 'hidden' }}>
            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '10px 14px', borderBottom: '1px solid #1e2530',
            }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                Discovered Devices
              </span>
              {newMacs.size > 0 && (
                <button
                  onClick={markAllKnown}
                  style={{ fontSize: 11, color: '#22c55e', background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}
                >
                  <CheckCircle size={11} /> Mark all known
                </button>
              )}
            </div>
            <div style={{ overflowY: 'auto', maxHeight: 360 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily: 'JetBrains Mono, monospace' }}>
                <thead>
                  <tr style={{ position: 'sticky', top: 0, background: '#0d1117' }}>
                    {['', 'IP', 'MAC', 'Vendor', 'Last seen', ''].map((h, i) => (
                      <th key={i} style={{ textAlign: 'left', padding: '6px 10px', color: '#374151', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em', borderBottom: '1px solid #1e2530', fontWeight: 600 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[...discovered]
                    .sort((a, b) => (a.offline ? 1 : 0) - (b.offline ? 1 : 0) || a.ip?.localeCompare(b.ip))
                    .map(d => {
                      const isNew = newMacs.has(d.mac)
                      return (
                        <tr key={d.mac} style={{
                          borderBottom: '1px solid #0a0c0f',
                          background: isNew ? '#0a1f0f' : 'transparent',
                        }}>
                          <td style={{ padding: '6px 10px' }}>
                            <span style={{
                              fontSize: 16,
                              color: d.offline ? '#374151' : isNew ? '#22c55e' : '#1d4ed8',
                              lineHeight: 1,
                            }}>●</span>
                          </td>
                          <td style={{ padding: '6px 10px', color: d.offline ? '#4b5563' : '#e5e7eb' }}>{d.ip}</td>
                          <td style={{ padding: '6px 10px', color: '#6b7280', fontSize: 11 }}>{d.mac}</td>
                          <td style={{ padding: '6px 10px', color: '#4b5563', fontSize: 11 }}>{d.vendor || '—'}</td>
                          <td style={{ padding: '6px 10px', color: '#374151', fontSize: 11 }}>
                            {new Date(d.lastSeen).toLocaleTimeString()}
                          </td>
                          <td style={{ padding: '6px 8px' }}>
                            <button
                              onClick={() => forgetDevice(d.mac)}
                              title="Remove from list"
                              style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#374151', padding: 2 }}
                            >
                              <Trash2 size={11} />
                            </button>
                          </td>
                        </tr>
                      )
                    })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : (
        /* Empty state */
        <div style={{
          textAlign: 'center', padding: '70px 0', color: '#374151',
          border: '1px dashed #1e2530', borderRadius: 10,
        }}>
          <Network size={52} color="#1e2530" style={{ marginBottom: 16 }} />
          <p style={{ fontSize: 14, marginBottom: 6 }}>No devices discovered yet</p>
          <p style={{ fontSize: 12, color: '#1e2530' }}>
            Select an agent and click <strong style={{ color: '#374151' }}>Start Monitoring</strong> to begin scanning.
          </p>
        </div>
      )}
    </div>
  )
}
