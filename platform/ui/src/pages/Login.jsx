import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { Alert, Spinner } from '../components/ui'
import { Radio, ArrowRight } from 'lucide-react'

export default function Login() {
  const { login } = useAuth()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      await login(email, password)
      navigate('/')
    } catch (err) {
      setError(err.message || 'Invalid credentials')
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
            <Radio className="w-6 h-6 text-bg-base" />
          </div>
          <h1 className="font-display font-800 text-2xl text-slate-100 tracking-tight">MSP Command</h1>
          <p className="text-slate-600 text-sm mt-1 font-mono">Remote Diagnostics Platform</p>
        </div>

        {/* Card */}
        <div className="card p-6">
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
        </div>

        <p className="text-center text-xs text-slate-700 mt-6 font-mono">
          MSP Command · Remote Diagnostics
        </p>
      </div>
    </div>
  )
}
