import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { api } from '../lib/api'
import { Alert, Spinner } from '../components/ui'
import { Radio, ArrowRight, ShieldCheck } from 'lucide-react'

export default function Login() {
  const { login, setAuth } = useAuth()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  // MFA step
  const [mfaToken, setMfaToken] = useState(null)
  const [mfaCode, setMfaCode] = useState('')

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const data = await login(email, password)
      if (data.mfa_required) {
        setMfaToken(data.mfa_token)
      } else {
        navigate('/')
      }
    } catch (err) {
      setError(err.message || 'Invalid credentials')
    } finally {
      setLoading(false)
    }
  }

  const handleMfaSubmit = async (e) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const data = await api.confirmMfa(mfaToken, mfaCode)
      setAuth(data.access_token, { id: data.operator_id, role: data.role, email })
      navigate('/')
    } catch (err) {
      setError(err.message || 'Invalid authenticator code')
      setMfaCode('')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-bg-base flex items-center justify-center p-4"
      style={{ backgroundImage: 'radial-gradient(ellipse 60% 60% at 50% 0%, rgba(6,182,212,0.06) 0%, transparent 70%)' }}
    >
      {/* Grid texture */}
      <div className="fixed inset-0 opacity-[0.02]"
        style={{ backgroundImage: 'linear-gradient(rgba(6,182,212,1) 1px, transparent 1px), linear-gradient(90deg, rgba(6,182,212,1) 1px, transparent 1px)', backgroundSize: '40px 40px' }}
      />

      <div className="relative w-full max-w-sm animate-fade-in">
        {/* Logo */}
        <div className="flex flex-col items-center mb-8">
          <div className="w-12 h-12 rounded-xl bg-cyan-DEFAULT flex items-center justify-center mb-4 shadow-lg shadow-cyan-DEFAULT/20">
            {mfaToken
              ? <ShieldCheck className="w-6 h-6 text-bg-base" />
              : <Radio className="w-6 h-6 text-bg-base" />
            }
          </div>
          <h1 className="font-display font-800 text-2xl text-slate-100 tracking-tight">TekNaBox</h1>
          <p className="text-slate-600 text-sm mt-1 font-mono">MSP Remote Management Platform</p>
        </div>

        {/* Card */}
        <div className="card p-6">
          {mfaToken ? (
            <>
              <h2 className="font-display font-600 text-slate-200 mb-1">Two-factor authentication</h2>
              <p className="text-slate-500 text-sm mb-5">Enter the 6-digit code from your authenticator app.</p>

              {error && (
                <div className="mb-4">
                  <Alert type="error" message={error} onClose={() => setError('')} />
                </div>
              )}

              <form onSubmit={handleMfaSubmit} className="space-y-4">
                <div>
                  <label className="label">Authenticator code</label>
                  <input
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]{6}"
                    maxLength={6}
                    className="input text-center text-xl tracking-widest font-mono"
                    placeholder="000000"
                    value={mfaCode}
                    onChange={e => setMfaCode(e.target.value.replace(/\D/g, ''))}
                    autoFocus
                    required
                  />
                </div>
                <button
                  type="submit"
                  disabled={loading || mfaCode.length !== 6}
                  className="btn-primary w-full flex items-center justify-center gap-2 mt-2"
                >
                  {loading ? <Spinner className="w-4 h-4" /> : (
                    <>Verify <ArrowRight className="w-4 h-4" /></>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => { setMfaToken(null); setMfaCode(''); setError('') }}
                  className="w-full text-center text-sm text-slate-600 hover:text-slate-400 transition-colors"
                >
                  ← Back to sign in
                </button>
              </form>
            </>
          ) : (
            <>
              <h2 className="font-display font-600 text-slate-200 mb-5">Sign in to continue</h2>

              {error && (
                <div className="mb-4">
                  <Alert type="error" message={error} onClose={() => setError('')} />
                </div>
              )}

              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label className="label">Email address</label>
                  <input
                    type="email"
                    className="input"
                    placeholder="you@yourmsp.com"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    autoFocus
                    required
                  />
                </div>
                <div>
                  <label className="label">Password</label>
                  <input
                    type="password"
                    className="input"
                    placeholder="••••••••"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    required
                  />
                </div>
                <button
                  type="submit"
                  disabled={loading}
                  className="btn-primary w-full flex items-center justify-center gap-2 mt-2"
                >
                  {loading ? <Spinner className="w-4 h-4" /> : (
                    <>Sign in <ArrowRight className="w-4 h-4" /></>
                  )}
                </button>
              </form>
            </>
          )}
        </div>

        <p className="text-center text-xs text-slate-700 mt-6 font-mono">
          TekNaBox · MSP Remote Management
        </p>
      </div>
    </div>
  )
}
