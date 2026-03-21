/**
 * Network Discovery — real-time network device scanner.
 * - Persistent background monitoring (survives page navigation)
 * - Interface auto-detection from agent sysinfo
 * - Interactive zoomable/pannable/clickable network diagram
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { api } from '../lib/api'
import {
  Network, Play, Square, Loader2, CheckCircle,
  AlertTriangle, Eye, EyeOff, Trash2, X, ZoomIn, ZoomOut,
  FileText, Download,
} from 'lucide-react'

// ── Constants ──────────────────────────────────────────────────────────────────

const STORAGE_KEY       = 'net-discovery-known'
const SCAN_STATE_KEY    = 'net-discovery-scan-state'

const SCAN_INTERVALS = [
  { label: '30 seconds', value: 30 },
  { label: '1 minute',   value: 60 },
  { label: '2 minutes',  value: 120 },
  { label: '5 minutes',  value: 300 },
]

const sleep = ms => new Promise(r => setTimeout(r, ms))

// ── LocalStorage helpers ───────────────────────────────────────────────────────

function loadKnown() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') } catch { return {} }
}

function saveKnown(known) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(known)) } catch {}
}

function loadScanState() {
  try { return JSON.parse(localStorage.getItem(SCAN_STATE_KEY) || 'null') } catch { return null }
}

function saveScanState(state) {
  try { localStorage.setItem(SCAN_STATE_KEY, JSON.stringify(state)) } catch {}
}

function clearScanState() {
  try { localStorage.removeItem(SCAN_STATE_KEY) } catch {}
}

// ── Persistent monitoring service ──────────────────────────────────────────────
// Lives at module scope — survives page navigation within the SPA.

// Restore persisted scan state (survives page refresh)
const _persistedState = loadScanState()

const _svc = {
  active:     _persistedState?.active     || false,
  agentId:    _persistedState?.agentId    || '',
  iface:      _persistedState?.iface      || 'eth0',
  interval:   _persistedState?.interval   || 60,
  discovered: [],
  known:      loadKnown(),
  newMacs:    new Set(),
  lastScan:   null,
  nextScanIn: null,
  scanning:   false,
  error:      null,
  _listeners: new Set(),

  subscribe(fn) {
    this._listeners.add(fn)
    fn(this._snap())
    return () => this._listeners.delete(fn)
  },

  _snap() {
    return {
      active:     this.active,
      agentId:    this.agentId,
      iface:      this.iface,
      interval:   this.interval,
      discovered: this.discovered,
      newMacs:    this.newMacs,
      lastScan:   this.lastScan,
      nextScanIn: this.nextScanIn,
      scanning:   this.scanning,
      error:      this.error,
    }
  },

  _notify() {
    const snap = this._snap()
    this._listeners.forEach(fn => fn(snap))
  },

  start(agentId, iface, interval) {
    if (this.active) return
    this.agentId  = agentId
    this.iface    = iface
    this.interval = interval
    this.active   = true
    this.error    = null
    saveScanState({ active: true, agentId, iface, interval })
    this._notify()
    this._loop()
  },

  stop() {
    this.active     = false
    this.nextScanIn = null
    clearScanState()
    this._notify()
  },

  async _scan() {
    if (!this.agentId) return
    this.scanning = true
    this.error    = null
    this._notify()
    try {
      const resp   = await api.issueTask(this.agentId, {
        task_type:       'run_arp_scan',
        payload:         { interface: this.iface, timeout: 10, _auto: true },
        timeout_seconds: 40,
      })
      const taskId = resp.task_id
      let result   = null

      for (let i = 0; i < 20 && this.active; i++) {
        await sleep(2000)
        const tasks = await api.getTasks(this.agentId)
        const t = (Array.isArray(tasks) ? tasks : (tasks.tasks || [])).find(t => t.id === taskId)
        if (!t) continue
        if (t.status === 'completed') { result = t.result; break }
        if (t.status === 'failed' || t.status === 'timeout') { this.error = t.error || t.status; break }
      }

      if (result) {
        const hosts = result.hosts || []
        const now   = new Date().toISOString()
        const map   = new Map(this.discovered.map(d => [d.mac, { ...d, _seen: false }]))
        const newlyFound = new Set()

        for (const h of hosts) {
          if (!h.mac) continue
          if (map.has(h.mac)) {
            const ex = map.get(h.mac)
            ex.ip     = h.ip
            ex.vendor = h.vendor || ex.vendor
            ex.lastSeen = now
            ex._seen    = true
            ex.offline  = false
          } else {
            map.set(h.mac, { mac: h.mac, ip: h.ip, vendor: h.vendor || '', firstSeen: now, lastSeen: now, _seen: true, offline: false })
          }
          if (!this.known[h.mac]) newlyFound.add(h.mac)
        }
        for (const d of map.values()) { if (!d._seen) d.offline = true }

        this.discovered = [...map.values()]
        if (newlyFound.size > 0) this.newMacs = new Set([...this.newMacs, ...newlyFound])
        this.lastScan = now

        // Persist to server history (fire-and-forget)
        api.post('/v1/network/discovered-devices', {
          device_id: this.agentId,
          devices: this.discovered.map(d => ({ mac: d.mac, ip: d.ip || '', vendor: d.vendor || '' })),
        }).catch(() => {})
      }
    } catch (e) {
      this.error = e.message || 'Scan error'
    } finally {
      this.scanning = false
      this._notify()
    }
  },

  async _loop() {
    while (this.active) {
      await this._scan()
      if (!this.active) break
      for (let i = this.interval; i > 0; i--) {
        if (!this.active) { this.nextScanIn = null; this._notify(); return }
        this.nextScanIn = i
        this._notify()
        await sleep(1000)
      }
      this.nextScanIn = null
    }
  },

  markAllKnown() {
    for (const d of this.discovered) this.known[d.mac] = { ip: d.ip, vendor: d.vendor }
    saveKnown(this.known)
    this.newMacs = new Set()
    this._notify()
  },

  forgetDevice(mac) {
    delete this.known[mac]
    saveKnown(this.known)
    this.newMacs    = new Set([...this.newMacs].filter(m => m !== mac))
    this.discovered = this.discovered.filter(d => d.mac !== mac)
    this._notify()
  },
}

// Auto-resume monitoring if it was active before the page refresh
if (_persistedState?.active && _persistedState?.agentId) {
  // Kick off the loop without calling start() (avoids double-saving state)
  _svc._loop()
}

// ── Node layout ────────────────────────────────────────────────────────────────

function getNodePositions(count) {
  if (count === 0) return []
  const W = 700, H = 380
  const cx = W / 2, cy = H / 2

  if (count <= 10) {
    const r = Math.min(cx - 70, cy - 60)
    return Array.from({ length: count }, (_, i) => {
      const a = (2 * Math.PI / count) * i - Math.PI / 2
      return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }
    })
  }

  const r1Count = Math.ceil(count / 2), r2Count = count - r1Count
  const r1 = Math.min(cx - 70, cy - 60) * 0.55
  const r2 = Math.min(cx - 70, cy - 60)
  const positions = []
  for (let i = 0; i < r1Count; i++) {
    const a = (2 * Math.PI / r1Count) * i - Math.PI / 2
    positions.push({ x: cx + r1 * Math.cos(a), y: cy + r1 * Math.sin(a) })
  }
  for (let i = 0; i < r2Count; i++) {
    const a = (2 * Math.PI / r2Count) * i - Math.PI / 2
    positions.push({ x: cx + r2 * Math.cos(a), y: cy + r2 * Math.sin(a) })
  }
  return positions
}

// ── Interactive Network Diagram ────────────────────────────────────────────────

function NetworkDiagram({ discovered, newMacs, showOffline, onNodeClick }) {
  const W = 700, H = 380
  const cx = W / 2, cy = H / 2

  const [transform,  setTransform]  = useState({ x: 0, y: 0, scale: 1 })
  const [isDragging, setIsDragging] = useState(false)
  const svgRef      = useRef(null)
  const dragRef     = useRef(null)  // { sx, sy, origX, origY, screenToSvg }
  const dragMoved   = useRef(false)

  const visible   = showOffline ? discovered : discovered.filter(d => !d.offline)
  const positions = getNodePositions(visible.length)

  const onWheel = useCallback((e) => {
    e.preventDefault()
    const factor = e.deltaY < 0 ? 1.12 : 0.88
    setTransform(t => ({ ...t, scale: Math.max(0.35, Math.min(5, t.scale * factor)) }))
  }, [])

  // Attach wheel listener as non-passive so preventDefault() works
  useEffect(() => {
    const el = svgRef.current
    if (!el) return
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [onWheel])

  const onMouseDown = useCallback((e) => {
    if (e.button !== 0) return
    const rect = e.currentTarget.getBoundingClientRect()
    const screenToSvg = W / rect.width
    dragRef.current = { sx: e.clientX, sy: e.clientY, origX: transform.x, origY: transform.y, screenToSvg }
    dragMoved.current = false
    setIsDragging(true)
  }, [transform])

  const onMouseMove = useCallback((e) => {
    if (!dragRef.current) return
    const { sx, sy, origX, origY, screenToSvg } = dragRef.current
    const dx = (e.clientX - sx) * screenToSvg
    const dy = (e.clientY - sy) * screenToSvg
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) dragMoved.current = true
    setTransform(t => ({ ...t, x: origX + dx, y: origY + dy }))
  }, [])

  const onMouseUp = useCallback(() => {
    dragRef.current = null
    setIsDragging(false)
  }, [])

  const resetView = () => setTransform({ x: 0, y: 0, scale: 1 })

  const handleNodeClick = useCallback((d) => {
    if (!dragMoved.current) onNodeClick(d)
  }, [onNodeClick])

  return (
    <div style={{ position: 'relative', userSelect: 'none' }}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: '100%', height: '100%', display: 'block', cursor: isDragging ? 'grabbing' : 'grab' }}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseUp}
      >
        {/* Background */}
        <rect width={W} height={H} fill="#0a0c10" rx={8} />

        {/* Grid dots (outside transform — always fixed) */}
        {Array.from({ length: 12 }, (_, col) =>
          Array.from({ length: 8 }, (_, row) => (
            <circle key={`${col}-${row}`}
              cx={(col + 1) * (W / 13)} cy={(row + 1) * (H / 9)}
              r={1} fill="#1a2030" />
          ))
        )}

        {/* Zoomable/pannable content */}
        <g transform={`translate(${transform.x},${transform.y}) scale(${transform.scale})`}>
          {/* Lines from center to nodes */}
          {visible.map((d, i) => {
            const { x, y } = positions[i]
            const isNew = newMacs.has(d.mac)
            return (
              <line key={`line-${d.mac}`}
                x1={cx} y1={cy} x2={x} y2={y}
                stroke={d.offline ? 'var(--bg-border)' : isNew ? '#22c55e' : '#1e3a5f'}
                strokeWidth={isNew ? 1.5 : 1}
                strokeOpacity={0.7}
                strokeDasharray={d.offline ? '4 4' : undefined}
              />
            )
          })}

          {/* Gateway node */}
          <circle cx={cx} cy={cy} r={28} fill="#0f1f3a" stroke="#06b6d4" strokeWidth={2} />
          <circle cx={cx} cy={cy} r={22} fill="#0f1f3a" stroke="#06b6d430" strokeWidth={1} />
          <text x={cx} y={cy - 4} textAnchor="middle" fontSize={8} fill="#06b6d4" fontFamily="monospace" fontWeight="600">GATEWAY</text>
          <text x={cx} y={cy + 6} textAnchor="middle" fontSize={7} fill="#0e7490" fontFamily="monospace">◉ active</text>

          {/* Device nodes */}
          {visible.map((d, i) => {
            const { x, y } = positions[i]
            const isNew      = newMacs.has(d.mac)
            const fillColor  = d.offline ? 'var(--bg-elevated)' : isNew ? 'var(--green-dim)' : 'var(--cyan-dim)'
            const strokeColor = d.offline ? 'var(--label-color)' : isNew ? '#22c55e' : '#1d4ed8'
            const ipShort    = d.ip ? d.ip.split('.').slice(-2).join('.') : '?'
            const vendorShort = (d.vendor || '').split(' ')[0].slice(0, 8)

            return (
              <g key={d.mac}
                onClick={(e) => { e.stopPropagation(); handleNodeClick(d) }}
                style={{ cursor: 'pointer' }}
              >
                {isNew && <circle cx={x} cy={y} r={24} fill="none" stroke="#22c55e" strokeWidth={1} strokeOpacity={0.3} />}
                <circle cx={x} cy={y} r={19} fill={fillColor} stroke={strokeColor} strokeWidth={isNew ? 2 : 1.5} />
                <text x={x} y={y - 2} textAnchor="middle" dominantBaseline="middle"
                  fontSize={9} fill={d.offline ? 'var(--label-color)' : 'var(--input-text)'} fontFamily="monospace">
                  {ipShort}
                </text>
                <text x={x} y={y + 30} textAnchor="middle" fontSize={7} fill="var(--label-color)" fontFamily="monospace">
                  {vendorShort}
                </text>
                {isNew && (
                  <g>
                    <rect x={x + 10} y={y - 28} width={22} height={11} rx={3} fill="#166534" stroke="#22c55e" strokeWidth={0.5} />
                    <text x={x + 21} y={y - 22} textAnchor="middle" fontSize={7} fill="#4ade80" fontFamily="monospace" fontWeight="700">NEW</text>
                  </g>
                )}
              </g>
            )
          })}
        </g>

        {/* Legend (outside transform — always visible) */}
        <g transform={`translate(12, ${H - 44})`}>
          <circle cx={6} cy={6}  r={5} fill="#0f1e2e" stroke="#1d4ed8" strokeWidth={1.5} />
          <text x={15} y={10} fontSize={9} fill="var(--label-color)" fontFamily="monospace">Known</text>
          <circle cx={6} cy={22} r={5} fill="#0f2a1a" stroke="#22c55e" strokeWidth={1.5} />
          <text x={15} y={26} fontSize={9} fill="var(--label-color)" fontFamily="monospace">New</text>
          <circle cx={6} cy={38} r={5} fill="var(--bg-elevated)" stroke="var(--label-color)" strokeWidth={1.5} />
          <text x={15} y={42} fontSize={9} fill="var(--label-color)" fontFamily="monospace">Offline</text>
        </g>

        {visible.length === 0 && (
          <text x={cx} y={cy + 50} textAnchor="middle" fontSize={13} fill="var(--label-color)" fontFamily="monospace">
            No devices discovered yet
          </text>
        )}
      </svg>

      {/* Zoom controls overlay */}
      <div style={{ position: 'absolute', bottom: 8, right: 8, display: 'flex', gap: 4 }}>
        {[
          { icon: ZoomIn,  action: () => setTransform(t => ({ ...t, scale: Math.min(5, t.scale * 1.25) })) },
          { icon: ZoomOut, action: () => setTransform(t => ({ ...t, scale: Math.max(0.35, t.scale * 0.8) })) },
        ].map(({ icon: Icon, action }, i) => (
          <button key={i} onClick={action} style={zoomBtn}>
            <Icon size={12} />
          </button>
        ))}
        <button onClick={resetView} title="Reset view" style={zoomBtn}>⊙</button>
      </div>
    </div>
  )
}

const zoomBtn = {
  background: 'var(--bg-surface)', border: '1px solid var(--bg-border)', borderRadius: 5,
  color: 'var(--btn-ghost-color)', padding: '3px 7px', cursor: 'pointer', fontSize: 12,
  display: 'flex', alignItems: 'center', lineHeight: 1,
}

// ── Device detail panel ────────────────────────────────────────────────────────

function DeviceDetail({ device, onClose, isNew, onForget, onMarkKnown }) {
  if (!device) return null
  const rows = [
    ['IP Address', device.ip || '—'],
    ['MAC Address', device.mac],
    ['Vendor', device.vendor || '—'],
    ['Status', device.offline ? 'Offline' : 'Online'],
    ['First seen', new Date(device.firstSeen).toLocaleString()],
    ['Last seen', new Date(device.lastSeen).toLocaleString()],
  ]

  return (
    <div style={{
      position: 'absolute', top: 8, right: 8, width: 240,
      background: 'var(--bg-surface)', border: '1px solid var(--bg-border)', borderRadius: 10,
      boxShadow: '0 8px 32px #00000080', zIndex: 10, overflow: 'hidden',
    }}>
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '10px 14px', borderBottom: '1px solid var(--bg-border)',
        background: isNew ? 'var(--green-dim)' : 'var(--bg-elevated)',
      }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: isNew ? 'var(--green-DEFAULT)' : 'var(--input-text)', fontFamily: 'JetBrains Mono, monospace' }}>
          {device.ip || device.mac}
        </span>
        <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--label-color)', padding: 2, display: 'flex' }}>
          <X size={13} />
        </button>
      </div>
      <div style={{ padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 6 }}>
        {rows.map(([k, v]) => (
          <div key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
            <span style={{ fontSize: 11, color: 'var(--label-color)', fontFamily: 'JetBrains Mono, monospace', whiteSpace: 'nowrap' }}>{k}</span>
            <span style={{ fontSize: 11, color: 'var(--btn-ghost-color)', fontFamily: 'JetBrains Mono, monospace', textAlign: 'right', wordBreak: 'break-all' }}>{v}</span>
          </div>
        ))}
      </div>
      <div style={{ padding: '8px 14px', borderTop: '1px solid var(--bg-border)', display: 'flex', gap: 8 }}>
        {isNew && (
          <button onClick={() => { onMarkKnown(device.mac); onClose() }} style={{
            flex: 1, padding: '5px 0', borderRadius: 5, border: '1px solid #166534',
            background: '#0a1f0f', color: '#4ade80', fontSize: 11, cursor: 'pointer', fontWeight: 600,
          }}>
            Mark known
          </button>
        )}
        <button onClick={() => { onForget(device.mac); onClose() }} style={{
          flex: 1, padding: '5px 0', borderRadius: 5, border: '1px solid #2d1515',
          background: '#1a0a0a', color: '#ef4444', fontSize: 11, cursor: 'pointer',
        }}>
          Remove
        </button>
      </div>
    </div>
  )
}

// ── Report generation ──────────────────────────────────────────────────────────

function buildExecutiveSummary(discovered, lastScan) {
  const online  = discovered.filter(d => !d.offline)
  const offline = discovered.filter(d => d.offline)
  const date    = lastScan ? new Date(lastScan).toLocaleString() : 'N/A'
  const lines = [
    '═══════════════════════════════════════════════════════════════',
    '  NETWORK DISCOVERY — EXECUTIVE SUMMARY',
    `  Generated: ${new Date().toLocaleString()}`,
    '═══════════════════════════════════════════════════════════════',
    '',
    'OVERVIEW',
    '────────',
    `  Total devices discovered : ${discovered.length}`,
    `  Currently online         : ${online.length}`,
    `  Currently offline        : ${offline.length}`,
    `  Last scan completed      : ${date}`,
    '',
    'FINDINGS',
    '────────',
    `  The network scan identified ${discovered.length} unique device${discovered.length !== 1 ? 's' : ''} across`,
    `  the monitored subnet. Of these, ${online.length} device${online.length !== 1 ? 's are' : ' is'} currently`,
    `  reachable and ${offline.length} ${offline.length !== 1 ? 'have' : 'has'} not responded in the most recent scan.`,
    '',
  ]

  // Vendor breakdown
  const vendorMap = {}
  for (const d of discovered) {
    const v = (d.vendor || 'Unknown').split(' ')[0]
    vendorMap[v] = (vendorMap[v] || 0) + 1
  }
  const topVendors = Object.entries(vendorMap).sort((a, b) => b[1] - a[1]).slice(0, 5)
  if (topVendors.length > 0) {
    lines.push('TOP DEVICE VENDORS')
    lines.push('──────────────────')
    for (const [v, c] of topVendors) lines.push(`  ${v.padEnd(20)} ${c} device${c !== 1 ? 's' : ''}`)
    lines.push('')
  }

  lines.push('RECOMMENDATIONS')
  lines.push('───────────────')
  if (offline.length > 0) lines.push(`  • Review ${offline.length} offline device${offline.length !== 1 ? 's' : ''} — confirm whether they are decommissioned or unreachable.`)
  lines.push('  • Ensure all discovered devices are accounted for in your asset inventory.')
  lines.push('  • Investigate any unrecognized vendor or device that does not belong on this network.')
  lines.push('')
  lines.push('═══════════════════════════════════════════════════════════════')

  return lines.join('\n')
}

function buildTechnicalReport(discovered, lastScan) {
  const date = lastScan ? new Date(lastScan).toLocaleString() : 'N/A'
  const lines = [
    '═══════════════════════════════════════════════════════════════════════════════════',
    '  NETWORK DISCOVERY — DETAILED TECHNICAL REPORT',
    `  Generated: ${new Date().toLocaleString()}`,
    `  Last scan: ${date}`,
    '═══════════════════════════════════════════════════════════════════════════════════',
    '',
    'DISCOVERED DEVICES',
    '──────────────────',
    '',
    `  ${'STATUS'.padEnd(8)}  ${'IP ADDRESS'.padEnd(16)}  ${'MAC ADDRESS'.padEnd(18)}  ${'VENDOR'.padEnd(24)}  ${'FIRST SEEN'.padEnd(22)}  LAST SEEN`,
    `  ${''.padEnd(8, '─')}  ${''.padEnd(16, '─')}  ${''.padEnd(18, '─')}  ${''.padEnd(24, '─')}  ${''.padEnd(22, '─')}  ${''.padEnd(22, '─')}`,
  ]

  const sorted = [...discovered].sort((a, b) =>
    (a.offline ? 1 : 0) - (b.offline ? 1 : 0) ||
    (a.ip || '').localeCompare(b.ip || '', undefined, { numeric: true })
  )

  for (const d of sorted) {
    const status    = d.offline ? 'OFFLINE' : 'ONLINE'
    const ip        = (d.ip || '—').padEnd(16)
    const mac       = d.mac.padEnd(18)
    const vendor    = (d.vendor || '—').slice(0, 24).padEnd(24)
    const firstSeen = new Date(d.firstSeen).toLocaleString().padEnd(22)
    const lastSeen  = new Date(d.lastSeen).toLocaleString()
    lines.push(`  ${status.padEnd(8)}  ${ip}  ${mac}  ${vendor}  ${firstSeen}  ${lastSeen}`)
  }

  lines.push('')
  lines.push('SUMMARY')
  lines.push('───────')
  lines.push(`  Total   : ${discovered.length}`)
  lines.push(`  Online  : ${discovered.filter(d => !d.offline).length}`)
  lines.push(`  Offline : ${discovered.filter(d => d.offline).length}`)
  lines.push('')
  lines.push('═══════════════════════════════════════════════════════════════════════════════════')

  return lines.join('\n')
}

function ReportModal({ discovered, lastScan, onClose }) {
  const [tab, setTab] = useState('executive')
  const content = tab === 'executive'
    ? buildExecutiveSummary(discovered, lastScan)
    : buildTechnicalReport(discovered, lastScan)

  const download = () => {
    const blob = new Blob([content], { type: 'text/plain' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href = url
    a.download = `network-${tab}-report-${new Date().toISOString().slice(0, 10)}.txt`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, background: '#00000090', zIndex: 1000,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
    }}>
      <div style={{
        background: 'var(--bg-surface)', border: '1px solid var(--bg-border)', borderRadius: 12,
        width: '100%', maxWidth: 860, maxHeight: '88vh',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: '14px 20px', borderBottom: '1px solid var(--bg-border)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <FileText size={16} color="#06b6d4" />
            <span style={{ fontWeight: 700, fontSize: 15, color: 'var(--input-text)' }}>Network Scan Report</span>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button onClick={download} style={{
              display: 'flex', alignItems: 'center', gap: 6,
              background: '#0a1a2a', border: '1px solid #0e4260', borderRadius: 6,
              color: '#06b6d4', fontSize: 12, padding: '5px 12px', cursor: 'pointer',
            }}>
              <Download size={12} /> Download .txt
            </button>
            <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--label-color)' }}>
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', borderBottom: '1px solid var(--bg-border)' }}>
          {[['executive', 'Executive Summary'], ['technical', 'Technical Report']].map(([key, label]) => (
            <button key={key} onClick={() => setTab(key)} style={{
              padding: '9px 20px', fontSize: 12, fontWeight: tab === key ? 700 : 400,
              color: tab === key ? '#06b6d4' : 'var(--label-color)',
              background: 'none', border: 'none', cursor: 'pointer',
              borderBottom: tab === key ? '2px solid #06b6d4' : '2px solid transparent',
              marginBottom: -1,
            }}>
              {label}
            </button>
          ))}
        </div>

        {/* Content */}
        <pre style={{
          flex: 1, overflowY: 'auto', margin: 0,
          padding: '16px 20px', fontSize: 11.5, lineHeight: 1.6,
          color: 'var(--btn-ghost-color)', fontFamily: 'JetBrains Mono, Consolas, monospace',
          whiteSpace: 'pre', background: '#070a0e',
        }}>
          {content}
        </pre>
      </div>
    </div>
  )
}

// ── Main Page ──────────────────────────────────────────────────────────────────

export default function NetworkDiscoveryPage() {
  // Subscribe to persistent service
  const [svc, setSvc] = useState(() => _svc._snap())
  useEffect(() => _svc.subscribe(setSvc), [])

  // Local UI state (not persisted across navigation)
  const [agents,         setAgents]         = useState([])
  const [filterCustomer, setFilterCustomer] = useState('')
  const [selectedAgent,  setSelectedAgent]  = useState(_svc.agentId || '')
  const [iface,          setIface]          = useState(_svc.iface || 'eth0')
  const [scanInterval,   setScanInterval]   = useState(_svc.interval || 60)
  const [showOffline,    setShowOffline]    = useState(true)
  const [interfaces,     setInterfaces]     = useState([])   // from sysinfo
  const [ifaceLoading,   setIfaceLoading]   = useState(false)
  const [selectedDevice, setSelectedDevice] = useState(null) // diagram click
  const [showReport,     setShowReport]     = useState(false)

  // Load active agents
  useEffect(() => {
    api.getDevices({ status: 'active' })
      .then(devs => {
        const list = Array.isArray(devs) ? devs : (devs.devices || [])
        setAgents(list)
        if (!selectedAgent && list.length > 0) setSelectedAgent(list[0].id)
      })
      .catch(() => {})
  }, [])

  const customers = [...new Map(
    agents.filter(d => d.customer_id).map(d => [d.customer_id, d.customer_name || d.customer_id])
  ).entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name))

  const scopedAgents = filterCustomer ? agents.filter(d => d.customer_id === filterCustomer) : agents

  // Fetch interface list from sysinfo when agent changes
  useEffect(() => {
    if (!selectedAgent) { setInterfaces([]); return }
    setIfaceLoading(true)
    api.getAllTasks({ device_id: selectedAgent, task_type: 'get_sysinfo', status: 'completed', limit: 1 })
      .then(data => {
        const tasks  = Array.isArray(data) ? data : (data.tasks || [])
        const result = tasks[0]?.result
        const ifaces = result?.interfaces
        if (Array.isArray(ifaces) && ifaces.length > 0) {
          const parsed = ifaces
            .map(i => {
              const name = typeof i === 'string' ? i : i.name
              const ip   = Array.isArray(i.addresses)
                ? (i.addresses.find(a => a.family === 'inet')?.addr || '')
                : ''
              return name ? { name, ip } : null
            })
            .filter(Boolean)
          setInterfaces(parsed)
          // Pre-select if current iface not in list
          if (parsed.length > 0 && !parsed.some(p => p.name === iface)) setIface(parsed[0].name)
        } else {
          setInterfaces([])
        }
      })
      .catch(() => setInterfaces([]))
      .finally(() => setIfaceLoading(false))
  }, [selectedAgent])

  const startMonitoring = () => {
    if (!selectedAgent) return
    _svc.start(selectedAgent, iface, scanInterval)
  }

  const stopMonitoring = () => _svc.stop()

  const markOneKnown = (mac) => {
    const d = svc.discovered.find(d => d.mac === mac)
    if (d) { _svc.known[d.mac] = { ip: d.ip, vendor: d.vendor }; saveKnown(_svc.known) }
    _svc.newMacs = new Set([..._svc.newMacs].filter(m => m !== mac))
    _svc._notify()
  }

  const { active, discovered, newMacs, lastScan, nextScanIn, scanning, error } = svc
  const online  = discovered.filter(d => !d.offline)
  const offline = discovered.filter(d => d.offline)

  return (
    <div style={{ padding: '28px 32px', maxWidth: 1100, margin: '0 auto' }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
        <Network size={22} color="#06b6d4" />
        <h1 style={{ fontSize: 22, fontWeight: 700, color: 'var(--input-text)', fontFamily: 'Syne, sans-serif', margin: 0 }}>
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
        {active && (
          <span style={{
            background: '#0a1a2a', color: '#06b6d4', border: '1px solid #0e4260',
            borderRadius: 9999, padding: '2px 10px', fontSize: 12, display: 'flex', alignItems: 'center', gap: 5,
          }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#06b6d4', display: 'inline-block' }} />
            Background active
          </span>
        )}
      </div>
      <p style={{ fontSize: 13, color: 'var(--label-color)', marginBottom: 28 }}>
        Continuously scan your network for devices. Monitoring continues in the background while you navigate elsewhere.
      </p>

      {/* Controls bar */}
      <div style={{
        background: 'var(--bg-surface)', border: '1px solid var(--bg-border)', borderRadius: 10,
        padding: '14px 18px', marginBottom: 20,
        display: 'flex', alignItems: 'flex-end', gap: 14, flexWrap: 'wrap',
      }}>
        {/* Customer filter (only shown with multiple customers) */}
        {customers.length > 1 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <label style={labelStyle}>Customer</label>
            <select
              value={filterCustomer}
              onChange={e => { setFilterCustomer(e.target.value); setSelectedAgent('') }}
              disabled={active}
              style={{ ...selectStyle, minWidth: 160, cursor: active ? 'not-allowed' : 'pointer' }}
            >
              <option value="">All customers</option>
              {customers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        )}

        {/* Agent */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <label style={labelStyle}>Agent</label>
          <select
            value={selectedAgent}
            onChange={e => setSelectedAgent(e.target.value)}
            disabled={active}
            style={{ ...selectStyle, minWidth: 200, cursor: active ? 'not-allowed' : 'pointer' }}
          >
            <option value="">— select active device —</option>
            {scopedAgents.map(d => (
              <option key={d.id} value={d.id}>{d.name} ({d.last_ip || 'no IP'})</option>
            ))}
          </select>
        </div>

        {/* Interface — dropdown if sysinfo available, text fallback */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <label style={labelStyle}>
            Interface {ifaceLoading && <Loader2 size={10} style={{ display: 'inline', animation: 'spin 1s linear infinite', marginLeft: 4 }} />}
          </label>
          {interfaces.length > 0 ? (
            <select
              value={iface}
              onChange={e => setIface(e.target.value)}
              disabled={active}
              style={{ ...selectStyle, width: 130, cursor: active ? 'not-allowed' : 'pointer' }}
            >
              {interfaces.map(({ name, ip }) => (
                <option key={name} value={name}>{name}{ip ? ` (${ip})` : ''}</option>
              ))}
            </select>
          ) : (
            <input
              value={iface}
              onChange={e => setIface(e.target.value)}
              disabled={active}
              placeholder="eth0"
              style={{ ...inputStyle, width: 90, cursor: active ? 'not-allowed' : 'text' }}
            />
          )}
        </div>

        {/* Scan interval */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <label style={labelStyle}>Interval</label>
          <select
            value={scanInterval}
            onChange={e => setScanInterval(Number(e.target.value))}
            disabled={active}
            style={{ ...selectStyle, cursor: active ? 'not-allowed' : 'pointer' }}
          >
            {SCAN_INTERVALS.map(i => <option key={i.value} value={i.value}>{i.label}</option>)}
          </select>
        </div>

        {/* Start / Stop */}
        <button
          onClick={active ? stopMonitoring : startMonitoring}
          disabled={!selectedAgent}
          style={{
            display: 'flex', alignItems: 'center', gap: 7,
            padding: '7px 16px', borderRadius: 7, border: 'none',
            cursor: selectedAgent ? 'pointer' : 'not-allowed',
            fontWeight: 700, fontSize: 13,
            background: active ? '#450a0a' : '#06b6d4',
            color: active ? '#fca5a5' : '#000f14',
            transition: 'all 0.15s',
          }}
        >
          {active ? <><Square size={14} /> Stop</> : <><Play size={14} /> Start Monitoring</>}
        </button>

        {/* Status indicators */}
        <div style={{ marginLeft: 'auto', display: 'flex', flexDirection: 'column', gap: 3, fontSize: 12, textAlign: 'right' }}>
          {scanning && (
            <span style={{ color: '#06b6d4', display: 'flex', alignItems: 'center', gap: 5, justifyContent: 'flex-end' }}>
              <Loader2 size={11} style={{ animation: 'spin 1s linear infinite' }} /> Scanning…
            </span>
          )}
          {lastScan && !scanning && (
            <span style={{ color: 'var(--label-color)' }}>Last: {new Date(lastScan).toLocaleTimeString()}</span>
          )}
          {nextScanIn !== null && !scanning && (
            <span style={{ color: 'var(--label-color)' }}>Next in {nextScanIn}s</span>
          )}
          {error && (
            <span style={{ color: '#ef4444', maxWidth: 200, wordBreak: 'break-word' }}>
              <AlertTriangle size={11} style={{ display: 'inline', marginRight: 3 }} />{error}
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
            { label: 'Offline',          value: offline.length,    color: 'var(--btn-ghost-color)' },
            { label: 'New devices',      value: newMacs.size,      color: '#f59e0b' },
          ].map(s => (
            <div key={s.label} style={{ background: 'var(--bg-surface)', border: '1px solid var(--bg-border)', borderRadius: 8, padding: '12px 16px' }}>
              <div style={{ fontSize: 24, fontWeight: 700, color: s.color, fontFamily: 'JetBrains Mono, monospace' }}>{s.value}</div>
              <div style={{ fontSize: 11, color: 'var(--label-color)', marginTop: 2, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{s.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Main content: diagram full-width, table below */}
      {discovered.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Network diagram — full width */}
          <div style={{ background: '#0a0c10', border: '1px solid var(--bg-border)', borderRadius: 10, overflow: 'hidden' }}>
            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '10px 14px', borderBottom: '1px solid var(--bg-border)',
            }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--btn-ghost-color)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                Network Map
              </span>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <span style={{ fontSize: 11, color: 'var(--label-color)' }}>Scroll to zoom · Drag to pan · Click node for details</span>
                <button
                  onClick={() => setShowOffline(v => !v)}
                  style={{ display: 'flex', alignItems: 'center', gap: 5, background: 'none', border: 'none', cursor: 'pointer', fontSize: 11, color: 'var(--label-color)' }}
                >
                  {showOffline ? <EyeOff size={12} /> : <Eye size={12} />}
                  {showOffline ? 'Hide offline' : 'Show offline'}
                </button>
                <button
                  onClick={() => setShowReport(true)}
                  style={{ display: 'flex', alignItems: 'center', gap: 5, background: '#0a1a2a', border: '1px solid #0e4260', borderRadius: 6, cursor: 'pointer', fontSize: 11, color: '#06b6d4', padding: '4px 10px' }}
                >
                  <FileText size={11} /> Generate Report
                </button>
              </div>
            </div>
            <div style={{ position: 'relative', height: 460 }}>
              <NetworkDiagram
                discovered={discovered}
                newMacs={newMacs}
                showOffline={showOffline}
                onNodeClick={setSelectedDevice}
              />
              {selectedDevice && (
                <DeviceDetail
                  device={selectedDevice}
                  isNew={newMacs.has(selectedDevice.mac)}
                  onClose={() => setSelectedDevice(null)}
                  onForget={(mac) => _svc.forgetDevice(mac)}
                  onMarkKnown={markOneKnown}
                />
              )}
            </div>
          </div>

          {/* Device table — full width below diagram */}
          <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--bg-border)', borderRadius: 10, overflow: 'hidden' }}>
            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '10px 14px', borderBottom: '1px solid var(--bg-border)',
            }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--btn-ghost-color)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                Discovered Devices
              </span>
              {newMacs.size > 0 && (
                <button
                  onClick={() => _svc.markAllKnown()}
                  style={{ fontSize: 11, color: '#22c55e', background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}
                >
                  <CheckCircle size={11} /> Mark all known
                </button>
              )}
            </div>
            <div style={{ overflowY: 'auto', maxHeight: 320 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily: 'JetBrains Mono, monospace' }}>
                <thead>
                  <tr style={{ position: 'sticky', top: 0, background: 'var(--bg-surface)' }}>
                    {['', 'IP', 'MAC', 'Vendor', 'Last seen', ''].map((h, i) => (
                      <th key={i} style={{ textAlign: 'left', padding: '6px 10px', color: 'var(--label-color)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em', borderBottom: '1px solid var(--bg-border)', fontWeight: 600 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[...discovered]
                    .sort((a, b) => (a.offline ? 1 : 0) - (b.offline ? 1 : 0) || (a.ip || '').localeCompare(b.ip || ''))
                    .map(d => {
                      const isNew = newMacs.has(d.mac)
                      return (
                        <tr
                          key={d.mac}
                          onClick={() => setSelectedDevice(d)}
                          style={{ borderBottom: '1px solid #0a0c0f', background: isNew ? 'var(--green-dim)' : 'transparent', cursor: 'pointer' }}
                        >
                          <td style={{ padding: '6px 10px' }}>
                            <span style={{ fontSize: 16, color: d.offline ? 'var(--label-color)' : isNew ? '#22c55e' : '#1d4ed8', lineHeight: 1 }}>●</span>
                          </td>
                          <td style={{ padding: '6px 10px', color: d.offline ? 'var(--label-color)' : 'var(--input-text)' }}>{d.ip}</td>
                          <td style={{ padding: '6px 10px', color: 'var(--btn-ghost-color)', fontSize: 11 }}>{d.mac}</td>
                          <td style={{ padding: '6px 10px', color: 'var(--label-color)', fontSize: 11 }}>{d.vendor || '—'}</td>
                          <td style={{ padding: '6px 10px', color: 'var(--label-color)', fontSize: 11 }}>
                            {new Date(d.lastSeen).toLocaleTimeString()}
                          </td>
                          <td style={{ padding: '6px 8px' }}>
                            <button
                              onClick={(e) => { e.stopPropagation(); _svc.forgetDevice(d.mac) }}
                              title="Remove"
                              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--label-color)', padding: 2 }}
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
        <div style={{
          textAlign: 'center', padding: '70px 0', color: 'var(--label-color)',
          border: '1px dashed var(--bg-border)', borderRadius: 10,
        }}>
          <Network size={52} color="var(--bg-border)" style={{ marginBottom: 16 }} />
          <p style={{ fontSize: 14, marginBottom: 6 }}>No devices discovered yet</p>
          <p style={{ fontSize: 12, color: 'var(--bg-border)' }}>
            Select an agent and click <strong style={{ color: 'var(--label-color)' }}>Start Monitoring</strong> to begin scanning.
          </p>
        </div>
      )}

      {showReport && (
        <ReportModal
          discovered={discovered}
          lastScan={lastScan}
          onClose={() => setShowReport(false)}
        />
      )}
    </div>
  )
}

// ── Shared style tokens ────────────────────────────────────────────────────────

const labelStyle = {
  fontSize: 11, color: 'var(--label-color)', textTransform: 'uppercase', letterSpacing: '0.08em',
}

const selectStyle = {
  background: 'var(--bg-base)', border: '1px solid var(--bg-border)', borderRadius: 6,
  color: 'var(--input-text)', padding: '6px 10px', fontSize: 13,
  fontFamily: 'JetBrains Mono, monospace', outline: 'none',
}

const inputStyle = {
  background: 'var(--bg-base)', border: '1px solid var(--bg-border)', borderRadius: 6,
  color: 'var(--input-text)', padding: '6px 10px', fontSize: 13,
  fontFamily: 'JetBrains Mono, monospace', outline: 'none',
}
