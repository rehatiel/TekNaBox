import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api'
import {
  PageHeader, StatusBadge, Spinner, Empty, Modal,
  Alert, Table, TR, TD, CodeBlock
} from '../components/ui'
import { Monitor, Plus, Terminal, XCircle, RefreshCw, ChevronRight } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'

const TASK_TYPES = [
  // ── Basics ────────────────────────────────────────────────────────────────
  { value: 'get_sysinfo',         label: 'System Info',       defaultPayload: {} },
  { value: 'run_speedtest',       label: 'Speed Test',        defaultPayload: {} },

  // ── Network discovery ─────────────────────────────────────────────────────
  { value: 'run_ping_sweep',      label: 'Ping Sweep',        defaultPayload: { network: '192.168.1.0/24' } },
  { value: 'run_arp_scan',        label: 'ARP Scan',          defaultPayload: { interface: 'eth0' } },
  { value: 'run_port_scan',       label: 'Port Scan',         defaultPayload: { target: '192.168.1.1', ports: '1-1024' } },
  { value: 'run_nmap_scan',       label: 'Nmap Scan',         defaultPayload: { targets: ['192.168.1.1'], ports: '1-1024', scan_type: 'quick' } },
  { value: 'run_wireless_survey', label: 'Wireless Survey',   defaultPayload: { interface: 'wlan0' } },

  // ── Diagnostics ───────────────────────────────────────────────────────────
  { value: 'run_dns_lookup',      label: 'DNS Lookup',        defaultPayload: { hostname: 'google.com', record_types: ['A', 'MX', 'TXT'] } },
  { value: 'run_traceroute',      label: 'Traceroute',        defaultPayload: { target: '8.8.8.8', max_hops: 30 } },
  { value: 'run_mtr',             label: 'MTR Report',        defaultPayload: { target: '8.8.8.8', count: 10 } },
  { value: 'run_iperf',           label: 'iPerf Test',        defaultPayload: { server: '', port: 5201, duration: 10, direction: 'both' } },
  { value: 'run_banner_grab',     label: 'Banner Grab',       defaultPayload: { targets: ['192.168.1.1'], ports: [22, 80, 443, 8080] } },
  { value: 'run_packet_capture',  label: 'Packet Capture',    defaultPayload: { interface: 'eth0', duration: 10, filter: '' } },

  // ── SNMP ──────────────────────────────────────────────────────────────────
  { value: 'run_snmp_query',      label: 'SNMP Query',        defaultPayload: { target: '192.168.1.1', community: 'public', oids: [] } },

  // ── Security ──────────────────────────────────────────────────────────────
  { value: 'run_vuln_scan',       label: 'Vuln Scan',         defaultPayload: { targets: ['192.168.1.0/24'], ports: '1-1024' } },
  { value: 'run_security_audit',  label: 'Security Audit',    defaultPayload: {} },

  // ── Active Directory ──────────────────────────────────────────────────────
  { value: 'run_ad_discover',     label: 'AD Discover',       defaultPayload: { network: '192.168.1.0/24' } },
  { value: 'run_ad_recon',        label: 'AD Recon',          defaultPayload: { domain: '', dc_ip: '', username: '', password: '' } },
]

// ── Health mini-badge ─────────────────────────────────────────────────────────

function healthColor(pct, warnAt = 70, critAt = 90) {
  if (pct == null) return '#374151'
  if (pct >= critAt) return '#ef4444'
  if (pct >= warnAt) return '#f59e0b'
  return '#22c55e'
}

function HealthCell({ device }) {
  if (device.last_sysinfo_at == null) return <span className="text-xs font-mono text-slate-700">—</span>
  const { last_cpu_temp_c: temp, last_mem_pct: mem, last_disk_pct: disk } = device
  return (
    <span className="flex items-center gap-2 font-mono text-xs">
      {temp != null && (
        <span style={{ color: healthColor(temp, 65, 80) }} title="CPU temp">
          {temp.toFixed(0)}°C
        </span>
      )}
      {mem != null && (
        <span style={{ color: healthColor(mem) }} title="RAM usage">
          RAM {mem.toFixed(0)}%
        </span>
      )}
      {disk != null && (
        <span style={{ color: healthColor(disk, 75, 90) }} title="Disk usage">
          Disk {disk.toFixed(0)}%
        </span>
      )}
    </span>
  )
}

export default function Devices() {
  const [devices, setDevices] = useState([])
  const [sites, setSites] = useState([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [showTask, setShowTask] = useState(null)
  const [showResult, setShowResult] = useState(null)
  const [error, setError] = useState('')

  // Filters
  const [filterCustomer, setFilterCustomer] = useState('')
  const [filterSite, setFilterSite] = useState('')

  // Sort
  const [sort, setSort] = useState({ key: 'name', dir: 'asc' })
  const toggleSort = key => setSort(prev => ({
    key,
    dir: prev.key === key && prev.dir === 'asc' ? 'desc' : 'asc',
  }))

  const load = useCallback(async () => {
    setLoading(true)
    const [d, s] = await Promise.all([api.getDevices(), api.getSites()])
    setDevices(d)
    setSites(s)
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const siteName = id => sites.find(s => s.id === id)?.name || id?.slice(0, 8)

  // Derive unique customers from loaded devices
  const customers = [...new Map(
    devices.filter(d => d.customer_id).map(d => [d.customer_id, d.customer_name || d.customer_id])
  ).entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name))

  // Filter + sort
  const visible = [...devices]
    .filter(d => !filterCustomer || d.customer_id === filterCustomer)
    .filter(d => !filterSite     || d.site_id     === filterSite)
    .sort((a, b) => {
      const dir = sort.dir === 'asc' ? 1 : -1
      switch (sort.key) {
        case 'name':      return dir * (a.name || '').localeCompare(b.name || '')
        case 'status':    return dir * (a.status || '').localeCompare(b.status || '')
        case 'customer':  return dir * (a.customer_name || '').localeCompare(b.customer_name || '')
        case 'site':      return dir * (siteName(a.site_id) || '').localeCompare(siteName(b.site_id) || '')
        case 'version':   return dir * (a.current_version || '').localeCompare(b.current_version || '')
        case 'last_seen': {
          const ta = a.last_seen_at ? new Date(a.last_seen_at).getTime() : 0
          const tb = b.last_seen_at ? new Date(b.last_seen_at).getTime() : 0
          return dir * (ta - tb)
        }
        default: return 0
      }
    })

  // Site filter options scoped to selected customer
  const siteOptions = sites.filter(s =>
    !filterCustomer || devices.some(d => d.customer_id === filterCustomer && d.site_id === s.id)
  )

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Devices"
        subtitle={`${visible.length} of ${devices.length} device${devices.length !== 1 ? 's' : ''}`}
        actions={
          <>
            <button onClick={load} className="btn-ghost flex items-center gap-1.5">
              <RefreshCw className="w-3.5 h-3.5" /> Refresh
            </button>
            <button onClick={() => setShowCreate(true)} className="btn-primary flex items-center gap-1.5">
              <Plus className="w-4 h-4" /> New Device
            </button>
          </>
        }
      />

      {error && <Alert type="error" message={error} onClose={() => setError('')} className="mb-4" />}

      {/* Customer / site filter bar */}
      {(customers.length > 1 || sites.length > 1) && (
        <div className="flex items-center gap-3 mb-4 flex-wrap">
          {customers.length > 1 && (
            <select
              value={filterCustomer}
              onChange={e => { setFilterCustomer(e.target.value); setFilterSite('') }}
              className="input text-xs py-1.5 w-48"
            >
              <option value="">All customers</option>
              {customers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          )}
          {siteOptions.length > 1 && (
            <select
              value={filterSite}
              onChange={e => setFilterSite(e.target.value)}
              className="input text-xs py-1.5 w-44"
            >
              <option value="">All sites</option>
              {siteOptions.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          )}
          {(filterCustomer || filterSite) && (
            <button
              onClick={() => { setFilterCustomer(''); setFilterSite('') }}
              className="btn-ghost text-xs py-1.5"
            >
              Clear
            </button>
          )}
        </div>
      )}

      <div className="card">
        {loading ? (
          <div className="flex items-center justify-center h-40"><Spinner /></div>
        ) : devices.length === 0 ? (
          <Empty icon={Monitor} title="No devices yet"
            description="Create a device slot to get an enrollment secret for your Pi"
            action={<button onClick={() => setShowCreate(true)} className="btn-primary">New Device</button>}
          />
        ) : (
          <Table
            headers={[
              { label: 'Name',      key: 'name' },
              { label: 'Status',    key: 'status' },
              { label: 'Customer',  key: 'customer' },
              { label: 'Site',      key: 'site' },
              { label: 'Health',    key: null },
              { label: 'Version',   key: 'version' },
              { label: 'Last Seen', key: 'last_seen' },
              '',
            ]}
            sortKey={sort.key}
            sortDir={sort.dir}
            onSort={toggleSort}
          >
            {visible.map(d => (
              <TR key={d.id}>
                <TD>
                  <Link to={`/devices/${d.id}`} className="flex items-center gap-2 hover:text-cyan-DEFAULT transition-colors">
                    <Monitor className="w-3.5 h-3.5 text-slate-600 shrink-0" />
                    <span className="font-mono text-xs">{d.name}</span>
                  </Link>
                </TD>
                <TD><StatusBadge status={d.status} /></TD>
                <TD><span className="text-xs text-slate-500">{d.customer_name || '—'}</span></TD>
                <TD><span className="text-xs text-slate-500">{siteName(d.site_id)}</span></TD>
                <TD><HealthCell device={d} /></TD>
                <TD><span className="tag bg-bg-elevated border-bg-border text-slate-500">{d.current_version || '—'}</span></TD>
                <TD>
                  <span className="text-xs font-mono text-slate-600">
                    {d.last_seen_at ? formatDistanceToNow(new Date(d.last_seen_at), { addSuffix: true }) : '—'}
                  </span>
                </TD>
                <TD>
                  <div className="flex items-center gap-1">
                    {d.status !== 'revoked' && (
                      <button
                        onClick={() => setShowTask(d)}
                        className="p-1.5 text-slate-600 hover:text-cyan-DEFAULT hover:bg-cyan-dim rounded transition-colors"
                        title="Issue task"
                      >
                        <Terminal className="w-3.5 h-3.5" />
                      </button>
                    )}
                    <Link to={`/devices/${d.id}`} className="p-1.5 text-slate-600 hover:text-slate-300 rounded transition-colors">
                      <ChevronRight className="w-3.5 h-3.5" />
                    </Link>
                  </div>
                </TD>
              </TR>
            ))}
          </Table>
        )}
      </div>

      {showCreate && (
        <CreateDeviceModal
          sites={sites}
          onClose={() => setShowCreate(false)}
          onCreated={(secret, name) => {
            setShowCreate(false)
            setShowResult({ type: 'enrollment', secret, name })
            load()
          }}
        />
      )}

      {showTask && (
        <IssueTaskModal
          device={showTask}
          onClose={() => setShowTask(null)}
          onIssued={(task) => {
            setShowTask(null)
            setShowResult({ type: 'task_issued', task })
          }}
        />
      )}

      {showResult && (
        <ResultModal result={showResult} onClose={() => setShowResult(null)} />
      )}
    </div>
  )
}


function CreateDeviceModal({ sites, onClose, onCreated }) {
  const [name, setName] = useState('')
  const [siteId, setSiteId] = useState(sites[0]?.id || '')
  const [role, setRole] = useState('diagnostic')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const submit = async (e) => {
    e.preventDefault()
    setLoading(true)
    setError('')
    try {
      const data = await api.createDevice({ name, site_id: siteId, role })
      onCreated(data.enrollment_secret, name)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <Modal title="New Device" onClose={onClose}>
      {error && <Alert type="error" message={error} className="mb-4" />}
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label className="label">Device Name</label>
          <input className="input" value={name} onChange={e => setName(e.target.value)}
            placeholder="pi-zero-01" required />
        </div>
        <div>
          <label className="label">Site</label>
          <select className="input" value={siteId} onChange={e => setSiteId(e.target.value)} required>
            {sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Role</label>
          <select className="input" value={role} onChange={e => setRole(e.target.value)}>
            <option value="diagnostic">Diagnostic</option>
            <option value="prospecting">Prospecting</option>
            <option value="pentest">Pentest</option>
          </select>
        </div>
        <div className="flex gap-2 pt-2">
          <button type="button" onClick={onClose} className="btn-ghost flex-1">Cancel</button>
          <button type="submit" className="btn-primary flex-1" disabled={loading}>
            {loading ? <Spinner className="w-4 h-4 mx-auto" /> : 'Create Device'}
          </button>
        </div>
      </form>
    </Modal>
  )
}


function IssueTaskModal({ device, onClose, onIssued }) {
  const [taskType, setTaskType] = useState(TASK_TYPES[0].value)
  const [payloadStr, setPayloadStr] = useState(JSON.stringify(TASK_TYPES[0].defaultPayload, null, 2))
  const [timeout, setTimeout_] = useState(300)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleTypeChange = (v) => {
    setTaskType(v)
    const t = TASK_TYPES.find(t => t.value === v)
    setPayloadStr(JSON.stringify(t?.defaultPayload || {}, null, 2))
  }

  const submit = async (e) => {
    e.preventDefault()
    setLoading(true)
    setError('')
    try {
      const payload = JSON.parse(payloadStr)
      const task = await api.issueTask(device.id, {
        task_type: taskType,
        payload,
        timeout_seconds: timeout,
      })
      onIssued(task)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <Modal title={`Issue Task — ${device.name}`} onClose={onClose} width="max-w-xl">
      {error && <Alert type="error" message={error} className="mb-4" />}
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label className="label">Task Type</label>
          <select className="input" value={taskType} onChange={e => handleTypeChange(e.target.value)}>
            {TASK_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Payload (JSON)</label>
          <textarea
            className="input font-mono text-xs h-32 resize-none"
            value={payloadStr}
            onChange={e => setPayloadStr(e.target.value)}
          />
        </div>
        <div>
          <label className="label">Timeout (seconds)</label>
          <input type="number" className="input" value={timeout} onChange={e => setTimeout_(+e.target.value)} min={10} max={3600} />
        </div>
        <div className="flex gap-2 pt-2">
          <button type="button" onClick={onClose} className="btn-ghost flex-1">Cancel</button>
          <button type="submit" className="btn-primary flex-1" disabled={loading}>
            {loading ? <Spinner className="w-4 h-4 mx-auto" /> : 'Issue Task'}
          </button>
        </div>
      </form>
    </Modal>
  )
}


function ResultModal({ result, onClose }) {
  if (result.type === 'enrollment') {
    const wsBase   = import.meta.env.VITE_WS_BASE || ''
    const apiBase  = import.meta.env.VITE_API_BASE ||
      wsBase.replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://')
    return (
      <Modal title="Device Created" onClose={onClose}>
        <Alert type="success" message={`Device "${result.name}" created successfully.`} />
        <div className="mt-4">
          <label className="label">Enrollment Secret — shown once, copy now</label>
          <CodeBlock>{result.secret}</CodeBlock>
          <p className="text-xs text-slate-600 mt-2">
            Run this on the target machine — downloads and installs everything automatically:
          </p>
          <CodeBlock>{`curl -fsSL ${apiBase}/v1/agent/bootstrap | sudo bash -s -- --secret ${result.secret}`}</CodeBlock>
        </div>
        <button onClick={onClose} className="btn-primary w-full mt-4">Done</button>
      </Modal>
    )
  }
  if (result.type === 'task_issued') {
    return (
      <Modal title="Task Queued" onClose={onClose}>
        <Alert type="success" message="Task queued successfully. It will be delivered to the device." />
        <div className="mt-3">
          <label className="label">Task ID</label>
          <CodeBlock>{result.task.task_id}</CodeBlock>
        </div>
        <button onClick={onClose} className="btn-primary w-full mt-4">Done</button>
      </Modal>
    )
  }
  return null
}
