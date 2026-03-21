import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../lib/api'
import { Search, X, Monitor } from 'lucide-react'

export default function CommandSearch({ isOpen, onClose }) {
  const [query, setQuery]       = useState('')
  const [devices, setDevices]   = useState([])
  const [selected, setSelected] = useState(0)
  const inputRef = useRef(null)
  const navigate = useNavigate()

  useEffect(() => {
    if (!isOpen) { setQuery(''); return }
    setTimeout(() => inputRef.current?.focus(), 10)
    api.getDevices().then(setDevices).catch(() => {})
  }, [isOpen])

  const filtered = query.trim()
    ? devices.filter(d => {
        const q = query.toLowerCase()
        return (
          d.name?.toLowerCase().includes(q) ||
          d.last_ip?.toLowerCase().includes(q) ||
          d.hostname?.toLowerCase().includes(q) ||
          (d.tags || []).some(t => t.toLowerCase().includes(q))
        )
      })
    : devices.slice(0, 8)

  useEffect(() => { setSelected(0) }, [query])

  const go = useCallback((device) => {
    navigate(`/devices/${device.id}`)
    onClose()
  }, [navigate, onClose])

  useEffect(() => {
    if (!isOpen) return
    const handler = (e) => {
      if (e.key === 'Escape')    { onClose(); return }
      if (e.key === 'ArrowDown') { setSelected(s => Math.min(s + 1, filtered.length - 1)); e.preventDefault() }
      if (e.key === 'ArrowUp')   { setSelected(s => Math.max(s - 1, 0)); e.preventDefault() }
      if (e.key === 'Enter' && filtered[selected]) go(filtered[selected])
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [isOpen, filtered, selected, go, onClose])

  if (!isOpen) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center"
      style={{ background: 'rgba(0,0,0,0.55)', paddingTop: '14vh' }}
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div
        className="w-full max-w-lg rounded-xl border border-bg-border shadow-2xl overflow-hidden animate-fade-in"
        style={{ background: 'var(--bg-elevated)' }}
      >
        {/* Input row */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-bg-border">
          <Search className="w-4 h-4 text-slate-500 shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search devices by name, IP, or tag…"
            className="flex-1 bg-transparent text-slate-200 text-sm outline-none placeholder:text-slate-600"
          />
          <button onClick={onClose} className="text-slate-600 hover:text-slate-400 transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Results */}
        <div className="max-h-72 overflow-y-auto">
          {filtered.length === 0 ? (
            <div className="px-4 py-10 text-center text-slate-600 text-sm">
              {query ? `No devices match "${query}"` : 'No devices available'}
            </div>
          ) : (
            filtered.map((d, i) => (
              <button
                key={d.id}
                onClick={() => go(d)}
                className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors ${
                  i === selected ? 'bg-cyan-dim' : 'hover:bg-bg-surface'
                }`}
              >
                <Monitor className={`w-4 h-4 shrink-0 ${
                  d.status === 'active' ? 'text-green-DEFAULT' : 'text-slate-600'
                }`} />
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-slate-200 truncate">{d.name}</div>
                  {d.last_ip && (
                    <div className="text-xs text-slate-600 font-mono">{d.last_ip}</div>
                  )}
                </div>
                {d.customer_name && (
                  <span className="text-xs text-slate-600 truncate max-w-[120px]">{d.customer_name}</span>
                )}
                <span className={`text-xs font-mono px-1.5 py-0.5 rounded shrink-0 ${
                  d.status === 'active'
                    ? 'bg-green-dim text-green-DEFAULT'
                    : d.status === 'offline'
                    ? 'bg-bg-border text-slate-500'
                    : 'bg-amber-dim text-amber-DEFAULT'
                }`}>{d.status}</span>
              </button>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-2 border-t border-bg-border flex gap-4 text-xs text-slate-700 font-mono">
          <span>↑↓ navigate</span>
          <span>↵ open</span>
          <span>esc close</span>
          <span className="ml-auto">ctrl+k to open anytime</span>
        </div>
      </div>
    </div>
  )
}
