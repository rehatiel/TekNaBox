import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { Search, ChevronUp, ChevronDown } from "lucide-react";

// ── Severity helpers ──────────────────────────────────────────────────────────

const SEV_ORDER = ["critical", "high", "medium", "low", "info"];

const SEV_STYLE = {
  critical: { badge: "bg-red-dim text-red-bright border border-red-muted",       dot: "bg-red-DEFAULT",    row: "border-l-red-DEFAULT" },
  high:     { badge: "bg-orange-900/60 text-orange-300 border border-orange-700", dot: "bg-orange-400",     row: "border-l-orange-400" },
  medium:   { badge: "bg-amber-dim text-amber-bright border border-amber-muted",  dot: "bg-amber-DEFAULT",  row: "border-l-amber-DEFAULT" },
  low:      { badge: "bg-blue-900/60 text-blue-300 border border-blue-700",       dot: "bg-blue-400",       row: "border-l-blue-400" },
  info:     { badge: "bg-bg-elevated text-slate-500 border border-bg-border",     dot: "bg-slate-600",      row: "border-l-slate-700" },
};

function SevBadge({ sev }) {
  const s = SEV_STYLE[sev] || SEV_STYLE.info;
  return (
    <span className={`text-xs font-bold uppercase px-2 py-0.5 rounded ${s.badge}`}>
      {sev}
    </span>
  );
}

// ── Sort header helper ────────────────────────────────────────────────────────

function SortTh({ label, sortKey, currentKey, currentDir, onSort, className = '' }) {
  const active = currentKey === sortKey;
  return (
    <th
      className={`px-4 py-3 text-slate-500 font-medium text-left cursor-pointer select-none hover:text-slate-300 transition-colors ${className}`}
      onClick={() => onSort(sortKey)}
    >
      <span className="flex items-center gap-1">
        {label}
        {active
          ? currentDir === 'asc'
            ? <ChevronUp className="w-3 h-3" />
            : <ChevronDown className="w-3 h-3" />
          : <ChevronDown className="w-3 h-3 opacity-20" />
        }
      </span>
    </th>
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
      <div className="bg-bg-surface border border-bg-border rounded-lg p-6 w-full max-w-lg shadow-xl">
        <h2 className="text-lg font-semibold text-slate-100 mb-4">New Security Scan</h2>
        {error && <div className="text-red-DEFAULT text-sm mb-4 bg-red-dim border border-red-muted rounded p-3">{error}</div>}

        <div className="space-y-4">
          <div>
            <label className="block text-xs text-slate-500 mb-1">Device</label>
            {customers.length > 1 && (
              <select className="w-full bg-bg-elevated border border-bg-border rounded px-3 py-2 text-slate-200 text-sm mb-2"
                value={modalCustomer} onChange={e => { setModalCustomer(e.target.value); setForm(f => ({ ...f, device_id: "" })); }}>
                <option value="">All customers</option>
                {customers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            )}
            <select className="w-full bg-bg-elevated border border-bg-border rounded px-3 py-2 text-slate-200 text-sm"
              value={form.device_id} onChange={e => setForm(f => ({ ...f, device_id: e.target.value }))}>
              <option value="">— select device —</option>
              {scopedDevices.map(d => <option key={d.id} value={d.id}>{d.name} {d.status !== "active" ? "(offline)" : ""}</option>)}
            </select>
            {isOffline && (
              <div className="mt-1.5 text-amber-DEFAULT text-xs bg-amber-dim border border-amber-muted rounded p-2">
                ⚠ This device is offline — the scan will be queued and run when it reconnects.
              </div>
            )}
          </div>

          <div>
            <label className="block text-xs text-slate-500 mb-2">Scan Type</label>
            <div className="grid grid-cols-2 gap-2">
              {[
                ["audit",  "Security Audit",  "Checks for telnet, anonymous FTP, weak SSH, default creds, SNMP defaults. Fast and safe."],
                ["vuln",   "Vuln Scan",       "Nmap script scan. More comprehensive, can be intrusive on aggressive intensity."],
              ].map(([val, label, desc]) => (
                <label key={val} className={`p-3 rounded-lg border cursor-pointer transition-colors ${
                  form.scan_type === val ? "border-cyan-muted bg-cyan-dim" : "border-bg-border hover:border-bg-elevated"
                }`}>
                  <input type="radio" name="scan_type" value={val} checked={form.scan_type === val}
                    onChange={() => setForm(f => ({ ...f, scan_type: val }))} className="hidden" />
                  <div className="text-slate-200 text-sm font-medium">{label}</div>
                  <div className="text-slate-600 text-xs mt-1">{desc}</div>
                </label>
              ))}
            </div>
          </div>

          {form.scan_type === "vuln" && (
            <div>
              <label className="block text-xs text-slate-500 mb-2">Intensity</label>
              <div className="flex gap-2">
                {[["safe","Safe"],["default","Default"],["aggressive","Aggressive"]].map(([val, label]) => (
                  <button key={val} onClick={() => setForm(f => ({ ...f, intensity: val }))}
                    className={`flex-1 py-1.5 rounded text-sm transition-colors ${
                      form.intensity === val ? "bg-cyan-DEFAULT text-white" : "bg-bg-elevated text-slate-500 hover:text-slate-200"
                    }`}>
                    {label}
                  </button>
                ))}
              </div>
              {form.intensity === "aggressive" && (
                <div className="mt-2 text-amber-DEFAULT text-xs bg-amber-dim border border-amber-muted rounded p-2">
                  ⚠ Aggressive mode runs intrusive scripts. Only use with explicit permission.
                </div>
              )}
            </div>
          )}

          {form.scan_type === "vuln" && (
            <div>
              <label className="block text-xs text-slate-500 mb-2">Port Scope</label>
              <div className="flex gap-2">
                {[[100,"Top 100"],[500,"Top 500"],[1000,"Top 1000"]].map(([n, label]) => (
                  <button key={n} onClick={() => setForm(f => ({ ...f, top_ports: n }))}
                    className={`flex-1 py-1.5 rounded text-sm transition-colors ${
                      form.top_ports === n ? "bg-cyan-DEFAULT text-white" : "bg-bg-elevated text-slate-500 hover:text-slate-200"
                    }`}>
                    {label}
                  </button>
                ))}
              </div>
              <div className="text-xs text-slate-700 mt-1">Scans nmap's most common ports. Top 500+ adds significant scan time.</div>
            </div>
          )}

          <div>
            <label className="block text-xs text-slate-500 mb-1">Targets (IPs or CIDRs, one per line)</label>
            <textarea
              className="w-full bg-bg-elevated border border-bg-border rounded px-3 py-2 text-slate-200 text-sm font-mono h-24 resize-none"
              placeholder={"192.168.1.1\n192.168.1.0/24\n10.0.0.5"}
              value={form.targets}
              onChange={e => setForm(f => ({ ...f, targets: e.target.value }))}
            />
          </div>
        </div>

        <div className="flex gap-2 mt-5 justify-end">
          <button onClick={onClose} className="px-4 py-2 text-sm text-slate-500 hover:text-slate-200 transition-colors">Cancel</button>
          <button onClick={handleStart} disabled={running}
            className="px-4 py-2 bg-cyan-DEFAULT hover:bg-cyan-muted text-white rounded text-sm font-medium transition-colors disabled:opacity-50">
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
      <div className="w-full max-w-lg bg-bg-surface border-l border-bg-border h-full overflow-y-auto shadow-2xl"
        onClick={e => e.stopPropagation()}>
        <div className="sticky top-0 bg-bg-surface border-b border-bg-border px-5 py-4 flex items-start justify-between">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <SevBadge sev={finding.severity} />
              {finding.scan_type && (
                <span className="text-xs text-slate-600 bg-bg-elevated px-2 py-0.5 rounded">{finding.scan_type.replace("_", " ")}</span>
              )}
            </div>
            <h2 className="text-slate-100 font-semibold leading-tight">{finding.title}</h2>
          </div>
          <button onClick={onClose} className="text-slate-600 hover:text-slate-200 text-xl ml-4 mt-1 transition-colors">✕</button>
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
              <div key={label} className="bg-bg-elevated rounded p-3">
                <div className="text-xs text-slate-600 mb-0.5">{label}</div>
                <div className={`text-sm font-medium ${label === "Status" && finding.acknowledged ? "text-green-DEFAULT" : "text-slate-200"}`}>{val}</div>
              </div>
            ))}
          </div>

          {/* Description */}
          {finding.description && (
            <div>
              <div className="text-xs text-slate-600 mb-2 uppercase tracking-wider">Description</div>
              <div className="text-slate-300 text-sm leading-relaxed bg-bg-elevated rounded p-3">
                {finding.description}
              </div>
            </div>
          )}

          {/* Raw output */}
          {finding.raw_output && (
            <div>
              <div className="text-xs text-slate-600 mb-2 uppercase tracking-wider">Raw Output</div>
              <pre className="text-slate-500 text-xs bg-bg-base rounded p-3 overflow-x-auto whitespace-pre-wrap max-h-48">
                {finding.raw_output}
              </pre>
            </div>
          )}

          {/* Acknowledge */}
          {!finding.acknowledged && (
            <div className="border-t border-bg-border pt-5">
              <div className="text-xs text-slate-600 mb-2 uppercase tracking-wider">Acknowledge / Notes</div>
              <textarea
                className="w-full bg-bg-elevated border border-bg-border rounded px-3 py-2 text-slate-200 text-sm h-20 resize-none mb-3"
                placeholder="Optional notes — e.g. accepted risk, remediation plan…"
                value={notes}
                onChange={e => setNotes(e.target.value)}
              />
              <button onClick={handleAck} disabled={saving}
                className="w-full py-2 bg-green-DEFAULT hover:bg-green-muted text-white rounded text-sm font-medium transition-colors disabled:opacity-50">
                {saving ? "Saving…" : "Mark Acknowledged"}
              </button>
            </div>
          )}

          {finding.acknowledged && (
            <div className="border-t border-bg-border pt-4 flex items-center justify-between">
              <span className="text-green-DEFAULT text-sm">✓ Acknowledged</span>
              <button onClick={handleAck} disabled={saving}
                className="text-xs text-slate-600 hover:text-slate-200 transition-colors">
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
  const [activeTask, setActiveTask] = useState(null);

  // Filters
  const [filterSearch,   setFilterSearch]   = useState("");
  const [filterSev,      setFilterSev]      = useState("all");
  const [filterType,     setFilterType]     = useState("all");
  const [filterAck,      setFilterAck]      = useState("open");
  const [filterDev,      setFilterDev]      = useState("all");
  const [filterCustomer, setFilterCustomer] = useState("all");

  // Sort
  const [sort, setSort] = useState({ key: "sev", dir: "asc" });
  const toggleSort = key => setSort(prev => ({
    key,
    dir: prev.key === key && prev.dir === "asc" ? "desc" : "asc",
  }));

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

  const customers = [...new Map(
    devices.filter(d => d.customer_id).map(d => [d.customer_id, d.customer_name || d.customer_id])
  ).entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));

  const deviceCustomerMap = Object.fromEntries(devices.map(d => [d.id, d.customer_id]));
  const deviceMap = Object.fromEntries(devices.map(d => [d.id, d.name]));

  const hasFilters = filterSearch || filterSev !== "all" || filterType !== "all" || filterDev !== "all" || filterAck !== "open" || filterCustomer !== "all";

  // Filter
  const filtered = findings.filter(f => {
    if (filterSev      !== "all"  && f.severity  !== filterSev)  return false;
    if (filterType     !== "all"  && f.scan_type !== filterType) return false;
    if (filterDev      !== "all"  && f.device_id !== filterDev)  return false;
    if (filterCustomer !== "all"  && deviceCustomerMap[f.device_id] !== filterCustomer) return false;
    if (filterAck  === "open"  && f.acknowledged)  return false;
    if (filterAck  === "acked" && !f.acknowledged) return false;
    if (filterSearch) {
      const q = filterSearch.toLowerCase();
      if (!(
        f.title?.toLowerCase().includes(q) ||
        f.target_ip?.toLowerCase().includes(q) ||
        f.cve_id?.toLowerCase().includes(q) ||
        deviceMap[f.device_id]?.toLowerCase().includes(q)
      )) return false;
    }
    return true;
  });

  // Sort
  const sorted = [...filtered].sort((a, b) => {
    const dir = sort.dir === "asc" ? 1 : -1;
    switch (sort.key) {
      case "sev":    return dir * (SEV_ORDER.indexOf(a.severity) - SEV_ORDER.indexOf(b.severity));
      case "title":  return dir * (a.title || "").localeCompare(b.title || "");
      case "target": return dir * (a.target_ip || "").localeCompare(b.target_ip || "");
      case "device": return dir * (deviceMap[a.device_id] || "").localeCompare(deviceMap[b.device_id] || "");
      case "found": {
        const ta = a.found_at ? new Date(a.found_at).getTime() : 0;
        const tb = b.found_at ? new Date(b.found_at).getTime() : 0;
        return dir * (ta - tb);
      }
      default: return 0;
    }
  });

  // Counts (unacknowledged only)
  const counts = SEV_ORDER.reduce((acc, s) => {
    acc[s] = findings.filter(f => f.severity === s && !f.acknowledged).length;
    return acc;
  }, {});

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-100">Security Findings</h1>
          <p className="text-slate-500 text-sm mt-1">Vuln scans and security audits across all devices</p>
        </div>
        <div className="flex gap-2 items-center">
          {activeTask && (
            <span className="text-cyan-DEFAULT text-sm animate-pulse">Scan running…</span>
          )}
          <button onClick={load} className="px-3 py-2 bg-bg-elevated hover:bg-bg-border text-slate-300 rounded text-sm transition-colors">↻</button>
          <button onClick={() => setShowScan(true)}
            className="px-4 py-2 bg-cyan-DEFAULT hover:bg-cyan-muted text-white rounded text-sm font-medium transition-colors">
            + New Scan
          </button>
        </div>
      </div>

      {/* Severity summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        {SEV_ORDER.map(s => (
          <button key={s} onClick={() => setFilterSev(filterSev === s ? "all" : s)}
            className={`rounded-lg border p-3 text-left transition-colors ${
              filterSev === s ? "border-slate-500 bg-bg-elevated" : "border-bg-border bg-bg-surface hover:bg-bg-elevated"
            }`}>
            <div className={`w-2 h-2 rounded-full mb-2 ${SEV_STYLE[s].dot}`} />
            <div className={`text-2xl font-bold ${counts[s] > 0 ? "text-slate-100" : "text-slate-700"}`}>{counts[s]}</div>
            <div className="text-xs text-slate-600 capitalize mt-0.5">{s}</div>
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-center">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-600 pointer-events-none" />
          <input
            className="bg-bg-elevated border border-bg-border rounded px-3 py-1.5 text-slate-200 text-sm pl-8 w-52"
            placeholder="Search findings…"
            value={filterSearch}
            onChange={e => setFilterSearch(e.target.value)}
          />
        </div>
        <select className="bg-bg-elevated border border-bg-border rounded px-3 py-1.5 text-slate-200 text-sm"
          value={filterAck} onChange={e => setFilterAck(e.target.value)}>
          <option value="open">Open only</option>
          <option value="acked">Acknowledged</option>
          <option value="all">All</option>
        </select>
        <select className="bg-bg-elevated border border-bg-border rounded px-3 py-1.5 text-slate-200 text-sm"
          value={filterType} onChange={e => setFilterType(e.target.value)}>
          <option value="all">All scan types</option>
          <option value="vuln_scan">Vuln scan</option>
          <option value="security_audit">Security audit</option>
        </select>
        {customers.length > 1 && (
          <select className="bg-bg-elevated border border-bg-border rounded px-3 py-1.5 text-slate-200 text-sm"
            value={filterCustomer} onChange={e => { setFilterCustomer(e.target.value); setFilterDev("all"); }}>
            <option value="all">All customers</option>
            {customers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        )}
        <select className="bg-bg-elevated border border-bg-border rounded px-3 py-1.5 text-slate-200 text-sm"
          value={filterDev} onChange={e => setFilterDev(e.target.value)}>
          <option value="all">All devices</option>
          {devices
            .filter(d => filterCustomer === "all" || d.customer_id === filterCustomer)
            .map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        {hasFilters && (
          <button onClick={() => { setFilterSearch(""); setFilterSev("all"); setFilterType("all"); setFilterDev("all"); setFilterAck("open"); setFilterCustomer("all"); }}
            className="text-xs text-slate-600 hover:text-slate-200 transition-colors">
            Clear filters
          </button>
        )}
        <span className="text-slate-600 text-sm ml-auto">{sorted.length} findings</span>
      </div>

      {/* Findings list */}
      {loading ? (
        <div className="text-center py-20 text-slate-600">Loading…</div>
      ) : sorted.length === 0 ? (
        <div className="text-center py-20">
          <div className="text-slate-600 text-lg mb-2">
            {findings.length === 0 ? "No findings yet" : "No findings match the current filters"}
          </div>
          {findings.length === 0 && (
            <p className="text-slate-700 text-sm mb-6">Run a security audit or vuln scan to start collecting findings.</p>
          )}
        </div>
      ) : (
        <div className="bg-bg-surface border border-bg-border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-bg-border text-left">
                <SortTh label="Severity" sortKey="sev"    currentKey={sort.key} currentDir={sort.dir} onSort={toggleSort} className="w-28" />
                <SortTh label="Finding"  sortKey="title"  currentKey={sort.key} currentDir={sort.dir} onSort={toggleSort} />
                <SortTh label="Target"   sortKey="target" currentKey={sort.key} currentDir={sort.dir} onSort={toggleSort} />
                <SortTh label="Device"   sortKey="device" currentKey={sort.key} currentDir={sort.dir} onSort={toggleSort} />
                <th className="px-4 py-3 text-slate-500 font-medium">Type</th>
                <SortTh label="Found"    sortKey="found"  currentKey={sort.key} currentDir={sort.dir} onSort={toggleSort} />
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {sorted.map(f => (
                <tr key={f.id}
                  onClick={() => setSelected(f)}
                  className={`border-b border-bg-border border-l-2 hover:bg-bg-elevated cursor-pointer transition-colors ${SEV_STYLE[f.severity]?.row || "border-l-slate-700"} ${f.acknowledged ? "opacity-50" : ""}`}>
                  <td className="px-4 py-3">
                    <SevBadge sev={f.severity} />
                  </td>
                  <td className="px-4 py-3">
                    <div className="text-slate-200 font-medium">{f.title}</div>
                    <div className="flex gap-2 mt-0.5">
                      {f.cve_id && <span className="text-xs text-blue-400">{f.cve_id}</span>}
                      {f.cvss_score && <span className="text-xs font-mono text-slate-600">CVSS {f.cvss_score.toFixed(1)}</span>}
                    </div>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-400">
                    {f.target_ip || "—"}
                    {f.target_port && <span className="text-slate-600">:{f.target_port}</span>}
                  </td>
                  <td className="px-4 py-3 text-slate-400 text-xs">
                    <button onClick={e => { e.stopPropagation(); navigate(`/devices/${f.device_id}`); }}
                      className="hover:text-cyan-DEFAULT transition-colors">
                      {deviceMap[f.device_id] || f.device_id.slice(0,8) + "…"}
                    </button>
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-xs text-slate-600 bg-bg-elevated px-2 py-0.5 rounded">
                      {f.scan_type?.replace("_", " ")}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-slate-600 text-xs">
                    {new Date(f.found_at).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-3 text-slate-600 text-xs">
                    {f.acknowledged && <span className="text-green-DEFAULT">✓</span>}
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
