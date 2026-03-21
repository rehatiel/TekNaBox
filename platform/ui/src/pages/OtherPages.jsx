import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api'
import { PageHeader, Spinner, Empty, Modal, Alert, Table, TR, TD, CodeBlock, StatusBadge } from '../components/ui'
import { Building2, Plus, MapPin, PackageOpen, ScrollText, Users, Upload, RefreshCw } from 'lucide-react'
import { formatDistanceToNow, format } from 'date-fns'

// ── Customers ─────────────────────────────────────────────────────────────────
export function Customers() {
  const [customers, setCustomers] = useState([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setCustomers(await api.getCustomers())
    setLoading(false)
  }, [])
  useEffect(() => { load() }, [load])

  return (
    <div className="animate-fade-in">
      <PageHeader title="Customers" subtitle={`${customers.length} customers`}
        actions={<button onClick={() => setShowCreate(true)} className="btn-primary flex items-center gap-1.5"><Plus className="w-4 h-4" /> New Customer</button>}
      />
      <div className="card">
        {loading ? <div className="h-40 flex items-center justify-center"><Spinner /></div>
          : customers.length === 0
          ? <Empty icon={Building2} title="No customers yet" description="Add your first customer" action={<button className="btn-primary" onClick={() => setShowCreate(true)}>New Customer</button>} />
          : <Table headers={['Name', 'Slug', 'ID']}>
              {customers.map(c => (
                <TR key={c.id}>
                  <TD>
                    <Link to={`/customers/${c.id}`} className="font-display font-500 text-slate-200 hover:text-cyan-DEFAULT transition-colors">
                      {c.name}
                    </Link>
                  </TD>
                  <TD><span className="tag bg-bg-elevated border-bg-border text-slate-500">{c.slug}</span></TD>
                  <TD><span className="text-xs font-mono text-slate-600">{c.id.slice(0, 8)}</span></TD>
                </TR>
              ))}
            </Table>
        }
      </div>
      {showCreate && <CreateCustomerModal onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); load() }} />}
    </div>
  )
}

function CreateCustomerModal({ onClose, onCreated }) {
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const submit = async (e) => {
    e.preventDefault()
    setLoading(true)
    try { await api.createCustomer({ name, slug }); onCreated() }
    catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }
  return (
    <Modal title="New Customer" onClose={onClose}>
      {error && <Alert type="error" message={error} className="mb-3" />}
      <form onSubmit={submit} className="space-y-4">
        <div><label className="label">Name</label><input className="input" value={name} onChange={e => { setName(e.target.value); setSlug(e.target.value.toLowerCase().replace(/\s+/g,'-')) }} placeholder="Acme Corp" required /></div>
        <div><label className="label">Slug</label><input className="input" value={slug} onChange={e => setSlug(e.target.value)} placeholder="acme-corp" required /></div>
        <div className="flex gap-2"><button type="button" onClick={onClose} className="btn-ghost flex-1">Cancel</button><button type="submit" className="btn-primary flex-1" disabled={loading}>{loading ? 'Creating…' : 'Create'}</button></div>
      </form>
    </Modal>
  )
}


// ── Sites ─────────────────────────────────────────────────────────────────────
export function Sites() {
  const [sites, setSites] = useState([])
  const [customers, setCustomers] = useState([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    const [s, c] = await Promise.all([api.getSites(), api.getCustomers()])
    setSites(s); setCustomers(c); setLoading(false)
  }, [])
  useEffect(() => { load() }, [load])

  const customerName = id => customers.find(c => c.id === id)?.name || id?.slice(0, 8)

  return (
    <div className="animate-fade-in">
      <PageHeader title="Sites" subtitle={`${sites.length} sites`}
        actions={<button onClick={() => setShowCreate(true)} className="btn-primary flex items-center gap-1.5"><Plus className="w-4 h-4" /> New Site</button>}
      />
      <div className="card">
        {loading ? <div className="h-40 flex items-center justify-center"><Spinner /></div>
          : sites.length === 0
          ? <Empty icon={MapPin} title="No sites yet" description="Sites represent physical or logical locations for your customers" action={<button className="btn-primary" onClick={() => setShowCreate(true)}>New Site</button>} />
          : <Table headers={['Name', 'Customer', 'ID']}>
              {sites.map(s => (
                <TR key={s.id}>
                  <TD><span className="font-display font-500 text-slate-200">{s.name}</span></TD>
                  <TD><span className="text-sm text-slate-400">{customerName(s.customer_id)}</span></TD>
                  <TD><span className="text-xs font-mono text-slate-600">{s.id.slice(0, 8)}</span></TD>
                </TR>
              ))}
            </Table>
        }
      </div>
      {showCreate && <CreateSiteModal customers={customers} onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); load() }} />}
    </div>
  )
}

function CreateSiteModal({ customers, onClose, onCreated }) {
  const [name, setName] = useState('')
  const [customerId, setCustomerId] = useState(customers[0]?.id || '')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const submit = async (e) => {
    e.preventDefault()
    setLoading(true)
    try { await api.createSite({ name, customer_id: customerId }); onCreated() }
    catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }
  return (
    <Modal title="New Site" onClose={onClose}>
      {error && <Alert type="error" message={error} className="mb-3" />}
      <form onSubmit={submit} className="space-y-4">
        <div><label className="label">Site Name</label><input className="input" value={name} onChange={e => setName(e.target.value)} placeholder="Head Office" required /></div>
        <div>
          <label className="label">Customer</label>
          <select className="input" value={customerId} onChange={e => setCustomerId(e.target.value)} required>
            {customers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div className="flex gap-2"><button type="button" onClick={onClose} className="btn-ghost flex-1">Cancel</button><button type="submit" className="btn-primary flex-1" disabled={loading}>{loading ? 'Creating…' : 'Create'}</button></div>
      </form>
    </Modal>
  )
}


// ── Releases ──────────────────────────────────────────────────────────────────
export function Releases() {
  const [releases, setReleases] = useState([])
  const [loading, setLoading] = useState(true)
  const [showUpload, setShowUpload] = useState(false)
  const [showRollout, setShowRollout] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    setReleases(await api.getReleases())
    setLoading(false)
  }, [])
  useEffect(() => { load() }, [load])

  const handleRevoke = async (id) => {
    if (!confirm('Revoke this release? Pending updates will be cancelled.')) return
    await api.revokeRelease(id)
    load()
  }

  return (
    <div className="animate-fade-in">
      <PageHeader title="Releases" subtitle="Client software versions"
        actions={
          <>
            <button onClick={load} className="btn-ghost flex items-center gap-1.5"><RefreshCw className="w-3.5 h-3.5" /> Refresh</button>
            <button onClick={() => setShowUpload(true)} className="btn-primary flex items-center gap-1.5"><Upload className="w-4 h-4" /> Upload Release</button>
          </>
        }
      />
      <div className="card">
        {loading ? <div className="h-40 flex items-center justify-center"><Spinner /></div>
          : releases.length === 0
          ? <Empty icon={PackageOpen} title="No releases yet" description="Upload a client binary to enable remote updates" action={<button className="btn-primary" onClick={() => setShowUpload(true)}>Upload Release</button>} />
          : <Table headers={['Version', 'Channel', 'Arch', 'Size', 'SHA256', 'Uploaded', '']}>
              {releases.map(r => (
                <TR key={r.id}>
                  <TD><span className="font-mono font-500 text-cyan-DEFAULT">{r.version}</span></TD>
                  <TD><span className={`tag ${r.channel === 'stable' ? 'bg-green-dim border-green-muted text-green-DEFAULT' : 'bg-amber-dim border-amber-muted text-amber-DEFAULT'}`}>{r.channel}</span></TD>
                  <TD><span className="tag bg-bg-elevated border-bg-border text-slate-500">{r.arch}</span></TD>
                  <TD><span className="text-xs text-slate-600">{(r.size_bytes / 1024).toFixed(1)}KB</span></TD>
                  <TD><span className="text-xs font-mono text-slate-600">{r.sha256?.slice(0, 12)}…</span></TD>
                  <TD><span className="text-xs font-mono text-slate-600">{formatDistanceToNow(new Date(r.created_at), { addSuffix: true })}</span></TD>
                  <TD>
                    <div className="flex gap-2">
                      <button onClick={() => setShowRollout(r)} className="text-xs text-cyan-muted hover:text-cyan-DEFAULT">Rollout</button>
                      <button onClick={() => handleRevoke(r.id)} className="text-xs text-red-muted hover:text-red-DEFAULT">Revoke</button>
                    </div>
                  </TD>
                </TR>
              ))}
            </Table>
        }
      </div>
      {showUpload && <UploadReleaseModal onClose={() => setShowUpload(false)} onUploaded={() => { setShowUpload(false); load() }} />}
      {showRollout && <RolloutModal release={showRollout} onClose={() => setShowRollout(null)} onDone={() => { setShowRollout(null); }} />}
    </div>
  )
}

function UploadReleaseModal({ onClose, onUploaded }) {
  const [version, setVersion] = useState('')
  const [arch, setArch] = useState('armv6l')
  const [channel, setChannel] = useState('stable')
  const [mandatory, setMandatory] = useState(false)
  const [notes, setNotes] = useState('')
  const [file, setFile] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const submit = async (e) => {
    e.preventDefault()
    if (!file) { setError('Please select a file'); return }
    setLoading(true)
    try {
      await api.uploadRelease({ version, arch, channel, is_mandatory: mandatory, release_notes: notes }, file)
      onUploaded()
    } catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }

  return (
    <Modal title="Upload Release" onClose={onClose} width="max-w-xl">
      {error && <Alert type="error" message={error} className="mb-3" />}
      <form onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div><label className="label">Version</label><input className="input" value={version} onChange={e => setVersion(e.target.value)} placeholder="1.2.0" required /></div>
          <div><label className="label">Architecture</label>
            <select className="input" value={arch} onChange={e => setArch(e.target.value)}>
              <option value="armv6l">armv6l (Pi Zero)</option>
              <option value="armv7l">armv7l</option>
              <option value="aarch64">aarch64</option>
            </select>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div><label className="label">Channel</label>
            <select className="input" value={channel} onChange={e => setChannel(e.target.value)}>
              <option value="stable">Stable</option>
              <option value="beta">Beta</option>
              <option value="canary">Canary</option>
            </select>
          </div>
          <div className="flex items-end pb-2">
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={mandatory} onChange={e => setMandatory(e.target.checked)} className="accent-cyan-DEFAULT" />
              <span className="text-sm text-slate-400">Mandatory update</span>
            </label>
          </div>
        </div>
        <div>
          <label className="label">Artifact Binary</label>
          <input type="file" className="input py-1.5 cursor-pointer" onChange={e => setFile(e.target.files[0])} required />
        </div>
        <div><label className="label">Release Notes (optional)</label><textarea className="input h-20 resize-none" value={notes} onChange={e => setNotes(e.target.value)} placeholder="What changed in this version…" /></div>
        <div className="flex gap-2"><button type="button" onClick={onClose} className="btn-ghost flex-1">Cancel</button><button type="submit" className="btn-primary flex-1" disabled={loading}>{loading ? 'Uploading…' : 'Upload'}</button></div>
      </form>
    </Modal>
  )
}

function RolloutModal({ release, onClose, onDone }) {
  const [percent, setPercent] = useState(100)
  const [forced, setForced] = useState(false)
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')

  const submit = async (e) => {
    e.preventDefault()
    setLoading(true)
    try {
      const r = await api.triggerRollout(release.id, { rollout_percent: percent, is_forced: forced })
      setResult(r)
    } catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }

  return (
    <Modal title={`Rollout — ${release.version}`} onClose={onClose}>
      {error && <Alert type="error" message={error} className="mb-3" />}
      {result ? (
        <>
          <Alert type="success" message={`Rollout scheduled for ${result.scheduled_devices} device(s).`} />
          <button onClick={onDone} className="btn-primary w-full mt-4">Done</button>
        </>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="label">Rollout Percentage — {percent}%</label>
            <input type="range" min={1} max={100} value={percent} onChange={e => setPercent(+e.target.value)} className="w-full accent-cyan-DEFAULT" />
          </div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={forced} onChange={e => setForced(e.target.checked)} className="accent-cyan-DEFAULT" />
            <span className="text-sm text-slate-400">Force update (ignore device deferral)</span>
          </label>
          <div className="flex gap-2"><button type="button" onClick={onClose} className="btn-ghost flex-1">Cancel</button><button type="submit" className="btn-primary flex-1" disabled={loading}>{loading ? 'Scheduling…' : 'Trigger Rollout'}</button></div>
        </form>
      )}
    </Modal>
  )
}


// ── Audit Log ─────────────────────────────────────────────────────────────────
export function AuditLog() {
  const [logs, setLogs] = useState([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    setLogs(await api.getAudit({ limit: 100 }))
    setLoading(false)
  }, [])
  useEffect(() => { load() }, [load])

  return (
    <div className="animate-fade-in">
      <PageHeader title="Audit Log" subtitle="Immutable record of all platform actions"
        actions={<button onClick={load} className="btn-ghost flex items-center gap-1.5"><RefreshCw className="w-3.5 h-3.5" /> Refresh</button>}
      />
      <div className="card">
        {loading ? <div className="h-40 flex items-center justify-center"><Spinner /></div>
          : logs.length === 0
          ? <Empty icon={ScrollText} title="No audit events yet" />
          : <Table headers={['Action', 'Device', 'Operator', 'IP', 'Timestamp']}>
              {logs.map(l => (
                <TR key={l.id}>
                  <TD>
                    <span className={`tag ${actionTag(l.action)}`}>{l.action.replace(/_/g,' ')}</span>
                  </TD>
                  <TD><span className="text-xs font-mono text-slate-600">{l.device_id?.slice(0,8) || '—'}</span></TD>
                  <TD><span className="text-xs font-mono text-slate-600">{l.operator_id?.slice(0,8) || '—'}</span></TD>
                  <TD><span className="text-xs font-mono text-slate-600">{l.ip_address || '—'}</span></TD>
                  <TD><span className="text-xs font-mono text-slate-600">{format(new Date(l.created_at), 'MMM d HH:mm:ss')}</span></TD>
                </TR>
              ))}
            </Table>
        }
      </div>
    </div>
  )
}

function actionTag(action) {
  if (action.includes('revok')) return 'bg-red-dim border-red-muted text-red-DEFAULT'
  if (action.includes('enroll') || action.includes('creat')) return 'bg-green-dim border-green-muted text-green-DEFAULT'
  if (action.includes('login')) return 'bg-cyan-dim border-cyan-muted text-cyan-DEFAULT'
  if (action.includes('deploy') || action.includes('update')) return 'bg-amber-dim border-amber-muted text-amber-DEFAULT'
  return 'bg-bg-elevated border-bg-border text-slate-500'
}


// ── MSPs (super admin only) ───────────────────────────────────────────────────
export function MSPs() {
  const [msps, setMsps] = useState([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [showOperator, setShowOperator] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    setMsps(await api.getMsps())
    setLoading(false)
  }, [])
  useEffect(() => { load() }, [load])

  return (
    <div className="animate-fade-in">
      <PageHeader title="MSP Organizations" subtitle="Platform-level tenant management"
        actions={<button onClick={() => setShowCreate(true)} className="btn-primary flex items-center gap-1.5"><Plus className="w-4 h-4" /> New MSP</button>}
      />
      <div className="card">
        {loading ? <div className="h-40 flex items-center justify-center"><Spinner /></div>
          : msps.length === 0
          ? <Empty icon={Users} title="No MSPs yet" action={<button className="btn-primary" onClick={() => setShowCreate(true)}>Create MSP</button>} />
          : <Table headers={['Name', 'Slug', 'Status', 'ID', '']}>
              {msps.map(m => (
                <TR key={m.id}>
                  <TD><span className="font-display font-500 text-slate-200">{m.name}</span></TD>
                  <TD><span className="tag bg-bg-elevated border-bg-border text-slate-500">{m.slug}</span></TD>
                  <TD><span className={`tag ${m.is_active ? 'bg-green-dim border-green-muted text-green-DEFAULT' : 'bg-red-dim border-red-muted text-red-DEFAULT'}`}>{m.is_active ? 'Active' : 'Inactive'}</span></TD>
                  <TD><span className="text-xs font-mono text-slate-600">{m.id.slice(0,8)}</span></TD>
                  <TD><button onClick={() => setShowOperator(m)} className="text-xs text-cyan-muted hover:text-cyan-DEFAULT">Add Admin</button></TD>
                </TR>
              ))}
            </Table>
        }
      </div>
      {showCreate && <CreateMSPModal onClose={() => setShowCreate(false)} onCreated={(m) => { setShowCreate(false); setShowOperator(m); load() }} />}
      {showOperator && <CreateOperatorModal msp={showOperator} onClose={() => setShowOperator(null)} onCreated={() => { setShowOperator(null) }} />}
    </div>
  )
}

function CreateMSPModal({ onClose, onCreated }) {
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const submit = async (e) => {
    e.preventDefault(); setLoading(true)
    try { const m = await api.createMsp({ name, slug }); onCreated(m) }
    catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }
  return (
    <Modal title="New MSP" onClose={onClose}>
      {error && <Alert type="error" message={error} className="mb-3" />}
      <form onSubmit={submit} className="space-y-4">
        <div><label className="label">MSP Name</label><input className="input" value={name} onChange={e => { setName(e.target.value); setSlug(e.target.value.toLowerCase().replace(/\s+/g,'-')) }} placeholder="Acme IT Services" required /></div>
        <div><label className="label">Slug</label><input className="input" value={slug} onChange={e => setSlug(e.target.value)} placeholder="acme-it" required /></div>
        <div className="flex gap-2"><button type="button" onClick={onClose} className="btn-ghost flex-1">Cancel</button><button type="submit" className="btn-primary flex-1" disabled={loading}>{loading ? 'Creating…' : 'Create MSP'}</button></div>
      </form>
    </Modal>
  )
}

function CreateOperatorModal({ msp, onClose, onCreated }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState('msp_admin')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)
  const submit = async (e) => {
    e.preventDefault(); setLoading(true)
    try {
      await api.createOperator({ email, password, role, msp_id: msp.id })
      setSuccess(true)
    }
    catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }
  if (success) return (
    <Modal title="Operator Created" onClose={onCreated}>
      <Alert type="success" message={`Operator ${email} created for ${msp.name}.`} />
      <button onClick={onCreated} className="btn-primary w-full mt-4">Done</button>
    </Modal>
  )
  return (
    <Modal title={`Add Admin — ${msp.name}`} onClose={onClose}>
      {error && <Alert type="error" message={error} className="mb-3" />}
      <form onSubmit={submit} className="space-y-4">
        <div><label className="label">Email</label><input type="email" className="input" value={email} onChange={e => setEmail(e.target.value)} placeholder="admin@msp.com" required /></div>
        <div><label className="label">Password</label><input type="password" className="input" value={password} onChange={e => setPassword(e.target.value)} placeholder="Strong password" required /></div>
        <div><label className="label">Role</label>
          <select className="input" value={role} onChange={e => setRole(e.target.value)}>
            <option value="msp_admin">MSP Admin</option>
            <option value="msp_operator">MSP Operator</option>
          </select>
        </div>
        <div className="flex gap-2"><button type="button" onClick={onClose} className="btn-ghost flex-1">Cancel</button><button type="submit" className="btn-primary flex-1" disabled={loading}>{loading ? 'Creating…' : 'Create Operator'}</button></div>
      </form>
    </Modal>
  )
}


// ── Tasks overview ────────────────────────────────────────────────────────────
export function Tasks() {
  const [devices, setDevices] = useState([])
  const [allTasks, setAllTasks] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api.getDevices().then(async (devs) => {
      setDevices(devs)
      const taskArrays = await Promise.all(
        devs.slice(0, 20).map(d => api.getTasks(d.id).catch(() => []))
      )
      const flat = taskArrays.flat().sort((a,b) => new Date(b.queued_at) - new Date(a.queued_at))
      setAllTasks(flat)
      setLoading(false)
    })
  }, [])

  const deviceName = id => devices.find(d => d.id === id)?.name || id?.slice(0,8)

  return (
    <div className="animate-fade-in">
      <PageHeader title="Tasks" subtitle="Recent task executions across all devices" />
      <div className="card">
        {loading ? <div className="h-40 flex items-center justify-center"><Spinner /></div>
          : allTasks.length === 0
          ? <Empty icon={CheckSquare} title="No tasks yet" description="Issue tasks from the Devices page" />
          : <Table headers={['Device', 'Type', 'Status', 'Queued', 'Duration']}>
              {allTasks.slice(0, 50).map(t => {
                const duration = t.completed_at && t.queued_at
                  ? `${((new Date(t.completed_at) - new Date(t.queued_at)) / 1000).toFixed(1)}s`
                  : '—'
                return (
                  <TR key={t.id}>
                    <TD><span className="text-xs font-mono text-slate-400">{deviceName(t.device_id)}</span></TD>
                    <TD><span className="text-xs font-mono">{t.task_type}</span></TD>
                    <TD><StatusBadge status={t.status} /></TD>
                    <TD><span className="text-xs font-mono text-slate-600">{formatDistanceToNow(new Date(t.queued_at), { addSuffix: true })}</span></TD>
                    <TD><span className="text-xs font-mono text-slate-600">{duration}</span></TD>
                  </TR>
                )
              })}
            </Table>
        }
      </div>
    </div>
  )
}
