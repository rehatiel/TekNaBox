import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { api } from "../lib/api";

// ── Severity helpers ──────────────────────────────────────────────────────────

const SEV_STYLE = {
  critical: "bg-red-dim border-red-muted text-red-DEFAULT",
  high:     "bg-orange-500/10 border-orange-500/30 text-orange-500",
  medium:   "bg-amber-dim border-amber-muted text-amber-DEFAULT",
  low:      "bg-blue-500/10 border-blue-500/30 text-blue-500",
  info:     "bg-bg-elevated border-bg-border text-slate-500",
};

function SevBadge({ sev }) {
  return (
    <span className={`text-xs font-bold uppercase px-2 py-0.5 rounded border ${SEV_STYLE[sev] || SEV_STYLE.info}`}>
      {sev}
    </span>
  );
}

function StatCard({ label, value, sub, color = "text-slate-200" }) {
  return (
    <div className="bg-bg-elevated border border-bg-border rounded-lg p-4">
      <div className="text-xs text-slate-600 mb-1">{label}</div>
      <div className={`text-2xl font-bold ${color}`}>{value ?? "—"}</div>
      {sub && <div className="text-xs text-slate-600 mt-1">{sub}</div>}
    </div>
  );
}

function KV({ label, value, mono = false, warn = false }) {
  return (
    <div className="flex justify-between py-2 border-b border-bg-border text-sm">
      <span className="text-slate-500">{label}</span>
      <span className={`font-medium ${warn ? "text-red-DEFAULT" : "text-slate-200"} ${mono ? "font-mono text-xs" : ""}`}>
        {value ?? "—"}
      </span>
    </div>
  );
}

function Tag({ children, color = "gray" }) {
  const styles = {
    gray:   "bg-bg-elevated border-bg-border text-slate-400",
    red:    "bg-red-dim border-red-muted text-red-DEFAULT",
    orange: "bg-orange-500/10 border-orange-500/30 text-orange-500",
    yellow: "bg-amber-dim border-amber-muted text-amber-DEFAULT",
    green:  "bg-green-dim border-green-muted text-green-DEFAULT",
    cyan:   "bg-cyan-dim border-cyan-muted text-cyan-DEFAULT",
    purple: "bg-purple-500/10 border-purple-500/30 text-purple-500",
  };
  return (
    <span className={`text-xs px-1.5 py-0.5 rounded border font-mono ${styles[color] || styles.gray}`}>
      {children}
    </span>
  );
}

// ── Section wrapper ───────────────────────────────────────────────────────────

function Section({ title, count, children, empty = "No data." }) {
  return (
    <div>
      {title && (
        <div className="text-slate-300 font-medium mb-3 text-sm">
          {title}
          {count != null && <span className="ml-2 text-slate-600 font-normal">({count})</span>}
        </div>
      )}
      {children || <div className="text-slate-600 text-sm">{empty}</div>}
    </div>
  );
}

// ── Tab/filter button ─────────────────────────────────────────────────────────

function FilterBtn({ active, onClick, children }) {
  return (
    <button onClick={onClick}
      className={`px-3 py-1 rounded text-sm transition-colors ${active ? "bg-bg-border text-slate-100" : "text-slate-500 hover:text-slate-200"}`}>
      {children}
    </button>
  );
}

function AdInput({ className = "", ...props }) {
  return (
    <input
      className={`bg-bg-elevated border border-bg-border rounded px-3 py-1 text-sm text-slate-200 focus:outline-none focus:border-cyan-DEFAULT ${className}`}
      {...props}
    />
  );
}

// ── Findings ──────────────────────────────────────────────────────────────────

function FindingsSection({ findings = [] }) {
  const [filter, setFilter] = useState("all");
  const filtered = filter === "all" ? findings : findings.filter(f => f.severity === filter);
  const counts = ["critical","high","medium","low"].map(s => ({ s, n: findings.filter(f => f.severity === s).length }));

  return (
    <div>
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <FilterBtn active={filter === "all"} onClick={() => setFilter("all")}>All ({findings.length})</FilterBtn>
        {counts.map(({ s, n }) => n > 0 && (
          <FilterBtn key={s} active={filter === s} onClick={() => setFilter(s)}>
            {s.charAt(0).toUpperCase() + s.slice(1)} ({n})
          </FilterBtn>
        ))}
      </div>
      {filtered.length === 0
        ? <div className="text-slate-600 text-sm py-4">No findings at this severity.</div>
        : (
          <div className="space-y-3">
            {filtered.map((f, i) => (
              <div key={i} className="bg-bg-elevated border border-bg-border rounded-lg p-4">
                <div className="flex items-start gap-3">
                  <SevBadge sev={f.severity} />
                  <div className="flex-1">
                    <div className="text-slate-100 font-medium">{f.title}</div>
                    <div className="text-xs text-slate-600 mt-0.5">{f.category}</div>
                    <div className="text-sm text-slate-300 mt-2">{f.detail}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
    </div>
  );
}

// ── Infrastructure ────────────────────────────────────────────────────────────

function InfrastructureSection({ domainInfo = {}, dcList = [], trusts = [], dnsZones = [], dhcpScopes = [], ous = [] }) {
  const [tab, setTab] = useState("dcs");
  const tabs = [
    ["dcs",    `Domain Controllers (${dcList.length})`],
    ["trusts", `Trusts (${trusts.length})`],
    ["dns",    `DNS Zones (${dnsZones.length})`],
    ["dhcp",   `DHCP Scopes (${dhcpScopes.length})`],
    ["ous",    `OUs (${ous.length})`],
  ];

  return (
    <div className="space-y-5">
      <div className="bg-bg-elevated border border-bg-border rounded-lg p-4">
        <div className="text-slate-300 font-medium mb-3 text-sm uppercase tracking-wider">Domain</div>
        <div className="grid grid-cols-2 gap-x-8">
          <KV label="Domain"           value={domainInfo.domain} />
          <KV label="Functional Level" value={domainInfo.functional_level} />
          <KV label="Primary DC"       value={domainInfo.dc_hostname} mono />
          <KV label="DC IP"            value={domainInfo.dc_ip} mono />
          <KV label="Base DN"          value={domainInfo.base_dn} mono />
          <KV label="Created"          value={domainInfo.created} />
          <KV label="Forest"           value={domainInfo.forest} />
          <KV label="NetBIOS Name"     value={domainInfo.netbios_name} />
        </div>
      </div>

      <div className="border-b border-bg-border">
        <div className="flex gap-1 overflow-x-auto">
          {tabs.map(([key, label]) => (
            <button key={key} onClick={() => setTab(key)}
              className={`px-4 py-2 text-sm whitespace-nowrap transition-colors border-b-2 -mb-px ${
                tab === key ? "border-cyan-DEFAULT text-cyan-DEFAULT" : "border-transparent text-slate-500 hover:text-slate-200"
              }`}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {tab === "dcs" && (
        dcList.length === 0
          ? <div className="text-slate-600 text-sm">No DC info collected.</div>
          : (
            <div className="space-y-4">
              {dcList.map((dc, i) => (
                <div key={i} className="bg-bg-elevated border border-bg-border rounded-lg p-4">
                  <div className="flex items-center gap-3 mb-3 flex-wrap">
                    <span className="text-cyan-DEFAULT font-mono font-bold">{dc.hostname || dc.ip}</span>
                    {dc.is_pdc && <Tag color="cyan">PDC Emulator</Tag>}
                    {dc.is_gc  && <Tag color="purple">Global Catalog</Tag>}
                    {dc.fsmo_roles?.map(r => <Tag key={r} color="gray">{r}</Tag>)}
                  </div>
                  <div className="grid grid-cols-2 gap-x-8 text-sm">
                    <KV label="IP"       value={dc.ip} mono />
                    <KV label="OS"       value={dc.os} />
                    <KV label="Version"  value={dc.os_version} />
                    <KV label="Site"     value={dc.site} />
                  </div>
                </div>
              ))}
            </div>
          )
      )}

      {tab === "trusts" && (
        trusts.length === 0
          ? <div className="text-slate-600 text-sm">No trust relationships found.</div>
          : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left border-b border-bg-border">
                  <th className="pb-2 text-slate-500 font-medium">Trusted Domain</th>
                  <th className="pb-2 text-slate-500 font-medium">Direction</th>
                  <th className="pb-2 text-slate-500 font-medium">Type</th>
                  <th className="pb-2 text-slate-500 font-medium">Transitive</th>
                </tr>
              </thead>
              <tbody>
                {trusts.map((t, i) => (
                  <tr key={i} className="border-b border-bg-border hover:bg-bg-elevated">
                    <td className="py-2 text-cyan-DEFAULT font-mono text-xs">{t.domain}</td>
                    <td className="py-2 text-slate-300">{t.direction}</td>
                    <td className="py-2 text-slate-500">{t.type}</td>
                    <td className="py-2">
                      <Tag color={t.transitive ? "yellow" : "gray"}>{t.transitive ? "Yes" : "No"}</Tag>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
      )}

      {tab === "dns" && (
        dnsZones.length === 0
          ? <div className="text-slate-600 text-sm">No DNS zones collected.</div>
          : (
            <div className="space-y-2">
              {dnsZones.map((z, i) => (
                <div key={i} className="flex items-center justify-between bg-bg-elevated border border-bg-border rounded px-3 py-2 text-sm">
                  <span className="text-slate-200 font-mono">{z.name}</span>
                  <div className="flex gap-2">
                    {z.type && <span className="text-xs text-slate-600">{z.type}</span>}
                    {z.partition && <Tag color="gray">{z.partition}</Tag>}
                  </div>
                </div>
              ))}
            </div>
          )
      )}

      {tab === "dhcp" && (
        dhcpScopes.length === 0
          ? <div className="text-slate-600 text-sm">No DHCP scopes found.</div>
          : (
            <div className="space-y-3">
              {dhcpScopes.map((s, i) => {
                const ranges = s.ranges?.length > 0
                  ? s.ranges
                  : (s.start_ip ? [{ start: s.start_ip, end: s.end_ip }] : []);
                return (
                  <div key={i} className="bg-bg-elevated border border-bg-border rounded-lg px-4 py-3">
                    <div className="flex items-center justify-between flex-wrap gap-2 mb-2">
                      <div>
                        <span className="text-slate-200 font-mono text-sm">{s.scope_id}</span>
                        {s.description && <span className="ml-3 text-slate-600 text-xs">{s.description}</span>}
                      </div>
                      <div className="flex items-center gap-2">
                        {s.subnet_mask && <span className="text-slate-700 text-xs font-mono">/{s.subnet_mask}</span>}
                        <Tag color={s.state === "Active" ? "green" : "gray"}>{s.state}</Tag>
                      </div>
                    </div>
                    {ranges.length > 0 && (
                      <div className="space-y-1">
                        {ranges.map((r, j) => (
                          <div key={j} className="text-xs font-mono text-slate-300">
                            {r.start} <span className="text-slate-600">→</span> {r.end}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )
      )}

      {tab === "ous" && (
        ous.length === 0
          ? <div className="text-slate-600 text-sm">No OU structure collected.</div>
          : (
            <div className="space-y-1 font-mono text-xs">
              {ous.map((ou, i) => (
                <div key={i} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-bg-elevated">
                  <span className="text-slate-700">{"  ".repeat(ou.depth || 0)}├─</span>
                  <span className="text-cyan-DEFAULT">{ou.name}</span>
                  {ou.gpo_links?.length > 0 && (
                    <span className="text-purple-500 ml-auto">{ou.gpo_links.length} GPO{ou.gpo_links.length > 1 ? "s" : ""}</span>
                  )}
                </div>
              ))}
            </div>
          )
      )}
    </div>
  );
}

// ── Computers ─────────────────────────────────────────────────────────────────

function ComputersSection({ computers = {} }) {
  const list      = computers.list || [];
  const osSummary = computers.os_summary || {};
  const [tab, setTab]       = useState("all");
  const [search, setSearch] = useState("");
  const [showAll, setShowAll] = useState(false);

  const stale  = list.filter(c => c.stale && c.enabled);
  const noLaps = list.filter(c => !c.laps_enrolled && c.enabled);
  const shown  = (tab === "stale" ? stale : tab === "nolaps" ? noLaps : list)
                  .filter(c => !search || c.name.toLowerCase().includes(search.toLowerCase()) || (c.os || "").toLowerCase().includes(search.toLowerCase()));
  const display = showAll ? shown : shown.slice(0, 25);

  return (
    <div>
      {Object.keys(osSummary).length > 0 && (
        <div className="flex flex-wrap gap-2 mb-4">
          {Object.entries(osSummary).sort(([,a],[,b]) => b-a).map(([os, count]) => (
            <div key={os} className="bg-bg-elevated border border-bg-border rounded px-3 py-1.5 text-xs">
              <span className="text-slate-300">{os || "Unknown"}</span>
              <span className="ml-2 text-cyan-DEFAULT font-bold">{count}</span>
            </div>
          ))}
        </div>
      )}
      <div className="flex gap-2 mb-4 text-sm flex-wrap items-center">
        {[
          ["all",    `All (${list.length})`],
          ["stale",  `Stale (${stale.length})`],
          ["nolaps", `No LAPS (${noLaps.length})`],
        ].map(([key, label]) => (
          <FilterBtn key={key} active={tab === key} onClick={() => { setTab(key); setShowAll(false); }}>{label}</FilterBtn>
        ))}
        <AdInput className="w-48 ml-auto" placeholder="Search…" value={search}
          onChange={e => { setSearch(e.target.value); setShowAll(false); }} />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left border-b border-bg-border">
              <th className="pb-2 text-slate-500 font-medium">Name</th>
              <th className="pb-2 text-slate-500 font-medium">OS</th>
              <th className="pb-2 text-slate-500 font-medium">Last Logon</th>
              <th className="pb-2 text-slate-500 font-medium">Flags</th>
            </tr>
          </thead>
          <tbody>
            {display.map((c, i) => (
              <tr key={i} className="border-b border-bg-border hover:bg-bg-elevated">
                <td className="py-2 text-cyan-DEFAULT font-mono text-xs">{c.name}</td>
                <td className="py-2 text-slate-300 text-xs">{c.os || "—"}</td>
                <td className="py-2 text-slate-500 text-xs">{c.last_logon ? new Date(c.last_logon).toLocaleDateString() : "Never"}</td>
                <td className="py-2">
                  <div className="flex gap-1 flex-wrap">
                    {!c.enabled       && <Tag color="gray">disabled</Tag>}
                    {c.stale          && <Tag color="orange">stale</Tag>}
                    {c.laps_enrolled  && <Tag color="green">LAPS</Tag>}
                    {!c.laps_enrolled && c.enabled && <Tag color="yellow">no LAPS</Tag>}
                    {c.description    && <span className="text-xs text-slate-700 truncate max-w-[120px]">{c.description}</span>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {shown.length > 25 && !showAll && (
        <button onClick={() => setShowAll(true)} className="mt-3 text-cyan-DEFAULT hover:text-cyan-bright text-sm">
          Show all {shown.length}
        </button>
      )}
    </div>
  );
}

// ── GPOs ──────────────────────────────────────────────────────────────────────

function GPOSection({ gpos = [] }) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  if (gpos.length === 0) return <div className="text-slate-600 text-sm">No GPOs found.</div>;

  const filtered = gpos.filter(g => {
    const matchSearch = !search || g.name?.toLowerCase().includes(search.toLowerCase());
    const matchFilter = filter === "all" || (filter === "enabled" && g.status === "Enabled") ||
                        (filter === "disabled" && g.status !== "Enabled") ||
                        (filter === "unlinked" && !g.linked_ous?.length);
    return matchSearch && matchFilter;
  });

  return (
    <div>
      <div className="flex gap-2 mb-4 flex-wrap items-center">
        {[["all","All"],["enabled","Enabled"],["disabled","Disabled"],["unlinked","Unlinked"]].map(([k,l]) => (
          <FilterBtn key={k} active={filter === k} onClick={() => setFilter(k)}>{l}</FilterBtn>
        ))}
        <AdInput className="w-56 ml-auto" placeholder="Search GPOs…" value={search} onChange={e => setSearch(e.target.value)} />
      </div>
      <div className="space-y-3">
        {filtered.map((g, i) => (
          <div key={i} className="bg-bg-elevated border border-bg-border rounded-lg p-4">
            <div className="flex items-start justify-between gap-3 mb-2 flex-wrap">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-slate-100 font-medium">{g.name}</span>
                <Tag color={g.status === "Enabled" ? "green" : "gray"}>{g.status}</Tag>
                {!g.linked_ous?.length && <Tag color="yellow">unlinked</Tag>}
              </div>
              <div className="flex gap-3 text-xs text-slate-700 font-mono shrink-0">
                {g.modified && <span>Modified: {g.modified.slice(0,10)}</span>}
                {(g.computer_version != null || g.user_version != null) && (
                  <span>v{g.computer_version ?? 0}/{g.user_version ?? 0}</span>
                )}
              </div>
            </div>
            {g.linked_ous?.length > 0 && (
              <div className="text-xs text-slate-600 mb-2">Linked: {g.linked_ous.join(", ")}</div>
            )}
            {g.computer_settings?.length > 0 && (
              <div className="mt-2">
                <div className="text-xs text-slate-700 mb-1">Computer config:</div>
                <div className="flex flex-wrap gap-1">
                  {g.computer_settings.map((s, j) => <Tag key={j} color="cyan">{s}</Tag>)}
                </div>
              </div>
            )}
            {g.user_settings?.length > 0 && (
              <div className="mt-2">
                <div className="text-xs text-slate-700 mb-1">User config:</div>
                <div className="flex flex-wrap gap-1">
                  {g.user_settings.map((s, j) => <Tag key={j} color="purple">{s}</Tag>)}
                </div>
              </div>
            )}
            {g.details && <GPODetails details={g.details} />}
          </div>
        ))}
      </div>
    </div>
  );
}

function GPODetails({ details = {} }) {
  const [open, setOpen] = useState(false);
  const hasData = Object.keys(details).length > 0;
  if (!hasData) return null;

  const SECTION_LABELS = {
    system_access:     { label: "Password / Lockout Policy",   color: "yellow" },
    privilege_rights:  { label: "User Rights Assignments",     color: "orange" },
    audit_policy:      { label: "Audit Policy",                color: "cyan"   },
    restricted_groups: { label: "Restricted Groups",           color: "red"    },
    security_options:  { label: "Security Options",            color: "purple" },
  };

  const AUDIT_COLORS = {
    "No auditing":           "gray",
    "Success":               "green",
    "Failure":               "red",
    "Success and Failure":   "cyan",
  };

  return (
    <div className="mt-3 border-t border-bg-border pt-3">
      <button onClick={() => setOpen(o => !o)}
        className="text-xs text-slate-600 hover:text-slate-300 transition-colors flex items-center gap-1">
        <span>{open ? "▾" : "▸"}</span>
        <span>Policy details</span>
        <span className="ml-1 text-slate-700">({Object.keys(details).length} section{Object.keys(details).length > 1 ? "s" : ""})</span>
      </button>

      {open && (
        <div className="mt-3 space-y-4">
          {details.system_access && (
            <div>
              <div className="text-xs text-yellow-500 font-medium mb-2 uppercase tracking-wider">
                {SECTION_LABELS.system_access.label}
              </div>
              <div className="grid grid-cols-2 gap-x-6 max-w-lg">
                {Object.entries(details.system_access).map(([k, v]) => (
                  <KV key={k} label={k.replace(/_/g, " ")} value={String(v)}
                    warn={k === "complexity_required" && !v || k === "reversible_encryption" && v} />
                ))}
              </div>
            </div>
          )}

          {details.audit_policy && (
            <div>
              <div className="text-xs text-cyan-DEFAULT font-medium mb-2 uppercase tracking-wider">
                {SECTION_LABELS.audit_policy.label}
              </div>
              <div className="grid grid-cols-2 gap-2">
                {Object.entries(details.audit_policy).map(([cat, val]) => (
                  <div key={cat} className="flex items-center justify-between bg-bg-surface rounded px-2 py-1 text-xs">
                    <span className="text-slate-500">{cat}</span>
                    <Tag color={AUDIT_COLORS[val] || "gray"}>{val}</Tag>
                  </div>
                ))}
              </div>
            </div>
          )}

          {details.privilege_rights && (
            <div>
              <div className="text-xs text-orange-500 font-medium mb-2 uppercase tracking-wider">
                {SECTION_LABELS.privilege_rights.label}
              </div>
              <div className="space-y-2">
                {Object.entries(details.privilege_rights).map(([right, principals]) => (
                  <div key={right} className="text-xs">
                    <div className="text-slate-500 mb-1">{right}</div>
                    <div className="flex flex-wrap gap-1 pl-2">
                      {principals.map((p, i) => <Tag key={i} color="gray">{p}</Tag>)}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {details.restricted_groups && (
            <div>
              <div className="text-xs text-red-DEFAULT font-medium mb-2 uppercase tracking-wider">
                {SECTION_LABELS.restricted_groups.label}
              </div>
              <div className="space-y-2">
                {Object.entries(details.restricted_groups).map(([group, members]) => (
                  <div key={group} className="text-xs">
                    <div className="text-slate-500 mb-1">{group}</div>
                    <div className="flex flex-wrap gap-1 pl-2">
                      {members.map((m, i) => <Tag key={i} color="red">{m}</Tag>)}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {details.security_options && (
            <div>
              <div className="text-xs text-purple-500 font-medium mb-2 uppercase tracking-wider">
                {SECTION_LABELS.security_options.label}
              </div>
              <div className="max-w-lg">
                {Object.entries(details.security_options).map(([k, v]) => (
                  <KV key={k} label={k} value={String(v)} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Users ─────────────────────────────────────────────────────────────────────

function UsersSection({ users = {} }) {
  const list     = users.list || [];
  const [tab, setTab]       = useState("stale");
  const [search, setSearch] = useState("");
  const [showAll, setShowAll] = useState(false);

  const stale    = list.filter(u => u.stale && u.enabled);
  const pne      = list.filter(u => u.pwd_never_expires && u.enabled);
  const disabled = list.filter(u => !u.enabled);
  const deleg    = list.filter(u => u.trusted_for_deleg);
  const shown    = (tab === "stale" ? stale : tab === "pne" ? pne : tab === "disabled" ? disabled : tab === "deleg" ? deleg : list)
                    .filter(u => !search || u.username.toLowerCase().includes(search.toLowerCase()) || (u.display_name||"").toLowerCase().includes(search.toLowerCase()));
  const display  = showAll ? shown : shown.slice(0, 25);

  return (
    <div>
      <div className="flex gap-2 mb-4 text-sm flex-wrap items-center">
        {[
          ["stale",    `Stale (${stale.length})`],
          ["pne",      `Pwd Never Expires (${pne.length})`],
          ["deleg",    `Delegation (${deleg.length})`],
          ["disabled", `Disabled (${disabled.length})`],
          ["all",      `All (${list.length})`],
        ].map(([key, label]) => (
          <FilterBtn key={key} active={tab === key} onClick={() => { setTab(key); setShowAll(false); setSearch(""); }}>{label}</FilterBtn>
        ))}
        <AdInput className="w-48 ml-auto" placeholder="Search…" value={search}
          onChange={e => { setSearch(e.target.value); setShowAll(false); }} />
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left border-b border-bg-border">
            <th className="pb-2 text-slate-500 font-medium">Username</th>
            <th className="pb-2 text-slate-500 font-medium">Name / Dept</th>
            <th className="pb-2 text-slate-500 font-medium">Last Logon</th>
            <th className="pb-2 text-slate-500 font-medium">Logon Script</th>
            <th className="pb-2 text-slate-500 font-medium">Flags</th>
          </tr>
        </thead>
        <tbody>
          {display.map((u, i) => (
            <tr key={i} className="border-b border-bg-border hover:bg-bg-elevated">
              <td className="py-2 text-cyan-DEFAULT font-mono text-xs">{u.username}</td>
              <td className="py-2">
                <div className="text-slate-300 text-sm">{u.display_name || "—"}</div>
                {u.department && <div className="text-slate-600 text-xs">{u.department}</div>}
              </td>
              <td className="py-2 text-slate-500 text-xs">{u.last_logon ? new Date(u.last_logon).toLocaleDateString() : "Never"}</td>
              <td className="py-2 text-slate-600 font-mono text-xs">{u.logon_script || "—"}</td>
              <td className="py-2">
                <div className="flex gap-1 flex-wrap">
                  {!u.enabled            && <Tag color="gray">disabled</Tag>}
                  {u.pwd_never_expires   && <Tag color="yellow">pwd never expires</Tag>}
                  {u.stale && u.enabled  && <Tag color="orange">stale</Tag>}
                  {u.pwd_not_required    && <Tag color="red">no pwd</Tag>}
                  {u.trusted_for_deleg   && <Tag color="red">unconstrained deleg</Tag>}
                  {u.sensitive_no_deleg  && <Tag color="green">no-deleg</Tag>}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {shown.length > 25 && !showAll && (
        <button onClick={() => setShowAll(true)} className="mt-3 text-cyan-DEFAULT hover:text-cyan-bright text-sm">
          Show all {shown.length}
        </button>
      )}
    </div>
  );
}

// ── Groups ────────────────────────────────────────────────────────────────────

function GroupsSection({ groups = {} }) {
  const entries = Object.entries(groups);
  if (entries.length === 0) return <div className="text-slate-600 text-sm">No group data.</div>;
  return (
    <div className="space-y-5">
      {entries.map(([key, grp]) => {
        const isNew     = grp && typeof grp === "object" && !Array.isArray(grp);
        const direct    = isNew ? (grp.members || []) : grp;
        const nested    = isNew ? (grp.nested_members || []) : [];
        const total     = isNew ? grp.total_effective : direct.length;
        const groupName = isNew ? grp.name : key.replace(/_/g, " ");
        return (
          <div key={key}>
            <div className="text-slate-300 font-medium mb-2 capitalize flex items-center gap-2">
              {groupName}
              <span className="text-slate-600 text-sm font-normal">{total} effective</span>
            </div>
            {direct.length === 0 && nested.length === 0
              ? <div className="text-slate-700 text-sm">Empty</div>
              : (
                <div className="space-y-2">
                  {direct.length > 0 && (
                    <div>
                      <div className="text-xs text-slate-700 mb-1">Direct members</div>
                      <div className="flex flex-wrap gap-2">
                        {direct.map((m, i) => <Tag key={i} color="gray">{m}</Tag>)}
                      </div>
                    </div>
                  )}
                  {nested.length > 0 && (
                    <div>
                      <div className="text-xs text-slate-700 mb-1">Via nested groups</div>
                      <div className="flex flex-wrap gap-2">
                        {nested.map((m, i) => <Tag key={i} color="purple">{m}</Tag>)}
                      </div>
                    </div>
                  )}
                </div>
              )}
          </div>
        );
      })}
    </div>
  );
}

// ── Delegation ────────────────────────────────────────────────────────────────

function DelegationSection({ delegations = [] }) {
  if (delegations.length === 0) return (
    <div className="text-green-DEFAULT text-sm flex items-center gap-2">
      <span>✓</span> No delegation misconfigurations found.
    </div>
  );

  const byType = { unconstrained: [], constrained: [], resource_based_constrained: [] };
  delegations.forEach(d => { (byType[d.type] || []).push(d); });

  return (
    <div className="space-y-6">
      {byType.unconstrained.length > 0 && (
        <div>
          <div className="text-red-DEFAULT font-medium mb-2 flex items-center gap-2">
            ⚠ Unconstrained Delegation
            <span className="text-slate-600 text-sm font-normal">({byType.unconstrained.length})</span>
          </div>
          <p className="text-slate-600 text-xs mb-3">These accounts can impersonate any domain user to any service. High-value attack target.</p>
          <div className="space-y-2">
            {byType.unconstrained.map((d, i) => (
              <div key={i} className="flex items-center gap-3 bg-red-dim border border-red-muted rounded px-3 py-2">
                <SevBadge sev={d.severity} />
                <span className="text-slate-100 font-mono text-sm">{d.account}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {byType.constrained.length > 0 && (
        <div>
          <div className="text-orange-500 font-medium mb-2 flex items-center gap-2">
            Constrained Delegation
            <span className="text-slate-600 text-sm font-normal">({byType.constrained.length})</span>
          </div>
          <div className="space-y-3">
            {byType.constrained.map((d, i) => (
              <div key={i} className="bg-bg-elevated border border-bg-border rounded-lg p-3">
                <div className="flex items-center gap-2 mb-2">
                  <SevBadge sev={d.severity} />
                  <span className="text-slate-100 font-mono text-sm">{d.account}</span>
                  {d.protocol_transition && <Tag color="red">protocol transition</Tag>}
                </div>
                {d.allowed_services?.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1">
                    {d.allowed_services.slice(0,8).map((s, j) => <Tag key={j} color="gray">{s}</Tag>)}
                    {d.allowed_services.length > 8 && (
                      <span className="text-xs text-slate-700">+{d.allowed_services.length - 8} more</span>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {byType.resource_based_constrained.length > 0 && (
        <div>
          <div className="text-amber-DEFAULT font-medium mb-2 flex items-center gap-2">
            Resource-Based Constrained Delegation (RBCD)
            <span className="text-slate-600 text-sm font-normal">({byType.resource_based_constrained.length})</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {byType.resource_based_constrained.map((d, i) => <Tag key={i} color="yellow">{d.account}</Tag>)}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Kerberos ──────────────────────────────────────────────────────────────────

function KerberosSection({ spns = [], asrep = [] }) {
  return (
    <div className="space-y-6">
      <Section title="Kerberoastable Accounts" count={spns.length}>
        {spns.length > 0 && (
          <div className="space-y-2">
            {spns.map((s, i) => (
              <div key={i} className="bg-orange-500/10 border border-orange-500/30 rounded p-3 text-sm">
                <span className="text-orange-500 font-mono">{s.username || s.spn}</span>
                {s.spn && s.username && <span className="text-slate-600 ml-3 text-xs">{s.spn}</span>}
              </div>
            ))}
          </div>
        )}
      </Section>
      <Section title="AS-REP Roastable Accounts" count={asrep.length}>
        {asrep.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {asrep.map((a, i) => <Tag key={i} color="red">{a.username}</Tag>)}
          </div>
        )}
      </Section>
    </div>
  );
}

// ── Password Policy ───────────────────────────────────────────────────────────

function PasswordPolicySection({ policy = {}, psos = [] }) {
  const rows = [
    ["Minimum length",      policy.min_length ?? "Unknown",                                                    (policy.min_length ?? 99) < 8],
    ["Complexity required", policy.complexity_required != null ? (policy.complexity_required ? "Yes" : "⚠ No") : "Unknown", !policy.complexity_required],
    ["Lockout threshold",   policy.lockout_threshold != null ? (policy.lockout_threshold === 0 ? "⚠ Never locks out" : `${policy.lockout_threshold} attempts`) : "Unknown", policy.lockout_threshold === 0],
    ["Min password age",    policy.min_age_days != null ? `${policy.min_age_days} days` : "Unknown",           false],
    ["Max password age",    policy.max_age_days != null ? (policy.max_age_days === 0 ? "⚠ Never expires" : `${policy.max_age_days} days`) : "Unknown", policy.max_age_days === 0],
    ["History length",      policy.history_length != null ? `${policy.history_length} passwords` : "Unknown",  false],
    ["Lockout window",      policy.lockout_observation_window != null ? `${policy.lockout_observation_window} min` : "Unknown", false],
    ["Lockout duration",    policy.lockout_duration != null ? `${policy.lockout_duration} min` : "Unknown",    false],
  ];

  return (
    <div className="space-y-6">
      <div>
        <div className="text-slate-300 font-medium mb-3 text-sm">Domain Default Policy</div>
        <div className="max-w-md">
          {rows.map(([label, value, warn]) => <KV key={label} label={label} value={String(value)} warn={!!warn} />)}
        </div>
      </div>

      {psos.length > 0 && (
        <div>
          <div className="text-slate-300 font-medium mb-3 text-sm">
            Fine-Grained Policies (PSOs)
            <span className="ml-2 text-slate-600 font-normal text-xs">Override domain default for specific users/groups</span>
          </div>
          <div className="space-y-3">
            {psos.map((p, i) => (
              <div key={i} className="bg-bg-elevated border border-bg-border rounded-lg p-4">
                <div className="flex items-center gap-2 mb-3 flex-wrap">
                  <span className="text-slate-100 font-medium">{p.name}</span>
                  <Tag color="gray">Precedence: {p.precedence}</Tag>
                  {p.reversible_encryption && <Tag color="red">reversible encryption</Tag>}
                </div>
                <div className="grid grid-cols-2 gap-x-8 text-sm">
                  <KV label="Min length"       value={p.min_length} warn={p.min_length < 8} />
                  <KV label="Max age"          value={p.max_age_days != null ? `${p.max_age_days} days` : null} />
                  <KV label="Lockout"          value={p.lockout_threshold != null ? `${p.lockout_threshold} attempts` : null} warn={p.lockout_threshold === 0} />
                  <KV label="Lockout duration" value={p.lockout_duration_min != null ? `${p.lockout_duration_min} min` : null} />
                  <KV label="History"          value={p.history_length != null ? `${p.history_length} passwords` : null} />
                  <KV label="Complexity"       value={p.complexity_enabled ? "Yes" : "⚠ No"} warn={!p.complexity_enabled} />
                </div>
                {p.applies_to?.length > 0 && (
                  <div className="mt-3">
                    <div className="text-xs text-slate-700 mb-1">Applies to:</div>
                    <div className="flex flex-wrap gap-1">
                      {p.applies_to.map((a, j) => <Tag key={j} color="cyan">{a}</Tag>)}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Shares ────────────────────────────────────────────────────────────────────

function SharesSection({ shares = [] }) {
  if (shares.length === 0) return <div className="text-slate-600 text-sm">No shares found.</div>;
  return (
    <div className="space-y-4">
      {shares.map((s, i) => (
        <div key={i} className="bg-bg-elevated border border-bg-border rounded-lg p-4">
          <div className="flex items-center gap-3 mb-2 flex-wrap">
            <span className="text-cyan-DEFAULT font-mono font-bold">{s.name}</span>
            <Tag color="gray">{s.type}</Tag>
            {s.comment && <span className="text-slate-600 text-xs">{s.comment}</span>}
          </div>
          {s.permissions?.length > 0
            ? (
              <table className="w-full text-xs mt-2">
                <thead>
                  <tr className="text-left border-b border-bg-border">
                    <th className="pb-1 text-slate-600 font-medium">Principal</th>
                    <th className="pb-1 text-slate-600 font-medium">Rights</th>
                    <th className="pb-1 text-slate-600 font-medium">Type</th>
                  </tr>
                </thead>
                <tbody>
                  {s.permissions.map((p, j) => (
                    <tr key={j} className="border-b border-bg-border">
                      <td className="py-1 text-slate-300 font-mono">{p.principal}</td>
                      <td className="py-1">
                        <Tag color={p.readable === "Full Control" ? "orange" : p.readable === "Change" ? "yellow" : "gray"}>
                          {p.readable}
                        </Tag>
                      </td>
                      <td className="py-1">
                        <Tag color={p.access_type === "DENIED" ? "red" : "gray"}>{p.access_type}</Tag>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
            : <div className="text-slate-700 text-xs mt-1">No share-level ACL data collected</div>
          }
        </div>
      ))}
    </div>
  );
}

// ── Security — LAPS, AdminSDHolder, Protected Users, Service Accounts ─────────

function SecuritySection({ laps = {}, adminsdholder = [], protectedUsers = [], serviceAccounts = [] }) {
  const [tab, setTab] = useState("laps");
  const tabs = [
    ["laps",     "LAPS"],
    ["sdholder", `AdminSDHolder (${adminsdholder.length})`],
    ["protected",`Protected Users (${protectedUsers.length})`],
    ["svcaccts", `Service Accounts (${serviceAccounts.length})`],
  ];

  return (
    <div className="space-y-4">
      <div className="border-b border-bg-border">
        <div className="flex gap-1 overflow-x-auto">
          {tabs.map(([key, label]) => (
            <button key={key} onClick={() => setTab(key)}
              className={`px-4 py-2 text-sm whitespace-nowrap transition-colors border-b-2 -mb-px ${
                tab === key ? "border-cyan-DEFAULT text-cyan-DEFAULT" : "border-transparent text-slate-500 hover:text-slate-200"
              }`}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {tab === "laps" && (
        <div>
          <div className="flex items-center gap-3 mb-4">
            <div className={`w-3 h-3 rounded-full ${laps.deployed ? "bg-green-DEFAULT" : "bg-red-DEFAULT"}`} />
            <span className={`font-medium ${laps.deployed ? "text-green-DEFAULT" : "text-red-DEFAULT"}`}>
              {laps.deployed ? "LAPS Deployed" : "LAPS Not Deployed"}
            </span>
          </div>
          {laps.deployed
            ? (
              <div className="space-y-4">
                <div className="max-w-sm">
                  <KV label="Schema present" value={laps.schema_present ? "Yes" : "No"} />
                  <KV label="Enrolled"       value={`${laps.enrolled_count} / ${laps.total_computers} computers`} warn={(laps.coverage_pct || 0) < 80} />
                  <KV label="Coverage"       value={`${laps.coverage_pct ?? 0}%`} warn={(laps.coverage_pct || 0) < 80} />
                </div>
                {laps.coverage_pct != null && (
                  <div className="max-w-sm">
                    <div className="h-2 bg-bg-border rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all ${laps.coverage_pct >= 80 ? "bg-green-DEFAULT" : laps.coverage_pct >= 50 ? "bg-amber-DEFAULT" : "bg-red-DEFAULT"}`}
                        style={{ width: `${laps.coverage_pct}%` }}
                      />
                    </div>
                  </div>
                )}
              </div>
            )
            : (
              <div className="bg-red-dim border border-red-muted rounded p-4 text-sm text-slate-300">
                {laps.detail || "LAPS is not installed. All computers likely share the same local administrator password, making lateral movement trivial once one machine is compromised."}
              </div>
            )
          }
        </div>
      )}

      {tab === "sdholder" && (
        adminsdholder.length === 0
          ? <div className="text-slate-600 text-sm">No AdminSDHolder-protected accounts found.</div>
          : (
            <div>
              <p className="text-slate-600 text-xs mb-3">
                Accounts with adminCount=1. Their ACLs are overwritten periodically by SDProp to match the AdminSDHolder template.
                Disabled accounts that remain here continue to have their ACLs reset.
              </p>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left border-b border-bg-border">
                    <th className="pb-2 text-slate-500 font-medium">Account</th>
                    <th className="pb-2 text-slate-500 font-medium">Status</th>
                    <th className="pb-2 text-slate-500 font-medium">Last Logon</th>
                  </tr>
                </thead>
                <tbody>
                  {adminsdholder.map((a, i) => (
                    <tr key={i} className="border-b border-bg-border hover:bg-bg-elevated">
                      <td className="py-2 text-cyan-DEFAULT font-mono text-xs">{a.username}</td>
                      <td className="py-2"><Tag color={a.enabled ? "green" : "gray"}>{a.enabled ? "Enabled" : "Disabled"}</Tag></td>
                      <td className="py-2 text-slate-500 text-xs">{a.last_logon ? new Date(a.last_logon).toLocaleDateString() : "Never"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
      )}

      {tab === "protected" && (
        protectedUsers.length === 0
          ? <div className="text-slate-600 text-sm">No members in Protected Users group.</div>
          : (
            <div>
              <p className="text-slate-600 text-xs mb-3">
                Protected Users members get enhanced Kerberos protections: no NTLM, no DES/RC4, no delegation, short TGT lifetime.
              </p>
              <div className="flex flex-wrap gap-2">
                {protectedUsers.map((u, i) => <Tag key={i} color="green">{u}</Tag>)}
              </div>
            </div>
          )
      )}

      {tab === "svcaccts" && (
        serviceAccounts.length === 0
          ? <div className="text-slate-600 text-sm">No service accounts found.</div>
          : (
            <div>
              <p className="text-slate-600 text-xs mb-3">
                MSA/gMSA accounts have auto-rotating passwords. User accounts with SPNs are Kerberoastable — consider migrating to gMSA.
              </p>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left border-b border-bg-border">
                    <th className="pb-2 text-slate-500 font-medium">Account</th>
                    <th className="pb-2 text-slate-500 font-medium">Type</th>
                    <th className="pb-2 text-slate-500 font-medium">SPNs</th>
                  </tr>
                </thead>
                <tbody>
                  {serviceAccounts.map((a, i) => {
                    const spns = Array.isArray(a.spns) ? a.spns : (a.spns ? [a.spns] : []);
                    return (
                      <tr key={i} className="border-b border-bg-border hover:bg-bg-elevated">
                        <td className="py-2 text-cyan-DEFAULT font-mono text-xs">{a.name}</td>
                        <td className="py-2">
                          <Tag color={a.type === "gMSA" ? "green" : a.type === "MSA" ? "cyan" : "yellow"}>{a.type}</Tag>
                        </td>
                        <td className="py-2 text-slate-600 text-xs">{spns.slice(0,3).join(", ")}{spns.length > 3 ? ` +${spns.length-3}` : ""}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )
      )}
    </div>
  );
}

// ── Device selector ───────────────────────────────────────────────────────────

function DeviceSelector({ devices, deviceId, onChange }) {
  const grouped = devices.reduce((acc, d) => {
    const key = d.customer_name || "Unassigned";
    if (!acc[key]) acc[key] = [];
    acc[key].push(d);
    return acc;
  }, {});

  return (
    <select
      className="bg-bg-elevated border border-bg-border rounded px-3 py-2 text-slate-200 text-sm min-w-[260px] focus:outline-none focus:border-cyan-DEFAULT"
      value={deviceId || ""}
      onChange={e => onChange(e.target.value)}
    >
      <option value="">— Select an agent —</option>
      {Object.entries(grouped).sort(([a], [b]) => a.localeCompare(b)).map(([customer, devs]) => (
        <optgroup key={customer} label={customer}>
          {devs.map(d => (
            <option key={d.id} value={d.id}>{d.name} ({d.status})</option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

// ── Discovery modal ───────────────────────────────────────────────────────────

function DiscoverModal({ deviceId, onClose, onDiscovered }) {
  const [targets, setTargets] = useState("");
  const [running, setRunning] = useState(false);
  const [taskId,  setTaskId]  = useState(null);
  const [result,  setResult]  = useState(null);
  const [error,   setError]   = useState("");

  async function handleDiscover() {
    const targetList = targets.split(/[\n,\s]+/).map(t => t.trim()).filter(Boolean);
    if (!targetList.length) { setError("Enter at least one IP or CIDR"); return; }
    setRunning(true); setError("");
    try {
      const res = await api.post(`/v1/devices/${deviceId}/ad/discover`, { targets: targetList });
      setTaskId(res.task_id);
      let attempts = 0;
      const poll = setInterval(async () => {
        attempts++;
        try {
          const tasks = await api.get(`/v1/devices/${deviceId}/tasks`);
          const task = tasks.find(t => t.id === res.task_id);
          if (task?.status === "completed") {
            clearInterval(poll); setResult(task.result); setRunning(false);
          } else if (task?.status === "failed" || attempts > 40) {
            clearInterval(poll); setError(task?.error || "Discovery timed out"); setRunning(false);
          }
        } catch { /* keep polling */ }
      }, 3000);
    } catch (e) { setError(e.message); setRunning(false); }
  }

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="bg-bg-surface border border-bg-border rounded-xl p-6 w-full max-w-lg shadow-2xl">
        <h2 className="text-lg font-semibold text-slate-100 mb-1">AD Discovery</h2>
        <p className="text-slate-500 text-sm mb-4">Unauthenticated scan — detects domain controllers and domain name.</p>
        {error && <div className="text-red-DEFAULT text-sm mb-3 bg-red-dim border border-red-muted rounded p-3">{error}</div>}
        {!result ? (
          <>
            <label className="block text-xs text-slate-500 mb-1">Target IPs / CIDRs (one per line)</label>
            <textarea
              className="w-full bg-bg-elevated border border-bg-border rounded px-3 py-2 text-slate-200 text-sm font-mono h-28 resize-none focus:outline-none focus:border-cyan-DEFAULT"
              placeholder={"192.168.1.0/24\n10.0.0.0/24"}
              value={targets} onChange={e => setTargets(e.target.value)} disabled={running}
            />
            <div className="flex gap-2 mt-4 justify-end">
              <button onClick={onClose} className="px-4 py-2 text-sm text-slate-500 hover:text-slate-200">Cancel</button>
              <button onClick={handleDiscover} disabled={running}
                className="px-4 py-2 bg-cyan-DEFAULT hover:bg-cyan-bright text-bg-base rounded text-sm font-medium disabled:opacity-50">
                {running ? (taskId ? "Scanning…" : "Starting…") : "Start Discovery"}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="bg-bg-elevated border border-bg-border rounded p-4 space-y-2 text-sm mb-4">
              <div className="flex justify-between">
                <span className="text-slate-500">Domain</span>
                <span className="text-slate-100 font-bold">{result.domain_name || "Not detected"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">DCs found</span>
                <span className="text-slate-100">{result.dc_candidates}</span>
              </div>
              {result.domain_controllers?.slice(0,3).map((dc, i) => (
                <div key={i} className="flex justify-between">
                  <span className="text-slate-600">DC {i+1}</span>
                  <span className="text-cyan-DEFAULT font-mono text-xs">{dc.ip} ({dc.confidence})</span>
                </div>
              ))}
              <div className="pt-2 text-slate-300 text-xs border-t border-bg-border">{result.recommendation}</div>
            </div>
            <div className="flex gap-2 justify-end">
              <button onClick={onClose} className="px-4 py-2 text-sm text-slate-500 hover:text-slate-200">Close</button>
              {result.domain_name && result.domain_controllers?.[0] && (
                <button onClick={() => onDiscovered(result)}
                  className="px-4 py-2 bg-cyan-DEFAULT hover:bg-cyan-bright text-bg-base rounded text-sm font-medium">
                  Enter Credentials →
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Recon modal ───────────────────────────────────────────────────────────────

function ReconModal({ deviceId, prefill, onClose, onComplete }) {
  const [form, setForm] = useState({
    dc_ip:    prefill?.domain_controllers?.[0]?.ip || "",
    domain:   prefill?.domain_name || "",
    username: "",
    password: "",
    base_dn:  prefill?.domain_controllers?.[0]?.base_dn || "",
  });
  const [running,  setRunning]  = useState(false);
  const [error,    setError]    = useState("");
  const [progress, setProgress] = useState("");

  async function handleRecon() {
    if (!form.dc_ip || !form.domain || !form.username || !form.password) {
      setError("All fields required"); return;
    }
    setRunning(true); setError(""); setProgress("Sending task to agent…");
    try {
      const res = await api.post(`/v1/devices/${deviceId}/ad/recon`, form);
      setProgress("Running AD recon — this may take 1–2 minutes…");
      let attempts = 0;
      const poll = setInterval(async () => {
        attempts++;
        try {
          const tasks = await api.get(`/v1/devices/${deviceId}/tasks`);
          const task = tasks.find(t => t.id === res.task_id);
          if (task?.status === "completed") {
            clearInterval(poll); setProgress("Done — loading report…");
            setTimeout(() => { onComplete(); onClose(); }, 1000);
          } else if (task?.status === "failed" || attempts > 60) {
            clearInterval(poll); setError(task?.error || "Recon timed out or failed"); setRunning(false);
          }
        } catch { /* keep polling */ }
      }, 3000);
    } catch (e) { setError(e.message); setRunning(false); }
  }

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="bg-bg-surface border border-bg-border rounded-xl p-6 w-full max-w-lg shadow-2xl">
        <h2 className="text-lg font-semibold text-slate-100 mb-1">Full AD Recon</h2>
        <p className="text-slate-500 text-sm mb-4">Credentials are used only during the task and are never stored on the server.</p>
        {error   && <div className="text-red-DEFAULT text-sm mb-3 bg-red-dim border border-red-muted rounded p-3">{error}</div>}
        {running && <div className="text-cyan-DEFAULT text-sm mb-3 animate-pulse">{progress}</div>}
        <div className="space-y-3">
          {[
            ["dc_ip",    "Domain Controller IP", "192.168.1.10"],
            ["domain",   "Domain",               "CORP.LOCAL"],
            ["username", "Username",              "administrator"],
            ["base_dn",  "Base DN (optional)",    "DC=corp,DC=local"],
          ].map(([key, label, ph]) => (
            <div key={key}>
              <label className="block text-xs text-slate-500 mb-1">{label}</label>
              <input
                className="w-full bg-bg-elevated border border-bg-border rounded px-3 py-2 text-slate-200 text-sm font-mono focus:outline-none focus:border-cyan-DEFAULT"
                placeholder={ph} value={form[key]}
                onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
                disabled={running}
              />
            </div>
          ))}
          <div>
            <label className="block text-xs text-slate-500 mb-1">Password</label>
            <input type="password"
              className="w-full bg-bg-elevated border border-bg-border rounded px-3 py-2 text-slate-200 text-sm focus:outline-none focus:border-cyan-DEFAULT"
              value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} disabled={running}
            />
          </div>
        </div>
        <div className="flex gap-2 mt-5 justify-end">
          <button onClick={onClose} disabled={running} className="px-4 py-2 text-sm text-slate-500 hover:text-slate-200 disabled:opacity-50">Cancel</button>
          <button onClick={handleRecon} disabled={running}
            className="px-4 py-2 bg-red-DEFAULT hover:bg-red-bright text-white rounded text-sm font-medium disabled:opacity-50">
            {running ? "Running…" : "Run Full Recon"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function ADReportPage() {
  const { id: routeDeviceId } = useParams();
  const navigate = useNavigate();

  const [devices,        setDevices]        = useState([]);
  const [deviceId,       setDeviceId]       = useState(routeDeviceId || "");
  const [reports,        setReports]        = useState([]);
  const [selected,       setSelected]       = useState(null);
  const [tab,            setTab]            = useState("Findings");
  const [loading,        setLoading]        = useState(false);
  const [devicesLoading, setDevicesLoading] = useState(true);
  const [showDiscover,   setShowDiscover]   = useState(false);
  const [showRecon,      setShowRecon]      = useState(false);
  const [discoverResult, setDiscoverResult] = useState(null);

  useEffect(() => {
    api.getDevices()
      .then(d => setDevices(d))
      .catch(() => {})
      .finally(() => setDevicesLoading(false));
  }, []);

  useEffect(() => {
    if (!deviceId) { setReports([]); setSelected(null); return; }
    setLoading(true);
    api.get(`/v1/devices/${deviceId}/ad/reports`)
      .then(list => {
        setReports(list);
        if (list.length > 0) {
          return api.get(`/v1/devices/${deviceId}/ad/reports/${list[0].id}`)
            .then(r => { setSelected(r); setTab("Findings"); });
        } else {
          setSelected(null);
        }
      })
      .catch(e => console.error(e))
      .finally(() => setLoading(false));
  }, [deviceId]);

  async function loadFullReport(reportId) {
    setLoading(true);
    try {
      const r = await api.get(`/v1/devices/${deviceId}/ad/reports/${reportId}`);
      setSelected(r); setTab("Findings");
    } finally { setLoading(false); }
  }

  const currentDevice = devices.find(d => d.id === deviceId);
  const rd = selected?.report_data;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div className="flex items-center gap-4 flex-wrap">
          {routeDeviceId && (
            <button onClick={() => navigate(`/devices/${routeDeviceId}`)}
              className="text-slate-600 hover:text-slate-200 transition-colors text-sm">
              ← Device
            </button>
          )}
          <h1 className="text-2xl font-bold text-slate-100">AD Report</h1>

          <DeviceSelector
            devices={devices}
            deviceId={deviceId}
            onChange={id => { setDeviceId(id); setSelected(null); setReports([]); }}
          />

          {currentDevice && (
            <div className="flex items-center gap-2 text-sm">
              {currentDevice.customer_name && (
                <span className="text-slate-600 font-mono">{currentDevice.customer_name}</span>
              )}
              {selected?.domain && (
                <span className="text-cyan-DEFAULT font-mono bg-cyan-dim border border-cyan-muted px-2 py-1 rounded">
                  {selected.domain}
                </span>
              )}
            </div>
          )}
        </div>

        {deviceId && (
          <div className="flex gap-2">
            <button onClick={() => setShowDiscover(true)}
              className="px-4 py-2 bg-bg-elevated hover:bg-bg-border text-slate-200 rounded text-sm font-medium transition-colors border border-bg-border">
              Discover
            </button>
            <button onClick={() => setShowRecon(true)}
              className="px-4 py-2 bg-red-DEFAULT hover:bg-red-bright text-white rounded text-sm font-medium transition-colors">
              + Run Recon
            </button>
          </div>
        )}
      </div>

      {!deviceId && !devicesLoading && (
        <div className="text-center py-20">
          <div className="text-slate-600 text-lg mb-2">Select an agent to view AD reports</div>
        </div>
      )}

      {deviceId && loading && (
        <div className="text-center py-20 text-slate-600">Loading…</div>
      )}

      {deviceId && !loading && reports.length === 0 && (
        <div className="text-center py-20">
          <div className="text-slate-600 text-lg mb-2">No AD reports yet for this agent</div>
          <p className="text-slate-700 text-sm mb-6">Run Discovery first, then run a full recon.</p>
          <button onClick={() => setShowDiscover(true)}
            className="px-6 py-3 bg-cyan-DEFAULT hover:bg-cyan-bright text-bg-base rounded-lg font-medium transition-colors">
            Start AD Discovery
          </button>
        </div>
      )}

      {deviceId && !loading && reports.length > 0 && (
        <div className="flex gap-6">
          {/* Report list sidebar */}
          <div className="w-56 flex-shrink-0 space-y-2">
            <div className="text-xs text-slate-600 uppercase tracking-wider mb-3">Reports</div>
            {reports.map(r => (
              <button key={r.id} onClick={() => loadFullReport(r.id)}
                className={`w-full text-left p-3 rounded-lg border transition-colors ${
                  selected?.id === r.id
                    ? "bg-bg-elevated border-slate-500"
                    : "bg-bg-surface border-bg-border hover:bg-bg-elevated"
                }`}>
                <div className="text-slate-100 text-sm font-medium">{r.domain || "Unknown domain"}</div>
                <div className="text-slate-600 text-xs mt-1">{new Date(r.created_at).toLocaleDateString()}</div>
                <div className="flex gap-1 mt-2 flex-wrap">
                  {r.findings_critical > 0 && (
                    <span className="text-xs bg-red-dim text-red-DEFAULT px-1.5 rounded">{r.findings_critical} crit</span>
                  )}
                  {r.findings_high > 0 && (
                    <span className="text-xs bg-orange-500/10 text-orange-500 px-1.5 rounded">{r.findings_high} high</span>
                  )}
                  {r.laps_deployed === false && (
                    <span className="text-xs bg-amber-dim text-amber-DEFAULT px-1.5 rounded">no LAPS</span>
                  )}
                </div>
              </button>
            ))}
          </div>

          {/* Report detail */}
          {selected && rd && (
            <div className="flex-1 min-w-0 space-y-6">
              {/* Stat cards */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <StatCard label="Users"          value={rd.summary?.total_users} />
                <StatCard label="Computers"      value={rd.summary?.computer_count} />
                <StatCard label="Domain Admins"  value={rd.summary?.domain_admins}
                  color={rd.summary?.domain_admins > 5 ? "text-yellow-500" : "text-slate-200"} />
                <StatCard label="Stale Accounts" value={rd.summary?.stale_accounts}
                  color={rd.summary?.stale_accounts > 10 ? "text-yellow-500" : "text-slate-200"} />
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <StatCard label="Kerberoastable"      value={rd.summary?.kerberoastable}
                  color={rd.summary?.kerberoastable > 0 ? "text-orange-500" : "text-slate-200"} />
                <StatCard label="AS-REP Roastable"    value={rd.summary?.asrep_roastable}
                  color={rd.summary?.asrep_roastable > 0 ? "text-red-DEFAULT" : "text-slate-200"} />
                <StatCard label="Unconstrained Deleg" value={rd.summary?.unconstrained_delegation}
                  color={rd.summary?.unconstrained_delegation > 0 ? "text-red-DEFAULT" : "text-slate-200"} />
                <StatCard label="LAPS Coverage"       value={rd.summary?.laps_deployed === false ? "N/A" : `${rd.summary?.laps_coverage_pct ?? 0}%`}
                  sub={rd.summary?.laps_deployed === false ? "Not deployed" : null}
                  color={rd.summary?.laps_deployed === false ? "text-red-DEFAULT" : rd.summary?.laps_coverage_pct < 80 ? "text-yellow-500" : "text-green-DEFAULT"} />
              </div>

              {/* Quick info bar */}
              <div className="flex flex-wrap gap-4 text-sm bg-bg-elevated border border-bg-border rounded-lg px-4 py-3">
                <div><span className="text-slate-500">DC: </span><span className="text-slate-100 font-mono">{rd.domain_info?.dc_ip || "—"}</span></div>
                <div><span className="text-slate-500">Level: </span><span className="text-slate-100">{rd.domain_info?.functional_level || "—"}</span></div>
                <div><span className="text-slate-500">DCs: </span><span className="text-slate-100">{rd.dc_list?.length ?? 1}</span></div>
                <div><span className="text-slate-500">Trusts: </span><span className="text-slate-100">{rd.trusts?.length ?? 0}</span></div>
                <div><span className="text-slate-500">GPOs: </span><span className="text-slate-100">{rd.gpos?.length ?? 0}</span></div>
                <div><span className="text-slate-500">Shares: </span><span className="text-slate-100">{rd.summary?.shares_found ?? 0}</span></div>
                <div><span className="text-slate-500">PSOs: </span><span className="text-slate-100">{rd.fine_grained_policies?.length ?? 0}</span></div>
                <div><span className="text-slate-500">Service accts: </span><span className="text-slate-100">{rd.summary?.service_accounts ?? 0}</span></div>
              </div>

              {/* Left nav + content */}
              <div className="flex gap-0 min-h-0">
                {/* Left nav */}
                <div className="w-44 flex-shrink-0 border-r border-bg-border pr-1 space-y-0.5">
                  {[
                    { group: "SUMMARY",  items: [
                      { key: "Findings",       icon: "⚑", badge: rd.findings?.length > 0 ? { text: rd.findings.length, color: "bg-red-dim text-red-DEFAULT" } : null },
                    ]},
                    { group: "DIRECTORY", items: [
                      { key: "Infrastructure", icon: "⬡" },
                      { key: "Computers",      icon: "▣" },
                      { key: "Users",          icon: "◉" },
                      { key: "Groups",         icon: "⬡" },
                    ]},
                    { group: "POLICY", items: [
                      { key: "GPOs",           icon: "≡" },
                      { key: "Password Policy",icon: "⊕" },
                    ]},
                    { group: "SECURITY", items: [
                      { key: "Delegation",     icon: "⟳", badge: rd.summary?.unconstrained_delegation > 0 ? { text: "!", color: "bg-red-dim text-red-DEFAULT" } : null },
                      { key: "Kerberos",       icon: "⚿" },
                      { key: "Shares",         icon: "⊞" },
                      { key: "Security",       icon: "⊘", badge: rd.summary?.laps_deployed === false ? { text: "!", color: "bg-amber-dim text-amber-DEFAULT" } : null },
                    ]},
                  ].map(({ group, items }) => (
                    <div key={group} className="pb-2">
                      <div className="text-slate-700 text-xs font-semibold tracking-widest px-3 py-2 select-none">{group}</div>
                      {items.map(({ key, icon, badge }) => (
                        <button key={key} onClick={() => setTab(key)}
                          className={`w-full flex items-center justify-between px-3 py-2 rounded-md text-sm transition-all ${
                            tab === key
                              ? "bg-bg-elevated text-slate-100 font-medium"
                              : "text-slate-500 hover:text-slate-200 hover:bg-bg-elevated"
                          }`}>
                          <span className="flex items-center gap-2">
                            <span className={`text-base leading-none ${tab === key ? "text-cyan-DEFAULT" : "text-slate-600"}`}>{icon}</span>
                            <span>{key}</span>
                          </span>
                          {badge && (
                            <span className={`text-xs px-1.5 py-0.5 rounded font-bold ${badge.color}`}>{badge.text}</span>
                          )}
                        </button>
                      ))}
                    </div>
                  ))}
                </div>

                {/* Content area */}
                <div className="flex-1 min-w-0 pl-6">
                  {tab === "Findings"       && <FindingsSection findings={rd.findings} />}
                  {tab === "Infrastructure" && (
                    <InfrastructureSection
                      domainInfo={rd.domain_info}
                      dcList={rd.dc_list || []}
                      trusts={rd.trusts || []}
                      dnsZones={rd.dns_zones || []}
                      dhcpScopes={rd.dhcp_scopes || []}
                      ous={rd.ous || []}
                    />
                  )}
                  {tab === "Computers"       && <ComputersSection computers={rd.computers || {}} />}
                  {tab === "GPOs"            && <GPOSection gpos={rd.gpos || []} />}
                  {tab === "Users"           && <UsersSection users={rd.users} />}
                  {tab === "Groups"          && <GroupsSection groups={rd.groups} />}
                  {tab === "Delegation"      && <DelegationSection delegations={rd.delegations || []} />}
                  {tab === "Kerberos"        && <KerberosSection spns={rd.kerberoastable} asrep={rd.asrep_roastable} />}
                  {tab === "Password Policy" && (
                    <PasswordPolicySection
                      policy={rd.password_policy}
                      psos={rd.fine_grained_policies || []}
                    />
                  )}
                  {tab === "Shares"          && <SharesSection shares={rd.shares} />}
                  {tab === "Security"        && (
                    <SecuritySection
                      laps={rd.laps_status || {}}
                      adminsdholder={rd.adminsdholder_accounts || []}
                      protectedUsers={rd.protected_users || []}
                      serviceAccounts={rd.service_accounts || []}
                    />
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {showDiscover && deviceId && (
        <DiscoverModal
          deviceId={deviceId}
          onClose={() => setShowDiscover(false)}
          onDiscovered={result => { setDiscoverResult(result); setShowDiscover(false); setShowRecon(true); }}
        />
      )}

      {showRecon && deviceId && (
        <ReconModal
          deviceId={deviceId}
          prefill={discoverResult}
          onClose={() => { setShowRecon(false); setDiscoverResult(null); }}
          onComplete={() => {
            api.get(`/v1/devices/${deviceId}/ad/reports`).then(list => {
              setReports(list);
              if (list.length > 0) loadFullReport(list[0].id);
            }).catch(() => {});
          }}
        />
      )}
    </div>
  );
}
