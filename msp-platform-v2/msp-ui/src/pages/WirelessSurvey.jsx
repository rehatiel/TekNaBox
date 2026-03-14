import { useState, useEffect, useCallback, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api } from '../lib/api'
import { PageHeader, Spinner, Alert, Empty } from '../components/ui'
import { Wifi, RefreshCw, Play, Signal, Lock, Unlock, Radio, ChevronDown } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'

// ── Signal quality helpers ────────────────────────────────────────────────────

function signalQuality(dbm) {
  if (dbm === null || dbm === undefined) return { label: 'Unknown', pct: 0, color: '#475569' }
  if (dbm >= -50) return { label: 'Excellent', pct: 100, color: '#22c55e' }
  if (dbm >= -60) return { label: 'Good',      pct: 80,  color: '#86efac' }
  if (dbm >= -70) return { label: 'Fair',       pct: 55,  color: '#f59e0b' }
  if (dbm >= -80) return { label: 'Weak',       pct: 30,  color: '#f97316' }
  return                  { label: 'Poor',       pct: 12,  color: '#ef4444' }
}

function encColor(enc) {
  if (enc === 'WPA2') return '#06b6d4'
  if (enc === 'WPA')  return '#f59e0b'
  if (enc === 'WEP' || enc === 'WEP/Unknown') return '#ef4444'
  return '#475569'
}

function bandLabel(freq) {
  if (!freq) return '?'
  if (freq < 3000) return '2.4 GHz'
  if (freq < 6000) return '5 GHz'
  return '6 GHz'
}

// ── Channel congestion map ────────────────────────────────────────────────────

function ChannelMap({ networks }) {
  const canvasRef = useRef(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !networks.length) return
    const ctx = canvas.getContext('2d')
    const W = canvas.width
    const H = canvas.height
    ctx.clearRect(0, 0, W, H)

    // Split by band
    const band24 = networks.filter(n => n.frequency_mhz && n.frequency_mhz < 3000)
    const band5  = networks.filter(n => n.frequency_mhz && n.frequency_mhz >= 3000)

    // Draw 2.4 GHz channels 1–13
    const draw24 = (nets, yBase, height) => {
      const channels = [1,2,3,4,5,6,7,8,9,10,11,12,13]
      const channelX = ch => ((ch - 1) / 12) * (W - 60) + 30

      // Grid lines
      ctx.strokeStyle = '#1e2630'
      ctx.lineWidth = 1
      channels.forEach(ch => {
        const x = channelX(ch)
        ctx.beginPath()
        ctx.moveTo(x, yBase - height)
        ctx.lineTo(x, yBase)
        ctx.stroke()
        ctx.fillStyle = '#475569'
        ctx.font = '10px JetBrains Mono'
        ctx.textAlign = 'center'
        ctx.fillText(ch, x, yBase + 14)
      })

      // Draw bell curves for each network
      nets.forEach(net => {
        const ch = net.channel || 6
        const x = channelX(ch)
        const q = signalQuality(net.signal_dbm)
        const amp = (q.pct / 100) * height * 0.9

        ctx.beginPath()
        const spread = 2.5 * ((W - 60) / 12)
        for (let px = 0; px < W; px++) {
          const dx = px - x
          const y = yBase - amp * Math.exp(-(dx * dx) / (2 * spread * spread))
          if (px === 0) ctx.moveTo(px, yBase)
          ctx.lineTo(px, y)
        }
        ctx.lineTo(W, yBase)
        ctx.closePath()

        const grad = ctx.createLinearGradient(0, yBase - amp, 0, yBase)
        const col = q.color
        grad.addColorStop(0, col + 'cc')
        grad.addColorStop(1, col + '11')
        ctx.fillStyle = grad
        ctx.fill()

        // Peak label
        if (amp > 18) {
          ctx.fillStyle = '#e2e8f0'
          ctx.font = '9px DM Sans'
          ctx.textAlign = 'center'
          const label = net.ssid || net.bssid?.slice(0, 8) || '?'
          ctx.fillText(label.slice(0, 12), x, yBase - amp - 4)
        }
      })
    }

    // Draw 5 GHz channels (36, 40, 44, 48, 52, 56, 60, 64, 100–...)
    const draw5 = (nets, yBase, height) => {
      const commonChannels = [36,40,44,48,52,56,60,64,100,104,108,112,116,120,124,128,132,136,140,149,153,157,161,165]
      const usedChannels = [...new Set(nets.map(n => n.channel).filter(Boolean))]
      const displayChs = [...new Set([...commonChannels, ...usedChannels])].sort((a, b) => a - b)
      const n = displayChs.length || 1
      const channelX = ch => {
        const idx = displayChs.indexOf(ch)
        return idx < 0 ? W / 2 : (idx / (n - 1 || 1)) * (W - 60) + 30
      }

      ctx.strokeStyle = '#1e2630'
      ctx.lineWidth = 1
      displayChs.forEach(ch => {
        const x = channelX(ch)
        ctx.beginPath()
        ctx.moveTo(x, yBase - height)
        ctx.lineTo(x, yBase)
        ctx.stroke()
        ctx.fillStyle = '#334155'
        ctx.font = '9px JetBrains Mono'
        ctx.textAlign = 'center'
        ctx.fillText(ch, x, yBase + 14)
      })

      nets.forEach(net => {
        if (!net.channel) return
        const x = channelX(net.channel)
        const q = signalQuality(net.signal_dbm)
        const amp = (q.pct / 100) * height * 0.9
        const spread = (W - 60) / n * 1.2

        ctx.beginPath()
        for (let px = 0; px < W; px++) {
          const dx = px - x
          const y = yBase - amp * Math.exp(-(dx * dx) / (2 * spread * spread))
          if (px === 0) ctx.moveTo(px, yBase)
          ctx.lineTo(px, y)
        }
        ctx.lineTo(W, yBase)
        ctx.closePath()

        const grad = ctx.createLinearGradient(0, yBase - amp, 0, yBase)
        const col = q.color
        grad.addColorStop(0, col + 'cc')
        grad.addColorStop(1, col + '11')
        ctx.fillStyle = grad
        ctx.fill()

        if (amp > 18) {
          ctx.fillStyle = '#e2e8f0'
          ctx.font = '9px DM Sans'
          ctx.textAlign = 'center'
          const label = net.ssid || net.bssid?.slice(0, 8) || '?'
          ctx.fillText(label.slice(0, 12), x, yBase - amp - 4)
        }
      })
    }

    const halfH = Math.floor(H / 2)

    // Section labels
    ctx.fillStyle = '#0d7490'
    ctx.font = '11px Syne'
    ctx.textAlign = 'left'
    ctx.fillText('2.4 GHz', 4, 16)
    ctx.fillText('5 GHz', 4, halfH + 16)

    // Baselines
    ctx.strokeStyle = '#1e2630'
    ctx.lineWidth = 1
    ctx.beginPath(); ctx.moveTo(0, halfH - 20); ctx.lineTo(W, halfH - 20); ctx.stroke()
    ctx.beginPath(); ctx.moveTo(0, H - 20); ctx.lineTo(W, H - 20); ctx.stroke()

    draw24(band24, halfH - 22, halfH - 40)
    draw5(band5,   H - 22,     halfH - 40)
  }, [networks])

  return (
    <canvas
      ref={canvasRef}
      width={900}
      height={320}
      className="w-full rounded"
      style={{ background: '#0a0c0f' }}
    />
  )
}

// ── Signal bar ────────────────────────────────────────────────────────────────

function SignalBars({ dbm }) {
  const q = signalQuality(dbm)
  const bars = [20, 40, 60, 80, 100]
  return (
    <div className="flex items-end gap-0.5 h-4">
      {bars.map((threshold, i) => (
        <div
          key={i}
          className="w-1 rounded-sm"
          style={{
            height: `${(i + 1) * 20}%`,
            backgroundColor: q.pct >= threshold ? q.color : '#1e2630',
          }}
        />
      ))}
    </div>
  )
}

// ── Network card ──────────────────────────────────────────────────────────────

function NetworkCard({ net, rank }) {
  const q = signalQuality(net.signal_dbm)
  const enc = net.encryption || 'Open'
  const isOpen = enc === 'Open'

  return (
    <div className="card p-4 relative overflow-hidden group hover:border-slate-700 transition-colors duration-150">
      {/* Rank glow accent */}
      {rank <= 3 && (
        <div
          className="absolute top-0 left-0 w-0.5 h-full rounded-l"
          style={{ backgroundColor: rank === 1 ? '#22c55e' : rank === 2 ? '#06b6d4' : '#f59e0b' }}
        />
      )}

      <div className="flex items-start justify-between mb-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <SignalBars dbm={net.signal_dbm} />
            <span className="font-display font-600 text-slate-200 text-sm truncate">
              {net.ssid || <span className="text-slate-600 italic">Hidden network</span>}
            </span>
          </div>
          <p className="font-mono text-xs text-slate-600">{net.bssid}</p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0 ml-3">
          {isOpen
            ? <Unlock className="w-3.5 h-3.5 text-red-DEFAULT" />
            : <Lock className="w-3.5 h-3.5" style={{ color: encColor(enc) }} />
          }
          <span className="text-xs font-mono" style={{ color: encColor(enc) }}>{enc}</span>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 text-center">
        <div className="bg-bg-base rounded px-2 py-1.5">
          <p className="text-xs text-slate-600 mb-0.5">Signal</p>
          <p className="font-mono text-xs font-600" style={{ color: q.color }}>
            {net.signal_dbm !== null ? `${net.signal_dbm} dBm` : '—'}
          </p>
        </div>
        <div className="bg-bg-base rounded px-2 py-1.5">
          <p className="text-xs text-slate-600 mb-0.5">Channel</p>
          <p className="font-mono text-xs text-slate-300">{net.channel ?? '—'}</p>
        </div>
        <div className="bg-bg-base rounded px-2 py-1.5">
          <p className="text-xs text-slate-600 mb-0.5">Band</p>
          <p className="font-mono text-xs text-slate-300">{bandLabel(net.frequency_mhz)}</p>
        </div>
      </div>

      {/* Quality bar */}
      <div className="mt-3 h-1 bg-bg-border rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-700"
          style={{ width: `${q.pct}%`, backgroundColor: q.color }}
        />
      </div>
      <div className="flex justify-between mt-1">
        <span className="text-xs text-slate-700">Signal quality</span>
        <span className="text-xs" style={{ color: q.color }}>{q.label}</span>
      </div>
    </div>
  )
}

// ── Stats bar ─────────────────────────────────────────────────────────────────

function StatsBar({ networks }) {
  const enc = networks.reduce((acc, n) => {
    const e = n.encryption || 'Open'
    acc[e] = (acc[e] || 0) + 1
    return acc
  }, {})
  const band24 = networks.filter(n => n.frequency_mhz && n.frequency_mhz < 3000).length
  const band5  = networks.filter(n => n.frequency_mhz && n.frequency_mhz >= 3000).length
  const openNets = networks.filter(n => !n.encryption || n.encryption === 'Open').length

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
      {[
        { label: 'Networks Found', value: networks.length, color: 'text-cyan-DEFAULT' },
        { label: '2.4 GHz',        value: band24,           color: 'text-amber-DEFAULT' },
        { label: '5 GHz',          value: band5,            color: 'text-cyan-bright' },
        { label: 'Open / Unsecured', value: openNets,       color: openNets > 0 ? 'text-red-DEFAULT' : 'text-green-DEFAULT' },
      ].map(({ label, value, color }) => (
        <div key={label} className="card px-4 py-3 flex items-center justify-between">
          <span className="text-xs text-slate-500">{label}</span>
          <span className={`font-display font-700 text-xl ${color}`}>{value}</span>
        </div>
      ))}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function WirelessSurveyPage() {
  const [searchParams] = useSearchParams()
  const [devices, setDevices] = useState([])
  const [selectedDevice, setSelectedDevice] = useState(searchParams.get('device') || '')
  const [interface_, setInterface] = useState('wlan0')
  const [loading, setLoading] = useState(false)
  const [surveying, setSurveying] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState(null)
  const [taskId, setTaskId] = useState(null)
  const [pollingRef, setPollingRef] = useState(null)
  const [sortBy, setSortBy] = useState('signal')

  // Load devices
  useEffect(() => {
    api.getDevices().then(setDevices).catch(() => {})
  }, [])

  const stopPolling = useCallback(() => {
    if (pollingRef) {
      clearInterval(pollingRef)
      setPollingRef(null)
    }
  }, [pollingRef])

  const startSurvey = async () => {
    if (!selectedDevice) { setError('Select a device first'); return }
    stopPolling()
    setSurveying(true)
    setError('')
    setResult(null)
    setTaskId(null)

    try {
      const resp = await api.issueTask(selectedDevice, {
        task_type: 'run_wireless_survey',
        payload: { interface: interface_ || 'wlan0' },
        timeout_seconds: 60,
      })
      const tid = resp.task_id
      setTaskId(tid)

      // Poll for result
      const interval = setInterval(async () => {
        try {
          const tasks = await api.getTasks(selectedDevice)
          const task = tasks.find(t => t.id === tid)
          if (!task) return
          if (task.status === 'completed') {
            clearInterval(interval)
            setSurveying(false)
            setResult({ networks: task.result?.networks || [], interface: task.result?.interface, scannedAt: task.completed_at })
          } else if (['failed', 'timeout', 'cancelled'].includes(task.status)) {
            clearInterval(interval)
            setSurveying(false)
            setError(task.error || `Survey ${task.status}`)
          }
        } catch (e) {
          clearInterval(interval)
          setSurveying(false)
          setError(e.message)
        }
      }, 2500)
      setPollingRef(interval)
    } catch (e) {
      setSurveying(false)
      setError(e.message)
    }
  }

  const sortedNetworks = result?.networks
    ? [...result.networks].sort((a, b) => {
        if (sortBy === 'signal') return (b.signal_dbm ?? -999) - (a.signal_dbm ?? -999)
        if (sortBy === 'channel') return (a.channel ?? 999) - (b.channel ?? 999)
        if (sortBy === 'ssid') return (a.ssid || '').localeCompare(b.ssid || '')
        return 0
      })
    : []

  const onlineDevices = devices.filter(d => d.status === 'active' || d.status === 'online')

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Wireless Survey"
        subtitle="Scan and visualize the RF environment from any enrolled device"
        icon={<Radio className="w-5 h-5 text-cyan-DEFAULT" />}
      />

      {/* ── Controls ── */}
      <div className="card p-4 mb-5">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-48">
            <label className="label mb-1.5">Device</label>
            <div className="relative">
              <select
                className="input pr-8 appearance-none"
                value={selectedDevice}
                onChange={e => setSelectedDevice(e.target.value)}
                disabled={surveying}
              >
                <option value="">— Select a device —</option>
                {onlineDevices.map(d => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
                {devices.filter(d => !['active','online'].includes(d.status)).map(d => (
                  <option key={d.id} value={d.id} disabled>{d.name} ({d.status})</option>
                ))}
              </select>
              <ChevronDown className="absolute right-2.5 top-2.5 w-3.5 h-3.5 text-slate-600 pointer-events-none" />
            </div>
          </div>

          <div className="w-36">
            <label className="label mb-1.5">Interface</label>
            <input
              className="input"
              value={interface_}
              onChange={e => setInterface(e.target.value)}
              placeholder="wlan0"
              disabled={surveying}
            />
          </div>

          <button
            onClick={startSurvey}
            disabled={surveying || !selectedDevice}
            className="btn-primary flex items-center gap-2 h-9"
          >
            {surveying
              ? <><Spinner size="sm" /><span>Scanning…</span></>
              : <><Play className="w-3.5 h-3.5" /><span>Run Survey</span></>
            }
          </button>

          {result && (
            <button onClick={startSurvey} disabled={surveying} className="btn-ghost flex items-center gap-1.5 h-9">
              <RefreshCw className="w-3.5 h-3.5" /> Re-scan
            </button>
          )}
        </div>

        {surveying && (
          <div className="mt-3 flex items-center gap-2 text-xs text-slate-500">
            <div className="w-1.5 h-1.5 rounded-full bg-cyan-DEFAULT animate-pulse" />
            Scanning wireless environment on {devices.find(d => d.id === selectedDevice)?.name}…
          </div>
        )}
      </div>

      {error && <Alert type="error" message={error} className="mb-4" />}

      {/* ── Results ── */}
      {result && (
        <div className="animate-slide-up">
          {/* Metadata strip */}
          <div className="flex items-center gap-4 mb-4 text-xs text-slate-600">
            <span className="font-mono">{result.interface}</span>
            <span>·</span>
            <span>{result.networks.length} networks detected</span>
            {result.scannedAt && (
              <>
                <span>·</span>
                <span>Scanned {formatDistanceToNow(new Date(result.scannedAt), { addSuffix: true })}</span>
              </>
            )}
          </div>

          <StatsBar networks={result.networks} />

          {/* Channel map */}
          {result.networks.length > 0 && (
            <div className="card p-4 mb-5">
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-display font-600 text-slate-200 text-sm flex items-center gap-2">
                  <Signal className="w-4 h-4 text-cyan-DEFAULT" />
                  Channel Congestion Map
                </h3>
                <div className="flex items-center gap-3 text-xs text-slate-600">
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-green-DEFAULT inline-block" />Strong</span>
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-amber-DEFAULT inline-block" />Fair</span>
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-red-DEFAULT inline-block" />Weak</span>
                </div>
              </div>
              <ChannelMap networks={result.networks} />
            </div>
          )}

          {/* Network grid */}
          {result.networks.length === 0 ? (
            <Empty message="No wireless networks detected. Ensure the interface is wireless and the device has scanning permissions." />
          ) : (
            <>
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-display font-600 text-slate-200 text-sm">
                  Detected Networks
                </h3>
                <div className="flex items-center gap-1">
                  <span className="text-xs text-slate-600 mr-1">Sort:</span>
                  {['signal','channel','ssid'].map(s => (
                    <button
                      key={s}
                      onClick={() => setSortBy(s)}
                      className={`text-xs px-2.5 py-1 rounded transition-colors duration-100 capitalize ${
                        sortBy === s
                          ? 'bg-cyan-dim text-cyan-bright'
                          : 'text-slate-500 hover:text-slate-300'
                      }`}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {sortedNetworks.map((net, i) => (
                  <NetworkCard key={net.bssid || i} net={net} rank={i + 1} />
                ))}
              </div>

              {/* Security summary */}
              {result.networks.some(n => !n.encryption || n.encryption === 'Open') && (
                <div className="card border-red-muted/40 p-4 mt-4 flex items-start gap-3">
                  <Unlock className="w-4 h-4 text-red-DEFAULT shrink-0 mt-0.5" />
                  <div>
                    <p className="text-sm text-red-DEFAULT font-display font-600 mb-0.5">Open Networks Detected</p>
                    <p className="text-xs text-slate-500">
                      {result.networks.filter(n => !n.encryption || n.encryption === 'Open').map(n => n.ssid || 'Hidden').join(', ')} — these networks have no encryption and may pose a security risk.
                    </p>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {!result && !surveying && !error && (
        <div className="card py-16 text-center">
          <Wifi className="w-10 h-10 text-slate-700 mx-auto mb-3" />
          <p className="text-slate-500 text-sm">Select a device and run a survey to visualize the wireless environment</p>
          <p className="text-slate-700 text-xs mt-1">The agent will scan for nearby networks and return signal, channel, and security data</p>
        </div>
      )}
    </div>
  )
}
