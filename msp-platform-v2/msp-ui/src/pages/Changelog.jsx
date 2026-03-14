import { PageHeader } from '../components/ui'
import { GitBranch, Shield, Bug, Sparkles, Wrench } from 'lucide-react'

// ── Data ──────────────────────────────────────────────────────────────────────

const RELEASES = [
  {
    version: '3.2.0',
    date: '2026-03-09',
    summary: 'AD Report — vertical nav, DHCP fix, GPO detail parsing, new sections',
    entries: [
      {
        type: 'feature',
        text: 'AD Report navigation redesigned from a horizontal scrolling tab bar (11 items) to a grouped vertical sidebar nav. Sections are organised into four groups: Summary, Directory, Policy, and Security. No more left/right scrolling — all sections always visible.',
      },
      {
        type: 'feature',
        text: 'Stat cards split into two rows of four: Row 1 (inventory — Users, Computers, Domain Admins, Stale Accounts) and Row 2 (risk — Kerberoastable, AS-REP Roastable, Unconstrained Delegation, LAPS Coverage). Labels no longer truncate.',
      },
      {
        type: 'feature',
        text: 'LAPS Coverage card now shows "N/A" when LAPS is not deployed, with "Not deployed" as a small sub-label instead of squeezing the full string into the large value area.',
      },
      {
        type: 'feature',
        text: 'New Computers section: OS breakdown summary pills, filterable table (All / Stale / No LAPS), per-machine LAPS enrollment flag, stale detection.',
      },
      {
        type: 'feature',
        text: 'New Delegation section: accounts split by delegation type — unconstrained (critical, red), constrained (with protocol-transition flag highlighted), and resource-based constrained (RBCD). Shows a green "no issues" state when nothing is found.',
      },
      {
        type: 'feature',
        text: 'New Security section with four sub-tabs: LAPS (deployment status + coverage progress bar), AdminSDHolder (accounts with adminCount=1), Protected Users (group members), Service Accounts (MSA/gMSA/user-with-SPN with type badges).',
      },
      {
        type: 'feature',
        text: 'GPO section: added computer_settings and user_settings as coloured capability tag pills decoded from CSE GUIDs. Added Unlinked filter. New collapsible "Policy details" block renders GptTmpl.inf sections parsed from SYSVOL: password/lockout policy overrides, audit policy (colour-coded by category), user rights assignments with SE constants translated to human names, restricted groups, and security option registry values.',
      },
      {
        type: 'feature',
        text: 'Users section: new Delegation filter tab, logon script column, trusted_for_deleg and sensitive_no_deleg flag badges.',
      },
      {
        type: 'feature',
        text: 'Groups section: handles new nested group shape {members, nested_members, total_effective} — direct and via-nested-group members shown in separate rows.',
      },
      {
        type: 'feature',
        text: 'Password Policy section: PSOs (Fine-Grained Password Policies) now rendered inline below the domain default — shows precedence, applies-to list, and reversible-encryption warning.',
      },
      {
        type: 'feature',
        text: 'Shares section: now shows share-level ACL permissions table (principal, rights, allow/deny) when rpcclient data is available.',
      },
      {
        type: 'feature',
        text: 'DHCP display updated to handle multiple address ranges per scope, scope description (dhcpComment), and subnet mask.',
      },
      {
        type: 'fix',
        text: 'Server: ADReport model and save_ad_report() now populate 8 new denormalised summary columns (computer_count, unconstrained_delegation, laps_deployed, laps_coverage_pct, adminsdholder_count, protected_users_count, fine_grained_policies, service_accounts). Migration 0003 adds these columns with IF NOT EXISTS guards.',
      },
      {
        type: 'fix',
        text: 'Agent: DHCP scope collection was failing silently in most environments — server DN was reconstructed from the CN attribute value rather than using the actual dn returned by LDAP. Fixed to use the real DN directly.',
      },
    ],
  },
  {
    version: '3.1.0',
    date: '2026-03-08',
    summary: 'Hotfix — GET /v1/devices 500 error',
    entries: [
      {
        type: 'fix',
        text: 'Device model was missing the customer ORM relationship — only the customer_id FK column existed. selectinload(Device.customer) in list_devices crashed with an AttributeError, returning 500 on every GET /v1/devices call. Added Mapped[Optional["CustomerOrganization"]] relationship with explicit foreign_keys to resolve SQLAlchemy join ambiguity.',
      },
    ],
  },
  {
    version: '3.0.0',
    date: '2026-03-08',
    summary: 'Phase 4 — AD Report overhaul, customer-aware dropdowns, agent hardening',
    entries: [
      {
        type: 'feature',
        text: 'AD Report is now a top-level nav page (/ad-report) with a device selector dropdown — no longer requires navigating to a specific device first. The /devices/:id/ad-report route still works for direct device navigation.',
      },
      {
        type: 'feature',
        text: 'Device dropdown groups agents by customer name using <optgroup> — every agent picker across the platform now shows "Acme Corp → Agent-01" grouping instead of a flat list.',
      },
      {
        type: 'feature',
        text: 'customer_name added to GET /v1/devices response — eager-loaded via selectinload on the new Device.customer relationship.',
      },
      {
        type: 'feature',
        text: 'AD Report: new Infrastructure tab with domain overview, all domain controllers (OS, hardware, FSMO roles, Global Catalog status, site assignment), trust relationships, DNS zones (AD-integrated, both DomainDnsZones and ForestDnsZones partitions), DHCP scopes, and OU tree with GPO link counts.',
      },
      {
        type: 'feature',
        text: 'AD Report: new GPOs tab — searchable list of all Group Policy Objects with status (enabled/disabled), modification date, and linked OUs via reverse gPLink lookup.',
      },
      {
        type: 'feature',
        text: 'AD Report summary bar now shows DC count and trust count. Stat cards updated to show GPO count instead of Pwd Never Expires.',
      },
      {
        type: 'feature',
        text: 'agent/tasks/ad_recon.py expanded from 6 to 12 parallel collection functions: DC enumeration with FSMO role holders (Schema/PDC/RID/Infrastructure Master), AD Sites and Services, trust relationships with direction/type/transitivity, DNS zone enumeration, DHCP scope discovery via LDAP NetServices container, OU tree with depth and GPO link counts, and full GPO enumeration with linked-OU reverse mapping.',
      },
      {
        type: 'feature',
        text: 'Password policy collection now includes history length, lockout observation window, and lockout duration. Findings engine gained four new checks: domain-wide password never expires, short history (<5), accounts with no password required, and Enterprise Admins oversize.',
      },
      {
        type: 'feature',
        text: 'Privileged group enumeration expanded: added Server Operators, Print Operators, Remote Desktop Users, and Group Policy Creator Owners.',
      },
      {
        type: 'feature',
        text: 'Agent Phase 4 hardening: security_audit.py rewritten with asyncio.gather + Semaphore(10); packet_capture.py single tshark capture to temp pcap with post-process stats; hardware.py get_arch() uses functools.lru_cache; ad_recon.py credentials scrubbed immediately on entry; ad_discover.py nmblookup/smbclient replaces enum4linux dependency.',
      },
      {
        type: 'feature',
        text: 'core/monitor.py created — was referenced in connection.py but never existed, causing "No module named core.monitor" crash on every agent connect. Implements background uptime monitoring loop with concurrent pings via Semaphore(20).',
      },
      {
        type: 'fix',
        text: 'ssl_check.py: lstrip("https://") was stripping individual characters (including leading s, y, n etc.) rather than the prefix string. Fixed to use startswith/removeprefix — hostnames like synacktime.com no longer have their leading chars eaten.',
      },
      {
        type: 'fix',
        text: 'NetworkDiscovery.jsx ping_sweep: default payload and field key changed from "target" to "network" to match what ping_sweep.py expects. Was causing "No network specified" ValueError on every run.',
      },
      {
        type: 'fix',
        text: 'install.sh: changed cp -r to rm -rf then cp -r for tasks/ and core/ directories — stale task files from previous installs no longer persist across deploys.',
      },
      {
        type: 'fix',
        text: 'list_devices pagination: limit now defaults to 200 with a 500 cap and supports offset. issue_task returns a warning field when the target device is OFFLINE instead of silently queuing.',
      },
      {
        type: 'change',
        text: 'DB migration 0002_phase2_tables.py creates ad_reports, scan_findings, monitor_targets, and uptime_checks tables with IF NOT EXISTS guards — safe to run against existing databases without data loss.',
      },
    ],
  },
  {
    version: '2.8.0',
    date: '2026-03-07',
    summary: 'Bug fixes and internal improvements',
    entries: [
      {
        type: 'fix',
        text: 'Finding acknowledgement was inverting its own state — acknowledging a finding would clear acknowledged_by, and unacknowledging would set it. Toggle logic now computes new_state once and applies it consistently.',
      },
      {
        type: 'fix',
        text: 'PATCH /v1/operators/{id} accepted an untyped dict body with no password complexity enforcement — a password of "a" could be set via update. Now uses a typed Pydantic model and calls _validate_password() on any password change.',
      },
      {
        type: 'fix',
        text: 'Enrollment endpoint contained dead code that would crash (calling .hex() on an already-hex string) if ever reached. Removed the unreachable first assignment.',
      },
      {
        type: 'fix',
        text: 'get_current_device dependency was imported via __import__() hack in enrollment.py and management.py to avoid a circular import that did not actually exist. Replaced with direct imports from app.core.auth.',
      },
      {
        type: 'fix',
        text: 'wan_uptime_monitor() was defined after main() called it — a forward-reference that would break if main() were invoked at import time. Moved the function above main().',
      },
      {
        type: 'fix',
        text: 'Redis publish opened and closed a new connection for every outbound device message. Replaced with a module-level connection pool shared across all publish calls.',
      },
      {
        type: 'fix',
        text: 'api.js was missing getOperators() and updateOperator() as named methods — the Users page relied on the generic api.get/api.patch helpers. Both are now proper named methods consistent with the rest of the API client.',
      },
    ],
  },
  {
    version: '2.7.0',
    date: '2026-03-07',
    summary: 'Reports, SNMP UI, and bug fixes',
    entries: [
      {
        type: 'feature',
        text: 'Reports page — all task types now render as structured reports (Network Scan, Port Scan, Ping Sweep, ARP Scan, Speed Test, Wireless Survey, Traceroute, MTR, System Info) with print-to-PDF support',
      },
      {
        type: 'feature',
        text: 'Reports are filterable by customer, site, device, and report type — providing a full audit trail of diagnostic activity per client',
      },
      {
        type: 'feature',
        text: 'SNMP UI (Phase 5) — dedicated page with tabbed result views (System Info, Interfaces, Storage, Custom OIDs), quick-pick OID shortcuts, and historical query list',
      },
      {
        type: 'fix',
        text: 'Terminal popup: xterm.js and fit addon are now fully inlined — eliminates "Terminal is not defined" error caused by blocked CDN requests',
      },
      {
        type: 'fix',
        text: 'Bandwidth monitor: fixed malformed WebSocket URL where security hardening broke query param construction (?ticket= was appended after &params instead of before)',
      },
      {
        type: 'fix',
        text: 'Task result modal: CodeBlock now accepts both content prop and children — result box was silently blank due to prop name mismatch',
      },
    ],
  },
  {
    version: '2.6.0',
    date: '2026-03-07',
    summary: 'Security hardening',
    entries: [
      {
        type: 'security',
        text: 'AD credentials no longer stored in DB — password sent to Pi in-memory only, immediately cleared, never written to task.payload',
      },
      {
        type: 'security',
        text: 'SNMP community strings removed from task results before persistence',
      },
      {
        type: 'security',
        text: 'Bootstrap endpoint returns generic 404 after first use — no longer confirms platform existence to unauthenticated requests',
      },
      {
        type: 'security',
        text: '/metrics endpoint now requires operator Bearer token authentication',
      },
      {
        type: 'security',
        text: 'OpenAPI schema disabled in production (openapi_url=None) — API surface no longer publicly enumerable',
      },
      {
        type: 'security',
        text: 'Login rate limited to 10 requests/minute via slowapi — prevents brute-force attacks',
      },
      {
        type: 'security',
        text: 'Password complexity enforced: 12+ characters, upper, lower, digit, and special character required',
      },
      {
        type: 'security',
        text: 'CORS restricted to explicit methods and headers; security headers added (HSTS, CSP, X-Frame-Options, Referrer-Policy) via middleware and nginx',
      },
      {
        type: 'security',
        text: 'Timing-safe login: dummy bcrypt hash always evaluated when user not found — prevents user enumeration via response time',
      },
      {
        type: 'security',
        text: 'WebSocket authentication migrated to short-lived single-use tickets (POST /v1/ws-ticket) — operator JWT no longer exposed in URLs, nginx logs, or browser history',
      },
    ],
  },
  {
    version: '2.5.0',
    date: '2026-03-06',
    summary: 'User management',
    entries: [
      {
        type: 'feature',
        text: 'Users page — add, edit, activate/deactivate operators with role picker (msp_admin / msp_operator / customer_viewer)',
      },
      {
        type: 'feature',
        text: 'Self-protection: operators cannot deactivate their own account; MSP admins cannot create super admins',
      },
      {
        type: 'feature',
        text: 'GET /v1/operators and PATCH /v1/operators/{id} server endpoints',
      },
    ],
  },
  {
    version: '2.4.0',
    date: '2026-03-06',
    summary: 'Active Directory recon',
    entries: [
      {
        type: 'feature',
        text: 'AD Recon page — two-stage flow: Discover (finds domain controllers) → credential form → full recon',
      },
      {
        type: 'feature',
        text: 'AD report tabs: Findings, Users, Groups, Kerberoastable accounts, Password Policy, Shares',
      },
      {
        type: 'feature',
        text: 'Historical report sidebar — all past AD recon runs saved and accessible per device',
      },
      {
        type: 'feature',
        text: 'ADReport model with denormalised summary fields (total_users, domain_admins, kerberoastable, asrep_roastable, findings counts)',
      },
    ],
  },
  {
    version: '2.3.0',
    date: '2026-03-05',
    summary: 'Security findings and vulnerability scanning UI',
    entries: [
      {
        type: 'feature',
        text: 'Findings page — severity stat cards, new scan modal, findings table with filters, slide-out detail drawer',
      },
      {
        type: 'feature',
        text: 'Acknowledge findings with notes; CVE ID display; raw output viewer',
      },
      {
        type: 'feature',
        text: 'ScanFinding model with severity enum (critical/high/medium/low/info), CVE tracking, and false-positive acknowledgement',
      },
      {
        type: 'feature',
        text: 'Findings auto-populated from device channel when run_vuln_scan or run_security_audit tasks complete',
      },
    ],
  },
  {
    version: '2.2.0',
    date: '2026-03-05',
    summary: 'Dashboard and Tasks page overhaul',
    entries: [
      {
        type: 'feature',
        text: 'Dashboard rewritten — stat cards (active devices, offline, open findings, running tasks), device uptime table, recent findings panel, recent tasks, audit log',
      },
      {
        type: 'feature',
        text: 'Tasks page — global task list with filter bar (status, type, device), stat cards, result viewer modal',
      },
      {
        type: 'feature',
        text: 'GET /v1/tasks — global task list endpoint, filterable by device_id, status, task_type',
      },
      {
        type: 'fix',
        text: 'Dashboard stat cards were using non-existent acknowledged_at field — fixed to use acknowledged boolean',
      },
      {
        type: 'fix',
        text: '_task_dict now returns device_id and dispatched_at fields needed by the Tasks page',
      },
    ],
  },
  {
    version: '2.1.0',
    date: '2026-03-04',
    summary: 'Uptime monitoring',
    entries: [
      {
        type: 'feature',
        text: 'Monitoring page — uptime dashboard, RTT sparklines, add/delete monitor targets',
      },
      {
        type: 'feature',
        text: 'Dual-source uptime: Pi agent pings LAN targets every 30s (source=lan); server pings device last_ip every 60s (source=wan)',
      },
      {
        type: 'feature',
        text: 'MonitorTarget and UptimeCheck models; per-device uptime % and RTT time-series endpoints',
      },
      {
        type: 'fix',
        text: 'Monitoring devices dropdown: device load and uptime load decoupled — dropdown no longer blocked by uptime fetch',
      },
      {
        type: 'fix',
        text: '_device_dict now returns last_ip — required by WAN uptime monitor and DeviceDetail display',
      },
    ],
  },
  {
    version: '2.0.0',
    date: '2026-03-03',
    summary: 'Remote terminal and live bandwidth streaming',
    entries: [
      {
        type: 'feature',
        text: 'Remote terminal — full PTY shell over WebSocket bridge, xterm.js frontend with GitHub dark theme, resize support, reconnect',
      },
      {
        type: 'feature',
        text: 'Live bandwidth monitor — per-process (nethogs) and per-IP (iftop) modes, sparkline charts, 40-point history, column sort',
      },
      {
        type: 'feature',
        text: 'Both features ride the existing device WebSocket channel — no new Pi connection required',
      },
      {
        type: 'fix',
        text: 'require_role hierarchy fixed: SUPER_ADMIN always passes; MSP_ADMIN passes when MSP_OPERATOR is required',
      },
      {
        type: 'fix',
        text: 'Duplicate send_to_device removed from connection_manager.py',
      },
    ],
  },
  {
    version: '1.0.0',
    date: '2026-03-01',
    summary: 'Initial platform release — 19 task types',
    entries: [
      {
        type: 'feature',
        text: 'Core platform: MSP → Customer → Site → Device tenant hierarchy with JWT authentication',
      },
      {
        type: 'feature',
        text: 'Device enrollment with secret-based auth, WebSocket channel, heartbeat, and offline detection',
      },
      {
        type: 'feature',
        text: '19 task types: nmap scan, port scan, ping sweep, ARP scan, speedtest, wireless survey, DNS lookup, traceroute, MTR, iPerf, banner grab, packet capture, SNMP query, vuln scan, security audit, sysinfo, AD discover, AD recon',
      },
      {
        type: 'feature',
        text: 'Over-the-air agent updates via ClientRelease and DeviceUpdateJob models',
      },
      {
        type: 'feature',
        text: 'Immutable audit log for all operator and device actions',
      },
      {
        type: 'feature',
        text: 'Devices, Customers, Sites, Releases, and Audit Log pages in UI',
      },
    ],
  },
]

// ── Entry type config ─────────────────────────────────────────────────────────

const TYPE_CONFIG = {
  feature:  { label: 'Feature',  bg: 'bg-cyan-dim',   border: 'border-cyan-muted',   text: 'text-cyan-DEFAULT',   icon: Sparkles },
  fix:      { label: 'Fix',      bg: 'bg-amber-dim',  border: 'border-amber-muted',  text: 'text-amber-DEFAULT',  icon: Bug      },
  security: { label: 'Security', bg: 'bg-red-dim',    border: 'border-red-muted',    text: 'text-red-DEFAULT',    icon: Shield   },
  change:   { label: 'Changed',  bg: 'bg-bg-elevated',border: 'border-bg-border',    text: 'text-slate-400',      icon: Wrench   },
}

function EntryBadge({ type }) {
  const cfg = TYPE_CONFIG[type] || TYPE_CONFIG.change
  const Icon = cfg.icon
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-mono px-1.5 py-0.5 rounded border ${cfg.bg} ${cfg.border} ${cfg.text} shrink-0`}>
      <Icon className="w-3 h-3" />
      {cfg.label}
    </span>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function ChangelogPage() {
  const typeCounts = RELEASES.reduce((acc, r) => {
    r.entries.forEach(e => { acc[e.type] = (acc[e.type] || 0) + 1 })
    return acc
  }, {})

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Changelog"
        subtitle={`${RELEASES.length} releases · ${RELEASES.reduce((s, r) => s + r.entries.length, 0)} changes`}
      />

      {/* Summary badges */}
      <div className="flex flex-wrap gap-2 mb-6">
        {Object.entries(typeCounts).map(([type, count]) => {
          const cfg = TYPE_CONFIG[type] || TYPE_CONFIG.change
          const Icon = cfg.icon
          return (
            <span key={type} className={`inline-flex items-center gap-1.5 text-xs font-mono px-2.5 py-1 rounded border ${cfg.bg} ${cfg.border} ${cfg.text}`}>
              <Icon className="w-3.5 h-3.5" />
              {count} {cfg.label}{count !== 1 ? 's' : ''}
            </span>
          )
        })}
      </div>

      {/* Release timeline */}
      <div className="relative">
        {/* Vertical line */}
        <div className="absolute left-[7px] top-2 bottom-2 w-px bg-bg-border" />

        <div className="space-y-8">
          {RELEASES.map((release, ri) => (
            <div key={release.version} className="relative pl-8">
              {/* Timeline dot */}
              <div className={`absolute left-0 top-1.5 w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center
                ${ri === 0
                  ? 'bg-cyan-DEFAULT border-cyan-DEFAULT'
                  : 'bg-bg-surface border-bg-border'
                }`}
              >
                {ri === 0 && <div className="w-1.5 h-1.5 rounded-full bg-bg-base" />}
              </div>

              {/* Release header */}
              <div className="flex items-baseline gap-3 mb-3">
                <div className="flex items-center gap-2">
                  <GitBranch className="w-3.5 h-3.5 text-slate-600" />
                  <span className="font-display font-700 text-slate-100">v{release.version}</span>
                  {ri === 0 && (
                    <span className="text-xs font-mono px-1.5 py-0.5 rounded bg-cyan-dim border border-cyan-muted text-cyan-DEFAULT">
                      latest
                    </span>
                  )}
                </div>
                <span className="text-xs font-mono text-slate-600">{release.date}</span>
                <span className="text-sm text-slate-400">{release.summary}</span>
              </div>

              {/* Entries */}
              <div className="card divide-y divide-bg-border/50">
                {release.entries.map((entry, ei) => (
                  <div key={ei} className="flex items-start gap-3 px-4 py-3">
                    <EntryBadge type={entry.type} />
                    <p className="text-sm text-slate-300 leading-relaxed">{entry.text}</p>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
