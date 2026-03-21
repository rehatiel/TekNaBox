import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";

// ── Severity helpers ──────────────────────────────────────────────────────────

const SEV_ORDER = ["critical", "high", "medium", "low", "info"];

const SEV_STYLE = {
  critical: { badge: "bg-red-900/60 text-red-300 border-red-700",    dot: "bg-red-500",    row: "border-l-red-500" },
  high:     { badge: "bg-orange-900/60 text-orange-300 border-orange-700", dot: "bg-orange-400", row: "border-l-orange-400" },
  medium:   { badge: "bg-yellow-900/60 text-yellow-300 border-yellow-700", dot: "bg-yellow-400", row: "border-l-yellow-400" },
  low:      { badge: "bg-blue-900/60 text-blue-300 border-blue-700",  dot: "bg-blue-400",   row: "border-l-blue-400" },
  info:     { badge: "bg-gray-800 text-gray-400 border-gray-700",     dot: "bg-gray-500",   row: "border-l-gray-600" },
};

function SevBadge({ sev }) {
  const s = SEV_STYLE[sev] || SEV_STYLE.info;
  return (
    <span className={`text-xs font-bold uppercase px-2 py-0.5 rounded border ${s.badge}`}>
      {sev}
    </span>
  );
}

// ── Run Scan Modal ────────────────────────────────────────────────────────────

function ScanModal({ devices, onClose, onStarted }) {
  const activeDevices = devices.filter(d => d.status === "active");
  const customers = [...new Map(
    activeDevices.filter(d => d.customer_id).map(d => [d.customer_id, d.customer_name || d.customer_id])
  ).entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  const [modalCustomer, setModalCustomer] = useState("");
  const scopedDevices = modalCustomer ? activeDevices.filter(d => d.customer_id === modalCustomer) : activeDevices;
  const [form, setForm] = useState({
    device_id:  activeDevices[0]?.id || devices[0]?.id || "",
    scan_type:  "audit",
    targets:    "",
    intensity:  "safe",
    top_ports:  100,
  });
  const [running, setRunning] = useState(false);
  const [error, setError]     = useState("");

  const selectedDevice = devices.find(d => d.id === form.device_id);
  const isOffline = selectedDevice && selectedDevice.status !== "active";

  async function handleStart() {
    const targetList = form.targets.split(/[\n,\s]+/).map(t => t.trim()).filter(Boolean);
    if (!form.device_id) { setError("Select a device"); return; }
    if (!targetList.length) { setError("Enter at least one target IP or CIDR"); return; }
    setRunning(true); setError("");
    try {
      const path = form.scan_type === "vuln"
        ? `/v1/devices/${form.device_id}/scan/vuln`
        : `/v1/devices/${form.device_id}/scan/audit`;
      const body = form.scan_type === "vuln"
        ? { targets: targetList, intensity: form.intensity, top_ports: form.top_ports }
        : { targets: targetList };
      const res = await api.post(path, body);
      onStarted(res.task_id);
      onClose();
    } catch (e) {
      setError(e.message || "Failed to start scan");
      setRunning(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-gray-900 border border-gray-700 rounded-lg p-6 w-full max-w-lg shadow-xl">
        <h2 className="text-lg font-semibold text-white mb-4">New Security Scan</h2>
        {error && <div className="text-red-400 text-sm mb-4 bg-red-900/20 border border-red-800 rounded p-3">{error}</div>}

        <div className="space-y-4">
          <div>
            <label className="block text-xs text-gray-400 mb-1">Device</label>
            {customers.length > 1 && (
              <select className="w-full bg-gray-800 border border-gray-600 rounded px-3 py-2 text-white text-sm mb-2"
                value={modalCustomer} onChange={e => { setModalCustomer(e.target.value); setForm(f => ({ ...f, device_id: "" })); }}>
                <option value="">All customers</option>
                {customers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            )}
            <select className="w-full bg-gray-800 border border-gray-600 rounded px-3 py-2 text-white text-sm"
              value={form.device_id} onChange={e => setForm(f => ({ ...f, device_id: e.target.value }))}>
              <option value="">— select device —</option>
              {scopedDevices.map(d => <option key={d.id} value={d.id}>{d.name} {d.status !== "active" ? "(offline)" : ""}</option>)}
            </select>
            {isOffline && (
              <div className="mt-1.5 text-amber-400 text-xs bg-amber-900/20 border border-amber-800 rounded p-2">
                ⚠ This device is offline — the scan will be queued and run when it reconnects.
              </div>
            )}
          </div>

          <div>
            <label className="block text-xs text-gray-400 mb-2">Scan Type</label>
            <div className="grid grid-cols-2 gap-2">
              {[
                ["audit",  "Security Audit",  "Checks for telnet, anonymous FTP, weak SSH, default creds, SNMP defaults. Fast and safe."],
                ["vuln",   "Vuln Scan",       "Nmap script scan. More comprehensive, can be intrusive on aggressive intensity."],
              ].map(([val, label, desc]) => (
                <label key={val} className={`p-3 rounded-lg border cursor-pointer transition-colors ${
                  form.scan_type === val ? "border-cyan-700 bg-cyan-900/20" : "border-gray-700 hover:border-gray-600"
                }`}>
                  <input type="radio" name="scan_type" value={val} checked={form.scan_type === val}
                    onChange={() => setForm(f => ({ ...f, scan_type: val }))} className="hidden" />
                  <div className="text-white text-sm font-medium">{label}</div>
                  <div className="text-gray-500 text-xs mt-1">{desc}</div>
                </label>
              ))}
            </div>
          </div>

          {form.scan_type === "vuln" && (
            <div>
              <label className="block text-xs text-gray-400 mb-2">Intensity</label>
              <div className="flex gap-2">
                {[["safe","Safe"],["default","Default"],["aggressive","Aggressive"]].map(([val, label]) => (
                  <button key={val} onClick={() => setForm(f => ({ ...f, intensity: val }))}
                    className={`flex-1 py-1.5 rounded text-sm transition-colors ${
                      form.intensity === val ? "bg-cyan-700 text-white" : "bg-gray-800 text-gray-400 hover:text-white"
                    }`}>
                    {label}
                  </button>
                ))}
              </div>
              {form.intensity === "aggressive" && (
                <div className="mt-2 text-yellow-400 text-xs bg-yellow-900/20 border border-yellow-800 rounded p-2">
                  ⚠ Aggressive mode runs intrusive scripts. Only use with explicit permission.
                </div>
              )}
            </div>
          )}

          {form.scan_type === "vuln" && (
            <div>
              <label className="block text-xs text-gray-400 mb-2">Port Scope</label>
              <div className="flex gap-2">
                {[[100,"Top 100"],[500,"Top 500"],[1000,"Top 1000"]].map(([n, label]) => (
                  <button key={n} onClick={() => setForm(f => ({ ...f, top_ports: n }))}
                    className={`flex-1 py-1.5 rounded text-sm transition-colors ${
                      form.top_ports === n ? "bg-cyan-700 text-white" : "bg-gray-800 text-gray-400 hover:text-white"
                    }`}>
                    {label}
                  </button>
                ))}
              </div>
              <div className="text-xs text-gray-600 mt-1">Scans nmap's most common ports. Top 500+ adds significant scan time.</div>
            </div>
          )}

          <div>
            <label className="block text-xs text-gray-400 mb-1">Targets (IPs or CIDRs, one per line)</label>
            <textarea
              className="w-full bg-gray-800 border border-gray-600 rounded px-3 py-2 text-white text-sm font-mono h-24 resize-none"
              placeholder={"192.168.1.1\n192.168.1.0/24\n10.0.0.5"}
              value={form.targets}
              onChange={e => setForm(f => ({ ...f, targets: e.target.value }))}
            />
          </div>
        </div>

        <div className="flex gap-2 mt-5 justify-end">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors">Cancel</button>
          <button onClick={handleStart} disabled={running}
            className="px-4 py-2 bg-cyan-600 hover:bg-cyan-500 text-white rounded text-sm font-medium transition-colors disabled:opacity-50">
            {running ? "Starting…" : "Start Scan"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Finding Detail Drawer ─────────────────────────────────────────────────────

function FindingDrawer({ finding, onClose, onAcknowledged }) {
  const [notes, setNotes] = useState(finding.notes || "");
  const [saving, setSaving] = useState(false);

  async function handleAck() {
    setSaving(true);
    try {
      const updated = await api.post(`/v1/findings/${finding.id}/acknowledge`, { notes });
      onAcknowledged(updated);
      onClose();
    } catch (e) {
      console.error(e);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex justify-end z-50" onClick={onClose}>
      <div className="w-full max-w-lg bg-gray-900 border-l border-gray-700 h-full overflow-y-auto shadow-2xl"
        onClick={e => e.stopPropagation()}>
        <div className="sticky top-0 bg-gray-900 border-b border-gray-700 px-5 py-4 flex items-start justify-between">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <SevBadge sev={finding.severity} />
              {finding.scan_type && (
                <span className="text-xs text-gray-500 bg-gray-800 px-2 py-0.5 rounded">{finding.scan_type.replace("_", " ")}</span>
              )}
            </div>
            <h2 className="text-white font-semibold leading-tight">{finding.title}</h2>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-xl ml-4 mt-1 transition-colors">✕</button>
        </div>

        <div className="p-5 space-y-5">
          {/* Target info */}
          <div className="grid grid-cols-2 gap-3">
            {[
              ["Target IP",   finding.target_ip   || "—"],
              ["Port",        finding.target_port  ? `${finding.target_port}/${finding.protocol || "tcp"}` : "—"],
              ["Script",      finding.script_id    || "—"],
              ["CVE",         finding.cve_id       || "—"],
              ["CVSS",        finding.cvss_score != null ? finding.cvss_score.toFixed(1) : "—"],
              ["Found",       new Date(finding.found_at).toLocaleString()],
              ["Status",      finding.acknowledged ? "Acknowledged" : "Open"],
            ].map(([label, val]) => (
              <div key={label} className="bg-gray-800/60 rounded p-3">
                <div className="text-xs text-gray-500 mb-0.5">{label}</div>
                <div className={`text-sm font-medium ${label === "Status" && finding.acknowledged ? "text-green-400" : "text-white"}`}>{val}</div>
              </div>
            ))}
          </div>

          {/* Description */}
          {finding.description && (
            <div>
              <div className="text-xs text-gray-500 mb-2 uppercase tracking-wider">Description</div>
              <div className="text-gray-300 text-sm leading-relaxed bg-gray-800/40 rounded p-3">
                {finding.description}
              </div>
            </div>
          )}

          {/* Raw output */}
          {finding.raw_output && (
            <div>
              <div className="text-xs text-gray-500 mb-2 uppercase tracking-wider">Raw Output</div>
              <pre className="text-gray-400 text-xs bg-gray-950 rounded p-3 overflow-x-auto whitespace-pre-wrap max-h-48">
                {finding.raw_output}
              </pre>
            </div>
          )}

          {/* Acknowledge */}
          {!finding.acknowledged && (
            <div className="border-t border-gray-700 pt-5">
              <div className="text-xs text-gray-500 mb-2 uppercase tracking-wider">Acknowledge / Notes</div>
              <textarea
                className="w-full bg-gray-800 border border-gray-600 rounded px-3 py-2 text-white text-sm h-20 resize-none mb-3"
                placeholder="Optional notes — e.g. accepted risk, remediation plan…"
                value={notes}
                onChange={e => setNotes(e.target.value)}
              />
              <button onClick={handleAck} disabled={saving}
                className="w-full py-2 bg-green-700 hover:bg-green-600 text-white rounded text-sm font-medium transition-colors disabled:opacity-50">
                {saving ? "Saving…" : "Mark Acknowledged"}
              </button>
            </div>
          )}

          {finding.acknowledged && (
            <div className="border-t border-gray-700 pt-4 flex items-center justify-between">
              <span className="text-green-400 text-sm">✓ Acknowledged</span>
              <button onClick={handleAck} disabled={saving}
                className="text-xs text-gray-500 hover:text-white transition-colors">
                Reopen
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function Findings() {
  const navigate = useNavigate();
  const [findings, setFindings]   = useState([]);
  const [devices, setDevices]     = useState([]);
  const [loading, setLoading]     = useState(true);
  const [showScan, setShowScan]   = useState(false);
  const [selected, setSelected]   = useState(null);
  const [activeTask, setActiveTask] = useState(null);  // polling task_id

  // Filters
  const [filterSev,      setFilterSev]      = useState("all");
  const [filterType,     setFilterType]     = useState("all");
  const [filterAck,      setFilterAck]      = useState("open");
  const [filterDev,      setFilterDev]      = useState("all");
  const [filterCustomer, setFilterCustomer] = useState("all");

  const load = useCallback(async () => {
    try {
      const [f, d] = await Promise.all([
        api.get("/v1/findings"),
        api.get("/v1/devices"),
      ]);
      setFindings(f);
      setDevices(Array.isArray(d) ? d : d.devices || []);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Poll active task until complete
  useEffect(() => {
    if (!activeTask) return;
    const interval = setInterval(async () => {
      try {
        // Use the global tasks endpoint instead of polling per-device
        const allTasks = await api.getAllTasks({ limit: 50 });
        const task = allTasks.find ? allTasks.find(t => t.id === activeTask)
          : (allTasks.tasks || []).find(t => t.id === activeTask);
        if (task) {
          if (task.status === "completed" || task.status === "failed" || task.status === "timeout") {
            clearInterval(interval);
            setActiveTask(null);
            load();
          }
        }
      } catch { /* keep polling */ }
    }, 4000);
    return () => clearInterval(interval);
  }, [activeTask, load]);

  // Derive unique customers from loaded devices
  const customers = [...new Map(
    devices.filter(d => d.customer_id).map(d => [d.customer_id, d.customer_name || d.customer_id])
  ).entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));

  const deviceCustomerMap = Object.fromEntries(devices.map(d => [d.id, d.customer_id]));

  // Filtered findings
  const filtered = findings.filter(f => {
    if (filterSev      !== "all"  && f.severity  !== filterSev)  return false;
    if (filterType     !== "all"  && f.scan_type !== filterType) return false;
    if (filterDev      !== "all"  && f.device_id !== filterDev)  return false;
    if (filterCustomer !== "all"  && deviceCustomerMap[f.device_id] !== filterCustomer) return false;
    if (filterAck  === "open"  && f.acknowledged)  return false;
    if (filterAck  === "acked" && !f.acknowledged) return false;
    return true;
  });

  // Counts
  const counts = SEV_ORDER.reduce((acc, s) => {
    acc[s] = findings.filter(f => f.severity === s && !f.acknowledged).length;
    return acc;
  }, {});

  const deviceMap = Object.fromEntries(devices.map(d => [d.id, d.name]));

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Security Findings</h1>
          <p className="text-gray-400 text-sm mt-1">
            Vuln scans and security audits across all devices
          </p>
        </div>
        <div className="flex gap-2 items-center">
          {activeTask && (
            <span className="text-cyan-400 text-sm animate-pulse">Scan running…</span>
          )}
          <button onClick={load} className="px-3 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded text-sm transition-colors">↻</button>
          <button onClick={() => setShowScan(true)}
            className="px-4 py-2 bg-cyan-600 hover:bg-cyan-500 text-white rounded text-sm font-medium transition-colors">
            + New Scan
          </button>
        </div>
      </div>

      {/* Severity summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        {SEV_ORDER.map(s => (
          <button key={s} onClick={() => setFilterSev(filterSev === s ? "all" : s)}
            className={`rounded-lg border p-3 text-left transition-colors ${
              filterSev === s ? "border-gray-500 bg-gray-700" : "border-gray-700 bg-gray-900 hover:bg-gray-800"
            }`}>
            <div className={`w-2 h-2 rounded-full mb-2 ${SEV_STYLE[s].dot}`} />
            <div className={`text-2xl font-bold ${counts[s] > 0 ? "text-white" : "text-gray-600"}`}>{counts[s]}</div>
            <div className="text-xs text-gray-500 capitalize mt-0.5">{s}</div>
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-center">
        <select className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-white text-sm"
          value={filterAck} onChange={e => setFilterAck(e.target.value)}>
          <option value="open">Open only</option>
          <option value="acked">Acknowledged</option>
          <option value="all">All</option>
        </select>
        <select className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-white text-sm"
          value={filterType} onChange={e => setFilterType(e.target.value)}>
          <option value="all">All scan types</option>
          <option value="vuln_scan">Vuln scan</option>
          <option value="security_audit">Security audit</option>
        </select>
        {customers.length > 1 && (
          <select className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-white text-sm"
            value={filterCustomer} onChange={e => { setFilterCustomer(e.target.value); setFilterDev("all"); }}>
            <option value="all">All customers</option>
            {customers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        )}
        <select className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-white text-sm"
          value={filterDev} onChange={e => setFilterDev(e.target.value)}>
          <option value="all">All devices</option>
          {devices
            .filter(d => filterCustomer === "all" || d.customer_id === filterCustomer)
            .map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        {(filterSev !== "all" || filterType !== "all" || filterDev !== "all" || filterAck !== "open" || filterCustomer !== "all") && (
          <button onClick={() => { setFilterSev("all"); setFilterType("all"); setFilterDev("all"); setFilterAck("open"); setFilterCustomer("all"); }}
            className="text-xs text-gray-500 hover:text-white transition-colors">
            Clear filters
          </button>
        )}
        <span className="text-gray-600 text-sm ml-auto">{filtered.length} findings</span>
      </div>

      {/* Findings list */}
      {loading ? (
        <div className="text-center py-20 text-gray-500">Loading…</div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-20">
          <div className="text-gray-500 text-lg mb-2">
            {findings.length === 0 ? "No findings yet" : "No findings match the current filters"}
          </div>
          {findings.length === 0 && (
            <p className="text-gray-600 text-sm mb-6">Run a security audit or vuln scan to start collecting findings.</p>
          )}
        </div>
      ) : (
        <div className="bg-gray-900 border border-gray-700 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-700 text-left">
                <th className="px-4 py-3 text-gray-400 font-medium w-24">Severity</th>
                <th className="px-4 py-3 text-gray-400 font-medium">Finding</th>
                <th className="px-4 py-3 text-gray-400 font-medium">Target</th>
                <th className="px-4 py-3 text-gray-400 font-medium">Device</th>
                <th className="px-4 py-3 text-gray-400 font-medium">Type</th>
                <th className="px-4 py-3 text-gray-400 font-medium">Found</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(f => (
                <tr key={f.id}
                  onClick={() => setSelected(f)}
                  className={`border-b border-gray-800 border-l-2 hover:bg-gray-800/40 cursor-pointer transition-colors ${SEV_STYLE[f.severity]?.row || "border-l-gray-600"} ${f.acknowledged ? "opacity-50" : ""}`}>
                  <td className="px-4 py-3">
                    <SevBadge sev={f.severity} />
                  </td>
                  <td className="px-4 py-3">
                    <div className="text-white font-medium">{f.title}</div>
                    <div className="flex gap-2 mt-0.5">
                      {f.cve_id && <span className="text-xs text-blue-400">{f.cve_id}</span>}
                      {f.cvss_score && <span className="text-xs font-mono text-gray-500">CVSS {f.cvss_score.toFixed(1)}</span>}
                    </div>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-gray-300">
                    {f.target_ip || "—"}
                    {f.target_port && <span className="text-gray-500">:{f.target_port}</span>}
                  </td>
                  <td className="px-4 py-3 text-gray-300 text-xs">
                    <button onClick={e => { e.stopPropagation(); navigate(`/devices/${f.device_id}`); }}
                      className="hover:text-cyan-400 transition-colors">
                      {deviceMap[f.device_id] || f.device_id.slice(0,8) + "…"}
                    </button>
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-xs text-gray-500 bg-gray-800 px-2 py-0.5 rounded">
                      {f.scan_type?.replace("_", " ")}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-500 text-xs">
                    {new Date(f.found_at).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-3 text-gray-600 text-xs">
                    {f.acknowledged && <span className="text-green-600">✓</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showScan && (
        <ScanModal
          devices={devices}
          onClose={() => setShowScan(false)}
          onStarted={taskId => { setActiveTask(taskId); }}
        />
      )}

      {selected && (
        <FindingDrawer
          finding={selected}
          onClose={() => setSelected(null)}
          onAcknowledged={updated => {
            setFindings(prev => prev.map(f => f.id === updated.id ? updated : f));
            setSelected(null);
          }}
        />
      )}
    </div>
  );
}
