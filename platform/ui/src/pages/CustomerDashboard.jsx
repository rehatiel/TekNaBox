import { useState, useEffect, useCallback } from 'react'
import { useParams, Link } from 'react-router-dom'
import { api } from '../lib/api'
import { PageHeader, StatusBadge, Spinner, Alert, Table, TR, TD } from '../components/ui'
import { Building2, MapPin, Server, ShieldAlert, CheckSquare, Wifi, WifiOff, ArrowLeft } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'

const SEV_ORDER = { critical: 0, high: 1, medium: 2, low: 3, info: 4 }
const SEV_COLOR = {
  critical: 'text-red-DEFAULT',
  high:     'text-orange-400',
  medium:   'text-amber-DEFAULT',
  low:      'text-blue-400',
  info:     'text-slate-500',
}

function MiniBar({ pct, warn = 70, crit = 85 }) {
  if (pct == null) return null
  const color = pct >= crit ? 'bg-red-DEFAULT' : pct >= warn ? 'bg-amber-DEFAULT' : 'bg-green-DEFAULT'
  return (
    <div className="h-1 w-16 rounded-full bg-bg-border overflow-hidden">
      <div className={`h-full rounded-full ${color}`} style={{ width: `${Math.min(100, pct)}%` }} />
    </div>
  )
}

function StatCard({ label, value, sub, color = 'text-slate-200', icon: Icon }) {
  return (
    <div className="card px-4 py-3 flex items-center gap-3">
      {Icon && <Icon className="w-4 h-4 text-slate-600 shrink-0" />}
      <div className="min-w-0">
        <p className="text-xs text-slate-500">{label}</p>
        <p className={`font-display font-700 text-lg ${color}`}>{value}</p>
        {sub && <p className="text-xs text-slate-600 truncate">{sub}</p>}
      </div>
    </div>
  )
}

export default function CustomerDashboard() {
  const { id } = useParams()
  const [customer, setCustomer]   = useState(null)
  const [sites, setSites]         = useState([])
  const [devices, setDevices]     = useState([])
  const [findings, setFindings]   = useState([])
  const [tasks, setTasks]         = useState([])
  const [loading, setLoading]     = useState(true)
  const [error, setError]         = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [customers, sitesData, devicesData] = await Promise.all([
        api.getCustomers(),
        api.getSites(id),
        api.getDevices({ customer_id: id }),
      ])

      const found = customers.find(c => c.id === id)
      if (!found) { setError('Customer not found'); setLoading(false); return }
      setCustomer(found)
      setSites(sitesData)
      setDevices(devicesData)

      // Fetch findings + tasks, filter client-side by device set
      const deviceIds = new Set(devicesData.map(d => d.id))
      const [findingsData, tasksData] = await Promise.all([
        api.get('/v1/findings?limit=200'),
        api.getAllTasks({ limit: 200 }),
      ])
      setFindings(findingsData.filter(f => deviceIds.has(f.device_id)))
      setTasks(tasksData.filter(t => deviceIds.has(t.device_id)))
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => { load() }, [load])

  if (loading) return <div className="h-64 flex items-center justify-center"><Spinner /></div>
  if (error)   return <Alert type="error" message={error} className="mt-4" />
  if (!customer) return null

  const online   = devices.filter(d => d.status === 'online').length
  const offline  = devices.filter(d => d.status === 'offline').length
  const openFindings = findings.filter(f => !f.acknowledged)
  const critFindings = openFindings.filter(f => f.severity === 'critical' || f.severity === 'high')
  const cutoff24h = Date.now() - 24 * 60 * 60 * 1000
  const failedTasks = tasks.filter(t =>
    (t.status === 'failed' || t.status === 'timeout') &&
    t.queued_at && new Date(t.queued_at).getTime() > cutoff24h
  )

  // Sites with device counts
  const sitesWithCounts = sites.map(s => {
    const siteDevices = devices.filter(d => d.site_id === s.id)
    return {
      ...s,
      total: siteDevices.length,
      online: siteDevices.filter(d => d.status === 'online').length,
    }
  })

  // Device name lookup
  const deviceName = id => devices.find(d => d.id === id)?.name || id?.slice(0, 8) + '…'
  const siteName   = id => sites.find(s => s.id === id)?.name || '—'

  // Recent findings (unacked, sorted by severity then date, top 10)
  const recentFindings = [...openFindings]
    .sort((a, b) => {
      const sd = (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9)
      if (sd !== 0) return sd
      return new Date(b.found_at) - new Date(a.found_at)
    })
    .slice(0, 10)

  // Recent tasks (last 10)
  const recentTasks = [...tasks]
    .sort((a, b) => new Date(b.queued_at) - new Date(a.queued_at))
    .slice(0, 10)

  return (
    <div className="animate-fade-in space-y-6">
      <PageHeader
        title={customer.name}
        subtitle={
          <span className="flex items-center gap-2">
            <span className="tag bg-bg-elevated border-bg-border text-slate-500">{customer.slug}</span>
            <span className="text-slate-600">{sites.length} site{sites.length !== 1 ? 's' : ''}</span>
          </span>
        }
        actions={
          <Link to="/customers" className="btn-ghost flex items-center gap-1.5 text-xs">
            <ArrowLeft className="w-3.5 h-3.5" /> All Customers
          </Link>
        }
      />

      {/* Stat cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <StatCard icon={Server}      label="Total Devices"   value={devices.length} />
        <StatCard icon={Wifi}        label="Online"          value={online}   color="text-green-DEFAULT" />
        <StatCard icon={WifiOff}     label="Offline"         value={offline}  color={offline > 0 ? 'text-red-DEFAULT' : 'text-slate-500'} />
        <StatCard icon={MapPin}      label="Sites"           value={sites.length} />
        <StatCard icon={ShieldAlert} label="Open Findings"   value={openFindings.length} color={critFindings.length > 0 ? 'text-red-DEFAULT' : openFindings.length > 0 ? 'text-amber-DEFAULT' : 'text-slate-200'} sub={critFindings.length > 0 ? `${critFindings.length} critical/high` : undefined} />
        <StatCard icon={CheckSquare} label="Failed Tasks 24h" value={failedTasks.length} color={failedTasks.length > 0 ? 'text-red-DEFAULT' : 'text-slate-200'} />
      </div>

      {/* Sites */}
      {sitesWithCounts.length > 0 && (
        <div>
          <h2 className="text-sm font-display font-600 text-slate-400 mb-3">Sites</h2>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
            {sitesWithCounts.map(s => (
              <div key={s.id} className="card px-4 py-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-500 text-slate-200 truncate">{s.name}</p>
                    {s.description && <p className="text-xs text-slate-600 truncate mt-0.5">{s.description}</p>}
                  </div>
                  <MapPin className="w-3.5 h-3.5 text-slate-600 shrink-0 mt-0.5" />
                </div>
                <div className="mt-2 flex items-center gap-3 text-xs">
                  <span className="text-slate-500">{s.total} device{s.total !== 1 ? 's' : ''}</span>
                  {s.online > 0 && <span className="text-green-DEFAULT">{s.online} online</span>}
                  {s.total - s.online > 0 && <span className="text-red-muted">{s.total - s.online} offline</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Devices */}
      <div>
        <h2 className="text-sm font-display font-600 text-slate-400 mb-3">Devices</h2>
        <div className="card">
          {devices.length === 0 ? (
            <div className="py-10 text-center text-xs text-slate-600">No devices assigned to this customer</div>
          ) : (
            <Table headers={['Device', 'Site', 'Status', 'Health', 'Last Seen']}>
              {devices.map(d => {
                const ram  = d.last_sysinfo?.ram_pct ?? d.ram_pct ?? null
                const disk = d.last_sysinfo?.disk_pct ?? d.disk_pct ?? null
                return (
                  <TR key={d.id}>
                    <TD>
                      <Link to={`/devices/${d.id}`} className="text-xs font-mono text-slate-300 hover:text-cyan-DEFAULT transition-colors">
                        {d.name}
                      </Link>
                    </TD>
                    <TD><span className="text-xs text-slate-500">{siteName(d.site_id)}</span></TD>
                    <TD><StatusBadge status={d.status} /></TD>
                    <TD>
                      <div className="flex flex-col gap-0.5">
                        {ram  != null && <div className="flex items-center gap-1.5"><span className="text-xs font-mono text-slate-600 w-10">RAM</span><MiniBar pct={ram} /></div>}
                        {disk != null && <div className="flex items-center gap-1.5"><span className="text-xs font-mono text-slate-600 w-10">Disk</span><MiniBar pct={disk} warn={75} crit={90} /></div>}
                        {ram == null && disk == null && <span className="text-xs text-slate-700">—</span>}
                      </div>
                    </TD>
                    <TD>
                      <span className="text-xs font-mono text-slate-600">
                        {d.last_seen ? formatDistanceToNow(new Date(d.last_seen), { addSuffix: true }) : '—'}
                      </span>
                    </TD>
                  </TR>
                )
              })}
            </Table>
          )}
        </div>
      </div>

      {/* Findings + Tasks side by side */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

        {/* Open findings */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-display font-600 text-slate-400">Open Findings</h2>
            <Link to={`/findings`} className="text-xs text-cyan-muted hover:text-cyan-DEFAULT transition-colors">
              View all →
            </Link>
          </div>
          <div className="card">
            {recentFindings.length === 0 ? (
              <div className="py-8 text-center text-xs text-slate-600">No open findings</div>
            ) : (
              <Table headers={['Severity', 'Finding', 'Device']}>
                {recentFindings.map(f => (
                  <TR key={f.id}>
                    <TD>
                      <span className={`text-xs font-mono capitalize ${SEV_COLOR[f.severity] || 'text-slate-500'}`}>
                        {f.severity}
                      </span>
                    </TD>
                    <TD>
                      <span className="text-xs text-slate-300 line-clamp-1">{f.title}</span>
                    </TD>
                    <TD>
                      <Link to={`/devices/${f.device_id}`} className="text-xs font-mono text-slate-500 hover:text-cyan-DEFAULT transition-colors">
                        {deviceName(f.device_id)}
                      </Link>
                    </TD>
                  </TR>
                ))}
              </Table>
            )}
          </div>
        </div>

        {/* Recent tasks */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-display font-600 text-slate-400">Recent Tasks</h2>
            <Link to="/tasks" className="text-xs text-cyan-muted hover:text-cyan-DEFAULT transition-colors">
              View all →
            </Link>
          </div>
          <div className="card">
            {recentTasks.length === 0 ? (
              <div className="py-8 text-center text-xs text-slate-600">No tasks</div>
            ) : (
              <Table headers={['Task', 'Device', 'Status', 'Queued']}>
                {recentTasks.map(t => (
                  <TR key={t.id}>
                    <TD><span className="text-xs font-mono text-slate-300">{t.task_type}</span></TD>
                    <TD>
                      <Link to={`/devices/${t.device_id}`} className="text-xs font-mono text-slate-500 hover:text-cyan-DEFAULT transition-colors">
                        {deviceName(t.device_id)}
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
            )}
          </div>
        </div>

      </div>
    </div>
  )
}
