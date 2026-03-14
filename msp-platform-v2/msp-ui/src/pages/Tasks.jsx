import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api'
import {
  PageHeader, StatusBadge, Spinner, Empty, Modal,
  Alert, Table, TR, TD, CodeBlock
} from '../components/ui'
import { CheckSquare, RefreshCw, Filter, X } from 'lucide-react'
import { formatDistanceToNow, format } from 'date-fns'

const STATUS_OPTIONS = ['', 'queued', 'dispatched', 'running', 'completed', 'failed', 'timeout', 'cancelled']

// Fallback if /v1/task-types is unavailable — kept in sync with server ALLOWED_TASK_TYPES
const FALLBACK_TASK_TYPES = [
  'get_sysinfo', 'run_speedtest',
  'run_ping_sweep', 'run_arp_scan', 'run_nmap_scan', 'run_port_scan',
  'run_netbios_scan', 'run_lldp_neighbors', 'run_wireless_survey', 'run_wol',
  'run_dns_lookup', 'run_traceroute', 'run_mtr', 'run_iperf',
  'run_banner_grab', 'run_packet_capture', 'run_http_monitor', 'run_ntp_check',
  'run_snmp_query',
  'run_ssl_check', 'run_dns_health', 'run_vuln_scan', 'run_security_audit',
  'run_default_creds', 'run_cleartext_services', 'run_smb_enum',
  'run_ad_discover', 'run_ad_recon', 'run_email_breach',
]

export default function TasksPage() {
  const [tasks, setTasks] = useState([])
  const [devices, setDevices] = useState([])
  const [taskTypes, setTaskTypes] = useState(FALLBACK_TASK_TYPES)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState(null)

  // Filters
  const [filterStatus, setFilterStatus] = useState('')
  const [filterType, setFilterType] = useState('')
  const [filterDevice, setFilterDevice] = useState('')

  // Fetch task types from server on mount
  useEffect(() => {
    api.getTaskTypes()
      .then(data => { if (data?.task_types?.length) setTaskTypes(data.task_types) })
      .catch(() => {}) // fallback list stays
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const params = {}
      if (filterStatus) params.status = filterStatus
      if (filterType) params.task_type = filterType
      if (filterDevice) params.device_id = filterDevice
      const [t, d] = await Promise.all([
        api.getAllTasks({ ...params, limit: 200 }),
        api.getDevices(),
      ])
      setTasks(t)
      setDevices(d)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [filterStatus, filterType, filterDevice])

  useEffect(() => { load() }, [load])

  const deviceName = id => devices.find(d => d.id === id)?.name || id?.slice(0, 8) + '…'

  const hasFilters = filterStatus || filterType || filterDevice

  // Stats
  const counts = tasks.reduce((acc, t) => {
    acc[t.status] = (acc[t.status] || 0) + 1
    return acc
  }, {})

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Tasks"
        subtitle={`${tasks.length} task${tasks.length !== 1 ? 's' : ''}${hasFilters ? ' (filtered)' : ''}`}
        actions={
          <button onClick={load} className="btn-ghost flex items-center gap-1.5">
            <RefreshCw className="w-3.5 h-3.5" /> Refresh
          </button>
        }
      />

      {error && <Alert type="error" message={error} className="mb-4" />}

      {/* Quick stats */}
      <div className="grid grid-cols-4 gap-3 mb-4">
        {[
          { label: 'Completed', key: 'completed', color: 'text-green-DEFAULT' },
          { label: 'Failed', key: 'failed', color: 'text-red-DEFAULT' },
          { label: 'Running', key: 'running', color: 'text-cyan-DEFAULT' },
          { label: 'Queued', key: 'queued', color: 'text-amber-DEFAULT' },
        ].map(({ label, key, color }) => (
          <div key={key} className="card px-4 py-3 flex items-center justify-between">
            <span className="text-xs text-slate-500">{label}</span>
            <span className={`font-display font-700 text-lg ${color}`}>{counts[key] || 0}</span>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="card px-4 py-3 mb-4 flex flex-wrap items-center gap-3">
        <Filter className="w-3.5 h-3.5 text-slate-600 shrink-0" />

        <select
          className="input py-1 text-xs w-36"
          value={filterStatus}
          onChange={e => setFilterStatus(e.target.value)}
        >
          <option value="">All statuses</option>
          {STATUS_OPTIONS.filter(Boolean).map(s => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>

        <select
          className="input py-1 text-xs w-44"
          value={filterType}
          onChange={e => setFilterType(e.target.value)}
        >
          <option value="">All task types</option>
          {taskTypes.map(t => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>

        <select
          className="input py-1 text-xs w-44"
          value={filterDevice}
          onChange={e => setFilterDevice(e.target.value)}
        >
          <option value="">All devices</option>
          {devices.map(d => (
            <option key={d.id} value={d.id}>{d.name}</option>
          ))}
        </select>

        {hasFilters && (
          <button
            onClick={() => { setFilterStatus(''); setFilterType(''); setFilterDevice('') }}
            className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-300 transition-colors"
          >
            <X className="w-3 h-3" /> Clear
          </button>
        )}
      </div>

      {/* Table */}
      <div className="card">
        {loading ? (
          <div className="h-48 flex items-center justify-center"><Spinner /></div>
        ) : tasks.length === 0 ? (
          <Empty
            icon={CheckSquare}
            title="No tasks found"
            description={hasFilters ? 'Try adjusting your filters' : 'Issue tasks from the Devices page'}
          />
        ) : (
          <Table headers={['Device', 'Task Type', 'Status', 'Queued', 'Duration', '']}>
            {tasks.map(t => {
              const duration = t.completed_at && t.queued_at
                ? `${((new Date(t.completed_at) - new Date(t.queued_at)) / 1000).toFixed(1)}s`
                : t.status === 'running' || t.status === 'dispatched' ? 'running…' : '—'

              return (
                <TR key={t.id}>
                  <TD>
                    <Link
                      to={`/devices/${t.device_id}`}
                      className="text-xs font-mono text-slate-400 hover:text-cyan-DEFAULT transition-colors"
                    >
                      {deviceName(t.device_id)}
                    </Link>
                  </TD>
                  <TD>
                    <span className="text-xs font-mono text-slate-300">{t.task_type}</span>
                  </TD>
                  <TD><StatusBadge status={t.status} /></TD>
                  <TD>
                    <span className="text-xs font-mono text-slate-600" title={t.queued_at ? format(new Date(t.queued_at), 'PPpp') : ''}>
                      {t.queued_at ? formatDistanceToNow(new Date(t.queued_at), { addSuffix: true }) : '—'}
                    </span>
                  </TD>
                  <TD>
                    <span className="text-xs font-mono text-slate-600">{duration}</span>
                  </TD>
                  <TD>
                    {(t.result || t.error) && (
                      <button
                        onClick={() => setSelected(t)}
                        className="text-xs text-cyan-muted hover:text-cyan-DEFAULT transition-colors"
                      >
                        View result
                      </button>
                    )}
                  </TD>
                </TR>
              )
            })}
          </Table>
        )}
      </div>

      {/* Result modal */}
      {selected && (
        <Modal
          title={`Task Result — ${selected.task_type}`}
          onClose={() => setSelected(null)}
          width="max-w-3xl"
        >
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3 text-xs">
              <div className="card px-3 py-2">
                <p className="text-slate-600 mb-1">Device</p>
                <p className="font-mono text-slate-300">{deviceName(selected.device_id)}</p>
              </div>
              <div className="card px-3 py-2">
                <p className="text-slate-600 mb-1">Status</p>
                <StatusBadge status={selected.status} />
              </div>
              <div className="card px-3 py-2">
                <p className="text-slate-600 mb-1">Queued</p>
                <p className="font-mono text-slate-300">{selected.queued_at ? format(new Date(selected.queued_at), 'PPpp') : '—'}</p>
              </div>
              <div className="card px-3 py-2">
                <p className="text-slate-600 mb-1">Completed</p>
                <p className="font-mono text-slate-300">{selected.completed_at ? format(new Date(selected.completed_at), 'PPpp') : '—'}</p>
              </div>
            </div>

            {selected.error && (
              <div>
                <p className="text-xs text-slate-500 mb-1">Error</p>
                <div className="rounded bg-red-dim border border-red-muted px-3 py-2 text-xs font-mono text-red-DEFAULT">
                  {selected.error}
                </div>
              </div>
            )}

            {selected.result && (
              <div>
                <p className="text-xs text-slate-500 mb-1">Result</p>
                <CodeBlock content={JSON.stringify(selected.result, null, 2)} />
              </div>
            )}
          </div>
        </Modal>
      )}
    </div>
  )
}
