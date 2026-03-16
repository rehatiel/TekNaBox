import { useState, useEffect, useCallback } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { api } from '../lib/api'
import {
  StatusBadge, Spinner, Alert, Modal, CodeBlock,
  Table, TR, TD, PageHeader
} from '../components/ui'
import {
  ArrowLeft, RefreshCw, XCircle, RotateCcw, Trash2,
  ChevronDown, Terminal, Radio, FileText, Shield,
  ShieldAlert, Network, Play, Check, Clock, Wifi
} from 'lucide-react'
import { formatDistanceToNow, format } from 'date-fns'

// ── Task definitions with smart form fields ───────────────────────────────────

const TASK_GROUPS = [
  {
    label: 'System',
    tasks: [
      {
        value: 'get_sysinfo',
        label: 'System Info',
        desc: 'Hardware, OS, memory, disk, network interfaces',
        fields: [],
      },
      {
        value: 'run_speedtest',
        label: 'Speed Test',
        desc: 'Download, upload, and latency test',
        fields: [],
      },
    ],
  },
  {
    label: 'Network Discovery',
    tasks: [
      {
        value: 'run_ping_sweep',
        label: 'Ping Sweep',
        desc: 'Find all live hosts in a subnet',
        fields: [
          { key: 'network', label: 'Network (CIDR)', type: 'text', placeholder: '192.168.1.0/24', required: true },
          { key: 'timeout', label: 'Timeout (sec/host)', type: 'number', placeholder: '1', min: 1, max: 10 },
        ],
      },
      {
        value: 'run_arp_scan',
        label: 'ARP Scan',
        desc: 'Discover LAN hosts with MAC + vendor info',
        fields: [
          { key: 'interface', label: 'Interface', type: 'text', placeholder: 'eth0' },
          { key: 'targets',   label: 'Target CIDR (blank = localnet)', type: 'text', placeholder: '192.168.1.0/24' },
        ],
      },
      {
        value: 'run_nmap_scan',
        label: 'Nmap Scan',
        desc: 'Detailed network scan with service/OS detection',
        fields: [
          { key: 'targets',   label: 'Targets (comma-separated IPs/CIDRs)', type: 'text', placeholder: '192.168.1.0/24', required: true, transform: v => v.split(',').map(s => s.trim()).filter(Boolean) },
          { key: 'ports',     label: 'Ports', type: 'text', placeholder: '1-1024' },
          { key: 'scan_type', label: 'Scan Type', type: 'select', options: [
            { value: 'quick',   label: 'Quick (fast, no service detection)' },
            { value: 'service', label: 'Service (version detection)' },
            { value: 'os',      label: 'OS Detection' },
          ]},
        ],
      },
      {
        value: 'run_port_scan',
        label: 'Port Scan',
        desc: 'Fast async TCP connect scan — no root required',
        fields: [
          { key: 'target', label: 'Target IP / Host', type: 'text', placeholder: '192.168.1.1', required: true },
          { key: 'ports',  label: 'Ports', type: 'text', placeholder: '1-1024 or 22,80,443' },
        ],
      },
      {
        value: 'run_netbios_scan',
        label: 'NetBIOS Scan',
        desc: 'Discover Windows machine names and workgroups via NBNS',
        fields: [
          { key: 'targets', label: 'Targets (IPs or CIDRs, comma-separated)', type: 'text', placeholder: '192.168.1.0/24', required: true, transform: v => v.split(',').map(s => s.trim()).filter(Boolean) },
          { key: 'timeout', label: 'Per-host timeout (sec)', type: 'number', placeholder: '2', min: 1, max: 10 },
        ],
      },
      {
        value: 'run_lldp_neighbors',
        label: 'LLDP/CDP Neighbors',
        desc: 'Passively capture LLDP/CDP frames to map connected switches and APs',
        fields: [
          { key: 'interface', label: 'Interface', type: 'text', placeholder: 'eth0' },
          { key: 'duration',  label: 'Listen duration (sec)', type: 'number', placeholder: '35', min: 10, max: 120 },
        ],
      },
      {
        value: 'run_wireless_survey',
        label: 'Wireless Survey',
        desc: 'Scan nearby WiFi networks — SSID, signal, security',
        fields: [
          { key: 'interface', label: 'Wireless Interface', type: 'text', placeholder: 'wlan0' },
        ],
      },
      {
        value: 'run_wol',
        label: 'Wake-on-LAN',
        desc: 'Send magic packets to wake devices on the local subnet',
        fields: [
          { key: 'targets', label: 'MAC addresses (comma-separated)', type: 'text', placeholder: 'AA:BB:CC:DD:EE:FF', required: true, transform: v => v.split(',').map(s => s.trim()).filter(Boolean) },
          { key: 'count',   label: 'Packets per target', type: 'number', placeholder: '3', min: 1, max: 10 },
        ],
      },
    ],
  },
  {
    label: 'Diagnostics',
    tasks: [
      {
        value: 'run_traceroute',
        label: 'Traceroute',
        desc: 'Hop-by-hop path to a destination',
        fields: [
          { key: 'target',    label: 'Target', type: 'text', placeholder: '8.8.8.8', required: true },
          { key: 'max_hops',  label: 'Max Hops', type: 'number', placeholder: '30', min: 1, max: 64 },
          { key: 'protocol',  label: 'Protocol', type: 'select', options: [
            { value: 'icmp', label: 'ICMP' },
            { value: 'udp',  label: 'UDP' },
            { value: 'tcp',  label: 'TCP' },
          ]},
        ],
      },
      {
        value: 'run_mtr',
        label: 'MTR Report',
        desc: 'Combines traceroute + ping with loss stats per hop',
        fields: [
          { key: 'target', label: 'Target', type: 'text', placeholder: '8.8.8.8', required: true },
          { key: 'count',  label: 'Ping Cycles', type: 'number', placeholder: '10', min: 1, max: 100 },
        ],
      },
      {
        value: 'run_dns_lookup',
        label: 'DNS Lookup',
        desc: 'Query DNS records for a domain or IP',
        fields: [
          { key: 'target',        label: 'Domain / IP', type: 'text', placeholder: 'example.com', required: true },
          { key: 'nameserver',    label: 'Nameserver (optional)', type: 'text', placeholder: '8.8.8.8' },
          { key: 'zone_transfer', label: 'Attempt Zone Transfer', type: 'checkbox' },
        ],
      },
      {
        value: 'run_ntp_check',
        label: 'NTP Check',
        desc: 'Verify clock sync against public NTP servers',
        fields: [
          { key: 'warn_offset_ms', label: 'Warn if offset exceeds (ms)', type: 'number', placeholder: '500', min: 10, max: 10000 },
        ],
      },
      {
        value: 'run_http_monitor',
        label: 'HTTP Monitor',
        desc: 'Check URLs for up/down status, response time, and content',
        fields: [
          { key: 'urls',            label: 'URLs (comma-separated)', type: 'text', placeholder: 'https://example.com', required: true, transform: v => v.split(',').map(s => s.trim()).filter(Boolean) },
          { key: 'content_match',   label: 'Content match string (optional)', type: 'text', placeholder: 'Login' },
          { key: 'timeout',         label: 'Timeout (sec)', type: 'number', placeholder: '10', min: 1, max: 30 },
        ],
      },
      {
        value: 'run_iperf',
        label: 'iPerf Test',
        desc: 'Throughput test against an iPerf3 server',
        fields: [
          { key: 'server',    label: 'iPerf Server', type: 'text', placeholder: '192.168.1.1', required: true },
          { key: 'port',      label: 'Port', type: 'number', placeholder: '5201' },
          { key: 'duration',  label: 'Duration (sec)', type: 'number', placeholder: '10', min: 1, max: 60 },
          { key: 'direction', label: 'Direction', type: 'select', options: [
            { value: 'both',     label: 'Both (upload + download)' },
            { value: 'upload',   label: 'Upload only' },
            { value: 'download', label: 'Download only' },
          ]},
        ],
      },
      {
        value: 'run_banner_grab',
        label: 'Banner Grab',
        desc: 'Read service banners from open ports',
        fields: [
          { key: 'targets', label: 'Target IPs (comma-separated)', type: 'text', placeholder: '192.168.1.1', required: true, transform: v => v.split(',').map(s => s.trim()).filter(Boolean) },
          { key: 'ports',   label: 'Ports (comma-separated)', type: 'text', placeholder: '22,80,443,8080', transform: v => v.split(',').map(s => parseInt(s.trim())).filter(Boolean) },
        ],
      },
      {
        value: 'run_packet_capture',
        label: 'Packet Capture',
        desc: 'Capture live traffic on an interface',
        fields: [
          { key: 'interface', label: 'Interface', type: 'text', placeholder: 'eth0', required: true },
          { key: 'duration',  label: 'Duration (sec)', type: 'number', placeholder: '10', min: 1, max: 120 },
          { key: 'filter',    label: 'BPF Filter (optional)', type: 'text', placeholder: 'port 80' },
        ],
      },
    ],
  },
  {
    label: 'SNMP',
    tasks: [
      {
        value: 'run_snmp_query',
        label: 'SNMP Query',
        desc: 'Query SNMP-enabled devices — results in SNMP page',
        fields: [
          { key: 'target',    label: 'Target IP / Host', type: 'text', placeholder: '192.168.1.1', required: true },
          { key: 'community', label: 'Community String', type: 'text', placeholder: 'public' },
          { key: 'version',   label: 'SNMP Version', type: 'select', options: [
            { value: '2c', label: 'v2c' },
            { value: '1',  label: 'v1' },
            { value: '3',  label: 'v3' },
          ]},
          { key: 'mode', label: 'Mode', type: 'select', options: [
            { value: 'sysinfo',    label: 'System Info' },
            { value: 'interfaces', label: 'Interfaces' },
            { value: 'storage',    label: 'Storage' },
            { value: 'full',       label: 'Full Walk' },
          ]},
        ],
      },
    ],
  },
  {
    label: 'Security',
    tasks: [
      {
        value: 'run_ssl_check',
        label: 'SSL/TLS Check',
        desc: 'Verify cert expiry, cipher suites, and SAN coverage',
        fields: [
          { key: 'targets',   label: 'Targets — host:port (comma-separated)', type: 'text', placeholder: 'example.com:443', required: true, transform: v => v.split(',').map(s => s.trim()).filter(Boolean) },
          { key: 'warn_days', label: 'Warn if expiring within (days)', type: 'number', placeholder: '30', min: 1, max: 365 },
        ],
      },
      {
        value: 'run_dns_health',
        label: 'DNS & Email Security',
        desc: 'SPF, DKIM, DMARC, NS consistency checks',
        fields: [
          { key: 'domain',        label: 'Domain', type: 'text', placeholder: 'example.com', required: true },
          { key: 'dkim_selector', label: 'DKIM Selector', type: 'text', placeholder: 'default' },
        ],
      },
      {
        value: 'run_default_creds',
        label: 'Default Credentials',
        desc: 'Test common vendor defaults on network devices, cameras, printers',
        fields: [
          { key: 'targets', label: 'Targets (comma-separated IPs)', type: 'text', placeholder: '192.168.1.1', required: true, transform: v => v.split(',').map(s => s.trim()).filter(Boolean) },
        ],
      },
      {
        value: 'run_cleartext_services',
        label: 'Cleartext Services',
        desc: 'Detect Telnet, FTP, HTTP Basic Auth, LDAP, VNC, SNMP v1/v2',
        fields: [
          { key: 'targets', label: 'Targets (comma-separated IPs)', type: 'text', placeholder: '192.168.1.0/24', required: true, transform: v => v.split(',').map(s => s.trim()).filter(Boolean) },
        ],
      },
      {
        value: 'run_smb_enum',
        label: 'SMB Enumeration',
        desc: 'List shares, detect null sessions and guest access',
        fields: [
          { key: 'targets',  label: 'Targets (comma-separated IPs)', type: 'text', placeholder: '192.168.1.10', required: true, transform: v => v.split(',').map(s => s.trim()).filter(Boolean) },
          { key: 'username', label: 'Username (blank = null session)', type: 'text', placeholder: '' },
          { key: 'password', label: 'Password', type: 'password', placeholder: '' },
        ],
      },
      {
        value: 'run_vuln_scan',
        label: 'Vuln Scan',
        desc: 'Nmap NSE vulnerability scripts against targets',
        fields: [
          { key: 'targets', label: 'Targets (comma-separated IPs/CIDRs)', type: 'text', placeholder: '192.168.1.0/24', required: true, transform: v => v.split(',').map(s => s.trim()).filter(Boolean) },
          { key: 'ports',   label: 'Ports', type: 'text', placeholder: '1-1024' },
        ],
      },
      {
        value: 'run_security_audit',
        label: 'Security Audit',
        desc: 'Audit the agent host — open ports, weak configs, services',
        fields: [],
      },
      {
        value: 'run_email_breach',
        label: 'Email Breach Check',
        desc: 'Check domain against Have I Been Pwned breach database',
        fields: [
          { key: 'domain',       label: 'Domain', type: 'text', placeholder: 'example.com', required: true },
          { key: 'hibp_api_key', label: 'HIBP API Key', type: 'password', placeholder: 'your-hibp-key', required: true },
        ],
        note: 'Requires a Have I Been Pwned API key (haveibeenpwned.com/API/Key). The key is sent directly to the agent and is not stored on the server.',
      },
    ],
  },
  {
    label: 'Active Directory',
    tasks: [
      {
        value: 'run_ad_discover',
        label: 'AD Discover',
        desc: 'Find Active Directory domain controllers on the network',
        fields: [
          { key: 'network', label: 'Network (CIDR)', type: 'text', placeholder: '192.168.1.0/24', required: true },
        ],
      },
      {
        value: 'run_ad_recon',
        label: 'AD Recon',
        desc: '',
        disabled: true,
        disabledMsg: 'Use the AD Report page for full recon with credential management',
      },
    ],
  },
]

const REPORTABLE = [
  'run_nmap_scan','run_port_scan','run_ping_sweep','run_arp_scan',
  'run_speedtest','run_wireless_survey','run_traceroute','run_mtr','get_sysinfo',
  'run_ssl_check','run_dns_health','run_default_creds','run_cleartext_services',
  'run_smb_enum','run_netbios_scan','run_lldp_neighbors','run_ntp_check',
  'run_http_monitor','run_security_audit','run_vuln_scan','run_ad_discover',
  'run_email_breach',
]

// ── Smart task form ───────────────────────────────────────────────────────────

function TaskForm({ device, onIssued }) {
  const [selectedTask, setSelected] = useState(TASK_GROUPS[0].tasks[0])
  const [values, setValues]         = useState({})
  const [loading, setLoading]       = useState(false)
  const [error, setError]           = useState('')
  const [success, setSuccess]       = useState(null)

  const selectTask = (task) => {
    setSelected(task)
    setValues({})
    setError('')
    setSuccess(null)
  }

  const setValue = (key, val) => setValues(v => ({ ...v, [key]: val }))

  const buildPayload = () => {
    const payload = {}
    for (const field of selectedTask.fields) {
      const raw = values[field.key]
      if (raw === undefined || raw === '') continue
      payload[field.key] = field.transform ? field.transform(raw)
        : field.type === 'number'   ? Number(raw)
        : field.type === 'checkbox' ? Boolean(raw)
        : raw
    }
    return payload
  }

  const submit = async () => {
    if (selectedTask.disabled || device.status !== 'active') return
    setLoading(true)
    setError('')
    setSuccess(null)
    try {
      const task = await api.issueTask(device.id, {
        task_type: selectedTask.value,
        payload: buildPayload(),
        timeout_seconds: 300,
      })
      setSuccess(task)
      setValues({})
      onIssued()
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="card overflow-hidden">
      <div className="px-4 pt-4 pb-3 border-b border-bg-border flex items-center justify-between">
        <h2 className="font-display font-600 text-slate-200 text-sm">Run Task</h2>
        {device.status !== 'active' && (
          <span className="text-xs text-amber-DEFAULT font-mono">Device must be active to run tasks</span>
        )}
      </div>

      <div className="flex" style={{ minHeight: '260px' }}>
        {/* Left: task selector */}
        <div className="w-44 shrink-0 border-r border-bg-border overflow-y-auto">
          {TASK_GROUPS.map(group => (
            <div key={group.label}>
              <div className="px-3 pt-3 pb-1">
                <span className="text-xs font-display font-500 text-slate-600 uppercase tracking-wider">
                  {group.label}
                </span>
              </div>
              {group.tasks.map(task => (
                <button
                  key={task.value}
                  onClick={() => !task.disabled && selectTask(task)}
                  className={`w-full text-left px-3 py-2 text-xs transition-colors
                    ${task.disabled
                      ? 'opacity-35 cursor-not-allowed text-slate-600'
                      : selectedTask.value === task.value
                        ? 'bg-cyan-dim text-cyan-DEFAULT font-display font-500'
                        : 'text-slate-400 hover:text-slate-200 hover:bg-bg-elevated'
                    }`}
                >
                  {task.label}
                </button>
              ))}
            </div>
          ))}
        </div>

        {/* Right: form area */}
        <div className="flex-1 p-5 flex flex-col">
          <div className="mb-4">
            <p className="text-sm font-display font-500 text-slate-200 mb-0.5">{selectedTask.label}</p>
            <p className="text-xs text-slate-500">
              {selectedTask.disabledMsg || selectedTask.desc}
            </p>
          </div>

          {!selectedTask.disabled && (
            <>
              {selectedTask.note && (
                <div className="mb-3 px-3 py-2 rounded text-xs text-slate-400 bg-bg-card border border-bg-border leading-relaxed">
                  ℹ️ {selectedTask.note}
                </div>
              )}

              {selectedTask.fields.length === 0 ? (
                <p className="text-xs text-slate-600 italic mb-4">No configuration required — ready to run.</p>
              ) : (
                <div className="grid grid-cols-2 gap-x-4 gap-y-3 mb-4">
                  {selectedTask.fields.map(field => (
                    <div key={field.key}>
                      <label className="label mb-1">{field.label}</label>
                      {field.type === 'select' ? (
                        <select
                          className="input w-full py-1.5 text-xs"
                          value={values[field.key] ?? field.options[0].value}
                          onChange={e => setValue(field.key, e.target.value)}
                        >
                          {field.options.map(o => (
                            <option key={o.value} value={o.value}>{o.label}</option>
                          ))}
                        </select>
                      ) : field.type === 'checkbox' ? (
                        <label className="flex items-center gap-2 cursor-pointer mt-1.5">
                          <input
                            type="checkbox"
                            checked={!!values[field.key]}
                            onChange={e => setValue(field.key, e.target.checked)}
                          />
                          <span className="text-xs text-slate-400">Enable</span>
                        </label>
                      ) : (
                        <input
                          type={field.type === 'password' ? 'password' : field.type === 'number' ? 'number' : 'text'}
                          className="input w-full py-1.5 text-xs"
                          placeholder={field.placeholder}
                          value={values[field.key] ?? ''}
                          onChange={e => setValue(field.key, e.target.value)}
                          min={field.min}
                          max={field.max}
                        />
                      )}
                    </div>
                  ))}
                </div>
              )}

              {error && <Alert type="error" message={error} className="mb-3" />}
              {success && (
                <>
                  <Alert type="success" message={`Task queued — ${success.task_id || success.id || 'queued'}`} className="mb-2" />
                  {success.warning && (
                    <Alert type="warning" message={success.warning} className="mb-3" />
                  )}
                </>
              )}

              <div className="mt-auto flex items-center gap-3">
                <button
                  onClick={submit}
                  disabled={loading || device.status !== 'active'}
                  className="btn-primary flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {loading ? <Spinner className="w-3.5 h-3.5" />
                    : success ? <Check className="w-3.5 h-3.5" />
                    : <Play className="w-3.5 h-3.5" />}
                  {loading ? 'Queuing…' : success ? 'Queued!' : `Run ${selectedTask.label}`}
                </button>

                {success && REPORTABLE.includes(selectedTask.value) && (
                  <Link
                    to={`/reports?device=${device.id}`}
                    className="text-xs text-cyan-muted hover:text-cyan-DEFAULT transition-colors"
                  >
                    View in Reports →
                  </Link>
                )}
                {success && selectedTask.value === 'run_snmp_query' && (
                  <Link
                    to={`/snmp?device=${device.id}`}
                    className="text-xs text-cyan-muted hover:text-cyan-DEFAULT transition-colors"
                  >
                    View in SNMP →
                  </Link>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function DeviceDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [device, setDevice]             = useState(null)
  const [tasks, setTasks]               = useState([])
  const [loading, setLoading]           = useState(true)
  const [showRevoke, setShowRevoke]     = useState(false)
  const [showReset, setShowReset]       = useState(false)
  const [showDelete, setShowDelete]     = useState(false)
  const [resetResult, setResetResult]   = useState(null)
  const [selectedTask, setSelectedTask] = useState(null)
  const [showActions, setShowActions]   = useState(false)
  const [error, setError]               = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [devices, t] = await Promise.all([api.getDevices(), api.getTasks(id)])
      setDevice(devices.find(d => d.id === id))
      setTasks(t)
    } catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }, [id])

  useEffect(() => { load() }, [load])

  const handleRevoke = async (reason) => {
    try { await api.revokeDevice(id, reason); setShowRevoke(false); load() }
    catch (e) { setError(e.message) }
  }
  const handleReset = async (reason) => {
    try { const r = await api.resetDevice(id, reason); setShowReset(false); setResetResult(r); load() }
    catch (e) { setError(e.message) }
  }
  const handleDelete = async () => {
    try { await api.deleteDevice(id); navigate('/devices') }
    catch (e) { setError(e.message) }
  }

  const apiBase = import.meta.env.VITE_API_BASE || import.meta.env.VITE_WS_BASE || ''

  const openTerminal = async () => {
    try {
      const { ticket } = await api.getWsTicket()
      const p = new URLSearchParams({ device_id: device.id, device_name: device.name, token: localStorage.getItem('msp_token'), ticket, api_base: apiBase })
      window.open(`/terminal.html?${p}`, '_blank', 'width=1000,height=650,noopener')
    } catch (e) { alert('Failed to open terminal: ' + e.message) }
  }

  const openBandwidth = async () => {
    try {
      const { ticket } = await api.getWsTicket()
      const p = new URLSearchParams({ device_id: device.id, device_name: device.name, token: localStorage.getItem('msp_token'), ticket, api_base: apiBase })
      window.open(`/bandwidth.html?${p}`, '_blank', 'width=1100,height=700,noopener')
    } catch (e) { alert('Failed to open bandwidth monitor: ' + e.message) }
  }

  if (loading) return <div className="flex items-center justify-center h-64"><Spinner /></div>
  if (!device)  return <div className="text-slate-500 text-center py-20">Device not found</div>

  const isActive  = device.status === 'active'
  const notRevoked = device.status !== 'revoked'

  return (
    <div className="animate-fade-in">

      {/* ── Streamlined header ── */}
      <PageHeader
        title={device.name}
        subtitle={<span className="font-mono text-xs text-slate-600">{device.id}</span>}
        actions={
          <div className="flex items-center gap-2">
            <Link to="/devices" className="btn-ghost flex items-center gap-1.5">
              <ArrowLeft className="w-3.5 h-3.5" /> Back
            </Link>
            <button onClick={load} className="btn-ghost p-2" title="Refresh">
              <RefreshCw className="w-3.5 h-3.5" />
            </button>

            {isActive && (
              <button onClick={openTerminal} className="btn-primary flex items-center gap-1.5">
                <Terminal className="w-3.5 h-3.5" /> Terminal
              </button>
            )}
            {isActive && (
              <button onClick={openBandwidth} className="btn-ghost flex items-center gap-1.5">
                <Radio className="w-3.5 h-3.5" /> Bandwidth
              </button>
            )}

            {notRevoked && (
              <div className="relative">
                <button
                  onClick={() => setShowActions(v => !v)}
                  className="btn-ghost flex items-center gap-1.5"
                >
                  Actions <ChevronDown className="w-3.5 h-3.5" />
                </button>
                {showActions && (
                  <>
                    <div className="fixed inset-0 z-10" onClick={() => setShowActions(false)} />
                    <div className="absolute right-0 top-full mt-1 z-20 w-40 card py-1 shadow-xl border border-bg-border">
                      <button onClick={() => { setShowActions(false); setShowReset(true) }}
                        className="w-full text-left px-3 py-2 text-xs text-slate-300 hover:bg-bg-elevated flex items-center gap-2">
                        <RotateCcw className="w-3.5 h-3.5 text-slate-500" /> Reset
                      </button>
                      <button onClick={() => { setShowActions(false); setShowRevoke(true) }}
                        className="w-full text-left px-3 py-2 text-xs text-red-DEFAULT hover:bg-red-dim flex items-center gap-2">
                        <XCircle className="w-3.5 h-3.5" /> Revoke
                      </button>
                      <div className="border-t border-bg-border my-1" />
                      <button onClick={() => { setShowActions(false); setShowDelete(true) }}
                        className="w-full text-left px-3 py-2 text-xs text-red-DEFAULT hover:bg-red-dim flex items-center gap-2">
                        <Trash2 className="w-3.5 h-3.5" /> Delete
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        }
      />

      {error && <Alert type="error" message={error} onClose={() => setError('')} className="mb-4" />}

      {/* ── Jump-to nav pills ── */}
      {notRevoked && (
        <div className="flex flex-wrap items-center gap-2 mb-5">
          <span className="text-xs text-slate-600 uppercase tracking-wider mr-1">Jump to:</span>
          {[
            { to: `/reports?device=${id}`,    icon: FileText,    label: 'Reports'  },
            { to: `/findings?device=${id}`,   icon: ShieldAlert, label: 'Findings' },
            { to: `/snmp?device=${id}`,        icon: Network,     label: 'SNMP'     },
            { to: `/wireless?device=${id}`,    icon: Wifi,        label: 'Wireless' },
            { to: `/devices/${id}/ad-report`,  icon: Shield,      label: 'AD Report'},
          ].map(({ to, icon: Icon, label }) => (
            <Link key={to} to={to}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-bg-border bg-bg-elevated text-xs text-slate-400 hover:text-slate-200 hover:border-slate-600 transition-colors">
              <Icon className="w-3.5 h-3.5" />
              {label}
            </Link>
          ))}
        </div>
      )}

      {/* ── Device info + task summary ── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-4">
        <div className="card p-4 space-y-3">
          <h3 className="label">Device Info</h3>
          <StatusBadge status={device.status} />
          <div className="space-y-2 pt-1">
            {[
              ['Hardware ID', device.hardware_id    || '—'],
              ['Version',     device.current_version || '—'],
              ['Role',        device.role],
              ['Last IP',     device.last_ip         || '—'],
              ['Enrolled',    device.enrolled_at ? format(new Date(device.enrolled_at), 'MMM d, yyyy') : '—'],
              ['Last Seen',   device.last_seen_at ? formatDistanceToNow(new Date(device.last_seen_at), { addSuffix: true }) : '—'],
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between text-xs">
                <span className="text-slate-600 font-display font-500 uppercase tracking-wide">{k}</span>
                <span className="font-mono text-slate-400">{v}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="card p-4 lg:col-span-2">
          <h3 className="label mb-3">Task Summary</h3>
          <div className="grid grid-cols-4 gap-2 mb-4">
            {['queued','completed','failed','timeout'].map(status => (
              <div key={status} className="bg-bg-base rounded p-3 text-center">
                <p className="font-display font-700 text-lg text-slate-200">
                  {tasks.filter(t => t.status === status).length}
                </p>
                <p className="text-xs text-slate-600 mt-0.5 capitalize">{status}</p>
              </div>
            ))}
          </div>
          {tasks.length > 0 && (() => {
            const last = tasks[0]
            return (
              <div className="flex items-center gap-2 text-xs text-slate-600 border-t border-bg-border pt-3">
                <Clock className="w-3 h-3" />
                Last:
                <span className="font-mono text-slate-400">{last.task_type}</span>
                <StatusBadge status={last.status} />
                <span className="ml-auto">
                  {formatDistanceToNow(new Date(last.queued_at), { addSuffix: true })}
                </span>
              </div>
            )
          })()}
        </div>
      </div>

      {/* ── Run task panel ── */}
      {notRevoked && (
        <div className="mb-4">
          <TaskForm device={device} onIssued={load} />
        </div>
      )}

      {/* ── Task history ── */}
      <div className="card">
        <div className="flex items-center justify-between px-4 pt-4 pb-3 border-b border-bg-border">
          <h2 className="font-display font-600 text-slate-200 text-sm">Task History</h2>
          <span className="text-xs text-slate-600 font-mono">{tasks.length} tasks</span>
        </div>
        {tasks.length === 0 ? (
          <div className="py-12 text-center text-slate-600 text-sm">No tasks yet — run one above</div>
        ) : (
          <Table headers={['Type', 'Status', 'Queued', 'Duration', '']}>
            {tasks.map(t => {
              const duration = t.completed_at && t.queued_at
                ? `${((new Date(t.completed_at) - new Date(t.queued_at)) / 1000).toFixed(1)}s`
                : '—'
              const isReport = REPORTABLE.includes(t.task_type)
              return (
                <TR key={t.id}>
                  <TD><span className="font-mono text-xs text-slate-300">{t.task_type}</span></TD>
                  <TD><StatusBadge status={t.status} /></TD>
                  <TD>
                    <span className="text-xs font-mono text-slate-600"
                      title={t.queued_at ? format(new Date(t.queued_at), 'PPpp') : ''}>
                      {t.queued_at ? formatDistanceToNow(new Date(t.queued_at), { addSuffix: true }) : '—'}
                    </span>
                  </TD>
                  <TD><span className="text-xs font-mono text-slate-600">{duration}</span></TD>
                  <TD>
                    <div className="flex items-center gap-3">
                      {t.status === 'completed' && isReport && (
                        <Link to={`/reports?device=${id}`}
                          className="text-xs text-cyan-muted hover:text-cyan-DEFAULT transition-colors">
                          View Report
                        </Link>
                      )}
                      {t.status === 'completed' && t.task_type === 'run_snmp_query' && (
                        <Link to={`/snmp?device=${id}`}
                          className="text-xs text-cyan-muted hover:text-cyan-DEFAULT transition-colors">
                          View in SNMP
                        </Link>
                      )}
                      {t.status === 'completed' && t.task_type === 'run_wireless_survey' && (
                        <Link to={`/wireless?device=${id}`}
                          className="text-xs text-cyan-muted hover:text-cyan-DEFAULT transition-colors">
                          View Survey
                        </Link>
                      )}
                      {(t.result || t.error) && !isReport && t.task_type !== 'run_snmp_query' && (
                        <button onClick={() => setSelectedTask(t)}
                          className="text-xs text-slate-500 hover:text-slate-300 transition-colors">
                          View Result
                        </button>
                      )}
                    </div>
                  </TD>
                </TR>
              )
            })}
          </Table>
        )}
      </div>

      {/* ── Modals ── */}
      {showRevoke && (
        <ActionModal title="Revoke Device"
          description={`Permanently blocks "${device.name}" from connecting. Cannot be undone.`}
          confirmLabel="Revoke Device" confirmClass="btn-danger" withReason
          onConfirm={handleRevoke} onClose={() => setShowRevoke(false)} />
      )}
      {showReset && (
        <ActionModal title="Reset Device"
          description={`Clears enrollment for "${device.name}" — the Pi must re-enroll with a new secret.`}
          confirmLabel="Reset Device" confirmClass="btn-primary" withReason
          onConfirm={handleReset} onClose={() => setShowReset(false)} />
      )}
      {showDelete && (
        <ActionModal title="Delete Device"
          description={`Permanently deletes "${device.name}" and all task history.`}
          confirmLabel="Delete Device" confirmClass="btn-danger"
          onConfirm={handleDelete} onClose={() => setShowDelete(false)} />
      )}

      {resetResult && (
        <Modal title="Device Reset — New Enrollment Secret" onClose={() => setResetResult(null)}>
          <Alert type="success" message="Device reset. Copy the new secret below — it won't be shown again." />
          <div className="mt-4">
            <label className="label">New Enrollment Secret</label>
            <CodeBlock>{resetResult.enrollment_secret}</CodeBlock>
            <p className="text-xs text-slate-600 mt-2">Run on the Pi:</p>
            <CodeBlock>{`sudo bash install.sh --server ${import.meta.env.VITE_API_BASE || import.meta.env.VITE_WS_BASE} --secret ${resetResult.enrollment_secret}`}</CodeBlock>
          </div>
          <button onClick={() => setResetResult(null)} className="btn-primary w-full mt-4">Done</button>
        </Modal>
      )}

      {selectedTask && (
        <Modal title={`Result — ${selectedTask.task_type}`} onClose={() => setSelectedTask(null)} width="max-w-2xl">
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <StatusBadge status={selectedTask.status} />
              <span className="text-xs font-mono text-slate-600">{selectedTask.id}</span>
            </div>
            {selectedTask.result && (
              <><label className="label">Result</label>
              <CodeBlock content={JSON.stringify(selectedTask.result, null, 2)} /></>
            )}
            {selectedTask.error && <Alert type="error" message={selectedTask.error} />}
          </div>
        </Modal>
      )}
    </div>
  )
}

function ActionModal({ title, description, confirmLabel, confirmClass, withReason, onConfirm, onClose }) {
  const [reason, setReason] = useState('')
  return (
    <Modal title={title} onClose={onClose}>
      <Alert type="warning" message={description} />
      {withReason && (
        <div className="mt-4">
          <label className="label">Reason (optional)</label>
          <input className="input" value={reason} onChange={e => setReason(e.target.value)}
            placeholder="e.g. Reimaging device" />
        </div>
      )}
      <div className="flex gap-2 mt-4">
        <button onClick={onClose} className="btn-ghost flex-1">Cancel</button>
        <button onClick={() => onConfirm(reason)} className={`${confirmClass} flex-1`}>{confirmLabel}</button>
      </div>
    </Modal>
  )
}
