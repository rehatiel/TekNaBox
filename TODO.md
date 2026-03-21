# Teknabox — To-Do List

## Network & Scanning

- [x] **Network adapter auto-detection** — Detect available network adapters and present them as a dropdown instead of requiring manual entry for each scan type. ✓ Done

- [ ] **Fix monitor module** — The monitor module is not actively pinging. Investigate and fix the ping loop. *(low priority)*

- [ ] **Uptime monitor not recording data** — After the bug-fix rebuild, the uptime monitor page shows no data for configured targets. Investigate the uptime monitor task and verify data is being stored and retrieved correctly. *(low priority)*

- [x] **Network device history page** — New `DiscoveredDevice` DB table (migration 0006), backend upsert/list/label/delete endpoints, and a new `/network-history` page showing all devices with first/last seen, known toggle, label editing, and search. Auto-populated by background monitoring. ✓ Done

- [x] **Persist network scan running state** — `_svc` now saves `{active, agentId, iface, interval}` to `localStorage` on start/stop and auto-resumes the loop on module init after a page refresh. ✓ Done

- [x] **Hide background ARP scans in Reports** — Background monitoring scans now include `_auto: true` in the task payload. Reports page has a "Hide background scans" checkbox (on by default) that filters out those tasks. ✓ Done

- [x] **Network monitoring: persistent background service** — `_svc` lives at module scope (not component state), so the scan loop keeps running after navigating away from the NetworkDiscovery page. State is also persisted to localStorage and auto-resumed on page refresh. ✓ Done

- [x] **Network monitoring: interactive diagram** — Zoom (scroll wheel, buttons), pan (drag), click node for detail panel. ✓ Done

- [x] **Network scan report** — "Generate Report" button on the Network Map opens a modal with two tabs: Executive Summary (counts, vendor breakdown, recommendations) and Technical Report (full device table sortable by IP). Downloadable as .txt. ✓ Done

- [x] **VLAN hopping detection** — `run_vlan_hop` task (scapy, double-tag + DTP tests) added to Network Tools page with a result renderer showing per-test vulnerable/not-vulnerable status. ✓ Done

- [x] **HTTP monitor dedicated page** — `/http-monitor` page with device selector, URL input, run button, polling, and result table (status, response time, SSL expiry, content match, redirect chain). ✓ Done

- [ ] **SSL certificate expiry dashboard widget** — The `run_ssl_check` task already returns expiry dates. Add a dashboard widget (or dedicated panel on the Monitoring page) showing all certificates expiring within 30/60/90 days across all devices.

- [ ] **Uptime SLA reporting** — Calculate rolling 30-day uptime percentage per target per customer and display it on the Monitoring page. Flag targets below a configurable SLA threshold (e.g. 99.9%).

- [ ] **Alerting thresholds per monitor target** — Allow configurable RTT warn/critical values stored against each MonitorTarget. Trigger an alert when a threshold is breached for a sustained period.

## Alerting & Notifications

- [ ] **Email alerts** — Send email notifications for: device going offline / coming back online, new critical/high findings, task failures, certificate expiry warnings.

- [ ] **Webhook support** — Generic outbound POST to a configurable URL on alert events (device offline, new finding, task failure). Enables integration with any external system without native support.

- [ ] **Slack / Microsoft Teams integration** — Native integration for posting alert messages to a channel, including finding summaries, device status changes, and daily digests.

- [ ] **Alert digest** — Daily or weekly summary email per customer showing: new findings, devices that went offline, tasks that failed, certificates expiring soon.

## Findings & Remediation

- [ ] **Finding assignment** — Allow findings to be assigned to a specific operator with a due date. Show assigned findings in operator's view.

- [ ] **Severity escalation** — Automatically escalate a finding's severity (or send an alert) if it remains unacknowledged past a configurable threshold.

- [ ] **Remediation notes with timestamps** — Extend the finding acknowledgment workflow to allow free-text remediation notes with a full history of who added what and when.

- [ ] **Finding recurrence tracking** — When a scan is re-run and finds a previously closed finding, automatically re-open it and link it to the original. Track recurrence count.

- [ ] **Finding export** — Export findings to CSV or PDF, filterable by severity, device, customer, and date range. For use in client-facing reports.

## Reporting & Export

- [x] **Dedicated result renderers for all task types** — Reports page now covers 28 of 29 task types (all except `run_ad_recon` which is disabled in the UI). ✓ Done

- [ ] **PDF report generation** — On-demand or scheduled PDF reports per customer, with MSP branding. Include executive summary, finding list, uptime stats, and device inventory.

- [ ] **Scheduled reports** — Allow operators to schedule a set of tasks to run automatically (e.g. weekly vuln scan + sysinfo on all devices for a customer) and email the compiled results to a contact.

## Customer & Site Scoping

- [ ] **Customer/site scoped device view** — Add a sidebar or breadcrumb navigation for MSP → Customer → Site → Device hierarchy. Device list should filter by customer and site.

- [ ] **Per-customer dashboard** — A dedicated dashboard view scoped to a single customer showing their devices, findings, uptime, and recent tasks.

- [ ] **Operator-to-customer assignment** — Allow MSP admins to restrict `msp_operator` and `customer_viewer` accounts to specific customers. Enforce this at the API level so scoped operators cannot see other customers' data.

- [ ] **Customer portal (read-only)** — A stripped-down login for end customers to view their own devices, uptime history, and findings — without access to MSP-level controls or other customers' data.

## Device Management

- [x] **One-liner agent install** — `curl -fsSL https://yourserver.com/v1/agent/bootstrap | sudo bash -s -- --secret <SECRET>`. The bootstrap endpoint generates a shell script with the server URL baked in; the package endpoint streams the agent source as a tar.gz. Agent dir mounted read-only into the API container via docker-compose. ✓ Done

- [ ] **Last sysinfo summary on device card** — Show the most recent CPU temp, disk usage, and memory inline on the device list and device detail page without requiring a new task run.

- [ ] **Stale sysinfo warning** — Flag devices where the last completed sysinfo task is older than a configurable threshold (e.g. 7 days).

- [x] **Device notes and tags** — `notes` (text) and `tags` (JSONB array) columns on Device. `PATCH /devices/:id` endpoint. DeviceDetail shows inline edit panel with notes textarea and tag chip input. ✓ Done

- [ ] **Offline reason display** — Distinguish between "never connected", "heartbeat timeout", and "manually revoked" in the device status badge and device detail page.

## Tasks

- [ ] **Scheduled tasks** — Allow operators to schedule any task type on a cron schedule (e.g. daily sysinfo, weekly vuln scan). Store schedule config per device and run via the worker service.

- [ ] **Task templates** — Save a named payload configuration (e.g. "Weekly vuln scan — Customer A targets") so operators don't re-enter the same targets and settings each time.

- [ ] **Bulk task dispatch** — Run the same task across multiple selected devices simultaneously from the device list view.

- [ ] **Task retry button** — Add a one-click retry button on failed or timed-out tasks in the task history view, pre-filling the original payload.

- [ ] **Task cancellation button** — The kill message exists at the agent level but there is no cancel button in the UI. Add a cancel action on queued or running tasks.

## Security

- [ ] **Threat actor security audit** — Conduct a thorough security review of the entire platform (API, agent, frontend, Docker config) from an attacker's perspective. Cover: authentication/authorization flaws, JWT handling, WebSocket security, injection vectors, secrets management, container hardening, network exposure, and agent enrollment security. Document findings and remediate.

- [x] **Multi-factor authentication (MFA)** — TOTP-based MFA (pyotp) on operator accounts. Login issues an mfa_challenge token if MFA enabled; confirmed via `/auth/mfa/confirm`. Setup/enable/disable via `/mfa/setup`, `/mfa/enable`, `/mfa/disable`. Users page shows MFA status with setup/disable UI and admin force-reset. ✓ Done

- [x] **Session revocation** — JWT `jti` claim added to operator tokens. `POST /auth/logout` stores JTI in Redis blocklist with TTL = remaining token lifetime. Auth dependency checks blocklist on every request. ✓ Done

- [ ] **Rate limiting on task dispatch** — Add per-operator rate limiting on the task dispatch endpoint to prevent an authenticated account from flooding a device with tasks.

- [ ] **SSRF validation in http_monitor** — Validate that http_monitor target URLs do not resolve to RFC-1918 / loopback addresses before dispatching to the agent, to prevent server-side request forgery on the local network.

## UX & Interface

- [ ] **Global device search** — A search bar in the navigation that lets operators type a hostname, IP, or tag and jump directly to that device.

- [ ] **In-app notification bell** — A notification area in the header showing recent events: devices going offline, new critical findings, task completions, certificate expiry warnings.

- [ ] **Table sorting and filtering** — Most data tables (devices, tasks, findings) are unsortable. Add sortable columns and a filter input for lists with many rows.

- [ ] **Collapsible sidebar** — Allow the navigation sidebar to collapse to icons only, giving more horizontal space to the map and table views.

- [ ] **Breadcrumb navigation** — Show the MSP → Customer → Site → Device hierarchy in the page header when viewing scoped resources.

- [ ] **Dark / light theme toggle** — The interface is currently hardcoded dark. Add a toggle stored in user preferences.

- [ ] **Keyboard shortcuts** — Add keyboard shortcuts for common actions (e.g. `G D` → go to Devices, `G F` → go to Findings, `R` → refresh current page data) for power users.

## Operational & Infrastructure

- [ ] **PostgreSQL backup strategy** — Document and automate a backup/restore procedure for the PostgreSQL volume. Consider a scheduled `pg_dump` to object storage with retention policy.

- [ ] **Audit log archival** — Audit logs grow indefinitely. Add a configurable retention policy (e.g. keep 12 months in the database, export older records to compressed storage).

- [ ] **Prometheus metrics endpoint** — Expose `/metrics` from the API for scraping by Prometheus. Include: active device connections, task queue depth, task success/failure rate, Redis pub/sub message volume, API request latency histograms.

- [ ] **Migration runner visibility** — If a database migration fails at startup, the API should halt with a clear error rather than starting with an inconsistent schema. Add explicit migration status logging.
