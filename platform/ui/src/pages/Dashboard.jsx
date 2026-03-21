import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api'
import { StatusBadge, Spinner, Table, TR, TD } from '../components/ui'
import {
  Monitor, Activity, ShieldAlert, CheckSquare,
  ArrowRight, Wifi, Clock, AlertTriangle, Cpu, HardDrive, MemoryStick
} from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'

function MiniBar({ pct, warn = 70, crit = 85, wide = false }) {
  if (pct == null) return null
  const color = pct >= crit ? 'bg-red-DEFAULT' : pct >= warn ? 'bg-amber-DEFAULT' : 'bg-green-DEFAULT'
  return (
    <div className={`h-1 rounded-full bg-bg-border overflow-hidden ${wide ? 'flex-1' : 'w-16'}`}>
      <div className={`h-full rounded-full ${color}`} style={{ width: `${Math.min(100, pct)}%` }} />
    </div>
  )
}

function StatCard({ label, value, icon: Icon, accent = 'slate', to, sub }) {
  const colors = {
    slate:  'text-slate-400 bg-bg-elevated',
    green:  'text-green-DEFAULT bg-green-dim',
    red:    'text-red-DEFAULT bg-red-dim',
    amber:  'text-amber-DEFAULT bg-amber-dim',
    cyan:   'text-cyan-DEFAULT bg-cyan-dim',
  }
  const inner = (
    <div className="card px-4 py-4 flex items-start justify-between gap-3 group hover:border-bg-border/80 transition-colors">
      <div>
        <p className="text-xs text-slate-600 mb-1">{label}</p>
        <p className={`font-display font-700 text-2xl ${colors[accent].split(' ')[0]}`}>{value}</p>
        {sub && <p className="text-xs text-slate-600 mt-0.5">{sub}</p>}
      </div>
      <div className={`w-8 h-8 rounded flex items-center justify-center shrink-0 ${colors[accent].split(' ')[1]}`}>
        <Icon className={`w-4 h-4 ${colors[accent].split(' ')[0]}`} />
      </div>
    </div>
  )
  return to ? <Link to={to}>{inner}</Link> : inner
}

function UptimePill({ pct }) {
  if (pct == null) return <span className="text-slate-700 text-xs">—</span>
  const color = pct >= 99 ? 'text-green-DEFAULT' : pct >= 95 ? 'text-amber-DEFAULT' : 'text-red-DEFAULT'
  return <span className={`text-xs font-mono ${color}`}>{pct.toFixed(1)}%</span>
}

export default function Dashboard() {
  const [devices, setDevices]       = useState([])
  const [auditLogs, setAuditLogs]   = useState([])
  const [tasks, setTasks]           = useState([])
  const [uptime, setUptime]         = useState([])
  const [findings, setFindings]     = useState([])
  const [loading, setLoading]       = useState(true)

  useEffect(() => {
    Promise.all([
      api.getDevices().catch(() => []),
      api.getAudit({ limit: 10 }).catch(() => []),
      api.getAllTasks({ limit: 200 }).catch(() => []),
      api.getUptimeSummary(24).catch(() => []),
      api.get('/v1/findings?limit=200').catch(() => []),
    ]).then(([d, a, t, u, f]) => {
      setDevices(d)
      setAuditLogs(a)
      setTasks(t)
      setUptime(Array.isArray(u) ? u : [])
      setFindings(Array.isArray(f) ? f : [])
    }).finally(() => setLoading(false))
  }, [])

  if (loading) return (
    <div className="flex items-center justify-center h-64">
      <Spinner className="w-8 h-8" />
    </div>
  )

  const active    = devices.filter(d => d.status === 'active').length
  const offline   = devices.filter(d => d.status === 'offline').length
  const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const tasks24h  = tasks.filter(t => t.queued_at && new Date(t.queued_at) > cutoff24h)
  const recentTasks = tasks.filter(t => t.status === 'running' || t.status === 'dispatched').length
  const failedTasks24h = tasks24h.filter(t => t.status === 'failed' || t.status === 'timeout').length
  const openFindings = findings.filter(f => !f.acknowledged).length
  const criticalFindings = findings.filter(f => !f.acknowledged && f.severity === 'critical').length
  const highFindings = findings.filter(f => !f.acknowledged && f.severity === 'high').length

  // Fleet health
  const healthDevices = devices.filter(d => d.last_sysinfo_at)
  const avgRam  = healthDevices.length ? Math.round(healthDevices.reduce((s, d) => s + (d.last_mem_pct  || 0), 0) / healthDevices.length) : null
  const avgDisk = healthDevices.length ? Math.round(healthDevices.reduce((s, d) => s + (d.last_disk_pct || 0), 0) / healthDevices.length) : null
  const warnCount = healthDevices.filter(d =>
    (d.last_mem_pct  != null && d.last_mem_pct  >= 80) ||
    (d.last_disk_pct != null && d.last_disk_pct >= 85) ||
    (d.last_cpu_temp_c != null && d.last_cpu_temp_c >= 70)
  ).length

  // Uptime map: device_id → { wan, lan }
  const uptimeByDevice = Object.fromEntries(uptime.map(u => [u.device_id, u]))

  // Devices sorted by last_seen desc (active first)
  const recentDevices = [...devices]
    .sort((a, b) => {
      if (a.status === 'active' && b.status !== 'active') return -1
      if (b.status === 'active' && a.status !== 'active') return 1
      return (new Date(b.last_seen_at || 0)) - (new Date(a.last_seen_at || 0))
    })
    .slice(0, 7)

  return (
    <div className="animate-fade-in">
      {/* Header */}
      <div className="mb-6">
        <h1 className="font-display font-700 text-xl text-slate-100">Dashboard</h1>
        <p className="text-sm text-slate-600 mt-0.5 font-mono">
          {new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
        </p>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        <StatCard label="Active Devices"   value={active}           icon={Wifi}        accent="green" to="/devices"  sub={offline > 0 ? `${offline} offline` : 'All online'} />
        <StatCard label="Open Findings"    value={openFindings}     icon={ShieldAlert} accent={criticalFindings > 0 ? 'red' : openFindings > 0 ? 'amber' : 'slate'} to="/findings" sub={criticalFindings > 0 ? `${criticalFindings} critical, ${highFindings} high` : highFindings > 0 ? `${highFindings} high` : openFindings === 0 ? 'All clear' : null} />
        <StatCard label="Tasks Running"    value={recentTasks}      icon={Activity}    accent={recentTasks > 0 ? 'cyan' : 'slate'} to="/tasks" sub={failedTasks24h > 0 ? `${failedTasks24h} failed in 24h` : `${tasks24h.length} run in 24h`} />
        <StatCard label="Tasks (24h)"      value={tasks24h.length}  icon={CheckSquare} accent="slate" to="/tasks"    sub={failedTasks24h > 0 ? `${failedTasks24h} failed` : 'No failures'} />
      </div>

      {/* Fleet health strip — only shown when health data is available */}
      {healthDevices.length > 0 && (
        <div className="grid grid-cols-3 gap-3 mb-6">
          <div className="card px-4 py-3 flex items-center gap-3">
            <div className="w-7 h-7 rounded bg-bg-elevated flex items-center justify-center shrink-0">
              <MemoryStick className="w-3.5 h-3.5 text-slate-500" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs text-slate-600 mb-1">Avg RAM usage</p>
              <div className="flex items-center gap-2">
                <MiniBar pct={avgRam} wide />
                <span className={`text-xs font-mono ${avgRam >= 85 ? 'text-red-DEFAULT' : avgRam >= 70 ? 'text-amber-DEFAULT' : 'text-green-DEFAULT'}`}>
                  {avgRam != null ? `${avgRam}%` : '—'}
                </span>
              </div>
            </div>
          </div>
          <div className="card px-4 py-3 flex items-center gap-3">
            <div className="w-7 h-7 rounded bg-bg-elevated flex items-center justify-center shrink-0">
              <HardDrive className="w-3.5 h-3.5 text-slate-500" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs text-slate-600 mb-1">Avg disk usage</p>
              <div className="flex items-center gap-2">
                <MiniBar pct={avgDisk} warn={75} crit={90} wide />
                <span className={`text-xs font-mono ${avgDisk >= 90 ? 'text-red-DEFAULT' : avgDisk >= 75 ? 'text-amber-DEFAULT' : 'text-green-DEFAULT'}`}>
                  {avgDisk != null ? `${avgDisk}%` : '—'}
                </span>
              </div>
            </div>
          </div>
          <div className="card px-4 py-3 flex items-center gap-3">
            <div className={`w-7 h-7 rounded flex items-center justify-center shrink-0 ${warnCount > 0 ? 'bg-amber-dim' : 'bg-bg-elevated'}`}>
              <AlertTriangle className={`w-3.5 h-3.5 ${warnCount > 0 ? 'text-amber-DEFAULT' : 'text-slate-600'}`} />
            </div>
            <div>
              <p className="text-xs text-slate-600 mb-0.5">Health warnings</p>
              <p className={`font-display font-700 text-xl ${warnCount > 0 ? 'text-amber-DEFAULT' : 'text-slate-600'}`}>
                {warnCount}
              </p>
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
        {/* Device status + uptime */}
        <div className="card">
          <div className="flex items-center justify-between px-4 pt-4 pb-3 border-b border-bg-border">
            <h2 className="font-display font-600 text-slate-200 text-sm flex items-center gap-2">
              <Monitor className="w-4 h-4 text-slate-600" /> Devices
            </h2>
            <Link to="/devices" className="text-xs text-cyan-muted hover:text-cyan-DEFAULT flex items-center gap-1">
              View all <ArrowRight className="w-3 h-3" />
            </Link>
          </div>
          <Table headers={['Device', 'Status', 'Health', 'WAN', 'Last Seen']}>
            {recentDevices.map(d => {
              const u = uptimeByDevice[d.id]
              return (
                <TR key={d.id}>
                  <TD>
                    <Link to={`/devices/${d.id}`} className="hover:text-cyan-DEFAULT transition-colors">
                      <span className="font-mono text-xs">{d.name}</span>
                    </Link>
                  </TD>
                  <TD><StatusBadge status={d.status} /></TD>
                  <TD>
                    {d.last_sysinfo_at ? (
                      <div className="flex flex-col gap-1">
                        {d.last_mem_pct  != null && (
                          <div className="flex items-center gap-1.5">
                            <span className="text-[10px] text-slate-700 w-7">RAM</span>
                            <MiniBar pct={d.last_mem_pct} />
                          </div>
                        )}
                        {d.last_disk_pct != null && (
                          <div className="flex items-center gap-1.5">
                            <span className="text-[10px] text-slate-700 w-7">Disk</span>
                            <MiniBar pct={d.last_disk_pct} warn={75} crit={90} />
                          </div>
                        )}
                      </div>
                    ) : (
                      <span className="text-xs text-slate-700">—</span>
                    )}
                  </TD>
                  <TD><UptimePill pct={u?.wan?.uptime_pct} /></TD>
                  <TD>
                    <span className="text-xs text-slate-600 font-mono">
                      {d.last_seen_at
                        ? formatDistanceToNow(new Date(d.last_seen_at), { addSuffix: true })
                        : '—'
                      }
                    </span>
                  </TD>
                </TR>
              )
            })}
          </Table>
          {devices.length === 0 && (
            <div className="py-10 text-center text-slate-600 text-sm">No devices yet</div>
          )}
        </div>

        {/* Recent findings */}
        <div className="card">
          <div className="flex items-center justify-between px-4 pt-4 pb-3 border-b border-bg-border">
            <h2 className="font-display font-600 text-slate-200 text-sm flex items-center gap-2">
              <ShieldAlert className="w-4 h-4 text-slate-600" /> Recent Findings
            </h2>
            <Link to="/findings" className="text-xs text-cyan-muted hover:text-cyan-DEFAULT flex items-center gap-1">
              View all <ArrowRight className="w-3 h-3" />
            </Link>
          </div>
          <Table headers={['Severity', 'Title', 'Device', '']}>
            {findings
              .filter(f => !f.acknowledged)
              .sort((a, b) => severityOrder(a.severity) - severityOrder(b.severity))
              .slice(0, 7)
              .map(f => (
                <TR key={f.id}>
                  <TD><SeverityBadge sev={f.severity} /></TD>
                  <TD>
                    <span className="text-xs text-slate-300 truncate max-w-[140px] block">{f.title}</span>
                  </TD>
                  <TD>
                    <span className="text-xs font-mono text-slate-600">
                      {devices.find(d => d.id === f.device_id)?.name || f.device_id?.slice(0, 8)}
                    </span>
                  </TD>
                  <TD>
                    <Link to={`/findings?device=${f.device_id}`} className="text-xs text-cyan-muted hover:text-cyan-DEFAULT">
                      →
                    </Link>
                  </TD>
                </TR>
              ))}
          </Table>
          {findings.filter(f => !f.acknowledged).length === 0 && (
            <div className="py-10 text-center text-slate-600 text-sm">No open findings</div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Recent tasks */}
        <div className="card">
          <div className="flex items-center justify-between px-4 pt-4 pb-3 border-b border-bg-border">
            <h2 className="font-display font-600 text-slate-200 text-sm flex items-center gap-2">
              <CheckSquare className="w-4 h-4 text-slate-600" /> Recent Tasks
            </h2>
            <Link to="/tasks" className="text-xs text-cyan-muted hover:text-cyan-DEFAULT flex items-center gap-1">
              View all <ArrowRight className="w-3 h-3" />
            </Link>
          </div>
          <Table headers={['Type', 'Device', 'Status', 'Age']}>
            {tasks.slice(0, 7).map(t => (
              <TR key={t.id}>
                <TD><span className="text-xs font-mono">{t.task_type}</span></TD>
                <TD>
                  <Link to={`/devices/${t.device_id}`} className="text-xs font-mono text-slate-500 hover:text-cyan-DEFAULT transition-colors">
                    {devices.find(d => d.id === t.device_id)?.name || t.device_id?.slice(0, 8)}
                  </Link>
                </TD>
                <TD><StatusBadge status={t.status} /></TD>
                <TD>
                  <span className="text-xs font-mono text-slate-600">
                    {t.queued_at ? formatDistanceToNow(new Date(t.queued_at), { addSuffix: true }) : '—'}
                  </span>
                </TD>
              </TR>
            ))}
          </Table>
          {tasks.length === 0 && (
            <div className="py-10 text-center text-slate-600 text-sm">No tasks yet</div>
          )}
        </div>

        {/* Audit log */}
        <div className="card">
          <div className="flex items-center justify-between px-4 pt-4 pb-3 border-b border-bg-border">
            <h2 className="font-display font-600 text-slate-200 text-sm flex items-center gap-2">
              <Clock className="w-4 h-4 text-slate-600" /> Recent Activity
            </h2>
            <Link to="/audit" className="text-xs text-cyan-muted hover:text-cyan-DEFAULT flex items-center gap-1">
              View all <ArrowRight className="w-3 h-3" />
            </Link>
          </div>
          <div className="divide-y divide-bg-border/50">
            {auditLogs.map(log => (
              <div key={log.id} className="px-4 py-2.5 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 min-w-0">
                  <span className={`tag shrink-0 ${actionTag(log.action)}`}>{log.action.replace(/_/g, ' ')}</span>
                  {log.device_id && (
                    <span className="text-xs font-mono text-slate-600 truncate">{log.device_id.slice(0, 8)}</span>
                  )}
                </div>
                <span className="text-xs font-mono text-slate-700 shrink-0">
                  {formatDistanceToNow(new Date(log.created_at), { addSuffix: true })}
                </span>
              </div>
            ))}
            {auditLogs.length === 0 && (
              <div className="py-10 text-center text-slate-600 text-sm">No activity yet</div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function severityOrder(sev) {
  return { critical: 0, high: 1, medium: 2, low: 3, info: 4 }[sev] ?? 5
}

function SeverityBadge({ sev }) {
  const styles = {
    critical: 'bg-red-dim border-red-muted text-red-DEFAULT',
    high:     'bg-red-dim border-red-muted text-red-DEFAULT opacity-75',
    medium:   'bg-amber-dim border-amber-muted text-amber-DEFAULT',
    low:      'bg-bg-elevated border-bg-border text-slate-400',
    info:     'bg-cyan-dim border-cyan-muted text-cyan-DEFAULT',
  }
  return (
    <span className={`tag ${styles[sev] || styles.info} capitalize`}>{sev}</span>
  )
}

function actionTag(action) {
  if (action.includes('revok')) return 'tag bg-red-dim border-red-muted text-red-DEFAULT'
  if (action.includes('enroll') || action.includes('creat')) return 'tag bg-green-dim border-green-muted text-green-DEFAULT'
  if (action.includes('login')) return 'tag bg-cyan-dim border-cyan-muted text-cyan-DEFAULT'
  if (action.includes('deploy') || action.includes('update')) return 'tag bg-amber-dim border-amber-muted text-amber-DEFAULT'
  return 'tag bg-bg-elevated border-bg-border text-slate-500'
}
