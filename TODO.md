# Teknabox — To-Do List

## Network & Scanning

- [x] **Network adapter auto-detection** — Detect available network adapters and present them as a dropdown instead of requiring manual entry for each scan type. ✓ Done

- [x] **Network device history page** — New `DiscoveredDevice` DB table, backend upsert/list/label/delete endpoints, and a new `/network-history` page showing all devices with first/last seen, known toggle, label editing, and search. Auto-populated by background monitoring. ✓ Done

- [x] **Persist network scan running state** — `_svc` saves `{active, agentId, iface, interval}` to `localStorage` on start/stop and auto-resumes on page refresh. ✓ Done

- [x] **Hide background ARP scans in Reports** — Background monitoring scans include `_auto: true` in the task payload. Reports page has a "Hide background scans" checkbox (on by default) that filters out those tasks. ✓ Done

- [x] **Network monitoring: persistent background service** — `_svc` lives at module scope so the scan loop keeps running after navigating away from the NetworkDiscovery page. ✓ Done

- [x] **Network monitoring: interactive diagram** — Zoom (scroll wheel, buttons), pan (drag), click node for detail panel. ✓ Done

- [x] **Network scan report** — "Generate Report" button on the Network Map opens a modal with Executive Summary and Technical Report tabs. Downloadable as .txt. ✓ Done

- [x] **VLAN hopping detection** — `run_vlan_hop` task (scapy, double-tag + DTP tests) added to Network Tools page with a result renderer. ✓ Done

- [x] **HTTP monitor dedicated page** — `/http-monitor` page with device selector, URL input, run button, polling, and result table (status, response time, SSL expiry, content match, redirect chain). ✓ Done

- [ ] **SSL certificate expiry dashboard widget** — Add a dashboard widget showing all certificates expiring within 30/60/90 days across all devices (data already collected by `run_ssl_check` and HTTP monitors).

- [ ] **Uptime SLA reporting** — Calculate rolling 30-day uptime percentage per monitor per customer. Flag monitors below a configurable SLA threshold (e.g. 99.9%).

## Uptime Monitoring

- [x] **Uptime Kuma-style monitoring** — Completely rebuilt as agent-based multi-type monitoring (ping/ICMP, TCP port, HTTP(S), DNS). Agent runs checks on configurable intervals and sends results to the server. Uptime Kuma-style dashboard with 60-tick history bar, live status dots, expandable RTT charts, jitter, packet loss, SSL expiry tracking, and 30s auto-refresh. Monitor config pushed to agent on every WebSocket connect. ✓ Done

- [x] **Monitor email alerts** — Per-monitor alert with configurable consecutive-failure threshold. Sends down and recovery emails via SMTP. ✓ Done

- [ ] **RTT threshold alerts** — Configurable warn/critical RTT values per monitor. Trigger an alert when latency exceeds a threshold for a sustained period (currently only alerts on outright failure).

- [ ] **Webhook / Slack alerts** — Generic outbound POST to a configurable URL on alert events (monitor down, device offline, new finding). Enables integration with Slack, Teams, PagerDuty, etc.

- [ ] **Alert digest** — Daily or weekly summary email per customer: monitors that went down, devices that went offline, tasks that failed, certificates expiring soon.

## Alerting & Notifications

- [x] **In-app notification bell** — Notification bell in the header showing recent events. ✓ Done

- [ ] **Device offline / online email alerts** — Send email when a device stops sending heartbeats or reconnects.

- [ ] **New finding email alerts** — Notify on new critical/high findings.

## Findings & Remediation

- [ ] **Finding assignment** — Allow findings to be assigned to a specific operator with a due date.

- [ ] **Severity escalation** — Automatically escalate a finding's severity if it remains unacknowledged past a configurable threshold.

- [ ] **Remediation notes with timestamps** — Extend the finding acknowledgment workflow to allow free-text notes with a full history of who added what and when.

- [ ] **Finding recurrence tracking** — When a scan is re-run and finds a previously closed finding, re-open it and link it to the original. Track recurrence count.

- [ ] **Finding export** — Export findings to CSV or PDF, filterable by severity, device, customer, and date range.

## Reporting & Export

- [x] **Dedicated result renderers for all task types** — Reports page covers all major task types. ✓ Done

- [ ] **PDF report generation** — On-demand or scheduled PDF reports per customer with executive summary, finding list, uptime stats, and device inventory.

- [ ] **Scheduled reports** — Schedule a set of tasks to run automatically (e.g. weekly vuln scan + sysinfo) and email the compiled results to a contact.

## Customer & Site Scoping

- [x] **Per-customer dashboard** — `/customers/:id` dashboard scoped to a single customer showing their devices, findings, uptime, and recent tasks. ✓ Done

- [ ] **Customer/site scoped device view** — Filter device list by customer and site in a sidebar or breadcrumb navigation.

- [ ] **Operator-to-customer assignment** — Allow MSP admins to restrict `msp_operator` accounts to specific customers. Enforce at the API level.

- [ ] **Customer portal (read-only)** — A stripped-down login for end customers to view their own devices, uptime history, and findings.

## Device Management

- [x] **One-liner agent install** — `curl -fsSL https://yourserver.com/v1/agent/bootstrap | sudo bash -s -- --secret <SECRET>`. Bootstrap endpoint generates a shell script with server URL baked in; package endpoint streams the agent as a tar.gz. ✓ Done

- [x] **Device notes and tags** — `notes` and `tags` columns on Device. Inline edit panel on DeviceDetail. ✓ Done

- [x] **Prospecting device data preservation** — When a prospecting device is "deleted", it is archived (status=REVOKED, revoke_reason="archived") rather than hard-deleted. All associated tasks, findings, AD reports, and discovered devices are preserved. Archived devices are hidden from the default device list. ✓ Done

- [ ] **Last sysinfo summary on device card** — Show the most recent CPU temp, disk usage, and memory inline on the device list without requiring a new task run.

- [ ] **Stale sysinfo warning** — Flag devices where the last completed sysinfo task is older than a configurable threshold (e.g. 7 days).

- [ ] **Offline reason display** — Distinguish between "never connected", "heartbeat timeout", and "manually revoked" in the device status badge and device detail page.

## Tasks

- [ ] **Scheduled tasks** — Allow operators to schedule any task type on a cron schedule (e.g. daily sysinfo, weekly vuln scan). Store schedule config per device and run via the worker service.

- [ ] **Task templates** — Save a named payload configuration so operators don't re-enter the same targets and settings each time.

- [ ] **Bulk task dispatch** — Run the same task across multiple selected devices simultaneously from the device list view.

- [ ] **Task retry button** — One-click retry on failed or timed-out tasks, pre-filling the original payload.

- [ ] **Task cancellation button** — Cancel action on queued or running tasks in the UI (API endpoint already exists).

## Security

- [x] **Multi-factor authentication (MFA)** — TOTP-based MFA on operator accounts. Login issues an mfa_challenge token if MFA is enabled; confirmed via `/auth/mfa/confirm`. Setup/enable/disable via dedicated endpoints. Users page shows MFA status with setup/disable UI and admin force-reset. ✓ Done

- [x] **Session revocation** — JWT `jti` claim on operator tokens. `POST /auth/logout` stores JTI in Redis blocklist with TTL = remaining token lifetime. Auth dependency checks blocklist on every request. ✓ Done

- [ ] **Threat actor security audit** — Full security review of the platform (API, agent, frontend, Docker config). Cover: authentication/authorization, JWT handling, WebSocket security, injection vectors, secrets management, container hardening, network exposure, agent enrollment security.

- [ ] **Rate limiting on task dispatch** — Per-operator rate limiting on task dispatch to prevent flooding a device with tasks.

- [ ] **SSRF validation in http_monitor** — Validate that HTTP monitor target URLs do not resolve to RFC-1918 / loopback addresses before dispatching to the agent.

## UX & Interface

- [x] **Global device search** — Ctrl+K command palette for searching devices by hostname, IP, or tag. ✓ Done

- [x] **Collapsible sidebar** — Navigation sidebar collapses to icons only. State persisted to localStorage. ✓ Done

- [x] **Breadcrumb navigation** — Page hierarchy shown in the header. ✓ Done

- [x] **Dark / light theme toggle** — Toggle in the top-right corner, stored in localStorage. ✓ Done

- [x] **Keyboard shortcuts** — `G D/F/T/M/N/S/W/A` navigation chords, `Ctrl+K` device search, `?` shortcut reference panel. ✓ Done

- [ ] **Table sorting and filtering** — Most data tables (devices, tasks, findings) are unsortable. Add sortable columns and filter inputs for large lists.

## Operational & Infrastructure

- [ ] **PostgreSQL backup strategy** — Document and automate a backup/restore procedure. Consider scheduled `pg_dump` to object storage with retention policy.

- [ ] **Audit log archival** — Audit logs grow indefinitely. Add a configurable retention policy (e.g. keep 12 months in DB, export older records to compressed storage).

- [ ] **Prometheus metrics endpoint** — Expose `/metrics` from the API. Include: active device connections, task queue depth, task success/failure rates, Redis pub/sub volume, API request latency histograms.
