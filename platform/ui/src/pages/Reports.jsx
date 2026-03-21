import { useState, useEffect, useCallback, useRef } from 'react'
import { useSearchParams, Link } from 'react-router-dom'
import { api } from '../lib/api'
import { PageHeader, Spinner, Alert, Empty, StatusBadge, Table, TR, TD } from '../components/ui'
import {
  FileText, RefreshCw, Filter, ChevronDown, ChevronRight,
  Download, Wifi, Zap, Network, Radio, Activity,
  Server, Map, Search, X,
  Globe, Clock, Tag, Layers, Cpu, Monitor, GitBranch, Power,
  Lock, Shield, ShieldAlert, Key, Eye, HardDrive, Mail,
  ShieldX, Building2, CheckCircle, AlertTriangle
} from 'lucide-react'
import { format, formatDistanceToNow } from 'date-fns'

// ── Report type definitions ───────────────────────────────────────────────────

const REPORT_TYPES = [
  { value: '',                       label: 'All Types',            icon: FileText   },
  // System
  { value: 'get_sysinfo',            label: 'System Info',          icon: Server     },
  { value: 'run_speedtest',          label: 'Speed Test',           icon: Zap        },
  { value: 'run_http_monitor',       label: 'HTTP Monitor',         icon: Globe      },
  { value: 'run_ntp_check',          label: 'NTP Check',            icon: Clock      },
  // Network scans
  { value: 'run_nmap_scan',          label: 'Network Scan',         icon: Search     },
  { value: 'run_port_scan',          label: 'Port Scan',            icon: Network    },
  { value: 'run_ping_sweep',         label: 'Ping Sweep',           icon: Activity   },
  { value: 'run_arp_scan',           label: 'ARP Scan',             icon: Map        },
  { value: 'run_netbios_scan',       label: 'NetBIOS Scan',         icon: Monitor    },
  { value: 'run_lldp_neighbors',     label: 'LLDP Neighbors',       icon: GitBranch  },
  { value: 'run_wireless_survey',    label: 'Wireless Survey',      icon: Wifi       },
  { value: 'run_wol',                label: 'Wake-on-LAN',          icon: Power      },
  // Diagnostics
  { value: 'run_traceroute',         label: 'Traceroute',           icon: Radio      },
  { value: 'run_mtr',                label: 'MTR Report',           icon: Radio      },
  { value: 'run_dns_lookup',         label: 'DNS Lookup',           icon: Globe      },
  { value: 'run_iperf',              label: 'iPerf Test',           icon: Zap        },
  { value: 'run_banner_grab',        label: 'Banner Grab',          icon: Tag        },
  { value: 'run_packet_capture',     label: 'Packet Capture',       icon: Layers     },
  { value: 'run_snmp_query',         label: 'SNMP Query',           icon: Cpu        },
  // Security
  { value: 'run_ssl_check',          label: 'SSL/TLS Check',        icon: Lock       },
  { value: 'run_dns_health',         label: 'DNS Health',           icon: Shield     },
  { value: 'run_vuln_scan',          label: 'Vuln Scan',            icon: ShieldX    },
  { value: 'run_security_audit',     label: 'Security Audit',       icon: ShieldAlert},
  { value: 'run_default_creds',      label: 'Default Credentials',  icon: Key        },
  { value: 'run_cleartext_services', label: 'Cleartext Services',   icon: Eye        },
  { value: 'run_smb_enum',           label: 'SMB Enumeration',      icon: HardDrive  },
  { value: 'run_email_breach',       label: 'Email Breach',         icon: Mail       },
  // Active Directory
  { value: 'run_ad_discover',        label: 'AD Discovery',         icon: Building2  },
  { value: 'run_ad_recon',           label: 'AD Recon',             icon: Building2  },
  // Agentless Windows
  { value: 'run_windows_probe',      label: 'Windows Probe',        icon: Monitor    },
]

const REPORTABLE_TYPES = REPORT_TYPES.slice(1).map(t => t.value)

// ── Utility helpers ───────────────────────────────────────────────────────────

function labelFor(taskType) {
  return REPORT_TYPES.find(t => t.value === taskType)?.label || taskType
}

function signalBar(dbm) {
  if (dbm == null) return { bars: 0, color: 'text-slate-600' }
  if (dbm >= -50) return { bars: 4, color: 'text-green-DEFAULT' }
  if (dbm >= -65) return { bars: 3, color: 'text-green-DEFAULT' }
  if (dbm >= -75) return { bars: 2, color: 'text-amber-DEFAULT' }
  if (dbm >= -85) return { bars: 1, color: 'text-red-DEFAULT' }
  return { bars: 0, color: 'text-red-DEFAULT' }
}

function SignalBars({ dbm }) {
  const { bars, color } = signalBar(dbm)
  return (
    <span className={`inline-flex items-end gap-px ${color}`} title={`${dbm} dBm`}>
      {[1,2,3,4].map(i => (
        <span key={i} className={`inline-block w-1 rounded-sm ${i <= bars ? 'opacity-100' : 'opacity-20'}`}
          style={{ height: `${i * 3 + 2}px`, background: 'currentColor' }} />
      ))}
      <span className="ml-1 text-xs font-mono">{dbm != null ? `${dbm}` : '—'}</span>
    </span>
  )
}

function encryptionBadge(enc) {
  const colors = {
    WPA2: 'text-green-DEFAULT bg-green-dim border-green-muted',
    WPA:  'text-amber-DEFAULT bg-amber-dim border-amber-muted',
    WEP:  'text-red-DEFAULT bg-red-dim border-red-muted',
    Open: 'text-red-DEFAULT bg-red-dim border-red-muted',
  }
  const cls = colors[enc] || 'text-slate-400 bg-bg-base border-bg-border'
  return <span className={`text-xs font-mono px-1.5 py-0.5 rounded border ${cls}`}>{enc || '?'}</span>
}

function speedRating(dl) {
  if (!dl) return { label: '—', color: 'text-slate-500' }
  if (dl >= 100) return { label: 'Excellent', color: 'text-green-DEFAULT' }
  if (dl >= 25)  return { label: 'Good',      color: 'text-green-DEFAULT' }
  if (dl >= 10)  return { label: 'Fair',      color: 'text-amber-DEFAULT' }
  return           { label: 'Poor',           color: 'text-red-DEFAULT' }
}

function lossColor(pct) {
  if (pct === 0)   return 'text-green-DEFAULT'
  if (pct <= 5)    return 'text-amber-DEFAULT'
  return 'text-red-DEFAULT'
}

function rttColor(ms) {
  if (!ms)       return 'text-slate-500'
  if (ms <= 20)  return 'text-green-DEFAULT'
  if (ms <= 80)  return 'text-amber-DEFAULT'
  return 'text-red-DEFAULT'
}

// ── Report Renderers ──────────────────────────────────────────────────────────

function NmapReport({ result }) {
  if (!result) return null
  const { hosts_up, hosts = [] } = result
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4 mb-2">
        <div className="card px-4 py-2 flex items-center gap-2">
          <span className="text-xs text-slate-500">Hosts Up</span>
          <span className="font-display font-700 text-lg text-green-DEFAULT">{hosts_up ?? hosts.length}</span>
        </div>
        <div className="card px-4 py-2 flex items-center gap-2">
          <span className="text-xs text-slate-500">Total Open Ports</span>
          <span className="font-display font-700 text-lg text-cyan-DEFAULT">
            {hosts.reduce((s, h) => s + (h.open_ports?.length || 0), 0)}
          </span>
        </div>
      </div>
      {hosts.length === 0 ? (
        <p className="text-xs text-slate-600">No hosts responded.</p>
      ) : (
        <div className="space-y-3">
          {hosts.map((host, i) => (
            <div key={i} className="rounded border border-bg-border overflow-hidden">
              <div className="flex items-center gap-3 px-3 py-2 bg-bg-elevated">
                <span className="text-xs font-mono font-600 text-cyan-DEFAULT">{host.ip}</span>
                {host.hostname && <span className="text-xs text-slate-400">{host.hostname}</span>}
                <span className="ml-auto text-xs text-slate-600">{host.open_port_count ?? host.open_ports?.length ?? 0} open ports</span>
              </div>
              {host.open_ports?.length > 0 && (
                <Table headers={['Port', 'Protocol', 'Service', 'Version']}>
                  {host.open_ports.map((p, j) => (
                    <TR key={j}>
                      <TD><span className="text-xs font-mono text-amber-DEFAULT">{p.port}</span></TD>
                      <TD><span className="text-xs font-mono text-slate-500">{p.protocol}</span></TD>
                      <TD><span className="text-xs font-mono text-slate-300">{p.service || '—'}</span></TD>
                      <TD><span className="text-xs font-mono text-slate-500">{p.version || '—'}</span></TD>
                    </TR>
                  ))}
                </Table>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function PortScanReport({ result, payload }) {
  if (!result) return null
  const { target, ports_scanned, open_ports = [], open_count } = result
  return (
    <div className="space-y-4">
      <div className="flex gap-3 flex-wrap">
        <div className="card px-4 py-2 flex items-center gap-2">
          <span className="text-xs text-slate-500">Target</span>
          <span className="text-xs font-mono text-cyan-DEFAULT">{target}</span>
        </div>
        <div className="card px-4 py-2 flex items-center gap-2">
          <span className="text-xs text-slate-500">Scanned</span>
          <span className="font-display font-700 text-lg text-slate-300">{ports_scanned}</span>
        </div>
        <div className="card px-4 py-2 flex items-center gap-2">
          <span className="text-xs text-slate-500">Open</span>
          <span className="font-display font-700 text-lg text-green-DEFAULT">{open_count ?? open_ports.length}</span>
        </div>
      </div>
      {open_ports.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {open_ports.map(p => (
            <span key={p} className="text-xs font-mono px-2 py-1 rounded bg-bg-base border border-cyan-muted text-cyan-DEFAULT">
              {p}
            </span>
          ))}
        </div>
      ) : (
        <p className="text-xs text-slate-600">No open ports found.</p>
      )}
    </div>
  )
}

function PingSweepReport({ result }) {
  if (!result) return null
  const { network, hosts_checked, hosts_up, alive_hosts = [] } = result
  const downCount = (hosts_checked || 0) - (hosts_up || 0)
  return (
    <div className="space-y-4">
      <div className="flex gap-3 flex-wrap">
        <div className="card px-4 py-2 flex items-center gap-2">
          <span className="text-xs text-slate-500">Network</span>
          <span className="text-xs font-mono text-cyan-DEFAULT">{network}</span>
        </div>
        <div className="card px-4 py-2 flex items-center gap-2">
          <span className="text-xs text-slate-500">Checked</span>
          <span className="font-display font-700 text-lg text-slate-300">{hosts_checked}</span>
        </div>
        <div className="card px-4 py-2 flex items-center gap-2">
          <span className="text-xs text-slate-500">Up</span>
          <span className="font-display font-700 text-lg text-green-DEFAULT">{hosts_up}</span>
        </div>
        <div className="card px-4 py-2 flex items-center gap-2">
          <span className="text-xs text-slate-500">Down</span>
          <span className="font-display font-700 text-lg text-slate-600">{downCount}</span>
        </div>
      </div>
      {alive_hosts.length > 0 && (
        <div>
          <p className="text-xs text-slate-500 mb-2">Responding Hosts</p>
          <div className="flex flex-wrap gap-2">
            {alive_hosts.map(ip => (
              <span key={ip} className="text-xs font-mono px-2 py-1 rounded bg-green-dim border border-green-muted text-green-DEFAULT">
                {ip}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function ArpScanReport({ result }) {
  if (!result) return null
  const { hosts_found, hosts = [] } = result
  return (
    <div className="space-y-4">
      <div className="card px-4 py-2 inline-flex items-center gap-2">
        <span className="text-xs text-slate-500">Hosts Found</span>
        <span className="font-display font-700 text-lg text-cyan-DEFAULT">{hosts_found ?? hosts.length}</span>
      </div>
      {hosts.length > 0 && (
        <Table headers={['IP Address', 'MAC Address', 'Vendor']}>
          {hosts.map((h, i) => (
            <TR key={i}>
              <TD><span className="text-xs font-mono text-cyan-DEFAULT">{h.ip}</span></TD>
              <TD><span className="text-xs font-mono text-slate-400">{h.mac || '—'}</span></TD>
              <TD><span className="text-xs text-slate-300">{h.vendor || '—'}</span></TD>
            </TR>
          ))}
        </Table>
      )}
    </div>
  )
}

function SpeedTestReport({ result }) {
  if (!result) return null
  const { download_mbps, upload_mbps, ping_ms, method, server, isp } = result
  const { label, color } = speedRating(download_mbps)

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3">
        <div className="card p-4 text-center">
          <p className="text-xs text-slate-500 mb-1">Download</p>
          <p className="font-display font-700 text-2xl text-cyan-DEFAULT">
            {download_mbps != null ? download_mbps.toFixed(1) : '—'}
          </p>
          <p className="text-xs text-slate-600">Mbps</p>
        </div>
        <div className="card p-4 text-center">
          <p className="text-xs text-slate-500 mb-1">Upload</p>
          <p className="font-display font-700 text-2xl text-green-DEFAULT">
            {upload_mbps != null ? upload_mbps.toFixed(1) : '—'}
          </p>
          <p className="text-xs text-slate-600">Mbps</p>
        </div>
        <div className="card p-4 text-center">
          <p className="text-xs text-slate-500 mb-1">Latency</p>
          <p className={`font-display font-700 text-2xl ${rttColor(ping_ms)}`}>
            {ping_ms != null ? ping_ms.toFixed(0) : '—'}
          </p>
          <p className="text-xs text-slate-600">ms</p>
        </div>
      </div>
      <div className="flex items-center gap-3 text-xs text-slate-500">
        <span>Rating: <span className={`font-600 ${color}`}>{label}</span></span>
        {method && <span>Method: <span className="font-mono text-slate-400">{method}</span></span>}
        {server && <span>Server: <span className="text-slate-400">{server}</span></span>}
        {isp    && <span>ISP: <span className="text-slate-400">{isp}</span></span>}
      </div>
    </div>
  )
}

function WirelessSurveyReport({ result }) {
  if (!result) return null
  const { interface: iface, networks_found, networks = [] } = result
  return (
    <div className="space-y-4">
      <div className="flex gap-3">
        <div className="card px-4 py-2 flex items-center gap-2">
          <span className="text-xs text-slate-500">Interface</span>
          <span className="text-xs font-mono text-cyan-DEFAULT">{iface || '—'}</span>
        </div>
        <div className="card px-4 py-2 flex items-center gap-2">
          <span className="text-xs text-slate-500">Networks Found</span>
          <span className="font-display font-700 text-lg text-cyan-DEFAULT">{networks_found ?? networks.length}</span>
        </div>
      </div>
      {networks.length > 0 && (
        <Table headers={['SSID', 'BSSID', 'Channel', 'Signal', 'Security']}>
          {networks.map((n, i) => (
            <TR key={i}>
              <TD>
                <span className="text-xs font-mono text-slate-200">{n.ssid || <span className="text-slate-600">(hidden)</span>}</span>
              </TD>
              <TD><span className="text-xs font-mono text-slate-500">{n.bssid || '—'}</span></TD>
              <TD><span className="text-xs font-mono text-slate-400">{n.channel || '—'}</span></TD>
              <TD><SignalBars dbm={n.signal_dbm} /></TD>
              <TD>{encryptionBadge(n.encryption)}</TD>
            </TR>
          ))}
        </Table>
      )}
    </div>
  )
}

function TracerouteReport({ result }) {
  if (!result) return null
  const { target, protocol, hop_count, hops = [] } = result
  return (
    <div className="space-y-4">
      <div className="flex gap-3 flex-wrap">
        <div className="card px-4 py-2 flex items-center gap-2">
          <span className="text-xs text-slate-500">Target</span>
          <span className="text-xs font-mono text-cyan-DEFAULT">{target}</span>
        </div>
        <div className="card px-4 py-2 flex items-center gap-2">
          <span className="text-xs text-slate-500">Protocol</span>
          <span className="text-xs font-mono text-slate-300">{protocol || 'icmp'}</span>
        </div>
        <div className="card px-4 py-2 flex items-center gap-2">
          <span className="text-xs text-slate-500">Hops</span>
          <span className="font-display font-700 text-lg text-slate-300">{hop_count ?? hops.length}</span>
        </div>
      </div>
      <Table headers={['Hop', 'IP / Hostname', 'RTT 1', 'RTT 2', 'RTT 3', 'Avg']}>
        {hops.map((h, i) => (
          <TR key={i}>
            <TD><span className="text-xs font-mono text-slate-500">{h.hop}</span></TD>
            <TD>
              <div>
                <span className="text-xs font-mono text-slate-200">{h.ip || '*'}</span>
                {h.hostname && h.hostname !== h.ip && (
                  <span className="text-xs text-slate-600 ml-2">{h.hostname}</span>
                )}
              </div>
            </TD>
            {[0,1,2].map(ri => (
              <TD key={ri}>
                <span className={`text-xs font-mono ${rttColor(h.rtt_ms?.[ri])}`}>
                  {h.rtt_ms?.[ri] != null ? `${h.rtt_ms[ri]} ms` : '*'}
                </span>
              </TD>
            ))}
            <TD>
              <span className={`text-xs font-mono ${rttColor(h.avg_rtt)}`}>
                {h.avg_rtt != null ? `${h.avg_rtt} ms` : '—'}
              </span>
            </TD>
          </TR>
        ))}
      </Table>
    </div>
  )
}

function MtrReport({ result }) {
  if (!result) return null
  const { target, cycles, hop_count, hops = [], worst_loss, worst_avg_ms } = result
  return (
    <div className="space-y-4">
      <div className="flex gap-3 flex-wrap">
        <div className="card px-4 py-2 flex items-center gap-2">
          <span className="text-xs text-slate-500">Target</span>
          <span className="text-xs font-mono text-cyan-DEFAULT">{target}</span>
        </div>
        <div className="card px-4 py-2 flex items-center gap-2">
          <span className="text-xs text-slate-500">Cycles</span>
          <span className="font-display font-700 text-lg text-slate-300">{cycles}</span>
        </div>
        <div className="card px-4 py-2 flex items-center gap-2">
          <span className="text-xs text-slate-500">Hops</span>
          <span className="font-display font-700 text-lg text-slate-300">{hop_count}</span>
        </div>
        {worst_loss > 0 && (
          <div className="card px-4 py-2 flex items-center gap-2">
            <span className="text-xs text-slate-500">Worst Loss</span>
            <span className={`font-display font-700 text-lg ${lossColor(worst_loss)}`}>{worst_loss}%</span>
          </div>
        )}
      </div>
      <Table headers={['Hop', 'Host', 'Loss%', 'Sent', 'Avg', 'Best', 'Worst', 'StDev']}>
        {hops.map((h, i) => (
          <TR key={i}>
            <TD><span className="text-xs font-mono text-slate-500">{h.hop}</span></TD>
            <TD><span className="text-xs font-mono text-slate-200">{h.ip || h.hostname || '*'}</span></TD>
            <TD>
              <span className={`text-xs font-mono ${lossColor(h.loss_pct)}`}>
                {h.loss_pct != null ? `${h.loss_pct}%` : '—'}
              </span>
            </TD>
            <TD><span className="text-xs font-mono text-slate-500">{h.sent ?? '—'}</span></TD>
            <TD><span className={`text-xs font-mono ${rttColor(h.avg_ms)}`}>{h.avg_ms != null ? `${h.avg_ms}` : '—'}</span></TD>
            <TD><span className="text-xs font-mono text-green-DEFAULT">{h.best_ms != null ? `${h.best_ms}` : '—'}</span></TD>
            <TD><span className="text-xs font-mono text-red-DEFAULT">{h.worst_ms != null ? `${h.worst_ms}` : '—'}</span></TD>
            <TD><span className="text-xs font-mono text-slate-500">{h.stdev_ms != null ? `${h.stdev_ms}` : '—'}</span></TD>
          </TR>
        ))}
      </Table>
    </div>
  )
}

function SysinfoReport({ result }) {
  if (!result) return null
  const uptimeFmt = (s) => {
    if (!s) return '—'
    const d = Math.floor(s / 86400)
    const h = Math.floor((s % 86400) / 3600)
    const m = Math.floor((s % 3600) / 60)
    return [d && `${d}d`, h && `${h}h`, `${m}m`].filter(Boolean).join(' ')
  }

  return (
    <div className="space-y-4">
      {/* Core info */}
      <div className="grid grid-cols-2 gap-3">
        <div className="card p-3 space-y-2">
          <p className="text-xs font-display font-500 text-slate-500 uppercase tracking-wider">System</p>
          {[
            ['Hostname',   result.hostname],
            ['Platform',   result.platform],
            ['Kernel',     result.kernel],
            ['Arch',       result.arch],
            ['CPU Serial', result.cpu_serial],
            ['Uptime',     uptimeFmt(result.uptime_seconds)],
            ['CPU Temp',   result.cpu_temp_c != null ? `${result.cpu_temp_c}°C` : null],
            ['Processes',  result.process_count],
          ].filter(([,v]) => v != null).map(([k,v]) => (
            <div key={k} className="flex justify-between gap-2">
              <span className="text-xs text-slate-600">{k}</span>
              <span className="text-xs font-mono text-slate-300 text-right truncate max-w-[200px]" title={String(v)}>{String(v)}</span>
            </div>
          ))}
        </div>

        <div className="card p-3 space-y-2">
          <p className="text-xs font-display font-500 text-slate-500 uppercase tracking-wider">Memory & Network</p>
          {result.memory && [
            ['Total RAM',  result.memory.total_mb != null ? `${result.memory.total_mb} MB` : null],
            ['Used RAM',   result.memory.used_mb  != null ? `${result.memory.used_mb} MB` : null],
            ['Free RAM',   result.memory.free_mb  != null ? `${result.memory.free_mb} MB` : null],
          ].filter(([,v]) => v).map(([k,v]) => (
            <div key={k} className="flex justify-between gap-2">
              <span className="text-xs text-slate-600">{k}</span>
              <span className="text-xs font-mono text-slate-300">{v}</span>
            </div>
          ))}
          {result.default_gateway && (
            <div className="flex justify-between gap-2">
              <span className="text-xs text-slate-600">Gateway</span>
              <span className="text-xs font-mono text-cyan-DEFAULT">{result.default_gateway}</span>
            </div>
          )}
          {result.dns_servers?.length > 0 && (
            <div className="flex justify-between gap-2">
              <span className="text-xs text-slate-600">DNS</span>
              <span className="text-xs font-mono text-slate-300">{result.dns_servers.join(', ')}</span>
            </div>
          )}
          {result.wifi?.ssid && (
            <div className="flex justify-between gap-2">
              <span className="text-xs text-slate-600">WiFi SSID</span>
              <span className="text-xs font-mono text-slate-300">{result.wifi.ssid}</span>
            </div>
          )}
          {result.wifi?.signal_dbm != null && (
            <div className="flex justify-between gap-2">
              <span className="text-xs text-slate-600">WiFi Signal</span>
              <SignalBars dbm={result.wifi.signal_dbm} />
            </div>
          )}
        </div>
      </div>

      {/* Interfaces */}
      {result.interfaces?.length > 0 && (
        <div>
          <p className="text-xs font-display font-500 text-slate-500 uppercase tracking-wider mb-2">Interfaces</p>
          <Table headers={['Name', 'State', 'MAC', 'Addresses']}>
            {result.interfaces.map((iface, i) => (
              <TR key={i}>
                <TD><span className="text-xs font-mono text-slate-200">{iface.name}</span></TD>
                <TD>
                  <span className={`text-xs font-mono ${iface.state === 'UP' ? 'text-green-DEFAULT' : 'text-slate-500'}`}>
                    {iface.state}
                  </span>
                </TD>
                <TD><span className="text-xs font-mono text-slate-500">{iface.mac || '—'}</span></TD>
                <TD>
                  <div className="flex flex-col gap-0.5">
                    {iface.addresses?.map((a, j) => (
                      <span key={j} className="text-xs font-mono text-cyan-muted">
                        {a.addr}/{a.prefix}
                      </span>
                    ))}
                  </div>
                </TD>
              </TR>
            ))}
          </Table>
        </div>
      )}

      {/* Disk */}
      {result.disk?.length > 0 && (
        <div>
          <p className="text-xs font-display font-500 text-slate-500 uppercase tracking-wider mb-2">Disk</p>
          <div className="space-y-2">
            {result.disk.map((d, i) => {
              const pct = d.used_pct ?? (d.size_mb ? Math.round(d.used_mb / d.size_mb * 100) : 0)
              const barColor = pct > 90 ? 'bg-red-DEFAULT' : pct > 70 ? 'bg-amber-DEFAULT' : 'bg-cyan-DEFAULT'
              return (
                <div key={i} className="card px-3 py-2">
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-xs font-mono text-slate-300">{d.mountpoint || d.device || `Disk ${i+1}`}</span>
                    <span className="text-xs font-mono text-slate-500">
                      {d.used_mb?.toFixed(0)} / {d.size_mb?.toFixed(0)} MB ({pct}%)
                    </span>
                  </div>
                  <div className="h-1.5 bg-bg-base rounded-full overflow-hidden">
                    <div className={`h-full ${barColor} rounded-full`} style={{ width: `${pct}%` }} />
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Shared sub-components ─────────────────────────────────────────────────────

function StatCards({ items }) {
  return (
    <div className="flex gap-3 flex-wrap mb-4">
      {items.filter(i => i.value != null).map(({ label, value, color }, i) => (
        <div key={i} className="card px-4 py-2 flex items-center gap-2">
          <span className="text-xs text-slate-500">{label}</span>
          <span className={`font-display font-700 text-lg ${color || 'text-slate-300'}`}>{value}</span>
        </div>
      ))}
    </div>
  )
}

function SevBadge({ severity }) {
  const cls = {
    critical: 'text-red-DEFAULT bg-red-dim border-red-muted',
    high:     'text-red-DEFAULT bg-red-dim border-red-muted',
    medium:   'text-amber-DEFAULT bg-amber-dim border-amber-muted',
    low:      'text-cyan-DEFAULT bg-cyan-dim border-cyan-muted',
    info:     'text-slate-500 bg-bg-elevated border-bg-border',
  }[severity] || 'text-slate-500 bg-bg-elevated border-bg-border'
  return <span className={`text-xs font-700 uppercase tracking-wide px-1.5 py-0.5 rounded border ${cls}`}>{severity}</span>
}

function FindingsList({ findings = [] }) {
  if (!findings.length) return (
    <p className="text-xs text-green-DEFAULT flex items-center gap-1.5">
      <CheckCircle className="w-3.5 h-3.5" /> No findings — all checks passed
    </p>
  )
  const sevOrder = { critical: 0, high: 1, medium: 2, low: 3, info: 4 }
  const sorted = [...findings].sort((a, b) => (sevOrder[a.severity] ?? 9) - (sevOrder[b.severity] ?? 9))
  return (
    <div className="space-y-2">
      {sorted.map((f, i) => (
        <div key={i} className="rounded border border-bg-border bg-bg-elevated px-3 py-2.5">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <SevBadge severity={f.severity} />
            <span className="text-xs font-500 text-slate-200">{f.title}</span>
            {f.host && <span className="ml-auto text-xs font-mono text-slate-500">{f.host}</span>}
          </div>
          {(f.detail || f.description) && (
            <p className="text-xs text-slate-500 mt-1 leading-relaxed">{f.detail || f.description}</p>
          )}
          {f.cve_id && <span className="text-xs font-mono text-amber-DEFAULT block mt-1">CVE: {f.cve_id}</span>}
        </div>
      ))}
    </div>
  )
}

// ── New report renderers ───────────────────────────────────────────────────────

function HttpMonitorReport({ result }) {
  if (!result) return null
  const { targets_checked, summary = {}, results = [] } = result
  return (
    <div className="space-y-4">
      <StatCards items={[
        { label: 'Checked', value: targets_checked },
        { label: 'Up',      value: summary.up,     color: 'text-green-DEFAULT' },
        { label: 'Down',    value: summary.down,   color: summary.down   > 0 ? 'text-red-DEFAULT'   : 'text-slate-500' },
        { label: 'Errors',  value: summary.errors, color: summary.errors > 0 ? 'text-amber-DEFAULT' : 'text-slate-500' },
      ]} />
      <Table headers={['URL', 'Status', 'Response', 'SSL Days', 'Match']}>
        {results.map((r, i) => (
          <TR key={i}>
            <TD><span className="text-xs font-mono text-slate-300 break-all">{r.url}</span></TD>
            <TD>
              <span className={`text-xs font-mono font-600 ${r.up ? 'text-green-DEFAULT' : 'text-red-DEFAULT'}`}>
                {r.status_code ?? (r.status === 'error' ? 'ERR' : '—')}
              </span>
            </TD>
            <TD>
              <span className={`text-xs font-mono ${rttColor(r.response_ms)}`}>
                {r.response_ms != null ? `${r.response_ms}ms` : '—'}
              </span>
            </TD>
            <TD>
              {r.ssl?.days_remaining != null ? (
                <span className={`text-xs font-mono ${r.ssl.days_remaining < 14 ? 'text-red-DEFAULT' : r.ssl.days_remaining < 30 ? 'text-amber-DEFAULT' : 'text-green-DEFAULT'}`}>
                  {r.ssl.days_remaining}d
                </span>
              ) : <span className="text-xs text-slate-600">—</span>}
            </TD>
            <TD>
              {r.content_match != null
                ? <span className={`text-xs font-mono ${r.content_match ? 'text-green-DEFAULT' : 'text-red-DEFAULT'}`}>{r.content_match ? '✓' : '✗'}</span>
                : <span className="text-xs text-slate-600">—</span>}
            </TD>
          </TR>
        ))}
      </Table>
    </div>
  )
}

function NtpCheckReport({ result }) {
  if (!result) return null
  const statusColor = result.status === 'ok' ? 'text-green-DEFAULT' : result.status === 'drifted' ? 'text-amber-DEFAULT' : 'text-red-DEFAULT'
  return (
    <div className="space-y-4">
      <StatCards items={[
        { label: 'Status',     value: result.status?.toUpperCase(), color: statusColor },
        { label: 'Avg Offset', value: result.avg_offset_ms != null ? `${result.avg_offset_ms}ms` : null, color: rttColor(result.avg_offset_ms) },
        { label: 'Threshold',  value: `${result.warn_offset_ms}ms` },
      ]} />
      {result.local_sync && (
        <div className="card px-4 py-3 space-y-1.5">
          <p className="text-xs font-display font-500 text-slate-500 uppercase tracking-wider mb-2">Local Sync</p>
          <div className="flex gap-2 text-xs">
            <span className="text-slate-600 w-28">Synchronized</span>
            <span className={result.local_sync.synchronized ? 'text-green-DEFAULT' : 'text-red-DEFAULT'}>
              {result.local_sync.synchronized ? 'Yes' : 'No'}
            </span>
          </div>
          {result.local_sync.source && (
            <div className="flex gap-2 text-xs"><span className="text-slate-600 w-28">Source</span><span className="font-mono text-slate-300">{result.local_sync.source}</span></div>
          )}
          {result.local_sync.offset_ms != null && (
            <div className="flex gap-2 text-xs"><span className="text-slate-600 w-28">Offset</span><span className={`font-mono ${rttColor(result.local_sync.offset_ms)}`}>{result.local_sync.offset_ms}ms</span></div>
          )}
        </div>
      )}
      {result.server_results?.length > 0 && (
        <Table headers={['NTP Server', 'Reachable', 'RTT (ms)', 'Offset (ms)', 'Stratum']}>
          {result.server_results.map((s, i) => (
            <TR key={i}>
              <TD><span className="text-xs font-mono text-slate-300">{s.server}</span></TD>
              <TD><span className={`text-xs font-mono ${s.reachable ? 'text-green-DEFAULT' : 'text-red-DEFAULT'}`}>{s.reachable ? '✓' : '✗'}</span></TD>
              <TD><span className={`text-xs font-mono ${rttColor(s.rtt_ms)}`}>{s.rtt_ms ?? '—'}</span></TD>
              <TD><span className="text-xs font-mono text-slate-400">{s.offset_ms ?? '—'}</span></TD>
              <TD><span className="text-xs font-mono text-slate-500">{s.stratum ?? '—'}</span></TD>
            </TR>
          ))}
        </Table>
      )}
    </div>
  )
}

function DnsLookupReport({ result }) {
  if (!result) return null
  const { target, nameserver, records = {}, errors = {}, zone_transfer } = result
  const recordEntries = Object.entries(records)
  return (
    <div className="space-y-4">
      <StatCards items={[
        { label: 'Target',              value: target,                color: 'text-cyan-DEFAULT' },
        { label: 'Nameserver',          value: nameserver },
        { label: 'Record types found',  value: recordEntries.length,  color: recordEntries.length > 0 ? 'text-green-DEFAULT' : 'text-slate-500' },
      ]} />
      {recordEntries.length > 0 ? (
        <div className="space-y-3">
          {recordEntries.map(([rtype, recs]) => (
            <div key={rtype} className="rounded border border-bg-border overflow-hidden">
              <div className="px-3 py-1.5 bg-bg-elevated flex items-center gap-2">
                <span className="text-xs font-mono font-600 text-cyan-DEFAULT">{rtype}</span>
                <span className="text-xs text-slate-600">{recs.length} record{recs.length !== 1 ? 's' : ''}</span>
              </div>
              <Table headers={['Name', 'TTL', 'Value']}>
                {recs.map((r, i) => (
                  <TR key={i}>
                    <TD><span className="text-xs font-mono text-slate-400">{r.name || '—'}</span></TD>
                    <TD><span className="text-xs font-mono text-slate-600">{r.ttl}s</span></TD>
                    <TD><span className="text-xs font-mono text-slate-200 break-all">{r.value}</span></TD>
                  </TR>
                ))}
              </Table>
            </div>
          ))}
        </div>
      ) : <p className="text-xs text-slate-600">No records found.</p>}
      {Object.keys(errors).length > 0 && (
        <div className="space-y-1">
          <p className="text-xs text-slate-500">Errors</p>
          {Object.entries(errors).map(([t, e]) => (
            <p key={t} className="text-xs font-mono text-red-DEFAULT">{t}: {e}</p>
          ))}
        </div>
      )}
      {zone_transfer && (
        <div className="card px-4 py-3">
          <p className="text-xs font-display font-500 text-slate-500 uppercase tracking-wider mb-2">Zone Transfer</p>
          <div className="flex gap-4 text-xs">
            <span className="text-slate-600">Server: <span className="font-mono text-slate-400">{zone_transfer.nameserver}</span></span>
            <span className={`font-600 ${zone_transfer.success ? 'text-red-DEFAULT' : 'text-green-DEFAULT'}`}>
              {zone_transfer.success ? '⚠ Successful (vulnerability!)' : 'Refused (expected)'}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}

function IperfReport({ result }) {
  if (!result) return null
  const isTcp = result.protocol === 'tcp'
  return (
    <div className="space-y-4">
      <StatCards items={[
        { label: 'Protocol',  value: result.protocol?.toUpperCase() },
        { label: 'Direction', value: result.direction },
        { label: 'Duration',  value: result.duration_s != null ? `${result.duration_s}s` : null },
      ]} />
      {isTcp ? (
        <div className="grid grid-cols-3 gap-3">
          <div className="card p-4 text-center">
            <p className="text-xs text-slate-500 mb-1">Sent</p>
            <p className="font-display font-700 text-2xl text-cyan-DEFAULT">{result.mbps_sent?.toFixed(1) ?? '—'}</p>
            <p className="text-xs text-slate-600">Mbps</p>
          </div>
          <div className="card p-4 text-center">
            <p className="text-xs text-slate-500 mb-1">Received</p>
            <p className="font-display font-700 text-2xl text-green-DEFAULT">{result.mbps_received?.toFixed(1) ?? '—'}</p>
            <p className="text-xs text-slate-600">Mbps</p>
          </div>
          <div className="card p-4 text-center">
            <p className="text-xs text-slate-500 mb-1">Retransmits</p>
            <p className={`font-display font-700 text-2xl ${result.retransmits > 0 ? 'text-amber-DEFAULT' : 'text-green-DEFAULT'}`}>{result.retransmits ?? '—'}</p>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-3">
          <div className="card p-4 text-center">
            <p className="text-xs text-slate-500 mb-1">Throughput</p>
            <p className="font-display font-700 text-2xl text-cyan-DEFAULT">{result.mbps?.toFixed(1) ?? '—'}</p>
            <p className="text-xs text-slate-600">Mbps</p>
          </div>
          <div className="card p-4 text-center">
            <p className="text-xs text-slate-500 mb-1">Jitter</p>
            <p className={`font-display font-700 text-2xl ${rttColor(result.jitter_ms)}`}>{result.jitter_ms?.toFixed(2) ?? '—'}</p>
            <p className="text-xs text-slate-600">ms</p>
          </div>
          <div className="card p-4 text-center">
            <p className="text-xs text-slate-500 mb-1">Packet Loss</p>
            <p className={`font-display font-700 text-2xl ${lossColor(result.loss_pct)}`}>{result.loss_pct != null ? `${result.loss_pct}%` : '—'}</p>
          </div>
        </div>
      )}
    </div>
  )
}

function BannerGrabReport({ result }) {
  if (!result) return null
  const { targets_tried, banners_found, results = [] } = result
  return (
    <div className="space-y-4">
      <StatCards items={[
        { label: 'Targets',       value: targets_tried },
        { label: 'Banners Found', value: banners_found, color: banners_found > 0 ? 'text-cyan-DEFAULT' : 'text-slate-500' },
      ]} />
      <Table headers={['Host', 'Port', 'Status', 'Service', 'Banner']}>
        {results.map((r, i) => (
          <TR key={i}>
            <TD><span className="text-xs font-mono text-cyan-DEFAULT">{r.host}</span></TD>
            <TD><span className="text-xs font-mono text-amber-DEFAULT">{r.port}</span></TD>
            <TD>
              <span className={`text-xs font-mono ${r.open ? 'text-green-DEFAULT' : 'text-red-DEFAULT'}`}>
                {r.open ? 'Open' : r.error || 'Closed'}
              </span>
            </TD>
            <TD><span className="text-xs font-mono text-slate-400">{r.service || '—'}</span></TD>
            <TD>
              <span className="text-xs font-mono text-slate-500 break-all">
                {r.banner ? r.banner.slice(0, 80) + (r.banner.length > 80 ? '…' : '') : '—'}
              </span>
            </TD>
          </TR>
        ))}
      </Table>
    </div>
  )
}

function PacketCaptureReport({ result }) {
  if (!result) return null
  const { interface: iface, duration_s, filter, packet_count, protocol_breakdown = {}, top_conversations = [] } = result
  const protocols = Object.entries(protocol_breakdown)
    .sort((a, b) => b[1].frames - a[1].frames)
    .slice(0, 15)
  return (
    <div className="space-y-4">
      <StatCards items={[
        { label: 'Interface', value: iface,      color: 'text-cyan-DEFAULT' },
        { label: 'Duration',  value: `${duration_s}s` },
        { label: 'Filter',    value: filter !== 'none' ? filter : null },
        { label: 'Packets',   value: packet_count },
      ]} />
      {protocols.length > 0 && (
        <div>
          <p className="text-xs font-display font-500 text-slate-500 uppercase tracking-wider mb-2">Protocol Breakdown</p>
          <Table headers={['Protocol', 'Frames', 'Bytes']}>
            {protocols.map(([proto, data]) => (
              <TR key={proto}>
                <TD><span className="text-xs font-mono text-slate-200">{proto}</span></TD>
                <TD><span className="text-xs font-mono text-cyan-DEFAULT">{data.frames.toLocaleString()}</span></TD>
                <TD><span className="text-xs font-mono text-slate-400">{(data.bytes / 1024).toFixed(1)} KB</span></TD>
              </TR>
            ))}
          </Table>
        </div>
      )}
      {top_conversations.length > 0 && (
        <div>
          <p className="text-xs font-display font-500 text-slate-500 uppercase tracking-wider mb-2">Top Conversations</p>
          <Table headers={['Source', 'Destination', 'Frames →', 'Frames ←', 'Total']}>
            {top_conversations.map((c, i) => (
              <TR key={i}>
                <TD><span className="text-xs font-mono text-cyan-DEFAULT">{c.src}</span></TD>
                <TD><span className="text-xs font-mono text-slate-300">{c.dst}</span></TD>
                <TD><span className="text-xs font-mono text-slate-500">{c.frames_a_b}</span></TD>
                <TD><span className="text-xs font-mono text-slate-500">{c.frames_b_a}</span></TD>
                <TD><span className="text-xs font-mono text-slate-400">{(c.total_bytes / 1024).toFixed(1)} KB</span></TD>
              </TR>
            ))}
          </Table>
        </div>
      )}
    </div>
  )
}

function SnmpReport({ result }) {
  if (!result) return null
  const { target, version, sysinfo = {}, interfaces = [], storage = [], custom = {} } = result
  return (
    <div className="space-y-4">
      <StatCards items={[
        { label: 'Target',  value: target,       color: 'text-cyan-DEFAULT' },
        { label: 'Version', value: `v${version}` },
      ]} />
      {Object.keys(sysinfo).length > 0 && (
        <div className="card p-3 space-y-2">
          <p className="text-xs font-display font-500 text-slate-500 uppercase tracking-wider">Device Info</p>
          {Object.entries(sysinfo).map(([k, v]) => (
            <div key={k} className="flex gap-2 text-xs">
              <span className="text-slate-600 w-28 shrink-0">{k}</span>
              <span className="font-mono text-slate-300 break-all">{v}</span>
            </div>
          ))}
        </div>
      )}
      {interfaces.length > 0 && (
        <div>
          <p className="text-xs font-display font-500 text-slate-500 uppercase tracking-wider mb-2">Interfaces</p>
          <Table headers={['Index', 'Name', 'Type', 'Speed', 'Status', 'MAC']}>
            {interfaces.map((iface, i) => (
              <TR key={i}>
                <TD><span className="text-xs font-mono text-slate-600">{iface.index}</span></TD>
                <TD><span className="text-xs font-mono text-slate-200">{iface.name || '—'}</span></TD>
                <TD><span className="text-xs font-mono text-slate-500">{iface.type || '—'}</span></TD>
                <TD><span className="text-xs font-mono text-slate-400">{iface.speed_mbps != null ? `${iface.speed_mbps} Mbps` : '—'}</span></TD>
                <TD>
                  <span className={`text-xs font-mono ${iface.status === 'up' ? 'text-green-DEFAULT' : 'text-slate-500'}`}>
                    {iface.status || '—'}
                  </span>
                </TD>
                <TD><span className="text-xs font-mono text-slate-600">{iface.mac || '—'}</span></TD>
              </TR>
            ))}
          </Table>
        </div>
      )}
      {storage.length > 0 && (
        <div>
          <p className="text-xs font-display font-500 text-slate-500 uppercase tracking-wider mb-2">Storage</p>
          <div className="space-y-2">
            {storage.map((s, i) => {
              const barColor = s.used_pct > 90 ? 'bg-red-DEFAULT' : s.used_pct > 70 ? 'bg-amber-DEFAULT' : 'bg-cyan-DEFAULT'
              return (
                <div key={i} className="card px-3 py-2">
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-xs font-mono text-slate-300">{s.description || `Storage ${i + 1}`}</span>
                    <span className="text-xs font-mono text-slate-500">{s.used_mb?.toFixed(0)} / {s.size_mb?.toFixed(0)} MB ({s.used_pct}%)</span>
                  </div>
                  <div className="h-1.5 bg-bg-base rounded-full overflow-hidden">
                    <div className={`h-full ${barColor} rounded-full`} style={{ width: `${s.used_pct}%` }} />
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
      {Object.keys(custom).length > 0 && (
        <div>
          <p className="text-xs font-display font-500 text-slate-500 uppercase tracking-wider mb-2">Custom OIDs</p>
          <div className="space-y-1">
            {Object.entries(custom).map(([oid, val]) => (
              <div key={oid} className="flex gap-3 text-xs">
                <span className="font-mono text-slate-600">{oid}</span>
                <span className="font-mono text-slate-300">{val || '—'}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function NetbiosScanReport({ result }) {
  if (!result) return null
  const { hosts_queried, hosts_found, hosts = [] } = result
  const found = hosts.filter(h => h.names?.length || h.hostname)
  return (
    <div className="space-y-4">
      <StatCards items={[
        { label: 'Queried', value: hosts_queried },
        { label: 'Found',   value: hosts_found ?? found.length, color: 'text-cyan-DEFAULT' },
      ]} />
      {found.length > 0 ? (
        <Table headers={['IP', 'Hostname', 'Workgroup', 'MAC', 'DC']}>
          {found.map((h, i) => (
            <TR key={i}>
              <TD><span className="text-xs font-mono text-cyan-DEFAULT">{h.ip}</span></TD>
              <TD><span className="text-xs font-mono text-slate-200">{h.hostname || '—'}</span></TD>
              <TD><span className="text-xs font-mono text-slate-400">{h.workgroup || '—'}</span></TD>
              <TD><span className="text-xs font-mono text-slate-600">{h.mac || '—'}</span></TD>
              <TD>
                {h.is_dc
                  ? <span className="text-xs font-mono text-amber-DEFAULT font-600">DC</span>
                  : <span className="text-xs text-slate-600">—</span>}
              </TD>
            </TR>
          ))}
        </Table>
      ) : <p className="text-xs text-slate-600">No NetBIOS responses received.</p>}
    </div>
  )
}

function LldpReport({ result }) {
  if (!result) return null
  const { neighbors = [], interface: iface, duration_s } = result
  return (
    <div className="space-y-4">
      <StatCards items={[
        { label: 'Interface',   value: iface, color: 'text-cyan-DEFAULT' },
        { label: 'Listen time', value: `${duration_s}s` },
        { label: 'Neighbors',   value: neighbors.length, color: neighbors.length > 0 ? 'text-green-DEFAULT' : 'text-slate-500' },
      ]} />
      {neighbors.length === 0 ? (
        <p className="text-xs text-slate-600">No LLDP/CDP frames received. Ensure the upstream switch has LLDP enabled.</p>
      ) : (
        <div className="space-y-3">
          {neighbors.map((nb, i) => (
            <div key={i} className="rounded border border-bg-border overflow-hidden">
              <div className="flex items-center gap-3 px-3 py-2 bg-bg-elevated">
                <span className="text-xs font-mono font-600 text-slate-200">{nb.system_name || nb.device_id || 'Unknown'}</span>
                <span className="text-xs font-mono text-slate-600">{nb.protocol}</span>
              </div>
              <div className="px-3 py-2 space-y-1.5">
                {[
                  ['Port',         nb.port_id],
                  ['Port desc',    nb.port_description],
                  ['Description',  nb.system_description],
                  ['Mgmt IP',      nb.mgmt_address],
                  ['Chassis ID',   nb.chassis_id],
                  ['Capabilities', nb.capabilities?.join(', ')],
                ].filter(([, v]) => v).map(([k, v]) => (
                  <div key={k} className="flex gap-3 text-xs">
                    <span className="text-slate-600 w-24 shrink-0">{k}</span>
                    <span className="font-mono text-slate-300 break-all">{v}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function WolReport({ result }) {
  if (!result) return null
  const { targets, sent, results = [] } = result
  return (
    <div className="space-y-4">
      <StatCards items={[
        { label: 'Targets', value: targets },
        { label: 'Sent',    value: sent, color: 'text-green-DEFAULT' },
      ]} />
      {results.length > 0 && (
        <Table headers={['MAC Address', 'Broadcast', 'Sent', 'Packets']}>
          {results.map((r, i) => (
            <TR key={i}>
              <TD><span className="text-xs font-mono text-slate-200">{r.mac}</span></TD>
              <TD><span className="text-xs font-mono text-slate-500">{r.broadcast || '—'}</span></TD>
              <TD>
                <span className={`text-xs font-mono ${r.sent ? 'text-green-DEFAULT' : 'text-red-DEFAULT'}`}>
                  {r.sent ? '✓' : '✗'}
                </span>
              </TD>
              <TD><span className="text-xs font-mono text-slate-400">{r.packets_sent ?? r.error ?? '—'}</span></TD>
            </TR>
          ))}
        </Table>
      )}
    </div>
  )
}

function SslCheckReport({ result }) {
  if (!result) return null
  const { results = [] } = result
  const expired  = results.filter(r => r.status === 'expired').length
  const expiring = results.filter(r => r.status === 'expiring_soon').length
  const ok       = results.filter(r => r.status === 'ok').length
  return (
    <div className="space-y-4">
      <StatCards items={[
        { label: 'Checked',  value: results.length },
        { label: 'OK',       value: ok,      color: 'text-green-DEFAULT' },
        { label: 'Expiring', value: expiring, color: expiring > 0 ? 'text-amber-DEFAULT' : 'text-slate-500' },
        { label: 'Expired',  value: expired,  color: expired  > 0 ? 'text-red-DEFAULT'   : 'text-slate-500' },
      ]} />
      <Table headers={['Host', 'Status', 'Days Left', 'Expires', 'Issuer']}>
        {results.map((r, i) => (
          <TR key={i}>
            <TD><span className="text-xs font-mono text-slate-200">{r.host}</span></TD>
            <TD>
              <span className={`text-xs font-mono font-600 ${
                r.status === 'expired' ? 'text-red-DEFAULT' :
                r.status === 'expiring_soon' ? 'text-amber-DEFAULT' :
                r.status === 'ok' ? 'text-green-DEFAULT' : 'text-slate-500'
              }`}>{r.status?.toUpperCase() || '—'}</span>
            </TD>
            <TD>
              <span className={`text-xs font-mono ${r.days_remaining < 0 ? 'text-red-DEFAULT' : r.days_remaining < 30 ? 'text-amber-DEFAULT' : 'text-green-DEFAULT'}`}>
                {r.days_remaining != null ? `${r.days_remaining}d` : '—'}
              </span>
            </TD>
            <TD><span className="text-xs font-mono text-slate-500">{r.expires_at?.slice(0, 10) || '—'}</span></TD>
            <TD><span className="text-xs font-mono text-slate-400 truncate max-w-[200px]" title={r.issuer || r.error}>{r.issuer || r.error || '—'}</span></TD>
          </TR>
        ))}
      </Table>
    </div>
  )
}

function DnsHealthReport({ result }) {
  if (!result) return null
  const { domain, findings = [] } = result
  return (
    <div className="space-y-4">
      <StatCards items={[
        { label: 'Domain',   value: domain, color: 'text-cyan-DEFAULT' },
        { label: 'Findings', value: findings.length, color: findings.length > 0 ? 'text-amber-DEFAULT' : 'text-green-DEFAULT' },
      ]} />
      <FindingsList findings={findings} />
    </div>
  )
}

function SecurityAuditReport({ result }) {
  if (!result) return null
  const { targets_checked, findings_count, findings = [] } = result
  const critical = findings.filter(f => f.severity === 'critical').length
  const high     = findings.filter(f => f.severity === 'high').length
  return (
    <div className="space-y-4">
      <StatCards items={[
        { label: 'Targets',  value: targets_checked },
        { label: 'Findings', value: findings_count ?? findings.length, color: (findings_count || findings.length) > 0 ? 'text-amber-DEFAULT' : 'text-green-DEFAULT' },
        { label: 'Critical', value: critical, color: critical > 0 ? 'text-red-DEFAULT'   : 'text-slate-500' },
        { label: 'High',     value: high,     color: high     > 0 ? 'text-amber-DEFAULT' : 'text-slate-500' },
      ]} />
      <FindingsList findings={findings} />
    </div>
  )
}

function DefaultCredsReport({ result }) {
  if (!result) return null
  const { targets_checked, findings_count, findings = [] } = result
  return (
    <div className="space-y-4">
      <StatCards items={[
        { label: 'Targets',  value: targets_checked },
        { label: 'Findings', value: findings_count ?? findings.length, color: (findings_count || findings.length) > 0 ? 'text-red-DEFAULT' : 'text-green-DEFAULT' },
      ]} />
      <FindingsList findings={findings} />
    </div>
  )
}

function CleartextServicesReport({ result }) {
  if (!result) return null
  const { targets_checked, findings_count, findings = [] } = result
  return (
    <div className="space-y-4">
      <StatCards items={[
        { label: 'Targets',  value: targets_checked },
        { label: 'Findings', value: findings_count ?? findings.length, color: (findings_count || findings.length) > 0 ? 'text-red-DEFAULT' : 'text-green-DEFAULT' },
      ]} />
      <FindingsList findings={findings} />
    </div>
  )
}

function SmbEnumReport({ result }) {
  if (!result) return null
  const { targets_checked, findings_count, findings = [], results = [] } = result
  return (
    <div className="space-y-4">
      <StatCards items={[
        { label: 'Targets',  value: targets_checked },
        { label: 'Findings', value: findings_count ?? findings.length, color: (findings_count || findings.length) > 0 ? 'text-amber-DEFAULT' : 'text-green-DEFAULT' },
      ]} />
      {results.map((host, i) => (
        <div key={i} className="rounded border border-bg-border overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-2 bg-bg-elevated">
            <span className="text-xs font-mono font-600 text-cyan-DEFAULT">{host.host}</span>
            <span className="text-xs text-slate-600">{host.shares?.length ?? 0} shares</span>
          </div>
          {host.shares?.length > 0 && (
            <Table headers={['Share', 'Type', 'Comment', 'Access']}>
              {host.shares.map((s, j) => (
                <TR key={j}>
                  <TD><span className="text-xs font-mono text-slate-200">{s.name}</span></TD>
                  <TD><span className="text-xs font-mono text-slate-500">{s.type || '—'}</span></TD>
                  <TD><span className="text-xs text-slate-400">{s.comment || '—'}</span></TD>
                  <TD>
                    <span className={`text-xs font-mono ${s.access && s.access !== 'DENIED' ? 'text-amber-DEFAULT' : 'text-slate-500'}`}>
                      {s.access || '—'}
                    </span>
                  </TD>
                </TR>
              ))}
            </Table>
          )}
        </div>
      ))}
      <FindingsList findings={findings} />
    </div>
  )
}

function EmailBreachReport({ result }) {
  if (!result) return null
  const { domain, breaches_found, total_accounts, sensitive_breaches, severity, breaches = [] } = result
  const sevColor = { critical: 'text-red-DEFAULT', high: 'text-red-DEFAULT', medium: 'text-amber-DEFAULT', low: 'text-cyan-DEFAULT', info: 'text-slate-500' }
  return (
    <div className="space-y-4">
      <StatCards items={[
        { label: 'Domain',           value: domain,                         color: 'text-cyan-DEFAULT' },
        { label: 'Breaches',         value: breaches_found,                 color: breaches_found > 0 ? (sevColor[severity] || 'text-amber-DEFAULT') : 'text-green-DEFAULT' },
        { label: 'Accounts Exposed', value: total_accounts?.toLocaleString(), color: total_accounts > 0 ? (sevColor[severity] || 'text-amber-DEFAULT') : 'text-slate-500' },
        { label: 'Sensitive',        value: sensitive_breaches,             color: sensitive_breaches > 0 ? 'text-red-DEFAULT' : 'text-slate-500' },
      ]} />
      {breaches_found === 0 ? (
        <p className="text-xs text-green-DEFAULT flex items-center gap-1.5">
          <CheckCircle className="w-3.5 h-3.5" /> No breaches found for {domain}
        </p>
      ) : (
        <Table headers={['Breach', 'Date', 'Accounts', 'Data Types', 'Verified', 'Sensitive']}>
          {breaches.map((b, i) => (
            <TR key={i}>
              <TD>
                <div>
                  <span className="text-xs font-mono text-slate-200">{b.title || b.name}</span>
                  {b.domain && <span className="text-xs text-slate-600 ml-2">{b.domain}</span>}
                </div>
              </TD>
              <TD><span className="text-xs font-mono text-slate-500">{b.breach_date || '—'}</span></TD>
              <TD><span className="text-xs font-mono text-amber-DEFAULT">{b.pwn_count?.toLocaleString() ?? '—'}</span></TD>
              <TD>
                <div className="flex flex-wrap gap-1">
                  {(b.data_classes || []).slice(0, 3).map(dc => (
                    <span key={dc} className="text-xs font-mono px-1 rounded bg-bg-base border border-bg-border text-slate-500">{dc}</span>
                  ))}
                  {(b.data_classes?.length || 0) > 3 && (
                    <span className="text-xs text-slate-600">+{b.data_classes.length - 3}</span>
                  )}
                </div>
              </TD>
              <TD><span className={`text-xs font-mono ${b.is_verified ? 'text-amber-DEFAULT' : 'text-slate-600'}`}>{b.is_verified ? '✓' : '—'}</span></TD>
              <TD><span className={`text-xs font-mono ${b.is_sensitive ? 'text-red-DEFAULT' : 'text-slate-600'}`}>{b.is_sensitive ? '⚠' : '—'}</span></TD>
            </TR>
          ))}
        </Table>
      )}
    </div>
  )
}

function VulnScanReport({ result }) {
  if (!result) return null
  const hosts = result.hosts || []
  const allFindings = hosts.flatMap(h => (h.findings || []).map(f => ({ ...f, _host: h.ip })))
  const critical = allFindings.filter(f => f.severity === 'critical').length
  const high     = allFindings.filter(f => f.severity === 'high').length
  const medium   = allFindings.filter(f => f.severity === 'medium').length
  return (
    <div className="space-y-4">
      <StatCards items={[
        { label: 'Hosts',    value: hosts.length },
        { label: 'Findings', value: allFindings.length, color: allFindings.length > 0 ? 'text-amber-DEFAULT' : 'text-green-DEFAULT' },
        { label: 'Critical', value: critical, color: critical > 0 ? 'text-red-DEFAULT'   : 'text-slate-500' },
        { label: 'High',     value: high,     color: high     > 0 ? 'text-amber-DEFAULT' : 'text-slate-500' },
        { label: 'Medium',   value: medium,   color: medium   > 0 ? 'text-amber-DEFAULT' : 'text-slate-500' },
      ]} />
      {hosts.length === 0 && <p className="text-xs text-slate-600">No hosts scanned.</p>}
      {hosts.map((host, i) => (
        <div key={i} className="rounded border border-bg-border overflow-hidden">
          <div className="flex items-center gap-3 px-3 py-2 bg-bg-elevated">
            <span className="text-xs font-mono font-600 text-cyan-DEFAULT">{host.ip}</span>
            {host.hostname && <span className="text-xs text-slate-400">{host.hostname}</span>}
            {host.os && <span className="text-xs font-mono text-slate-500">{host.os}</span>}
            <span className="ml-auto text-xs text-slate-600">{host.findings?.length ?? 0} findings</span>
          </div>
          {host.findings?.length > 0 && (
            <div className="px-3 py-3">
              <FindingsList findings={host.findings} />
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

function AdDiscoverReport({ result }) {
  if (!result) return null
  const { targets_scanned, dc_candidates, domain_name, domain_controllers = [], recommendation } = result
  return (
    <div className="space-y-4">
      <StatCards items={[
        { label: 'Targets Scanned', value: targets_scanned },
        { label: 'DC Candidates',   value: dc_candidates ?? domain_controllers.length, color: (dc_candidates || domain_controllers.length) > 0 ? 'text-cyan-DEFAULT' : 'text-slate-500' },
        { label: 'Domain',          value: domain_name, color: 'text-amber-DEFAULT' },
      ]} />
      {recommendation && (
        <div className="card px-4 py-3 text-xs text-slate-400 leading-relaxed">{recommendation}</div>
      )}
      {domain_controllers.length > 0 && (
        <Table headers={['IP', 'NetBIOS Name', 'Domain', 'DC Score', 'OS', 'Confidence']}>
          {domain_controllers.map((dc, i) => (
            <TR key={i}>
              <TD><span className="text-xs font-mono text-cyan-DEFAULT">{dc.ip}</span></TD>
              <TD><span className="text-xs font-mono text-slate-200">{dc.netbios_name || '—'}</span></TD>
              <TD><span className="text-xs font-mono text-slate-400">{dc.domain || '—'}</span></TD>
              <TD>
                <span className={`text-xs font-mono font-600 ${dc.dc_score >= 6 ? 'text-green-DEFAULT' : dc.dc_score >= 3 ? 'text-amber-DEFAULT' : 'text-slate-500'}`}>
                  {dc.dc_score}
                </span>
              </TD>
              <TD><span className="text-xs font-mono text-slate-500">{dc.os || '—'}</span></TD>
              <TD>
                <span className={`text-xs font-mono ${dc.confidence === 'confirmed' ? 'text-green-DEFAULT' : dc.confidence === 'likely' ? 'text-amber-DEFAULT' : 'text-slate-500'}`}>
                  {dc.confidence || '—'}
                </span>
              </TD>
            </TR>
          ))}
        </Table>
      )}
      {domain_controllers.length === 0 && <p className="text-xs text-slate-600">No domain controllers detected.</p>}
    </div>
  )
}

function WindowsProbeReport({ result, payload, deviceId }) {
  const [bulkState, setBulkState] = useState(null) // null | 'loading' | {computers, queued, skipped} | 'error'
  const [bulkMsg,   setBulkMsg]   = useState('')

  if (!result) return null
  if (result.error) return <p className="text-xs text-red-DEFAULT font-mono">{result.error}</p>

  const {
    hostname, os_caption, os_build, domain, domain_joined,
    total_ram_gb, free_ram_gb, ram_pct,
    cpu_name, cpu_cores, uptime_seconds,
    disks = [], adapters = [], services = [], local_users = [], local_admins = [],
    installed_software = [], hotfix_count, last_hotfix_kb,
    firewall, rdp_enabled, rdp_nla, smb_v1,
    defender_enabled, defender_rtp, defender_sig_age,
    uac_enabled, autologon_enabled, autologon_user,
    findings = [], target,
  } = result

  const isDC = domain_joined && services.some(s => s.name === 'Netlogon' && s.status === 'Running')

  const probeAllDomainComputers = async () => {
    if (!deviceId) { setBulkMsg('No agent device ID available.'); return }
    setBulkState('loading')
    setBulkMsg('')
    try {
      const tasks = await api.getAllTasks({ task_type: 'run_ad_recon', status: 'completed' })
      const recon = tasks[0]
      if (!recon?.result) { setBulkState('error'); setBulkMsg('No completed AD Recon found — run AD Recon first.'); return }
      const computers = (recon.result.computers?.list || []).filter(c => c.enabled && (c.dns_hostname || c.name))
      if (!computers.length) { setBulkState('error'); setBulkMsg('No enabled computers found in AD Recon result.'); return }
      let queued = 0, skipped = 0
      for (const comp of computers) {
        const t = comp.dns_hostname || comp.name
        if (!t) { skipped++; continue }
        try {
          await api.issueTask(deviceId, {
            task_type: 'run_windows_probe',
            payload: { target: t, username: payload?.username || '', password: payload?.password || '', port: payload?.port || 5985 },
          })
          queued++
        } catch { skipped++ }
      }
      setBulkState({ computers: computers.length, queued, skipped })
    } catch (e) {
      setBulkState('error')
      setBulkMsg(e.message || 'Failed to queue probes.')
    }
  }

  const uptimeFmt = (s) => {
    if (!s) return '—'
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60)
    return [d && `${d}d`, h && `${h}h`, `${m}m`].filter(Boolean).join(' ')
  }

  const boolBadge = (val, trueLabel = 'Yes', falseLabel = 'No') => {
    if (val === null || val === undefined) return <span className="text-slate-600">—</span>
    return val
      ? <span className="text-green-DEFAULT">{trueLabel}</span>
      : <span className="text-red-DEFAULT">{falseLabel}</span>
  }

  const fwProfiles = Object.entries(firewall || {})
  const critFindings = findings.filter(f => f.severity === 'critical').length
  const highFindings = findings.filter(f => f.severity === 'high').length

  return (
    <div className="space-y-5">
      {/* Connection info */}
      {payload && (
        <div className="card px-4 py-3">
          <div className="flex items-center justify-between mb-3">
            <p className="text-xs font-display font-600 text-slate-400">Connection</p>
            {isDC && deviceId && (
              <button
                onClick={probeAllDomainComputers}
                disabled={bulkState === 'loading'}
                className="text-xs px-3 py-1 rounded bg-blue-600/20 text-blue-400 border border-blue-500/30 hover:bg-blue-600/30 transition-colors disabled:opacity-50"
              >
                {bulkState === 'loading' ? 'Queueing…' : 'Probe All Domain Computers'}
              </button>
            )}
          </div>
          <div className="flex gap-8 text-xs">
            <div><span className="text-slate-600">Target</span><br/><span className="font-mono text-slate-200">{payload.target || '—'}</span></div>
            <div><span className="text-slate-600">Username</span><br/><span className="font-mono text-slate-200">{payload.username || '—'}</span></div>
            <div><span className="text-slate-600">Password</span><br/><span className="font-mono text-slate-500">••••••••</span></div>
            {isDC && <div><span className="text-slate-600">Role</span><br/><span className="text-cyan-DEFAULT font-mono">Domain Controller</span></div>}
          </div>
          {bulkState && bulkState !== 'loading' && (
            <div className={`mt-3 text-xs px-3 py-2 rounded border ${bulkState === 'error' ? 'border-red-500/30 text-red-400 bg-red-500/10' : 'border-green-500/30 text-green-400 bg-green-500/10'}`}>
              {bulkState === 'error'
                ? bulkMsg
                : `Queued ${bulkState.queued} Windows Probe task${bulkState.queued !== 1 ? 's' : ''}${bulkState.skipped ? ` (${bulkState.skipped} skipped — no hostname)` : ''}. Check Tasks page for progress.`
              }
            </div>
          )}
          {bulkMsg && bulkState !== 'error' && <p className="mt-2 text-xs text-red-400">{bulkMsg}</p>}
        </div>
      )}
      {/* Stats */}
      <StatCards items={[
        { label: 'Hostname',    value: hostname || target },
        { label: 'OS',          value: os_caption, color: 'text-slate-200' },
        { label: 'Build',       value: os_build },
        { label: 'Domain',      value: domain || '—', color: domain_joined ? 'text-cyan-DEFAULT' : 'text-slate-500' },
        { label: 'Uptime',      value: uptimeFmt(uptime_seconds) },
        { label: 'RAM',         value: `${ram_pct}%`, color: ram_pct > 90 ? 'text-red-DEFAULT' : ram_pct > 75 ? 'text-amber-DEFAULT' : 'text-green-DEFAULT' },
        { label: 'Hotfixes',    value: hotfix_count },
        { label: 'Findings',    value: findings.length, color: critFindings > 0 ? 'text-red-DEFAULT' : highFindings > 0 ? 'text-amber-DEFAULT' : 'text-green-DEFAULT' },
      ]} />

      {/* Security posture quick-view */}
      <div className="card px-4 py-3">
        <p className="text-xs font-display font-600 text-slate-400 mb-3">Security Posture</p>
        <div className="grid grid-cols-2 gap-x-8 gap-y-1.5 text-xs">
          {[
            ['Firewall (Domain)',  fwProfiles.find(([k]) => k === 'Domain')?.[1]  ?? null],
            ['Firewall (Private)', fwProfiles.find(([k]) => k === 'Private')?.[1] ?? null],
            ['Firewall (Public)',  fwProfiles.find(([k]) => k === 'Public')?.[1]  ?? null],
            ['SMBv1',              smb_v1 === true ? false : smb_v1 === false ? true : null, 'Disabled', 'Enabled'],
            ['RDP',                rdp_enabled],
            ['RDP NLA',            rdp_nla],
            ['Windows Defender',   defender_enabled],
            ['Real-Time Protection', defender_rtp],
            ['UAC',                uac_enabled],
            ['AutoLogon',          autologon_enabled === true ? false : autologon_enabled === false ? true : null, 'Off', 'On'],
          ].map(([label, val, t, f]) => (
            <div key={label} className="flex items-center justify-between gap-4">
              <span className="text-slate-500">{label}</span>
              {boolBadge(val, t, f)}
            </div>
          ))}
          {autologon_user && (
            <div className="flex items-center justify-between gap-4 col-span-2">
              <span className="text-slate-500">AutoLogon User</span>
              <span className="font-mono text-amber-DEFAULT">{autologon_user}</span>
            </div>
          )}
          {defender_sig_age != null && (
            <div className="flex items-center justify-between gap-4">
              <span className="text-slate-500">AV Sig Age</span>
              <span className={defender_sig_age > 7 ? 'text-red-DEFAULT' : 'text-green-DEFAULT'}>{defender_sig_age}d</span>
            </div>
          )}
        </div>
      </div>

      {/* Findings */}
      {findings.length > 0 && (
        <div>
          <p className="text-xs font-display font-600 text-slate-400 mb-2">Findings ({findings.length})</p>
          <div className="space-y-2">
            {findings.map((f, i) => (
              <div key={i} className="card px-3 py-2.5 flex gap-3 items-start">
                <SevBadge severity={f.severity} />
                <div className="min-w-0">
                  <p className="text-xs font-600 text-slate-200">{f.title}</p>
                  <p className="text-xs text-slate-500 mt-0.5 leading-relaxed">{f.detail}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Disks */}
      {disks.length > 0 && (
        <div>
          <p className="text-xs font-display font-600 text-slate-400 mb-2">Disk Usage</p>
          <div className="space-y-2">
            {disks.map((d, i) => (
              <div key={i} className="flex items-center gap-3">
                <span className="text-xs font-mono text-cyan-DEFAULT w-8">{d.drive}</span>
                {d.label && <span className="text-xs text-slate-500 w-24 truncate">{d.label}</span>}
                <div className="flex-1 h-2 bg-bg-base rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full ${d.used_pct > 90 ? 'bg-red-DEFAULT' : d.used_pct > 75 ? 'bg-amber-DEFAULT' : 'bg-cyan-DEFAULT'}`}
                    style={{ width: `${d.used_pct}%` }}
                  />
                </div>
                <span className={`text-xs font-mono w-10 text-right ${d.used_pct > 90 ? 'text-red-DEFAULT' : d.used_pct > 75 ? 'text-amber-DEFAULT' : 'text-slate-400'}`}>
                  {d.used_pct}%
                </span>
                <span className="text-xs text-slate-600 w-28 text-right">{d.free_gb} GB free / {d.total_gb} GB</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Network adapters */}
      {adapters.length > 0 && (
        <div>
          <p className="text-xs font-display font-600 text-slate-400 mb-2">Network Adapters</p>
          <Table headers={['Adapter', 'IP Address', 'Prefix']}>
            {adapters.map((a, i) => (
              <TR key={i}>
                <TD><span className="text-xs text-slate-300">{a.adapter}</span></TD>
                <TD><span className="text-xs font-mono text-cyan-DEFAULT">{a.ip}</span></TD>
                <TD><span className="text-xs font-mono text-slate-500">/{a.prefix}</span></TD>
              </TR>
            ))}
          </Table>
        </div>
      )}

      {/* Local admins */}
      {local_admins.length > 0 && (
        <div>
          <p className="text-xs font-display font-600 text-slate-400 mb-2">Local Administrators ({local_admins.length})</p>
          <div className="flex flex-wrap gap-2">
            {local_admins.map((a, i) => (
              <span key={i} className={`text-xs font-mono px-2 py-1 rounded border ${local_admins.length > 3 ? 'bg-amber-dim border-amber-muted text-amber-DEFAULT' : 'bg-bg-elevated border-bg-border text-slate-300'}`}>
                {a}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Key services */}
      {services.length > 0 && (
        <div>
          <p className="text-xs font-display font-600 text-slate-400 mb-2">Key Services</p>
          <Table headers={['Service', 'Display Name', 'Status', 'Start Type']}>
            {services.map((s, i) => (
              <TR key={i}>
                <TD><span className="text-xs font-mono text-slate-400">{s.name}</span></TD>
                <TD><span className="text-xs text-slate-300">{s.display}</span></TD>
                <TD>
                  <span className={`text-xs font-mono ${s.status === 'Running' ? 'text-green-DEFAULT' : 'text-slate-600'}`}>
                    {s.status}
                  </span>
                </TD>
                <TD><span className="text-xs font-mono text-slate-600">{s.start_type}</span></TD>
              </TR>
            ))}
          </Table>
        </div>
      )}

      {/* Installed software */}
      {installed_software.length > 0 && (
        <div>
          <p className="text-xs font-display font-600 text-slate-400 mb-2">Installed Software ({installed_software.length})</p>
          <Table headers={['Name', 'Version', 'Publisher']}>
            {installed_software.slice(0, 50).map((s, i) => (
              <TR key={i}>
                <TD><span className="text-xs text-slate-300">{s.name}</span></TD>
                <TD><span className="text-xs font-mono text-slate-500">{s.version || '—'}</span></TD>
                <TD><span className="text-xs text-slate-600">{s.publisher || '—'}</span></TD>
              </TR>
            ))}
          </Table>
          {installed_software.length > 50 && (
            <p className="text-xs text-slate-600 mt-2">Showing 50 of {installed_software.length} packages.</p>
          )}
        </div>
      )}
    </div>
  )
}

function AdReconReport({ result }) {
  if (!result) return null
  const {
    domain = {}, users = [], computers = [], groups = [],
    kerberoastable = [], asreproastable = [], delegation = {},
    password_policy = {}, trusts = [], gpos = [],
  } = result

  const domainInfo   = domain.info || {}
  const dcs          = domain.domain_controllers || []
  const privGroups   = groups.filter(g => g.privileged)
  const unconstrained = [
    ...(delegation.unconstrained_computers || []),
    ...(delegation.unconstrained_users     || []),
  ]

  const SEV = (count, warn, crit) => count >= crit ? 'text-red-DEFAULT' : count >= warn ? 'text-amber-DEFAULT' : 'text-green-DEFAULT'

  return (
    <div className="space-y-5">
      {/* Top stats */}
      <StatCards items={[
        { label: 'Domain',          value: domainInfo.dns_root || domainInfo.name || '—', color: 'text-cyan-DEFAULT' },
        { label: 'Users',           value: users.length },
        { label: 'Computers',       value: computers.length },
        { label: 'Domain Controllers', value: dcs.length },
        { label: 'Kerberoastable',  value: kerberoastable.length, color: SEV(kerberoastable.length, 1, 5) },
        { label: 'AS-REP Roastable',value: asreproastable.length, color: SEV(asreproastable.length, 1, 5) },
        { label: 'Unconstrained Deleg.', value: unconstrained.length, color: SEV(unconstrained.length, 1, 3) },
        { label: 'GPOs',            value: gpos.length },
      ]} />

      {/* Domain Controllers */}
      {dcs.length > 0 && (
        <div>
          <p className="text-xs font-display font-600 text-slate-400 mb-2">Domain Controllers</p>
          <Table headers={['Hostname', 'IP', 'OS', 'FSMO Roles', 'Site']}>
            {dcs.map((dc, i) => (
              <TR key={i}>
                <TD><span className="text-xs font-mono text-cyan-DEFAULT">{dc.name || dc.hostname || '—'}</span></TD>
                <TD><span className="text-xs font-mono text-slate-400">{dc.ip || '—'}</span></TD>
                <TD><span className="text-xs text-slate-300">{dc.os || '—'}</span></TD>
                <TD><span className="text-xs text-slate-500">{(dc.fsmo_roles || []).join(', ') || '—'}</span></TD>
                <TD><span className="text-xs text-slate-500">{dc.site || '—'}</span></TD>
              </TR>
            ))}
          </Table>
        </div>
      )}

      {/* Privileged groups */}
      {privGroups.length > 0 && (
        <div>
          <p className="text-xs font-display font-600 text-slate-400 mb-2">Privileged Groups</p>
          <Table headers={['Group', 'Members', 'Nested Members']}>
            {privGroups.map((g, i) => (
              <TR key={i}>
                <TD><span className="text-xs font-mono text-slate-200">{g.name}</span></TD>
                <TD><span className={`text-xs font-mono font-600 ${SEV(g.member_count || 0, 3, 10)}`}>{g.member_count ?? (g.members || []).length}</span></TD>
                <TD><span className="text-xs font-mono text-slate-500">{g.nested_member_count ?? '—'}</span></TD>
              </TR>
            ))}
          </Table>
        </div>
      )}

      {/* Kerberoastable accounts */}
      {kerberoastable.length > 0 && (
        <div>
          <p className="text-xs font-display font-600 text-red-DEFAULT mb-2">Kerberoastable Accounts ({kerberoastable.length})</p>
          <Table headers={['Username', 'SPN', 'Password Age (days)', 'Admin Count']}>
            {kerberoastable.map((u, i) => (
              <TR key={i}>
                <TD><span className="text-xs font-mono text-slate-200">{u.username || u.sam_account_name}</span></TD>
                <TD><span className="text-xs font-mono text-slate-500 truncate max-w-xs">{(u.spns || [])[0] || '—'}</span></TD>
                <TD><span className={`text-xs font-mono ${SEV(u.password_age_days || 0, 90, 365)}`}>{u.password_age_days ?? '—'}</span></TD>
                <TD><span className="text-xs font-mono">{u.admin_count ? <span className="text-red-DEFAULT">Yes</span> : <span className="text-slate-600">No</span>}</span></TD>
              </TR>
            ))}
          </Table>
        </div>
      )}

      {/* Unconstrained delegation */}
      {unconstrained.length > 0 && (
        <div>
          <p className="text-xs font-display font-600 text-amber-DEFAULT mb-2">Unconstrained Delegation ({unconstrained.length})</p>
          <div className="flex flex-wrap gap-2">
            {unconstrained.map((name, i) => (
              <span key={i} className="text-xs font-mono px-2 py-1 rounded bg-amber-dim border border-amber-muted text-amber-DEFAULT">{name}</span>
            ))}
          </div>
        </div>
      )}

      {/* Password policy */}
      {password_policy && Object.keys(password_policy).length > 0 && (
        <div>
          <p className="text-xs font-display font-600 text-slate-400 mb-2">Password Policy</p>
          <div className="grid grid-cols-3 gap-2">
            {[
              ['Min Length',   password_policy.min_length ?? password_policy.minimum_password_length],
              ['Max Age (days)', password_policy.max_age_days ?? password_policy.maximum_password_age],
              ['History',      password_policy.history_length ?? password_policy.password_history_length],
              ['Lockout Threshold', password_policy.lockout_threshold],
              ['Lockout Duration', password_policy.lockout_duration_mins != null ? `${password_policy.lockout_duration_mins}m` : null],
              ['Complexity',   password_policy.complexity_enabled ? 'Enabled' : password_policy.complexity_enabled === false ? 'Disabled' : null],
            ].filter(([, v]) => v != null).map(([label, val]) => (
              <div key={label} className="card px-3 py-2 flex items-center gap-2">
                <span className="text-xs text-slate-500">{label}</span>
                <span className="text-xs font-mono font-600 text-slate-300 ml-auto">{val}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Trusts */}
      {trusts.length > 0 && (
        <div>
          <p className="text-xs font-display font-600 text-slate-400 mb-2">Trust Relationships ({trusts.length})</p>
          <Table headers={['Trusted Domain', 'Direction', 'Type', 'Transitive']}>
            {trusts.map((t, i) => (
              <TR key={i}>
                <TD><span className="text-xs font-mono text-slate-200">{t.trusted_domain || t.name}</span></TD>
                <TD><span className="text-xs font-mono text-slate-400">{t.direction || '—'}</span></TD>
                <TD><span className="text-xs font-mono text-slate-500">{t.trust_type || '—'}</span></TD>
                <TD><span className="text-xs">{t.transitive ? <span className="text-amber-DEFAULT">Yes</span> : <span className="text-slate-600">No</span>}</span></TD>
              </TR>
            ))}
          </Table>
        </div>
      )}
    </div>
  )
}

// ── Renderer dispatcher ───────────────────────────────────────────────────────

function ReportRenderer({ task }) {
  const { task_type, result, payload } = task
  if (!result) return <p className="text-xs text-slate-600">No result data available.</p>

  switch (task_type) {
    // System
    case 'get_sysinfo':              return <SysinfoReport            result={result} payload={payload} />
    case 'run_speedtest':            return <SpeedTestReport          result={result} payload={payload} />
    case 'run_http_monitor':         return <HttpMonitorReport        result={result} payload={payload} />
    case 'run_ntp_check':            return <NtpCheckReport           result={result} payload={payload} />
    // Network scans
    case 'run_nmap_scan':            return <NmapReport               result={result} payload={payload} />
    case 'run_port_scan':            return <PortScanReport           result={result} payload={payload} />
    case 'run_ping_sweep':           return <PingSweepReport          result={result} payload={payload} />
    case 'run_arp_scan':             return <ArpScanReport            result={result} payload={payload} />
    case 'run_netbios_scan':         return <NetbiosScanReport        result={result} payload={payload} />
    case 'run_lldp_neighbors':       return <LldpReport               result={result} payload={payload} />
    case 'run_wireless_survey':      return <WirelessSurveyReport     result={result} payload={payload} />
    case 'run_wol':                  return <WolReport                result={result} payload={payload} />
    // Diagnostics
    case 'run_traceroute':           return <TracerouteReport         result={result} payload={payload} />
    case 'run_mtr':                  return <MtrReport                result={result} payload={payload} />
    case 'run_dns_lookup':           return <DnsLookupReport          result={result} payload={payload} />
    case 'run_iperf':                return <IperfReport              result={result} payload={payload} />
    case 'run_banner_grab':          return <BannerGrabReport         result={result} payload={payload} />
    case 'run_packet_capture':       return <PacketCaptureReport      result={result} payload={payload} />
    case 'run_snmp_query':           return <SnmpReport               result={result} payload={payload} />
    // Security
    case 'run_ssl_check':            return <SslCheckReport           result={result} payload={payload} />
    case 'run_dns_health':           return <DnsHealthReport          result={result} payload={payload} />
    case 'run_vuln_scan':            return <VulnScanReport           result={result} payload={payload} />
    case 'run_security_audit':       return <SecurityAuditReport      result={result} payload={payload} />
    case 'run_default_creds':        return <DefaultCredsReport       result={result} payload={payload} />
    case 'run_cleartext_services':   return <CleartextServicesReport  result={result} payload={payload} />
    case 'run_smb_enum':             return <SmbEnumReport            result={result} payload={payload} />
    case 'run_email_breach':         return <EmailBreachReport        result={result} payload={payload} />
    // Active Directory
    case 'run_ad_discover':          return <AdDiscoverReport         result={result} payload={payload} />
    case 'run_ad_recon':             return <AdReconReport            result={result} payload={payload} />
    // Agentless Windows
    case 'run_windows_probe':        return <WindowsProbeReport       result={result} payload={payload} deviceId={task.device_id} />
    default:
      return (
        <pre className="text-xs font-mono text-slate-400 bg-bg-base border border-bg-border rounded p-3 overflow-auto max-h-64">
          {JSON.stringify(result, null, 2)}
        </pre>
      )
  }
}

// ── Report Card ───────────────────────────────────────────────────────────────

function ReportCard({ task, deviceName, customerName, siteName, expanded, onToggle }) {
  const printRef = useRef()
  const isCompleted = task.status === 'completed'
  const duration = task.completed_at && task.queued_at
    ? `${((new Date(task.completed_at) - new Date(task.queued_at)) / 1000).toFixed(1)}s`
    : null

  const handlePrint = (e) => {
    e.stopPropagation()
    const content = printRef.current?.innerHTML
    if (!content) return

    const win = window.open('', '_blank')
    win.document.write(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>${labelFor(task.task_type)} — ${customerName} / ${siteName}</title>
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body { font-family: 'Segoe UI', sans-serif; font-size: 12px; color: #1a1a2e; padding: 32px; }
          h1 { font-size: 20px; font-weight: 700; margin-bottom: 4px; color: #0f0f1a; }
          .meta { font-size: 11px; color: #666; margin-bottom: 24px; }
          .meta span { margin-right: 16px; }
          table { width: 100%; border-collapse: collapse; margin: 12px 0; }
          th { text-align: left; padding: 6px 10px; font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; color: #888; border-bottom: 2px solid #eee; }
          td { padding: 6px 10px; border-bottom: 1px solid #f0f0f0; font-family: monospace; }
          .card { border: 1px solid #e5e5e5; border-radius: 6px; padding: 12px 16px; display: inline-block; margin: 0 8px 8px 0; }
          .label { font-size: 10px; color: #888; margin-bottom: 2px; }
          .value { font-size: 18px; font-weight: 700; }
          .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 10px; font-weight: 600; border: 1px solid #ddd; }
          .green { color: #16a34a; } .red { color: #dc2626; } .amber { color: #d97706; } .cyan { color: #0891b2; }
          .bar-wrap { height: 6px; background: #eee; border-radius: 3px; overflow: hidden; margin-top: 4px; }
          .bar { height: 100%; background: #0891b2; border-radius: 3px; }
          @media print { body { padding: 16px; } }
        </style>
      </head>
      <body>
        <h1>${labelFor(task.task_type)}</h1>
        <div class="meta">
          <span><strong>Customer:</strong> ${customerName}</span>
          <span><strong>Site:</strong> ${siteName}</span>
          <span><strong>Device:</strong> ${deviceName}</span>
          <span><strong>Run:</strong> ${task.completed_at ? format(new Date(task.completed_at), 'PPpp') : '—'}</span>
          ${duration ? `<span><strong>Duration:</strong> ${duration}</span>` : ''}
        </div>
        ${content}
      </body>
      </html>
    `)
    win.document.close()
    win.focus()
    setTimeout(() => { win.print(); win.close() }, 500)
  }

  return (
    <div className="card overflow-hidden">
      {/* Header row — always visible */}
      <button
        onClick={onToggle}
        className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-colors ${isCompleted ? 'hover:bg-bg-elevated cursor-pointer' : 'cursor-default'}`}
      >
        <div className="flex-1 min-w-0 grid grid-cols-5 gap-3 items-center">
          <div>
            <p className="text-xs text-slate-500 mb-0.5">Type</p>
            <p className="text-xs font-display font-500 text-slate-200">{labelFor(task.task_type)}</p>
          </div>
          <div>
            <p className="text-xs text-slate-500 mb-0.5">Customer</p>
            <p className="text-xs font-mono text-cyan-muted truncate">{customerName}</p>
          </div>
          <div>
            <p className="text-xs text-slate-500 mb-0.5">Site</p>
            <p className="text-xs font-mono text-slate-300 truncate">{siteName}</p>
          </div>
          <div>
            <p className="text-xs text-slate-500 mb-0.5">Device</p>
            <p className="text-xs font-mono text-slate-300 truncate">{deviceName}</p>
          </div>
          <div className="flex items-center gap-3">
            <div>
              <p className="text-xs text-slate-500 mb-0.5">Status</p>
              <StatusBadge status={task.status} />
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {duration && <span className="text-xs font-mono text-slate-600">{duration}</span>}
          <span className="text-xs font-mono text-slate-600">
            {task.queued_at ? formatDistanceToNow(new Date(task.queued_at), { addSuffix: true }) : ''}
          </span>
          {isCompleted && task.result && (
            <button
              onClick={handlePrint}
              className="p-1 rounded hover:bg-bg-border text-slate-500 hover:text-slate-300 transition-colors"
              title="Print / Export PDF"
            >
              <Download className="w-3.5 h-3.5" />
            </button>
          )}
          {isCompleted && task.result
            ? expanded
              ? <ChevronDown className="w-4 h-4 text-slate-500" />
              : <ChevronRight className="w-4 h-4 text-slate-500" />
            : null
          }
        </div>
      </button>

      {/* Expanded report body */}
      {expanded && isCompleted && (
        <div className="border-t border-bg-border px-4 py-4">
          <div className="flex items-center gap-3 mb-4 pb-3 border-b border-bg-border/40">
            <div className="text-xs text-slate-600">
              {task.completed_at ? format(new Date(task.completed_at), 'PPpp') : ''}
            </div>
            {task.payload && Object.keys(task.payload).length > 0 && (
              <div className="ml-auto flex gap-2 flex-wrap">
                {Object.entries(task.payload).filter(([k]) => k !== 'password').map(([k,v]) => (
                  <span key={k} className="text-xs font-mono text-slate-600">
                    {k}: <span className="text-slate-400">{typeof v === 'object' ? JSON.stringify(v) : String(v)}</span>
                  </span>
                ))}
              </div>
            )}
          </div>
          {/* Hidden print-friendly version */}
          <div ref={printRef} className="hidden">
            <ReportRenderer task={task} />
          </div>
          {/* Visible version */}
          <ReportRenderer task={task} />
        </div>
      )}

      {/* Error */}
      {task.status === 'failed' && task.error && (
        <div className="border-t border-bg-border px-4 py-3">
          <p className="text-xs font-mono text-red-DEFAULT">{task.error}</p>
        </div>
      )}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function ReportsPage() {
  const [searchParams] = useSearchParams()

  const [tasks, setTasks]         = useState([])
  const [devices, setDevices]     = useState([])
  const [customers, setCustomers] = useState([])
  const [sites, setSites]         = useState([])
  const [loading, setLoading]     = useState(true)
  const [error, setError]         = useState('')
  const [expandedId, setExpandedId] = useState(null)

  // Filters
  const [filterCustomer,  setFilterCustomer]  = useState(searchParams.get('customer') || '')
  const [filterSite,      setFilterSite]      = useState(searchParams.get('site') || '')
  const [filterDevice,    setFilterDevice]    = useState(searchParams.get('device') || '')
  const [filterType,      setFilterType]      = useState(searchParams.get('type') || '')
  const [hideBackground,  setHideBackground]  = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const params = { limit: 500 }
      if (filterType) params.task_type = filterType
      if (filterDevice) params.device_id = filterDevice

      const [allTasks, devs, custs] = await Promise.all([
        api.getAllTasks({ ...params, status: 'completed' }),
        api.getDevices(),
        api.getCustomers(),
      ])

      // Also load failed tasks so they show up
      const failedTasks = await api.getAllTasks({ ...params, status: 'failed' })

      const allReportable = [...allTasks, ...failedTasks]
        .filter(t => REPORTABLE_TYPES.includes(t.task_type))
        .sort((a, b) => new Date(b.queued_at) - new Date(a.queued_at))

      setTasks(allReportable)
      setDevices(devs)
      setCustomers(custs)

      // Load sites
      const siteData = await api.getSites()
      setSites(siteData)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [filterType, filterDevice])

  useEffect(() => { load() }, [load])

  // Lookup helpers
  const deviceById   = id => devices.find(d => d.id === id)
  const customerById = id => customers.find(c => c.id === id)
  const siteById     = id => sites.find(s => s.id === id)

  const deviceName   = id => deviceById(id)?.name   || id?.slice(0,8) + '…'
  const customerName = id => customerById(id)?.name  || '—'
  const siteName     = id => siteById(id)?.name      || '—'

  // Apply customer/site filters (client-side since tasks only have device_id)
  const filtered = tasks.filter(t => {
    const dev = deviceById(t.device_id)
    if (filterCustomer && dev?.customer_id !== filterCustomer) return false
    if (filterSite     && dev?.site_id     !== filterSite)     return false
    if (hideBackground && t.payload?._auto) return false
    return true
  })

  // Sites filtered by selected customer
  const filteredSites = filterCustomer
    ? sites.filter(s => s.customer_id === filterCustomer)
    : sites

  const hasFilters = filterCustomer || filterSite || filterDevice || filterType

  const clearFilters = () => {
    setFilterCustomer('')
    setFilterSite('')
    setFilterDevice('')
    setFilterType('')
  }

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Reports"
        subtitle={`${filtered.length} report${filtered.length !== 1 ? 's' : ''}${hasFilters ? ' (filtered)' : ''}`}
        actions={
          <button onClick={load} className="btn-ghost flex items-center gap-1.5">
            <RefreshCw className="w-3.5 h-3.5" /> Refresh
          </button>
        }
      />

      {error && <Alert type="error" message={error} className="mb-4" />}

      {/* Filter bar */}
      <div className="card px-4 py-3 mb-4 flex flex-wrap items-center gap-3">
        <Filter className="w-3.5 h-3.5 text-slate-600 shrink-0" />

        <select
          className="input py-1 text-xs w-44"
          value={filterCustomer}
          onChange={e => { setFilterCustomer(e.target.value); setFilterSite('') }}
        >
          <option value="">All customers</option>
          {customers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>

        <select
          className="input py-1 text-xs w-40"
          value={filterSite}
          onChange={e => setFilterSite(e.target.value)}
        >
          <option value="">All sites</option>
          {filteredSites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>

        <select
          className="input py-1 text-xs w-44"
          value={filterDevice}
          onChange={e => setFilterDevice(e.target.value)}
        >
          <option value="">All devices</option>
          {devices.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>

        <select
          className="input py-1 text-xs w-44"
          value={filterType}
          onChange={e => setFilterType(e.target.value)}
        >
          {REPORT_TYPES.map(t => (
            <option key={t.value} value={t.value}>{t.label}</option>
          ))}
        </select>

        <label className="flex items-center gap-1.5 text-xs text-slate-500 cursor-pointer select-none ml-auto">
          <input
            type="checkbox"
            checked={hideBackground}
            onChange={e => setHideBackground(e.target.checked)}
            className="accent-cyan-500 w-3 h-3"
          />
          Hide background scans
        </label>

        {hasFilters && (
          <button
            onClick={clearFilters}
            className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-300 transition-colors"
          >
            <X className="w-3 h-3" /> Clear
          </button>
        )}
      </div>

      {/* Report list */}
      {loading ? (
        <div className="h-48 flex items-center justify-center"><Spinner /></div>
      ) : filtered.length === 0 ? (
        <Empty
          icon={FileText}
          title="No reports found"
          description={hasFilters ? 'Try adjusting your filters' : 'Run tasks from the Devices page — completed reports appear here'}
        />
      ) : (
        <div className="space-y-2">
          {filtered.map(task => {
            const dev = deviceById(task.device_id)
            return (
              <ReportCard
                key={task.id}
                task={task}
                deviceName={deviceName(task.device_id)}
                customerName={customerName(dev?.customer_id)}
                siteName={siteName(dev?.site_id)}
                expanded={expandedId === task.id}
                onToggle={() => task.result && setExpandedId(expandedId === task.id ? null : task.id)}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}
