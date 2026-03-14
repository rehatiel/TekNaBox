# Teknabox — To-Do List

## Network & Scanning

- [ ] **Network adapter auto-detection** — Detect available network adapters and present them as a dropdown instead of requiring manual entry for each scan type.

- [ ] **Fix monitor module** — The monitor module is not actively pinging. Investigate and fix the ping loop.

- [ ] **Uptime monitor not recording data** — After the bug-fix rebuild, the uptime monitor page shows no data for configured targets. Likely cause: the `customer_id` column added to the `uptime_checks` table (migration 0005) has not been applied to the live database. Run migration 0005 on the server and verify data appears in the monitoring page.

- [ ] **Network monitoring: persistent background service** — Convert network monitoring into a start/stop service that continues running in the background even after navigating away from the page.

- [ ] **Network monitoring: interactive diagram** — Make the network diagram interactive: support zoom, pan/enlarge, and clicking on individual devices for detail.

- [ ] **Network scan report** — Generate a report from scan results showing all detected devices and their gathered information. Produce two formats:
  - Detailed technical report
  - Executive-level summary

- [ ] **VLAN hopping detection** — Add a "VLAN Hopping" item under the Network Tools page that scans for network misconfigurations that could allow VLAN hopping attacks.

## Security

- [ ] **Threat actor security audit** — Conduct a thorough security review of the entire platform (API, agent, frontend, Docker config) from an attacker's perspective. Cover: authentication/authorization flaws, JWT handling, WebSocket security, injection vectors, secrets management, container hardening, network exposure, and agent enrollment security. Document findings and remediate.

## Device Management

- [ ] **One-liner agent install** — Under "Add Device", provide a single command the user can copy and run on the target machine. The command should: download all required agent files, then install and enroll the agent automatically using the enrollment code (no manual script download required).
