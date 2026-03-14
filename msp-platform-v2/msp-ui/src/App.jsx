import { BrowserRouter, Routes, Route, Navigate, Outlet } from 'react-router-dom'
import { AuthProvider, useAuth } from './hooks/useAuth'
import Sidebar from './components/Sidebar'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import Devices from './pages/Devices'
import DeviceDetail from './pages/DeviceDetail'
import TasksPage from './pages/Tasks'
import { Customers, Sites, Releases, AuditLog, MSPs } from './pages/OtherPages'
import Monitoring from './pages/Monitoring'
import ADReportPage from './pages/ADReport'
import UsersPage from './pages/Users'
import Findings from './pages/Findings'
import SNMPPage from './pages/SNMP'
import ReportsPage from './pages/Reports'
import ChangelogPage from './pages/Changelog'
import WirelessSurveyPage from './pages/WirelessSurvey'
import SecurityHubPage from './pages/SecurityHub'
import NetworkDiscoveryPage from './pages/NetworkDiscovery'

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
    <AuthProvider>
      <BrowserRouter>
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
            <Route path="/customers"  element={<Customers />} />
            <Route path="/sites"      element={<Sites />} />
            <Route path="/releases"   element={<Releases />} />
            <Route path="/audit"      element={<AuditLog />} />
            <Route path="/msps"       element={<MSPs />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  )
}
