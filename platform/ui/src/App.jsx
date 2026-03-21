import { lazy, Suspense } from 'react'
import { BrowserRouter, Routes, Route, Navigate, Outlet } from 'react-router-dom'
import { AuthProvider, useAuth } from './hooks/useAuth'
import { ThemeProvider } from './hooks/useTheme'
import Sidebar from './components/Sidebar'

// ── Lazy-loaded pages (each becomes its own JS chunk) ─────────────────────────
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

// OtherPages exports multiple named components from one file — wrap each
const lp = (name) => lazy(() => import('./pages/OtherPages').then(m => ({ default: m[name] })))
const Customers = lp('Customers')
const Sites     = lp('Sites')
const Releases  = lp('Releases')
const AuditLog  = lp('AuditLog')
const MSPs      = lp('MSPs')

// ── Shared fallback while a page chunk loads ──────────────────────────────────
function PageFallback() {
  return (
    <div className="flex items-center justify-center h-64">
      <div className="w-5 h-5 border-2 border-cyan-DEFAULT border-t-transparent rounded-full animate-spin" />
    </div>
  )
}

function ProtectedLayout() {
  const { token } = useAuth()
  if (!token) return <Navigate to="/login" replace />
  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="flex-1 p-6 overflow-auto min-w-0">
        <div className="max-w-6xl mx-auto">
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
                <Route path="/findings"              element={<Findings />} />
                <Route path="/snmp"                  element={<SNMPPage />} />
                <Route path="/reports"               element={<ReportsPage />} />
                <Route path="/changelog"             element={<ChangelogPage />} />
                <Route path="/wireless"              element={<WirelessSurveyPage />} />
                <Route path="/security"              element={<SecurityHubPage />} />
                <Route path="/network"               element={<NetworkDiscoveryPage />} />
                <Route path="/network-history"       element={<NetworkDeviceHistoryPage />} />
                <Route path="/network-device/:mac"  element={<NetworkDeviceDetailPage />} />
                <Route path="/network-tools"         element={<NetworkToolsPage />} />
                <Route path="/http-monitor"          element={<HttpMonitorPage />} />
                <Route path="/customers"  element={<Customers />} />
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
