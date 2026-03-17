import { AlertTriangle, CheckCircle, Info, X, Loader2 } from 'lucide-react'

// ── Status Badge ──────────────────────────────────────────────────────────────
const STATUS_MAP = {
  active:     { dot: 'bg-green-DEFAULT animate-pulse-slow', text: 'text-green-DEFAULT', label: 'Active' },
  offline:    { dot: 'bg-slate-600', text: 'text-slate-500', label: 'Offline' },
  pending:    { dot: 'bg-amber-DEFAULT animate-pulse-slow', text: 'text-amber-DEFAULT', label: 'Pending' },
  revoked:    { dot: 'bg-red-DEFAULT', text: 'text-red-DEFAULT', label: 'Revoked' },
  queued:     { dot: 'bg-cyan-DEFAULT animate-pulse-slow', text: 'text-cyan-DEFAULT', label: 'Queued' },
  dispatched: { dot: 'bg-cyan-DEFAULT animate-pulse-slow', text: 'text-cyan-DEFAULT', label: 'Dispatched' },
  running:    { dot: 'bg-amber-DEFAULT animate-pulse-slow', text: 'text-amber-DEFAULT', label: 'Running' },
  completed:  { dot: 'bg-green-DEFAULT', text: 'text-green-DEFAULT', label: 'Completed' },
  failed:     { dot: 'bg-red-DEFAULT', text: 'text-red-DEFAULT', label: 'Failed' },
  timeout:    { dot: 'bg-red-muted', text: 'text-red-muted', label: 'Timeout' },
}

export function StatusBadge({ status }) {
  const s = STATUS_MAP[status] || { dot: 'bg-slate-600', text: 'text-slate-400', label: status }
  return (
    <span className="flex items-center gap-1.5">
      <span className={`status-dot ${s.dot}`} />
      <span className={`text-xs font-mono ${s.text}`}>{s.label}</span>
    </span>
  )
}

// ── Spinner ───────────────────────────────────────────────────────────────────
export function Spinner({ className = 'w-5 h-5' }) {
  return <Loader2 className={`animate-spin text-cyan-DEFAULT ${className}`} />
}

// ── Empty State ───────────────────────────────────────────────────────────────
export function Empty({ icon: Icon, title, description, action }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      {Icon && <Icon className="w-10 h-10 text-bg-border mb-4" strokeWidth={1} />}
      <p className="font-display font-600 text-slate-400 mb-1">{title}</p>
      {description && <p className="text-sm text-slate-600 mb-4">{description}</p>}
      {action}
    </div>
  )
}

// ── Toast / Alert ─────────────────────────────────────────────────────────────
export function Alert({ type = 'info', message, onClose }) {
  const styles = {
    info:    { bg: 'bg-cyan-dim border-cyan-muted',   icon: Info,          iconClass: 'text-cyan-DEFAULT' },
    success: { bg: 'bg-green-dim border-green-muted', icon: CheckCircle,   iconClass: 'text-green-DEFAULT' },
    error:   { bg: 'bg-red-dim border-red-muted',     icon: AlertTriangle, iconClass: 'text-red-DEFAULT' },
    warning: { bg: 'bg-amber-dim border-amber-muted', icon: AlertTriangle, iconClass: 'text-amber-DEFAULT' },
  }
  const s = styles[type]
  const Icon = s.icon
  return (
    <div className={`flex items-start gap-3 p-3 rounded border ${s.bg} animate-slide-up`}>
      <Icon className={`w-4 h-4 mt-0.5 shrink-0 ${s.iconClass}`} />
      <p className="text-sm text-slate-300 flex-1">{message}</p>
      {onClose && <button onClick={onClose}><X className="w-4 h-4 text-slate-500 hover:text-slate-300" /></button>}
    </div>
  )
}

// ── Modal ─────────────────────────────────────────────────────────────────────
export function Modal({ title, children, onClose, width = 'max-w-lg' }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className={`relative card w-full ${width} animate-slide-up`}>
        <div className="flex items-center justify-between p-4 border-b border-bg-border">
          <h3 className="font-display font-600 text-slate-200">{title}</h3>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  )
}

// ── Page Header ───────────────────────────────────────────────────────────────
export function PageHeader({ title, subtitle, actions }) {
  return (
    <div className="flex items-start justify-between mb-6">
      <div>
        <h1 className="font-display font-700 text-xl text-slate-100">{title}</h1>
        {subtitle && <p className="text-sm text-slate-500 mt-0.5">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  )
}

// ── Stat Card ─────────────────────────────────────────────────────────────────
export function StatCard({ label, value, sub, accent = 'cyan', icon: Icon }) {
  const accents = {
    cyan:  'text-cyan-DEFAULT border-cyan-dim',
    green: 'text-green-DEFAULT border-green-dim',
    amber: 'text-amber-DEFAULT border-amber-dim',
    red:   'text-red-DEFAULT border-red-dim',
    slate: 'text-slate-400 border-bg-border',
  }
  return (
    <div className="card p-4 flex items-start justify-between">
      <div>
        <p className="label">{label}</p>
        <p className={`font-display font-700 text-2xl mt-1 ${accents[accent].split(' ')[0]}`}>{value}</p>
        {sub && <p className="text-xs text-slate-600 mt-1">{sub}</p>}
      </div>
      {Icon && (
        <div className={`p-2 rounded border ${accents[accent].split(' ')[1]} bg-bg-base`}>
          <Icon className={`w-4 h-4 ${accents[accent].split(' ')[0]}`} />
        </div>
      )}
    </div>
  )
}

// ── Code / Mono block ─────────────────────────────────────────────────────────
export function CodeBlock({ children, content }) {
  const raw = content ?? children
  const text = typeof raw === 'object' && raw !== null ? JSON.stringify(raw, null, 2) : raw
  return (
    <pre className="bg-bg-base border border-bg-border rounded p-3 text-xs font-mono text-slate-300 overflow-auto max-h-64">
      {text}
    </pre>
  )
}

// ── Table ─────────────────────────────────────────────────────────────────────
// headers: array of strings OR { label, key } objects.
// Pass sortKey, sortDir, onSort to enable clickable column sorting.
export function Table({ headers, children, empty, sortKey, sortDir, onSort }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-bg-border">
            {headers.map(h => {
              const label    = typeof h === 'string' ? h : h.label
              const key      = typeof h === 'string' ? null : h.key
              const active   = key && sortKey === key
              const sortable = key && onSort
              return (
                <th
                  key={label || '_action'}
                  onClick={sortable ? () => onSort(key) : undefined}
                  className={[
                    'text-left py-2 px-3 text-xs font-display font-500 uppercase tracking-widest',
                    active ? 'text-cyan-DEFAULT' : 'text-slate-500',
                    sortable ? 'cursor-pointer select-none hover:text-slate-300' : '',
                  ].join(' ')}
                >
                  <span className="inline-flex items-center gap-1">
                    {label}
                    {active && <span>{sortDir === 'asc' ? '↑' : '↓'}</span>}
                    {!active && sortable && <span className="opacity-20">↕</span>}
                  </span>
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
      {empty}
    </div>
  )
}

export function TR({ children, onClick, className = '' }) {
  return (
    <tr
      onClick={onClick}
      className={`border-b border-bg-border/50 hover:bg-bg-elevated transition-colors duration-100 ${onClick ? 'cursor-pointer' : ''} ${className}`}
    >
      {children}
    </tr>
  )
}

export function TD({ children, className = '' }) {
  return <td className={`py-2.5 px-3 text-slate-300 ${className}`}>{children}</td>
}
