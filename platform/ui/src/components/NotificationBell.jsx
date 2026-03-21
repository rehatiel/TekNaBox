import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Bell, Wifi, ShieldAlert, AlertTriangle, CheckCircle, X } from 'lucide-react'
import { api } from '../lib/api'

const POLL_MS = 60_000

function buildItems(devices, findings, tasks) {
  const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const items = []

  // Offline devices
  devices
    .filter(d => d.status === 'offline')
    .forEach(d => items.push({
      id: `offline-${d.id}`,
      type: 'offline',
      title: `${d.name} is offline`,
      to: `/devices/${d.id}`,
    }))

  // Critical + high unacknowledged findings
  findings
    .filter(f => !f.acknowledged && (f.severity === 'critical' || f.severity === 'high'))
    .forEach(f => items.push({
      id: `finding-${f.id}`,
      type: f.severity,
      title: f.title,
      sub: f.severity,
      to: '/findings',
    }))

  // Failed/timed-out tasks in last 24h — grouped into a single entry
  const failed = (Array.isArray(tasks) ? tasks : []).filter(t =>
    (t.status === 'failed' || t.status === 'timeout') &&
    t.queued_at && new Date(t.queued_at) > cutoff24h
  )
  if (failed.length > 0) {
    items.push({
      id: `tasks-failed-24h`,
      type: 'warning',
      title: `${failed.length} task${failed.length > 1 ? 's' : ''} failed in the last 24h`,
      to: '/tasks',
    })
  }

  return items
}

function TypeIcon({ type }) {
  if (type === 'offline')  return <Wifi        className="w-3.5 h-3.5 text-slate-500" />
  if (type === 'critical') return <ShieldAlert className="w-3.5 h-3.5 text-red-DEFAULT" />
  if (type === 'high')     return <ShieldAlert className="w-3.5 h-3.5 text-orange-400" />
  return                          <AlertTriangle className="w-3.5 h-3.5 text-amber-DEFAULT" />
}

export default function NotificationBell() {
  const navigate = useNavigate()
  const [open, setOpen]   = useState(false)
  const [items, setItems] = useState([])
  const [dismissed, setDismissed] = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem('notif-dismissed') || '[]')) }
    catch { return new Set() }
  })
  const ref = useRef(null)

  const poll = useCallback(async () => {
    try {
      const [devices, findings, tasks] = await Promise.all([
        api.getDevices().catch(() => []),
        api.get('/v1/findings').catch(() => []),
        api.getAllTasks({ limit: 200 }).catch(() => []),
      ])
      setItems(buildItems(devices, findings, tasks))
    } catch {}
  }, [])

  useEffect(() => {
    poll()
    const id = setInterval(poll, POLL_MS)
    return () => clearInterval(id)
  }, [poll])

  // Close on outside click
  useEffect(() => {
    const handler = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const visible = items.filter(n => !dismissed.has(n.id))
  const unread  = visible.length

  const dismiss = (id, e) => {
    e?.stopPropagation()
    const next = new Set([...dismissed, id])
    setDismissed(next)
    localStorage.setItem('notif-dismissed', JSON.stringify([...next]))
  }

  const dismissAll = () => {
    const next = new Set(items.map(n => n.id))
    setDismissed(next)
    localStorage.setItem('notif-dismissed', JSON.stringify([...next]))
    setOpen(false)
  }

  const go = (to) => { navigate(to); setOpen(false) }

  return (
    <div ref={ref} className="fixed top-3 right-14 z-50">
      <button
        onClick={() => setOpen(o => !o)}
        title={`Notifications${unread > 0 ? ` — ${unread} alert${unread > 1 ? 's' : ''}` : ''}`}
        className="relative w-8 h-8 flex items-center justify-center rounded-full bg-bg-elevated border border-bg-border text-slate-500 hover:text-slate-300 hover:border-slate-500 transition-all duration-150"
      >
        <Bell className="w-4 h-4" />
        {unread > 0 && (
          <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-red-DEFAULT text-white text-[9px] font-bold flex items-center justify-center leading-none">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-10 w-80 bg-bg-surface border border-bg-border rounded-xl shadow-2xl overflow-hidden animate-fade-in">
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-bg-border">
            <span className="text-sm font-display font-600 text-slate-200">Notifications</span>
            {visible.length > 0 && (
              <button onClick={dismissAll} className="text-xs text-slate-600 hover:text-slate-300 transition-colors">
                Clear all
              </button>
            )}
          </div>

          <div className="max-h-80 overflow-y-auto divide-y divide-bg-border/50">
            {visible.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-8 text-slate-600 text-sm">
                <CheckCircle className="w-6 h-6 text-green-DEFAULT opacity-60" />
                All clear — no alerts
              </div>
            ) : (
              visible.map(n => (
                <div
                  key={n.id}
                  onClick={() => go(n.to)}
                  className="flex items-start gap-3 px-4 py-3 hover:bg-bg-elevated transition-colors cursor-pointer group"
                >
                  <div className="mt-0.5 shrink-0"><TypeIcon type={n.type} /></div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-slate-200 leading-snug">{n.title}</p>
                    {n.sub && (
                      <p className="text-xs text-slate-600 mt-0.5 uppercase tracking-wide font-mono">{n.sub}</p>
                    )}
                  </div>
                  <button
                    onClick={e => dismiss(n.id, e)}
                    className="opacity-0 group-hover:opacity-100 transition-opacity text-slate-600 hover:text-slate-300 shrink-0 mt-0.5"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))
            )}
          </div>

          <div className="px-4 py-2 border-t border-bg-border text-xs text-slate-700 font-mono">
            Refreshes every 60s
          </div>
        </div>
      )}
    </div>
  )
}
