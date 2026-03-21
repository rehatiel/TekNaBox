/**
 * HTTP Monitor — launch run_http_monitor tasks and view results per URL.
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { api } from '../lib/api'
import {
  Globe, Play, RefreshCw, CheckCircle2, XCircle, AlertTriangle,
  Clock, Lock, ChevronDown, ChevronRight, Loader2
} from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import { PageHeader, Spinner, Alert } from '../components/ui'

// ── Helpers ───────────────────────────────────────────────────────────────────

function rttColor(ms) {
  if (ms == null) return 'text-slate-500'
  if (ms < 200)   return 'text-green-DEFAULT'
  if (ms < 1000)  return 'text-amber-DEFAULT'
  return 'text-red-DEFAULT'
}

function StatusBadge({ up, code, error }) {
  if (error) return (
    <span className="inline-flex items-center gap-1 text-xs font-600 text-amber-DEFAULT">
      <AlertTriangle className="w-3.5 h-3.5" /> Error
    </span>
  )
  return up
    ? <span className="inline-flex items-center gap-1 text-xs font-600 text-green-DEFAULT"><CheckCircle2 className="w-3.5 h-3.5" /> {code}</span>
    : <span className="inline-flex items-center gap-1 text-xs font-600 text-red-DEFAULT"><XCircle className="w-3.5 h-3.5" /> {code ?? 'Down'}</span>
}

function SslBadge({ ssl }) {
  if (!ssl || ssl.days_remaining == null) return <span className="text-xs text-slate-600">—</span>
  const color = ssl.days_remaining < 14 ? 'text-red-DEFAULT' : ssl.days_remaining < 30 ? 'text-amber-DEFAULT' : 'text-green-DEFAULT'
  return <span className={`text-xs font-mono flex items-center gap-1 ${color}`}><Lock className="w-3 h-3" />{ssl.days_remaining}d</span>
}

// ── Run Panel ─────────────────────────────────────────────────────────────────

function RunPanel({ devices, onResult }) {
  const [deviceId, setDeviceId]       = useState('')
  const [urls, setUrls]               = useState('')
  const [contentMatch, setContentMatch] = useState('')
  const [timeout, setTimeout_]        = useState(10)
  const [running, setRunning]         = useState(false)
  const [error, setError]             = useState('')
  const pollRef                       = useRef(null)

  const activeDevices = devices.filter(d => d.status === 'active')

  useEffect(() => {
    if (!deviceId && activeDevices.length) setDeviceId(activeDevices[0].id)
  }, [activeDevices.length])

  const run = async () => {
    if (!deviceId || !urls.trim()) return
    clearInterval(pollRef.current)
    setError('')
    setRunning(true)
    try {
      const urlList = urls.split('\n').map(u => u.trim()).filter(Boolean)
      const payload = { urls: urlList, timeout: Number(timeout) }
      if (contentMatch.trim()) payload.content_match = contentMatch.trim()

      const { task_id } = await api.issueTask(deviceId, {
        task_type: 'run_http_monitor',
        payload,
        timeout_seconds: 120,
      })

      // Poll until done
      pollRef.current = setInterval(async () => {
        try {
          const t = await api.getTask(task_id)
          if (t.status === 'completed' || t.status === 'failed' || t.status === 'timeout') {
            clearInterval(pollRef.current)
            setRunning(false)
            onResult({ task: t, deviceId, deviceName: devices.find(d => d.id === deviceId)?.name })
          }
        } catch { clearInterval(pollRef.current); setRunning(false) }
      }, 2000)
    } catch (e) {
      setError(e.message)
      setRunning(false)
    }
  }

  useEffect(() => () => clearInterval(pollRef.current), [])

  return (
    <div className="card p-4">
      <h2 className="font-display font-600 text-slate-200 text-sm mb-4 flex items-center gap-2">
        <Globe className="w-4 h-4 text-cyan-DEFAULT" /> Run HTTP Monitor
      </h2>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div>
          <label className="label mb-1">Device</label>
          <select className="input text-sm" value={deviceId} onChange={e => setDeviceId(e.target.value)}>
            {activeDevices.length === 0 && <option value="">No active devices</option>}
            {activeDevices.map(d => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
        </div>
        <div className="lg:col-span-2">
          <label className="label mb-1">URLs <span className="text-slate-600 normal-case font-400">(one per line)</span></label>
          <textarea
            className="input resize-none text-sm font-mono"
            rows={3}
            placeholder={"https://example.com\nhttps://api.example.com/health"}
            value={urls}
            onChange={e => setUrls(e.target.value)}
          />
        </div>
        <div>
          <label className="label mb-1">Content match <span className="text-slate-600 normal-case font-400">(optional)</span></label>
          <input className="input text-sm" placeholder="Expected string in body" value={contentMatch} onChange={e => setContentMatch(e.target.value)} />
        </div>
        <div>
          <label className="label mb-1">Timeout (sec)</label>
          <input className="input text-sm" type="number" min={1} max={30} value={timeout} onChange={e => setTimeout_(e.target.value)} />
        </div>
        <div className="flex items-end">
          <button
            onClick={run}
            disabled={running || !deviceId || !urls.trim()}
            className="btn-primary w-full flex items-center justify-center gap-2"
          >
            {running ? <><Loader2 className="w-4 h-4 animate-spin" /> Running…</> : <><Play className="w-4 h-4" /> Run Check</>}
          </button>
        </div>
      </div>
      {error && <Alert type="error" message={error} onClose={() => setError('')} className="mt-3" />}
    </div>
  )
}

// ── Result Card ───────────────────────────────────────────────────────────────

function ResultCard({ entry, onRerun }) {
  const { task, deviceName } = entry
  const [expanded, setExpanded] = useState(true)
  const result = task.result || {}
  const { results = [], summary = {}, targets_checked } = result
  const failed = task.status !== 'completed'

  const upCount   = results.filter(r => r.up).length
  const downCount = results.filter(r => !r.up).length
  const allUp     = downCount === 0 && results.length > 0

  return (
    <div className={`card overflow-hidden border ${allUp ? 'border-green-DEFAULT/20' : downCount > 0 ? 'border-red-DEFAULT/20' : 'border-bg-border'}`}>
      {/* Header */}
      <div
        className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-bg-elevated transition-colors"
        onClick={() => setExpanded(v => !v)}
      >
        <Globe className={`w-4 h-4 shrink-0 ${allUp ? 'text-green-DEFAULT' : downCount > 0 ? 'text-red-DEFAULT' : 'text-slate-500'}`} />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-display font-600 text-slate-200">
            HTTP Monitor — {deviceName}
          </p>
          <p className="text-xs text-slate-600 font-mono">
            {task.queued_at ? formatDistanceToNow(new Date(task.queued_at), { addSuffix: true }) : '—'}
          </p>
        </div>
        <div className="flex items-center gap-3 mr-2">
          {!failed && (
            <>
              <span className="text-xs text-green-DEFAULT font-600">{upCount} up</span>
              {downCount > 0 && <span className="text-xs text-red-DEFAULT font-600">{downCount} down</span>}
              <span className="text-xs text-slate-600">{targets_checked ?? results.length} checked</span>
            </>
          )}
          {failed && <span className="text-xs text-red-DEFAULT capitalize">{task.status}</span>}
        </div>
        {expanded ? <ChevronDown className="w-4 h-4 text-slate-500 shrink-0" /> : <ChevronRight className="w-4 h-4 text-slate-500 shrink-0" />}
      </div>

      {expanded && (
        <div className="border-t border-bg-border">
          {failed ? (
            <div className="px-4 py-4 text-xs text-red-DEFAULT font-mono">{task.error || 'Task failed'}</div>
          ) : results.length === 0 ? (
            <div className="px-4 py-4 text-xs text-slate-600">No results returned.</div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-bg-border text-left">
                  {['URL', 'Status', 'Response', 'SSL', 'Content Match', 'Redirect'].map(h => (
                    <th key={h} className="px-4 py-2 text-xs font-display font-500 text-slate-500 uppercase tracking-wide">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {results.map((r, i) => (
                  <tr key={i} className={`border-b border-bg-border last:border-0 ${!r.up ? 'bg-red-DEFAULT/5' : ''}`}>
                    <td className="px-4 py-2.5">
                      <span className="text-xs font-mono text-slate-300 break-all">{r.url}</span>
                    </td>
                    <td className="px-4 py-2.5">
                      <StatusBadge up={r.up} code={r.status_code} error={r.status === 'error'} />
                      {r.error && <span className="block text-xs text-slate-600 mt-0.5 font-mono">{r.error}</span>}
                    </td>
                    <td className="px-4 py-2.5">
                      <span className={`text-xs font-mono ${rttColor(r.response_ms)}`}>
                        {r.response_ms != null ? `${r.response_ms}ms` : '—'}
                      </span>
                    </td>
                    <td className="px-4 py-2.5"><SslBadge ssl={r.ssl} /></td>
                    <td className="px-4 py-2.5">
                      {r.content_match != null
                        ? <span className={`text-xs font-600 ${r.content_match ? 'text-green-DEFAULT' : 'text-red-DEFAULT'}`}>
                            {r.content_match ? '✓ Match' : '✗ No match'}
                          </span>
                        : <span className="text-xs text-slate-600">—</span>
                      }
                    </td>
                    <td className="px-4 py-2.5">
                      {r.redirect_chain?.length
                        ? <span className="text-xs text-slate-500">{r.redirect_chain.length} hop{r.redirect_chain.length > 1 ? 's' : ''}</span>
                        : <span className="text-xs text-slate-600">—</span>
                      }
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function HttpMonitorPage() {
  const [devices, setDevices]   = useState([])
  const [results, setResults]   = useState([])
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState('')

  const load = useCallback(async () => {
    try {
      const devs = await api.getDevices()
      setDevices(devs)

      // Load recent http_monitor tasks (last 50 across all devices)
      const tasks = await api.getAllTasks({ task_type: 'run_http_monitor', limit: 50 })
      const completed = tasks
        .filter(t => t.status === 'completed' || t.status === 'failed')
        .slice(0, 20)
      setResults(completed.map(t => ({
        task: t,
        deviceName: devs.find(d => d.id === t.device_id)?.name || t.device_id.slice(0, 8),
      })))
    } catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  const addResult = (entry) => setResults(r => [entry, ...r])

  if (loading) return <div className="flex items-center justify-center h-64"><Spinner /></div>

  return (
    <div className="animate-fade-in space-y-4">
      <PageHeader
        title="HTTP Monitor"
        subtitle="Check URLs for availability, response time, SSL expiry, and content"
        actions={
          <button onClick={load} className="btn-ghost p-2" title="Refresh">
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        }
      />

      {error && <Alert type="error" message={error} onClose={() => setError('')} />}

      <RunPanel devices={devices} onResult={addResult} />

      {results.length > 0 ? (
        <div className="space-y-3">
          <h2 className="font-display font-600 text-slate-400 text-sm uppercase tracking-wider">Recent Results</h2>
          {results.map((entry, i) => (
            <ResultCard key={entry.task.id ?? i} entry={entry} />
          ))}
        </div>
      ) : (
        <div className="card py-16 text-center">
          <Globe className="w-10 h-10 text-slate-700 mx-auto mb-3" />
          <p className="text-slate-500 text-sm">No monitor results yet — run a check above.</p>
        </div>
      )}
    </div>
  )
}
