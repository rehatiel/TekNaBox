import { lazy, Suspense, useState, useEffect, useRef } from 'react'
import { BrowserRouter, Routes, Route, Navigate, Outlet, useNavigate } from 'react-router-dom'
import { AuthProvider, useAuth } from './hooks/useAuth'
import { ThemeProvider, useTheme } from './hooks/useTheme'
import Sidebar from './components/Sidebar'
import CommandSearch from './components/CommandSearch'
import Breadcrumbs from './components/Breadcrumbs'
import NotificationBell from './components/NotificationBell'
import { Sun, Moon, X } from 'lucide-react'

// ── Lazy-loaded pages ─────────────────────────────────────────────────────────
const Login                    = lazy(() => import('./pages/Login'))
const Dashboard                = lazy(() => import('./pages/Dashboard'))
const Devices                  = lazy(() => import('./pages/Devices'))
const DeviceDetail             = lazy(() => import('./pages/DeviceDetail'))
const TasksPage                = lazy(() => import('./pages/Tasks'))
const Monitoring               = lazy(() => import('./pages/Monitoring'))
const ADReportPage             = lazy(() => import('./pages/ADReport'))
const UsersPage                = lazy(() => import('./pages/Users'))
const Findings                 = lazy(() => import('./pages/Findings'))
const SNMPPage                 = lazy(() => import('./pages/SNMP'))
const ReportsPage              = lazy(() => import('./pages/Reports'))
const ChangelogPage            = lazy(() => import('./pages/Changelog'))
const WirelessSurveyPage       = lazy(() => import('./pages/WirelessSurvey'))
const SecurityHubPage          = lazy(() => import('./pages/SecurityHub'))
const NetworkDiscoveryPage     = lazy(() => import('./pages/NetworkDiscovery'))
const NetworkDeviceHistoryPage = lazy(() => import('./pages/NetworkDeviceHistory'))
const NetworkDeviceDetailPage  = lazy(() => import('./pages/NetworkDeviceDetail'))
const NetworkToolsPage         = lazy(() => import('./pages/NetworkTools'))
const HttpMonitorPage          = lazy(() => import('./pages/HttpMonitor'))
const CustomerDashboardPage    = lazy(() => import('./pages/CustomerDashboard'))
const AlertsPage               = lazy(() => import('./pages/Alerts'))

const lp = (name) => lazy(() => import('./pages/OtherPages').then(m => ({ default: m[name] })))
const Customers = lp('Customers')
const Sites     = lp('Sites')
const Releases  = lp('Releases')
const AuditLog  = lp('AuditLog')
const MSPs      = lp('MSPs')

function PageFallback() {
  return (
    <div className="flex items-center justify-center h-64">
      <div className="w-5 h-5 border-2 border-cyan-DEFAULT border-t-transparent rounded-full animate-spin" />
    </div>
  )
}

function ThemeToggle() {
  const { theme, toggleTheme } = useTheme()
  return (
    <button
      onClick={toggleTheme}
      title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
      className="fixed top-3 right-4 z-50 w-8 h-8 flex items-center justify-center rounded-full bg-bg-elevated border border-bg-border text-slate-500 hover:text-slate-300 hover:border-slate-500 transition-all duration-150"
    >
      {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
    </button>
  )
}

const SHORTCUTS = [
  { keys: ['G', 'H'], label: 'Dashboard' },
  { keys: ['G', 'D'], label: 'Devices' },
  { keys: ['G', 'F'], label: 'Findings' },
  { keys: ['G', 'T'], label: 'Tasks' },
  { keys: ['G', 'M'], label: 'Monitoring' },
  { keys: ['G', 'N'], label: 'Network Discovery' },
  { keys: ['G', 'S'], label: 'Security Hub' },
  { keys: ['G', 'W'], label: 'Wireless Survey' },
  { keys: ['G', 'A'], label: 'Audit Log' },
  { keys: ['Ctrl', 'K'], label: 'Device search' },
  { keys: ['?'], label: 'Show / hide this panel' },
]

function ShortcutsModal({ onClose }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        className="relative w-full max-w-sm bg-bg-surface border border-bg-border rounded-xl shadow-2xl animate-slide-up"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-bg-border">
          <span className="font-display font-600 text-slate-200 text-sm">Keyboard Shortcuts</span>
          <button onClick={onClose} className="text-slate-600 hover:text-slate-300 transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-4 space-y-1.5">
          {SHORTCUTS.map(({ keys, label }) => (
            <div key={label} className="flex items-center justify-between">
              <span className="text-xs text-slate-500">{label}</span>
              <span className="flex items-center gap-1">
                {keys.map(k => (
                  <kbd key={k} className="px-1.5 py-0.5 rounded bg-bg-elevated border border-bg-border text-xs font-mono text-slate-300">
                    {k}
                  </kbd>
                ))}
              </span>
            </div>
          ))}
        </div>
        <div className="px-4 pb-3 text-xs text-slate-700 font-mono">
          Shortcuts disabled when typing in a field
        </div>
      </div>
    </div>
  )
}

const GO_ROUTES = {
  h: '/', d: '/devices', f: '/findings', t: '/tasks',
  m: '/monitoring', n: '/network', s: '/security',
  w: '/wireless', a: '/audit', u: '/users',
}

function ProtectedLayout() {
  const { token } = useAuth()
  const navigate = useNavigate()
  const [searchOpen, setSearchOpen]       = useState(false)
  const [showShortcuts, setShowShortcuts] = useState(false)
  const [gMode, setGMode]                 = useState(false)
  const gTimer = useRef(null)

  useEffect(() => {
    const handler = (e) => {
      // Ctrl+K — device search
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault()
        setSearchOpen(o => !o)
        return
      }

      // Don't fire when typing
      const tag = e.target.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable) return
      if (e.ctrlKey || e.metaKey || e.altKey) return

      // G chord: G → letter
      if (gMode) {
        clearTimeout(gTimer.current)
        setGMode(false)
        const route = GO_ROUTES[e.key.toLowerCase()]
        if (route) navigate(route)
        return
      }

      if (e.key === 'g' || e.key === 'G') {
        setGMode(true)
        gTimer.current = setTimeout(() => setGMode(false), 1500)
        return
      }

      if (e.key === '?') {
        setShowShortcuts(s => !s)
        return
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [gMode, navigate])

  if (!token) return <Navigate to="/login" replace />

  return (
    <div className="flex min-h-screen">
      <Sidebar onSearchOpen={() => setSearchOpen(true)} />
      <ThemeToggle />
      <NotificationBell />
      <CommandSearch isOpen={searchOpen} onClose={() => setSearchOpen(false)} />
      {showShortcuts && <ShortcutsModal onClose={() => setShowShortcuts(false)} />}

      {/* G-mode indicator */}
      {gMode && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-3 py-1.5 bg-bg-elevated border border-bg-border rounded-full text-xs font-mono text-slate-400 animate-fade-in shadow-lg">
          Go to… <span className="text-cyan-DEFAULT">D</span>evices&nbsp;
          <span className="text-cyan-DEFAULT">F</span>indings&nbsp;
          <span className="text-cyan-DEFAULT">T</span>asks&nbsp;
          <span className="text-cyan-DEFAULT">M</span>onitoring&nbsp;
          <span className="text-cyan-DEFAULT">N</span>etwork
        </div>
      )}

      <main className="flex-1 p-6 overflow-auto min-w-0">
        <div className="max-w-6xl mx-auto">
          <Breadcrumbs />
          <Outlet />
        </div>
      </main>
    </div>
  )
}

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <BrowserRouter>
          <Suspense fallback={<PageFallback />}>
            <Routes>
              <Route path="/login" element={<Login />} />
              <Route element={<ProtectedLayout />}>
                <Route path="/"           element={<Dashboard />} />
                <Route path="/devices"    element={<Devices />} />
                <Route path="/devices/:id" element={<DeviceDetail />} />
                <Route path="/tasks"      element={<TasksPage />} />
                <Route path="/monitoring"              element={<Monitoring />} />
                <Route path="/devices/:id/ad-report"  element={<ADReportPage />} />
                <Route path="/ad-report"              element={<ADReportPage />} />
                <Route path="/users"                  element={<UsersPage />} />
                <Route path="/findings"               element={<Findings />} />
                <Route path="/snmp"                   element={<SNMPPage />} />
                <Route path="/reports"                element={<ReportsPage />} />
                <Route path="/changelog"              element={<ChangelogPage />} />
                <Route path="/wireless"               element={<WirelessSurveyPage />} />
                <Route path="/security"               element={<SecurityHubPage />} />
                <Route path="/network"                element={<NetworkDiscoveryPage />} />
                <Route path="/network-history"        element={<NetworkDeviceHistoryPage />} />
                <Route path="/network-device/:mac"    element={<NetworkDeviceDetailPage />} />
                <Route path="/network-tools"          element={<NetworkToolsPage />} />
                <Route path="/http-monitor"           element={<HttpMonitorPage />} />
                <Route path="/customers"     element={<Customers />} />
                <Route path="/customers/:id" element={<CustomerDashboardPage />} />
                <Route path="/alerts"        element={<AlertsPage />} />
                <Route path="/sites"      element={<Sites />} />
                <Route path="/releases"   element={<Releases />} />
                <Route path="/audit"      element={<AuditLog />} />
                <Route path="/msps"       element={<MSPs />} />
              </Route>
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Suspense>
        </BrowserRouter>
      </AuthProvider>
    </ThemeProvider>
  )
}
