import { useState, useEffect, useCallback } from 'react'
import { api } from '../lib/api'
import { PageHeader, Spinner, Alert } from '../components/ui'
import { Bell, Mail, Send, Save, Webhook } from 'lucide-react'

function Toggle({ label, description, checked, onChange, disabled }) {
  return (
    <label className={`flex items-start gap-3 py-3 cursor-pointer ${disabled ? 'opacity-50' : ''}`}>
      <div className="relative mt-0.5 shrink-0">
        <input
          type="checkbox"
          checked={checked}
          onChange={e => onChange(e.target.checked)}
          disabled={disabled}
          className="sr-only peer"
        />
        <div className="w-9 h-5 rounded-full bg-bg-border peer-checked:bg-cyan-DEFAULT transition-colors" />
        <div className="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform peer-checked:translate-x-4 shadow" />
      </div>
      <div>
        <p className="text-sm text-slate-200">{label}</p>
        {description && <p className="text-xs text-slate-600 mt-0.5">{description}</p>}
      </div>
    </label>
  )
}

export default function AlertsPage() {
  const [config, setConfig]         = useState(null)
  const [loading, setLoading]       = useState(true)
  const [saving, setSaving]         = useState(false)
  const [testing, setTesting]       = useState(false)
  const [testingWh, setTestingWh]   = useState(false)
  const [error, setError]           = useState('')
  const [success, setSuccess]       = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const cfg = await api.getAlertConfig()
      setConfig(cfg)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const handleSave = async () => {
    setSaving(true)
    setError('')
    setSuccess('')
    try {
      const updated = await api.updateAlertConfig({
        alert_email:              config.alert_email || null,
        webhook_url:              config.webhook_url || null,
        notify_offline:           config.notify_offline,
        notify_critical_findings: config.notify_critical_findings,
        notify_high_findings:     config.notify_high_findings,
        notify_failed_tasks:      config.notify_failed_tasks,
      })
      setConfig(updated)
      setSuccess('Alert settings saved.')
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  const handleTest = async () => {
    setTesting(true)
    setError('')
    setSuccess('')
    try {
      await api.testAlert()
      setSuccess(`Test email sent to ${config.alert_email}.`)
    } catch (e) {
      setError(e.message)
    } finally {
      setTesting(false)
    }
  }

  const handleTestWebhook = async () => {
    setTestingWh(true)
    setError('')
    setSuccess('')
    try {
      await api.testWebhook()
      setSuccess('Test payload sent to webhook URL.')
    } catch (e) {
      setError(e.message)
    } finally {
      setTestingWh(false)
    }
  }

  const set = (key, value) => setConfig(c => ({ ...c, [key]: value }))

  if (loading) return <div className="h-64 flex items-center justify-center"><Spinner /></div>

  return (
    <div className="animate-fade-in max-w-xl">
      <PageHeader title="Alert Settings" subtitle="Email notifications for critical platform events" />

      {error   && <Alert type="error"   message={error}   className="mb-4" />}
      {success && <Alert type="success" message={success} className="mb-4" />}

      {/* SMTP status banner */}
      {!config?.smtp_configured && (
        <div className="card px-4 py-3 mb-4 flex items-start gap-3 border-amber-muted bg-amber-dim">
          <Bell className="w-4 h-4 text-amber-DEFAULT shrink-0 mt-0.5" />
          <div>
            <p className="text-sm text-amber-DEFAULT font-500">SMTP not configured</p>
            <p className="text-xs text-slate-500 mt-0.5">
              Add <code className="font-mono bg-bg-elevated px-1 rounded">SMTP_HOST</code> and related variables to your server <code className="font-mono bg-bg-elevated px-1 rounded">.env</code> file to enable email delivery. Alert preferences below are saved regardless.
            </p>
          </div>
        </div>
      )}

      {/* Email address */}
      <div className="card px-4 py-4 mb-4 space-y-3">
        <div className="flex items-center gap-2 mb-1">
          <Mail className="w-4 h-4 text-slate-600" />
          <h2 className="text-sm font-display font-600 text-slate-300">Alert Email</h2>
        </div>
        <p className="text-xs text-slate-600">Alerts are sent to this address. Leave blank to disable delivery.</p>
        <div className="flex gap-2">
          <input
            className="input flex-1"
            type="email"
            placeholder="alerts@yourcompany.com"
            value={config?.alert_email || ''}
            onChange={e => set('alert_email', e.target.value)}
          />
          <button
            onClick={handleTest}
            disabled={testing || !config?.alert_email || !config?.smtp_configured}
            title={!config?.smtp_configured ? 'SMTP not configured' : !config?.alert_email ? 'Enter an email address first' : 'Send test email'}
            className="btn-ghost flex items-center gap-1.5 text-xs disabled:opacity-40"
          >
            <Send className="w-3.5 h-3.5" />
            {testing ? 'Sending…' : 'Test'}
          </button>
        </div>
      </div>

      {/* Webhook URL */}
      <div className="card px-4 py-4 mb-4 space-y-3">
        <div className="flex items-center gap-2 mb-1">
          <Webhook className="w-4 h-4 text-slate-600" />
          <h2 className="text-sm font-display font-600 text-slate-300">Webhook URL</h2>
        </div>
        <p className="text-xs text-slate-600">
          POST JSON alerts to this URL. Compatible with Slack incoming webhooks, n8n, Zapier, Make, or any custom endpoint.
        </p>
        <div className="flex gap-2">
          <input
            className="input flex-1 font-mono text-xs"
            type="url"
            placeholder="https://hooks.slack.com/services/…"
            value={config?.webhook_url || ''}
            onChange={e => set('webhook_url', e.target.value)}
          />
          <button
            onClick={handleTestWebhook}
            disabled={testingWh || !config?.webhook_url}
            title={!config?.webhook_url ? 'Enter a webhook URL first' : 'Send test payload'}
            className="btn-ghost flex items-center gap-1.5 text-xs disabled:opacity-40"
          >
            <Send className="w-3.5 h-3.5" />
            {testingWh ? 'Sending…' : 'Test'}
          </button>
        </div>
      </div>

      {/* Alert toggles */}
      <div className="card px-4 py-2 mb-4 divide-y divide-bg-border">
        <div className="pb-2">
          <h2 className="text-sm font-display font-600 text-slate-300 pt-2">Alert Types</h2>
        </div>
        <Toggle
          label="Device Offline"
          description="Alert when an agent loses its connection to the platform (heartbeat timeout)."
          checked={config?.notify_offline ?? true}
          onChange={v => set('notify_offline', v)}
        />
        <Toggle
          label="Critical Findings"
          description="Alert when a critical severity security finding is detected on any device."
          checked={config?.notify_critical_findings ?? true}
          onChange={v => set('notify_critical_findings', v)}
        />
        <Toggle
          label="High Findings"
          description="Alert when a high severity security finding is detected."
          checked={config?.notify_high_findings ?? false}
          onChange={v => set('notify_high_findings', v)}
        />
        <Toggle
          label="Task Failures"
          description="Alert when tasks fail or time out repeatedly. (Coming soon)"
          checked={config?.notify_failed_tasks ?? false}
          onChange={v => set('notify_failed_tasks', v)}
          disabled
        />
      </div>

      <button
        onClick={handleSave}
        disabled={saving}
        className="btn-primary flex items-center gap-1.5"
      >
        <Save className="w-3.5 h-3.5" />
        {saving ? 'Saving…' : 'Save Changes'}
      </button>
    </div>
  )
}
