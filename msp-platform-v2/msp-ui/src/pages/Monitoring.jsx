import { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { PageHeader, Spinner, Alert, Modal } from "../components/ui";
import { Plus, RefreshCw, ChevronDown, ChevronRight, Trash2, ExternalLink } from "lucide-react";
import { format, formatDistanceToNow } from "date-fns";

// ── RTT colour scale (Smokeping-style) ───────────────────────────────────────
// Returns an rgba string for a given rtt_ms value
function rttColor(rtt, alpha = 1) {
  if (rtt == null) return `rgba(40,44,52,${alpha})`;          // timeout — dark grey
  if (rtt <   5)  return `rgba(0,210,100,${alpha})`;          // <5ms   — vivid green
  if (rtt <  20)  return `rgba(80,220,80,${alpha})`;          // <20ms  — green
  if (rtt <  50)  return `rgba(180,220,40,${alpha})`;         // <50ms  — yellow-green
  if (rtt < 100)  return `rgba(240,190,20,${alpha})`;         // <100ms — amber
  if (rtt < 200)  return `rgba(240,120,20,${alpha})`;         // <200ms — orange
  if (rtt < 500)  return `rgba(220,60,40,${alpha})`;          // <500ms — red
  return           `rgba(180,30,30,${alpha})`;                 // >500ms — deep red
}

function rttLabel(rtt) {
  if (rtt == null) return "Timeout";
  if (rtt < 1)    return "<1 ms";
  return `${rtt.toFixed(1)} ms`;
}

// ── Smokeping canvas chart ────────────────────────────────────────────────────
// checks: [{ t, rtt_ms, success, source, target }]
// Each check is one ping. We bucket them into columns by time, draw stacked
// coloured cells per column (one per ping), overlay median line.

function SmokepingChart({ checks, hours, label }) {
  const canvasRef = useRef(null);
  const overlayRef = useRef(null);  // transparent canvas for tooltip hit-testing
  const [tooltip, setTooltip] = useState(null);
  const bucketsRef = useRef([]);

  const COL_W = 4;         // px per time bucket
  const ROW_H = 8;         // px per ping within bucket (stacked)
  const MAX_PINGS = 6;     // max pings shown per column
  const AXIS_H = 20;       // bottom axis height
  const LABEL_W = 48;      // right RTT scale

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !checks || checks.length === 0) return;

    const now = Date.now();
    const windowMs = hours * 60 * 60 * 1000;
    const bucketMs = Math.max(30_000, Math.floor(windowMs / Math.floor((canvas.offsetWidth - LABEL_W) / COL_W)));

    // Build buckets
    const nBuckets = Math.floor((canvas.offsetWidth - LABEL_W) / COL_W);
    const buckets = Array.from({ length: nBuckets }, (_, i) => ({
      t: now - windowMs + i * bucketMs,
      pings: [],
    }));

    checks.forEach(c => {
      const ts = new Date(c.t).getTime();
      const idx = Math.floor((ts - (now - windowMs)) / bucketMs);
      if (idx >= 0 && idx < nBuckets) {
        buckets[idx].pings.push(c.rtt_ms);
      }
    });
    bucketsRef.current = buckets;

    const chartH = MAX_PINGS * ROW_H;
    canvas.width  = canvas.offsetWidth;
    canvas.height = chartH + AXIS_H;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Background
    ctx.fillStyle = "#0a0c10";
    ctx.fillRect(0, 0, canvas.width - LABEL_W, chartH);

    // Draw columns
    buckets.forEach((bucket, bi) => {
      const x = bi * COL_W;
      const pings = bucket.pings.slice(0, MAX_PINGS);

      if (pings.length === 0) {
        // No data — faint stripe
        ctx.fillStyle = "#111418";
        ctx.fillRect(x, 0, COL_W - 1, chartH);
        return;
      }

      const sorted = [...pings].sort((a, b) => (a ?? 999999) - (b ?? 999999));
      const cellH  = chartH / MAX_PINGS;

      // Fill background of column with median color at low alpha
      const median = sorted[Math.floor(sorted.length / 2)];
      ctx.fillStyle = rttColor(median, 0.15);
      ctx.fillRect(x, 0, COL_W - 1, chartH);

      // Stack pings from bottom (best at bottom, worst at top)
      sorted.forEach((rtt, pi) => {
        const y = chartH - (pi + 1) * cellH;
        ctx.fillStyle = rttColor(rtt, rtt == null ? 0.4 : 0.9);
        ctx.fillRect(x, y, COL_W - 1, cellH - 0.5);
      });

      // Median line — bright white
      if (median != null) {
        const maxRtt = 500;
        const lineY = chartH - Math.min(median / maxRtt, 1) * chartH;
        ctx.fillStyle = "rgba(255,255,255,0.7)";
        ctx.fillRect(x, lineY - 0.5, COL_W - 1, 1.5);
      }
    });

    // RTT scale (right side)
    const scaleRtts = [0, 20, 50, 100, 200, 500];
    ctx.font = "9px monospace";
    ctx.fillStyle = "#4a5568";
    ctx.textAlign = "left";
    const maxRtt = 500;
    scaleRtts.forEach(r => {
      const y = chartH - (r / maxRtt) * chartH;
      ctx.fillStyle = "#1e2530";
      ctx.fillRect(0, y, canvas.width - LABEL_W, 0.5);
      ctx.fillStyle = "#4a5568";
      ctx.fillText(`${r}ms`, canvas.width - LABEL_W + 3, y + 4);
    });

    // Time axis
    ctx.fillStyle = "#2d3748";
    ctx.fillRect(0, chartH, canvas.width - LABEL_W, 1);
    ctx.font = "9px monospace";
    ctx.fillStyle = "#4a5568";
    ctx.textAlign = "center";
    const tickCount = Math.min(8, Math.floor(hours));
    for (let i = 0; i <= tickCount; i++) {
      const frac = i / tickCount;
      const x = frac * (canvas.width - LABEL_W);
      const ts = now - windowMs + frac * windowMs;
      ctx.fillStyle = "#2d3748";
      ctx.fillRect(x, chartH, 1, 4);
      ctx.fillStyle = "#4a5568";
      ctx.fillText(format(ts, hours > 24 ? "MMM d" : "HH:mm"), x, chartH + AXIS_H - 4);
    }
  }, [checks, hours]);

  const handleMouseMove = useCallback((e) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const chartH = MAX_PINGS * ROW_H;
    if (y > chartH) { setTooltip(null); return; }

    const bi = Math.floor(x / COL_W);
    const buckets = bucketsRef.current;
    if (bi < 0 || bi >= buckets.length) { setTooltip(null); return; }
    const bucket = buckets[bi];
    if (!bucket || bucket.pings.length === 0) { setTooltip(null); return; }

    const sorted = [...bucket.pings].sort((a, b) => (a ?? 999999) - (b ?? 999999));
    const median = sorted[Math.floor(sorted.length / 2)];
    const loss   = bucket.pings.filter(p => p == null).length;
    setTooltip({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      t: bucket.t,
      median, loss,
      min: sorted.find(p => p != null),
      max: sorted.filter(p => p != null).pop(),
      count: bucket.pings.length,
    });
  }, []);

  const chartH = MAX_PINGS * ROW_H;

  return (
    <div className="relative">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-mono text-slate-500 uppercase tracking-wider">{label}</span>
        {checks && checks.length > 0 && (() => {
          const rtts = checks.map(c => c.rtt_ms).filter(Boolean);
          const avg  = rtts.length ? rtts.reduce((a, b) => a + b, 0) / rtts.length : null;
          const loss = checks.filter(c => !c.success).length;
          const lossPct = checks.length ? (loss / checks.length * 100).toFixed(1) : 0;
          return (
            <span className="text-xs font-mono text-slate-600">
              avg <span style={{ color: rttColor(avg) }}>{avg ? `${avg.toFixed(1)}ms` : "—"}</span>
              <span className="mx-2">·</span>
              loss <span className={lossPct > 5 ? "text-red-400" : "text-slate-500"}>{lossPct}%</span>
              <span className="mx-2">·</span>
              {checks.length} checks
            </span>
          );
        })()}
      </div>
      <div className="relative rounded overflow-hidden border border-bg-border"
           style={{ height: chartH + AXIS_H }}
           onMouseMove={handleMouseMove}
           onMouseLeave={() => setTooltip(null)}>
        <canvas ref={canvasRef} className="w-full" style={{ display: "block", height: "100%" }} />

        {/* Tooltip */}
        {tooltip && (
          <div className="absolute z-10 pointer-events-none"
               style={{
                 left: Math.min(tooltip.x + 12, (canvasRef.current?.offsetWidth || 400) - 160),
                 top: Math.max(0, tooltip.y - 80),
               }}>
            <div className="bg-bg-surface border border-bg-border rounded px-2.5 py-2 shadow-xl text-xs font-mono space-y-0.5 min-w-[140px]">
              <div className="text-slate-400 mb-1">{format(tooltip.t, "MMM d, HH:mm:ss")}</div>
              <div>med <span style={{ color: rttColor(tooltip.median) }}>{rttLabel(tooltip.median)}</span></div>
              {tooltip.min != null && <div>min <span className="text-green-DEFAULT">{rttLabel(tooltip.min)}</span></div>}
              {tooltip.max != null && <div>max <span className="text-red-DEFAULT">{rttLabel(tooltip.max)}</span></div>}
              {tooltip.loss > 0 && <div className="text-red-DEFAULT">loss {tooltip.loss}/{tooltip.count}</div>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── RTT legend ────────────────────────────────────────────────────────────────
function RttLegend() {
  const steps = [
    { label: "<5ms",   rtt: 2   },
    { label: "<20ms",  rtt: 10  },
    { label: "<50ms",  rtt: 35  },
    { label: "<100ms", rtt: 75  },
    { label: "<200ms", rtt: 150 },
    { label: "<500ms", rtt: 350 },
    { label: "500ms+", rtt: 600 },
    { label: "Timeout",rtt: null},
  ];
  return (
    <div className="flex items-center gap-3 flex-wrap">
      <span className="text-xs text-slate-600 uppercase tracking-wider">RTT</span>
      {steps.map(s => (
        <span key={s.label} className="flex items-center gap-1 text-xs font-mono text-slate-500">
          <span className="inline-block w-3 h-3 rounded-sm"
                style={{ background: rttColor(s.rtt, 0.9) }} />
          {s.label}
        </span>
      ))}
    </div>
  );
}

// ── Uptime badge ──────────────────────────────────────────────────────────────
function UptimeBadge({ pct }) {
  if (pct == null) return <span className="text-slate-600 text-xs font-mono">—</span>;
  const color = pct >= 99 ? "text-green-DEFAULT" : pct >= 95 ? "text-amber-DEFAULT" : "text-red-DEFAULT";
  return <span className={`font-mono font-700 text-sm ${color}`}>{pct.toFixed(2)}%</span>;
}

// ── Expanded chart panel (inline accordion) ───────────────────────────────────
function DeviceChartPanel({ device, targets, hours }) {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState("");

  useEffect(() => {
    setLoading(true);
    api.get(`/v1/monitoring/devices/${device.id}/uptime?hours=${hours}`)
      .then(r => { setData(r); setLoading(false); })
      .catch(e => { setError(e.message); setLoading(false); });
  }, [device.id, hours]);

  if (loading) return (
    <div className="flex items-center justify-center h-24">
      <Spinner />
    </div>
  );
  if (error) return <p className="text-xs text-red-DEFAULT px-1">{error}</p>;
  if (!data?.checks?.length) return (
    <p className="text-xs text-slate-600 px-1 py-4">No check data for this period.</p>
  );

  const wanChecks = data.checks.filter(c => c.source === "wan");
  const lanChecks = data.checks.filter(c => c.source === "lan");

  // Group LAN checks by target host, preserving target order from the targets list
  const lanByTarget = lanChecks.reduce((acc, c) => {
    if (!acc[c.target]) acc[c.target] = [];
    acc[c.target].push(c);
    return acc;
  }, {});

  // Order: targets defined in the targets list first, then any unlabelled extras
  const orderedTargets = [
    ...targets.filter(t => lanByTarget[t.host]).map(t => t.host),
    ...Object.keys(lanByTarget).filter(h => !targets.find(t => t.host === h)),
  ];

  return (
    <div className="space-y-4">
      {wanChecks.length > 0 && (
        <SmokepingChart checks={wanChecks} hours={hours} label="WAN — server → device" />
      )}
      {orderedTargets.map(host => {
        const tgt = targets.find(t => t.host === host);
        const lbl = tgt ? `${tgt.label} · ${host}` : host;
        return (
          <SmokepingChart key={host} checks={lanByTarget[host]} hours={hours} label={lbl} />
        );
      })}
      {wanChecks.length === 0 && orderedTargets.length === 0 && (
        <p className="text-xs text-slate-600">No check data for this period.</p>
      )}
    </div>
  );
}

// ── Add Target Modal ──────────────────────────────────────────────────────────
function AddTargetModal({ devices, onClose, onSaved }) {
  const [form, setForm] = useState({
    device_id: devices[0]?.id || "",
    label: "",
    host: "",
    interval_seconds: 30,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState("");

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  async function handleSave() {
    if (!form.device_id || !form.label || !form.host) {
      setError("All fields required"); return;
    }
    setSaving(true);
    try {
      await api.post("/v1/monitoring/targets", form);
      onSaved(); onClose();
    } catch (e) {
      setError(e.message || "Failed to save");
    } finally { setSaving(false); }
  }

  return (
    <Modal title="Add Monitor Target" onClose={onClose}>
      {error && <Alert type="error" message={error} className="mb-3" />}
      <div className="space-y-3">
        <div>
          <label className="label">Device</label>
          <select className="input" value={form.device_id} onChange={e => set("device_id", e.target.value)}>
            {devices.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Label</label>
          <input className="input" placeholder="e.g. Default Gateway"
            value={form.label} onChange={e => set("label", e.target.value)} />
        </div>
        <div>
          <label className="label">Host / IP</label>
          <input className="input" placeholder="e.g. 192.168.1.1"
            value={form.host} onChange={e => set("host", e.target.value)} />
        </div>
        <div>
          <label className="label">Interval</label>
          <select className="input" value={form.interval_seconds}
            onChange={e => set("interval_seconds", Number(e.target.value))}>
            {[10, 30, 60, 120, 300].map(s => (
              <option key={s} value={s}>{s === 60 ? "1 min" : s === 300 ? "5 min" : `${s}s`}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="flex gap-2 mt-5">
        <button onClick={onClose} className="btn-ghost flex-1">Cancel</button>
        <button onClick={handleSave} disabled={saving} className="btn-primary flex-1">
          {saving ? "Saving…" : "Add Target"}
        </button>
      </div>
    </Modal>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function Monitoring() {
  const navigate = useNavigate();
  const [summary, setSummary]   = useState([]);
  const [devices, setDevices]   = useState([]);
  const [targets, setTargets]   = useState([]);
  const [hours, setHours]       = useState(24);
  const [showAdd, setShowAdd]   = useState(false);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState("");
  const [expanded, setExpanded] = useState(null);  // device_id
  const [lastRefresh, setLastRefresh] = useState(null);

  const load = useCallback(async () => {
    setError("");
    try {
      const [devs, tgts] = await Promise.all([
        api.get("/v1/devices"),
        api.get("/v1/monitoring/targets"),
      ]);
      setDevices(Array.isArray(devs) ? devs : (devs.devices || []));
      setTargets(Array.isArray(tgts) ? tgts : []);
    } catch (e) { console.error("devices/targets:", e); }

    try {
      const sum = await api.get(`/v1/monitoring/uptime?hours=${hours}`);
      setSummary(sum);
      setLastRefresh(new Date());
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [hours]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);

  const targetsByDevice = targets.reduce((acc, t) => {
    if (!acc[t.device_id]) acc[t.device_id] = [];
    acc[t.device_id].push(t);
    return acc;
  }, {});

  const uptimeByDevice = Object.fromEntries(summary.map(s => [s.device_id, s]));

  const monitoredDeviceIds = new Set([
    ...Object.keys(targetsByDevice),
    ...summary.map(s => s.device_id),
  ]);
  const monitoredDevices = devices.filter(d => monitoredDeviceIds.has(d.id));

  const overallUptime = summary.length
    ? summary.reduce((acc, d) => {
        const pct = d.wan?.uptime_pct ?? d.lan?.uptime_pct ?? null;
        return pct != null ? acc + pct : acc;
      }, 0) / summary.filter(d => d.wan || d.lan).length
    : null;

  const deleteTarget = async (id) => {
    if (!confirm("Remove this monitor target?")) return;
    try {
      await api.delete(`/v1/monitoring/targets/${id}`);
      load();
    } catch (e) { setError(e.message); }
  };

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Monitoring"
        subtitle={`${monitoredDevices.length} device${monitoredDevices.length !== 1 ? "s" : ""} monitored${lastRefresh ? ` · ${formatDistanceToNow(lastRefresh, { addSuffix: true })}` : ""}`}
        actions={
          <div className="flex items-center gap-2">
            <select className="input py-1 text-xs w-28"
              value={hours} onChange={e => setHours(Number(e.target.value))}>
              {[1, 4, 24, 48, 168].map(h => (
                <option key={h} value={h}>{h === 168 ? "7 days" : h === 1 ? "1 hour" : `${h}h`}</option>
              ))}
            </select>
            <button onClick={load} className="btn-ghost p-2" title="Refresh">
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
            <button onClick={() => setShowAdd(true)} className="btn-primary flex items-center gap-1.5">
              <Plus className="w-4 h-4" /> Add Target
            </button>
          </div>
        }
      />

      {error && <Alert type="error" message={error} className="mb-4" />}

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-3 mb-4">
        <div className="card p-4">
          <p className="text-xs text-slate-500 mb-1">Devices Monitored</p>
          <p className="font-display font-700 text-2xl text-slate-200">{monitoredDevices.length}</p>
        </div>
        <div className="card p-4">
          <p className="text-xs text-slate-500 mb-1">Overall Uptime ({hours}h)</p>
          <UptimeBadge pct={overallUptime} />
        </div>
        <div className="card p-4">
          <p className="text-xs text-slate-500 mb-1">LAN Targets</p>
          <p className="font-display font-700 text-2xl text-slate-200">{targets.length}</p>
        </div>
      </div>

      {/* Legend */}
      <div className="card px-4 py-2.5 mb-4">
        <RttLegend />
      </div>

      {/* Device list */}
      {loading ? (
        <div className="flex items-center justify-center h-48"><Spinner /></div>
      ) : monitoredDevices.length === 0 ? (
        <div className="card py-16 text-center">
          <p className="text-slate-400 mb-1">No devices monitored yet</p>
          <p className="text-xs text-slate-600">
            WAN data appears once a device connects. Add LAN targets using the button above.
          </p>
        </div>
      ) : (
        <div className="card overflow-hidden divide-y divide-bg-border">
          {monitoredDevices.map(device => {
            const uptime     = uptimeByDevice[device.id];
            const devTargets = targetsByDevice[device.id] || [];
            const isExpanded = expanded === device.id;
            const wan  = uptime?.wan;
            const lan  = uptime?.lan;

            // Quick colour bar — last N checks as tiny squares
            const statusColor = device.status === "active"
              ? "bg-green-DEFAULT" : "bg-red-DEFAULT";

            return (
              <div key={device.id}>
                {/* Row */}
                <div
                  className="flex items-center gap-4 px-4 py-3 hover:bg-bg-elevated transition-colors cursor-pointer select-none"
                  onClick={() => setExpanded(isExpanded ? null : device.id)}
                >
                  {/* Expand chevron */}
                  <div className="text-slate-600 shrink-0">
                    {isExpanded
                      ? <ChevronDown className="w-4 h-4 text-cyan-DEFAULT" />
                      : <ChevronRight className="w-4 h-4" />}
                  </div>

                  {/* Device name + status dot */}
                  <div className="w-40 shrink-0">
                    <div className="flex items-center gap-2">
                      <span className={`w-2 h-2 rounded-full shrink-0 ${statusColor}`} />
                      <span className="text-sm font-display font-500 text-slate-200 truncate">
                        {device.name}
                      </span>
                    </div>
                    <span className="text-xs font-mono text-slate-600 ml-4">
                      {device.id.slice(0, 8)}…
                    </span>
                  </div>

                  {/* WAN uptime */}
                  <div className="w-28 shrink-0">
                    <p className="text-xs text-slate-600 mb-0.5">WAN</p>
                    {wan ? (
                      <div>
                        <UptimeBadge pct={wan.uptime_pct} />
                        {wan.avg_rtt_ms && (
                          <span className="text-xs font-mono ml-2"
                                style={{ color: rttColor(wan.avg_rtt_ms) }}>
                            {wan.avg_rtt_ms.toFixed(1)}ms
                          </span>
                        )}
                      </div>
                    ) : <span className="text-xs text-slate-600">—</span>}
                  </div>

                  {/* LAN targets — one chip per endpoint showing live uptime */}
                  <div className="flex-1 min-w-0">
                    {devTargets.length === 0 ? (
                      <span className="text-xs text-slate-600">No LAN targets</span>
                    ) : (() => {
                      const liveByHost = Object.fromEntries(
                        (uptime?.lan_targets || []).map(t => [t.host, t])
                      );
                      return (
                        <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                          {devTargets.map(t => {
                            const live = liveByHost[t.host];
                            const dotColor = !t.enabled
                              ? "bg-slate-700"
                              : !live
                              ? "bg-slate-600"
                              : live.uptime_pct >= 99 ? "bg-green-DEFAULT"
                              : live.uptime_pct >= 95 ? "bg-amber-DEFAULT"
                              : "bg-red-DEFAULT";
                            return (
                              <span key={t.id} className="flex items-center gap-1.5 text-xs group">
                                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotColor}`} />
                                <span className="text-slate-300 font-mono font-500">{t.label}</span>
                                <span className="text-slate-600 font-mono">{t.host}</span>
                                {live ? (
                                  <>
                                    <UptimeBadge pct={live.uptime_pct} />
                                    {live.avg_rtt_ms != null && (
                                      <span className="font-mono" style={{ color: rttColor(live.avg_rtt_ms) }}>
                                        {live.avg_rtt_ms.toFixed(1)}ms
                                      </span>
                                    )}
                                  </>
                                ) : (
                                  <span className="text-slate-700 font-mono">no data</span>
                                )}
                                <button
                                  onClick={e => { e.stopPropagation(); deleteTarget(t.id); }}
                                  className="text-slate-800 hover:text-red-DEFAULT transition-colors opacity-0 group-hover:opacity-100"
                                  title="Remove target"
                                >
                                  <Trash2 className="w-3 h-3" />
                                </button>
                              </span>
                            );
                          })}
                        </div>
                      );
                    })()}
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-2 shrink-0" onClick={e => e.stopPropagation()}>
                    <button
                      onClick={() => navigate(`/devices/${device.id}`)}
                      className="p-1.5 text-slate-600 hover:text-slate-300 rounded transition-colors"
                      title="Device details"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                {/* Accordion chart panel */}
                {isExpanded && (
                  <div className="px-4 pb-4 pt-2 bg-bg-base border-t border-bg-border/50">
                    <div className="flex items-center justify-between mb-3">
                      <span className="text-xs text-slate-500">
                        RTT heatmap — last {hours === 168 ? "7 days" : hours === 1 ? "1 hour" : `${hours}h`}
                        <span className="ml-2 text-slate-700">· hover columns for details</span>
                      </span>
                    </div>
                    <DeviceChartPanel
                      device={device}
                      targets={devTargets}
                      hours={hours}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {showAdd && (
        <AddTargetModal
          devices={devices.filter(d => d.status === "active")}
          onClose={() => setShowAdd(false)}
          onSaved={load}
        />
      )}
    </div>
  );
}
