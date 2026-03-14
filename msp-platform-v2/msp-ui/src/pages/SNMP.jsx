import { useState, useEffect, useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api } from '../lib/api'
import {
  PageHeader, Spinner, Alert, Modal, Empty,
  Table, TR, TD, StatusBadge
} from '../components/ui'
import { Network, RefreshCw, Play, ChevronDown, ChevronRight, Clock, Server } from 'lucide-react'
import { formatDistanceToNow, format } from 'date-fns'

// ── Quick-pick OID presets ────────────────────────────────────────────────────
const QUICK_MODES = [
  { label: 'System Info',  value: 'sysinfo',    desc: 'Name, description, uptime, contact, location' },
  { label: 'Interfaces',   value: 'interfaces', desc: 'ifTable — interface list, speed, status, MAC' },
  { label: 'Storage',      value: 'storage',    desc: 'hrStorageTable — disk/memory usage' },
  { label: 'Full Walk',    value: 'full',       desc: 'All of the above combined' },
  { label: 'Custom OIDs',  value: 'custom',     desc: 'Enter specific OIDs manually' },
]

const COMMON_OIDS = [
  { label: 'sysDescr',       oid: '1.3.6.1.2.1.1.1.0' },
  { label: 'sysUpTime',      oid: '1.3.6.1.2.1.1.3.0' },
  { label: 'sysName',        oid: '1.3.6.1.2.1.1.5.0' },
  { label: 'sysLocation',    oid: '1.3.6.1.2.1.1.6.0' },
  { label: 'ifNumber',       oid: '1.3.6.1.2.1.2.1.0' },
  { label: 'hrMemorySize',   oid: '1.3.6.1.2.1.25.2.2.0' },
  { label: 'tcpCurrEstab',   oid: '1.3.6.1.2.1.6.9.0' },
  { label: 'icmpInEchos',    oid: '1.3.6.1.2.1.5.8.0' },
]

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtUptime(val) {
  if (!val) return '—'
  // timeticks: "(123456) 0:20:34.56" — extract human part
  const m = val.match(/\)\s*(.+)/)
  return m ? m[1].trim() : val
}

function usePct(used, size) {
  if (!size) return 0
  return Math.round((used / size) * 100)
}

// ── Sub-components ────────────────────────────────────────────────────────────

function SysInfoPanel({ data }) {
  if (!data) return <p className="text-xs text-slate-600">No sysinfo data.</p>
  const rows = [
    { label: 'Name',        value: data.sysName },
    { label: 'Description', value: data.sysDescr },
    { label: 'Location',    value: data.sysLocation },
    { label: 'Contact',     value: data.sysContact },
    { label: 'Uptime',      value: fmtUptime(data.sysUpTime) },
    { label: 'Object ID',   value: data.sysObjectID },
  ]
  return (
    <div className="grid grid-cols-1 gap-2">
      {rows.map(({ label, value }) => value ? (
        <div key={label} className="flex gap-3 py-2 border-b border-bg-border/40 last:border-0">
          <span className="text-xs text-slate-500 w-24 shrink-0">{label}</span>
          <span className="text-xs font-mono text-slate-200 break-all">{value}</span>
        </div>
      ) : null)}
    </div>
  )
}

function InterfacesPanel({ data }) {
  if (!data || !data.length) return <p className="text-xs text-slate-600">No interface data.</p>
  return (
    <Table headers={['#', 'Name', 'Type', 'Speed', 'Status', 'MAC']}>
      {data.map(iface => (
        <TR key={iface.index}>
          <TD><span className="text-xs font-mono text-slate-500">{iface.index}</span></TD>
          <TD><span className="text-xs font-mono text-slate-200">{iface.name || '—'}</span></TD>
          <TD><span className="text-xs text-slate-400">{iface.type || '—'}</span></TD>
          <TD>
            <span className="text-xs font-mono text-slate-400">
              {iface.speed_mbps != null ? `${iface.speed_mbps} Mbps` : '—'}
            </span>
          </TD>
          <TD>
            {iface.status ? (
              <span className={`text-xs font-mono ${iface.status === 'up' ? 'text-green-DEFAULT' : 'text-slate-600'}`}>
                {iface.status}
              </span>
            ) : '—'}
          </TD>
          <TD><span className="text-xs font-mono text-slate-500">{iface.mac || '—'}</span></TD>
        </TR>
      ))}
    </Table>
  )
}

function StoragePanel({ data }) {
  if (!data || !data.length) return <p className="text-xs text-slate-600">No storage data.</p>
  return (
    <div className="space-y-3">
      {data.map((s, i) => {
        const pct = usePct(s.used_mb, s.size_mb)
        const barColor = pct > 90 ? 'bg-red-DEFAULT' : pct > 70 ? 'bg-amber-DEFAULT' : 'bg-cyan-DEFAULT'
        return (
          <div key={i} className="card px-4 py-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-mono text-slate-200">{s.description || `Volume ${i + 1}`}</span>
              <span className="text-xs font-mono text-slate-500">
                {s.used_mb?.toFixed(0)} MB / {s.size_mb?.toFixed(0)} MB
                <span className={`ml-2 ${pct > 90 ? 'text-red-DEFAULT' : pct > 70 ? 'text-amber-DEFAULT' : 'text-slate-400'}`}>
                  ({pct}%)
                </span>
              </span>
            </div>
            <div className="h-1.5 bg-bg-base rounded-full overflow-hidden">
              <div className={`h-full ${barColor} rounded-full transition-all`} style={{ width: `${pct}%` }} />
            </div>
          </div>
        )
      })}
    </div>
  )
}

function CustomPanel({ data }) {
  if (!data) return <p className="text-xs text-slate-600">No custom OID data.</p>
  const entries = Object.entries(data)
  if (!entries.length) return <p className="text-xs text-slate-600">No results returned.</p>
  return (
    <div className="space-y-1">
      {entries.map(([oid, val]) => (
        <div key={oid} className="flex gap-3 py-2 border-b border-bg-border/40 last:border-0">
          <span className="text-xs font-mono text-cyan-muted w-48 shrink-0 truncate" title={oid}>{oid}</span>
          <span className="text-xs font-mono text-slate-200 break-all">{val ?? 'null'}</span>
        </div>
      ))}
    </div>
  )
}

function ResultViewer({ result }) {
  const tabs = []
  if (result.sysinfo)    tabs.push({ key: 'sysinfo',    label: 'System Info' })
  if (result.interfaces) tabs.push({ key: 'interfaces', label: `Interfaces (${result.interfaces.length})` })
  if (result.storage)    tabs.push({ key: 'storage',    label: `Storage (${result.storage.length})` })
  if (result.custom)     tabs.push({ key: 'custom',     label: 'Custom OIDs' })

  const [activeTab, setActiveTab] = useState(tabs[0]?.key || '')

  if (!tabs.length) return (
    <div className="rounded bg-bg-base border border-bg-border p-4 text-xs font-mono text-slate-500">
      No structured data — raw result: {JSON.stringify(result, null, 2)}
    </div>
  )

  return (
    <div>
      {/* Tab bar */}
      <div className="flex gap-1 border-b border-bg-border mb-4">
        {tabs.map(t => (
          <button
            key={t.key}
            onClick={() => setActiveTab(t.key)}
            className={`px-3 py-2 text-xs font-display font-500 border-b-2 transition-colors -mb-px ${
              activeTab === t.key
                ? 'border-cyan-DEFAULT text-cyan-DEFAULT'
                : 'border-transparent text-slate-500 hover:text-slate-300'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {activeTab === 'sysinfo'    && <SysInfoPanel    data={result.sysinfo} />}
      {activeTab === 'interfaces' && <InterfacesPanel data={result.interfaces} />}
      {activeTab === 'storage'    && <StoragePanel    data={result.storage} />}
      {activeTab === 'custom'     && <CustomPanel     data={result.custom} />}
    </div>
  )
}

// ── Run Query Modal ───────────────────────────────────────────────────────────

function RunQueryModal({ devices, onClose, onSubmit, loading }) {
  const [deviceId, setDeviceId]   = useState(devices[0]?.id || '')
  const [target, setTarget]       = useState('')
  const [community, setCommunity] = useState('public')
  const [version, setVersion]     = useState('2c')
  const [mode, setMode]           = useState('sysinfo')
  const [customOids, setCustomOids] = useState('')

  const handleSubmit = () => {
    const payload = { target, community, version, mode }
    if (mode === 'custom') {
      payload.oids = customOids.split('\n').map(s => s.trim()).filter(Boolean)
    }
    onSubmit(deviceId, payload)
  }

  const addOid = (oid) => {
    setCustomOids(prev => prev ? `${prev}\n${oid}` : oid)
    setMode('custom')
  }

  return (
    <Modal title="Run SNMP Query" onClose={onClose} width="max-w-2xl">
      <div className="space-y-4">
        {/* Device + Target */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label mb-1">Device (agent)</label>
            <select className="input w-full" value={deviceId} onChange={e => setDeviceId(e.target.value)}>
              {devices.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>
          <div>
            <label className="label mb-1">Target IP / Hostname</label>
            <input
              className="input w-full"
              placeholder="192.168.1.1"
              value={target}
              onChange={e => setTarget(e.target.value)}
            />
          </div>
        </div>

        {/* Community + Version */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label mb-1">Community String</label>
            <input
              className="input w-full"
              placeholder="public"
              value={community}
              onChange={e => setCommunity(e.target.value)}
            />
          </div>
          <div>
            <label className="label mb-1">SNMP Version</label>
            <select className="input w-full" value={version} onChange={e => setVersion(e.target.value)}>
              <option value="1">v1</option>
              <option value="2c">v2c</option>
              <option value="3">v3</option>
            </select>
          </div>
        </div>

        {/* Mode */}
        <div>
          <label className="label mb-2">Query Mode</label>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {QUICK_MODES.map(m => (
              <button
                key={m.value}
                onClick={() => setMode(m.value)}
                className={`text-left px-3 py-2 rounded border transition-colors ${
                  mode === m.value
                    ? 'border-cyan-DEFAULT bg-cyan-dim text-cyan-bright'
                    : 'border-bg-border bg-bg-base text-slate-400 hover:border-slate-600'
                }`}
              >
                <p className="text-xs font-display font-500">{m.label}</p>
                <p className="text-xs text-slate-600 mt-0.5 leading-tight">{m.desc}</p>
              </button>
            ))}
          </div>
        </div>

        {/* Custom OIDs */}
        {mode === 'custom' && (
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="label">OIDs (one per line)</label>
              <span className="text-xs text-slate-600">Quick-add:</span>
            </div>
            <div className="flex flex-wrap gap-1 mb-2">
              {COMMON_OIDS.map(o => (
                <button
                  key={o.oid}
                  onClick={() => addOid(o.oid)}
                  className="text-xs px-2 py-0.5 rounded bg-bg-base border border-bg-border text-slate-500 hover:text-cyan-DEFAULT hover:border-cyan-muted transition-colors font-mono"
                >
                  {o.label}
                </button>
              ))}
            </div>
            <textarea
              className="input w-full font-mono text-xs"
              rows={4}
              placeholder={"1.3.6.1.2.1.1.1.0\n1.3.6.1.2.1.1.5.0"}
              value={customOids}
              onChange={e => setCustomOids(e.target.value)}
            />
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2 border-t border-bg-border">
          <button onClick={onClose} className="btn-ghost">Cancel</button>
          <button
            onClick={handleSubmit}
            disabled={!deviceId || !target || loading}
            className="btn-primary flex items-center gap-1.5 disabled:opacity-50"
          >
            {loading ? <Spinner className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
            Run Query
          </button>
        </div>
      </div>
    </Modal>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function SNMPPage() {
  const [searchParams] = useSearchParams()
  const [tasks, setTasks]     = useState([])
  const [devices, setDevices] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState('')
  const [showRun, setShowRun] = useState(false)
  const [running, setRunning] = useState(false)
  const [selected, setSelected] = useState(null)
  const [filterDevice, setFilterDevice] = useState(searchParams.get('device') || '')
  const [expandedId, setExpandedId] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [allTasks, devs] = await Promise.all([
        api.getAllTasks({ task_type: 'run_snmp_query', limit: 200 }),
        api.getDevices(),
      ])
      setTasks(allTasks)
      setDevices(devs)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const handleRunQuery = async (deviceId, payload) => {
    setRunning(true)
    try {
      await api.issueTask(deviceId, { task_type: 'run_snmp_query', payload })
      setShowRun(false)
      // Brief delay then reload so the new queued task appears
      setTimeout(load, 800)
    } catch (e) {
      setError(e.message)
    } finally {
      setRunning(false)
    }
  }

  const deviceName = id => devices.find(d => d.id === id)?.name || id?.slice(0, 8) + '…'

  const filtered = filterDevice
    ? tasks.filter(t => t.device_id === filterDevice)
    : tasks

  const completedCount = tasks.filter(t => t.status === 'completed').length
  const activeDevices  = [...new Set(tasks.filter(t => t.status === 'completed').map(t => t.device_id))].length

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="SNMP"
        subtitle={`${completedCount} result${completedCount !== 1 ? 's' : ''} across ${activeDevices} device${activeDevices !== 1 ? 's' : ''}`}
        actions={
          <div className="flex items-center gap-2">
            <button onClick={load} className="btn-ghost flex items-center gap-1.5">
              <RefreshCw className="w-3.5 h-3.5" /> Refresh
            </button>
            <button
              onClick={() => setShowRun(true)}
              className="btn-primary flex items-center gap-1.5"
            >
              <Play className="w-3.5 h-3.5" /> Run Query
            </button>
          </div>
        }
      />

      {error && <Alert type="error" message={error} className="mb-4" />}

      {/* Stat cards */}
      <div className="grid grid-cols-3 gap-3 mb-4">
        <div className="card px-4 py-3 flex items-center justify-between">
          <span className="text-xs text-slate-500">Total Queries</span>
          <span className="font-display font-700 text-lg text-cyan-DEFAULT">{tasks.length}</span>
        </div>
        <div className="card px-4 py-3 flex items-center justify-between">
          <span className="text-xs text-slate-500">Completed</span>
          <span className="font-display font-700 text-lg text-green-DEFAULT">{completedCount}</span>
        </div>
        <div className="card px-4 py-3 flex items-center justify-between">
          <span className="text-xs text-slate-500">Devices Queried</span>
          <span className="font-display font-700 text-lg text-slate-300">{activeDevices}</span>
        </div>
      </div>

      {/* Device filter */}
      {devices.length > 1 && (
        <div className="mb-4">
          <select
            className="input py-1 text-xs w-48"
            value={filterDevice}
            onChange={e => setFilterDevice(e.target.value)}
          >
            <option value="">All devices</option>
            {devices.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </div>
      )}

      {/* Results list */}
      {loading ? (
        <div className="h-48 flex items-center justify-center"><Spinner /></div>
      ) : filtered.length === 0 ? (
        <Empty
          icon={Network}
          title="No SNMP queries yet"
          description="Run a query against any SNMP-enabled device on your network"
          action={
            <button onClick={() => setShowRun(true)} className="btn-primary mt-2 flex items-center gap-1.5">
              <Play className="w-3.5 h-3.5" /> Run Query
            </button>
          }
        />
      ) : (
        <div className="space-y-2">
          {filtered.map(task => {
            const isExpanded = expandedId === task.id
            const hasResult  = task.status === 'completed' && task.result
            const target     = task.payload?.target || '—'
            const mode       = task.payload?.mode || '—'
            const duration   = task.completed_at && task.queued_at
              ? `${((new Date(task.completed_at) - new Date(task.queued_at)) / 1000).toFixed(1)}s`
              : null

            return (
              <div key={task.id} className="card overflow-hidden">
                {/* Row header */}
                <button
                  onClick={() => hasResult && setExpandedId(isExpanded ? null : task.id)}
                  className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-colors ${hasResult ? 'hover:bg-bg-elevated cursor-pointer' : 'cursor-default'}`}
                >
                  <Server className="w-4 h-4 text-slate-600 shrink-0" />

                  <div className="flex-1 min-w-0 grid grid-cols-4 gap-3 items-center">
                    <div>
                      <p className="text-xs text-slate-500 mb-0.5">Device</p>
                      <p className="text-xs font-mono text-slate-200 truncate">{deviceName(task.device_id)}</p>
                    </div>
                    <div>
                      <p className="text-xs text-slate-500 mb-0.5">Target</p>
                      <p className="text-xs font-mono text-cyan-muted">{target}</p>
                    </div>
                    <div>
                      <p className="text-xs text-slate-500 mb-0.5">Mode</p>
                      <p className="text-xs font-mono text-slate-300">{mode}</p>
                    </div>
                    <div className="flex items-center gap-3">
                      <div>
                        <p className="text-xs text-slate-500 mb-0.5">Status</p>
                        <StatusBadge status={task.status} />
                      </div>
                      {duration && (
                        <div className="ml-auto text-right">
                          <p className="text-xs text-slate-500 mb-0.5">Duration</p>
                          <p className="text-xs font-mono text-slate-500">{duration}</p>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-xs text-slate-600 font-mono">
                      {task.queued_at ? formatDistanceToNow(new Date(task.queued_at), { addSuffix: true }) : ''}
                    </span>
                    {hasResult && (
                      isExpanded
                        ? <ChevronDown className="w-4 h-4 text-slate-500" />
                        : <ChevronRight className="w-4 h-4 text-slate-500" />
                    )}
                  </div>
                </button>

                {/* Expanded result */}
                {isExpanded && hasResult && (
                  <div className="border-t border-bg-border px-4 py-4">
                    <div className="flex items-center gap-2 mb-3">
                      <Clock className="w-3.5 h-3.5 text-slate-600" />
                      <span className="text-xs text-slate-600">
                        Completed {task.completed_at ? format(new Date(task.completed_at), 'PPpp') : '—'}
                      </span>
                      {task.result?.version && (
                        <span className="ml-auto text-xs font-mono text-slate-600">
                          SNMPv{task.result.version} · {task.result.target}
                        </span>
                      )}
                    </div>
                    <ResultViewer result={task.result} />
                  </div>
                )}

                {/* Error state */}
                {task.status === 'failed' && task.error && (
                  <div className="border-t border-bg-border px-4 py-3">
                    <p className="text-xs font-mono text-red-DEFAULT">{task.error}</p>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Run query modal */}
      {showRun && (
        <RunQueryModal
          devices={devices.filter(d => d.status === 'active')}
          onClose={() => setShowRun(false)}
          onSubmit={handleRunQuery}
          loading={running}
        />
      )}
    </div>
  )
}
