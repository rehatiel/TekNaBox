import { NavLink, useNavigate } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import {
  LayoutDashboard, Monitor, CheckSquare, Users,
  Building2, MapPin, PackageOpen, ScrollText,
  LogOut, Radio, ChevronRight, Activity, UserCog, ShieldAlert, ShieldCheck, Wifi, FileText, BookOpen, Network, BookMarked, Wrench, History
} from 'lucide-react'

// Shown to all authenticated users
const NAV = [
  { to: '/',           icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/devices',    icon: Monitor,         label: 'Devices' },
  { to: '/tasks',      icon: CheckSquare,     label: 'Tasks' },
  { to: '/monitoring', icon: Activity,        label: 'Monitoring' },
  { to: '/findings',   icon: ShieldAlert,     label: 'Findings' },
  { to: '/security',   icon: ShieldCheck,     label: 'Security Hub' },
  { to: '/network',         icon: Network,  label: 'Network Discovery' },
  { to: '/network-history', icon: History,  label: 'Device History' },
  { to: '/network-tools',   icon: Wrench,   label: 'Network Tools' },
  { to: '/wireless',   icon: Radio,           label: 'Wireless Survey' },
  { to: '/snmp',       icon: Wifi,            label: 'SNMP' },
  { to: '/ad-report',  icon: BookMarked,      label: 'AD Report' },
  { to: '/reports',    icon: FileText,        label: 'Reports' },
  { to: '/changelog',  icon: BookOpen,        label: 'Changelog' },
  { to: '/customers',  icon: Building2,       label: 'Customers' },
  { to: '/sites',      icon: MapPin,          label: 'Sites' },
  { to: '/releases',   icon: PackageOpen,     label: 'Releases' },
  { to: '/audit',      icon: ScrollText,      label: 'Audit Log' },
]

// Shown to MSP admins and super admins
const ADMIN_NAV = [
  { to: '/users',     icon: UserCog,         label: 'Users' },
]

// Shown to super admins only
const SUPER_NAV = [
  { to: '/msps',      icon: Users,           label: 'MSPs' },
]

export default function Sidebar() {
  const { operator, logout, isSuper } = useAuth()
  const isAdmin = isSuper || operator?.role === 'msp_admin'
  const navigate = useNavigate()

  const handleLogout = () => {
    logout()
    navigate('/login')
  }

  return (
    <aside className="w-56 shrink-0 bg-bg-surface border-r border-bg-border flex flex-col h-screen sticky top-0">
      {/* Logo */}
      <div className="px-5 py-5 border-b border-bg-border">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded bg-cyan-DEFAULT flex items-center justify-center">
            <Radio className="w-4 h-4 text-bg-base" />
          </div>
          <span className="font-display font-700 text-slate-100 tracking-tight">MSP Command</span>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-3 py-4 space-y-0.5 overflow-y-auto">
        {NAV.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            className={({ isActive }) =>
              `flex items-center gap-2.5 px-3 py-2 rounded text-sm transition-all duration-150 group
               ${isActive
                 ? 'bg-cyan-dim text-cyan-bright font-display font-500'
                 : 'text-slate-500 hover:text-slate-300 hover:bg-bg-elevated'
               }`
            }
          >
            {({ isActive }) => (
              <>
                <Icon className={`w-4 h-4 shrink-0 ${isActive ? 'text-cyan-DEFAULT' : 'text-slate-600 group-hover:text-slate-400'}`} />
                <span>{label}</span>
                {isActive && <ChevronRight className="w-3 h-3 ml-auto text-cyan-muted" />}
              </>
            )}
          </NavLink>
        ))}

        {isAdmin && (
          <>
            <div className="pt-3 pb-1 px-3">
              <span className="text-xs font-display font-500 text-slate-700 uppercase tracking-widest">Admin</span>
            </div>
            {ADMIN_NAV.map(({ to, icon: Icon, label }) => (
              <NavLink
                key={to}
                to={to}
                className={({ isActive }) =>
                  `flex items-center gap-2.5 px-3 py-2 rounded text-sm transition-all duration-150 group
                   ${isActive
                     ? 'bg-cyan-dim text-cyan-bright font-display font-500'
                     : 'text-slate-500 hover:text-slate-300 hover:bg-bg-elevated'
                   }`
                }
              >
                {({ isActive }) => (
                  <>
                    <Icon className={`w-4 h-4 shrink-0 ${isActive ? 'text-cyan-DEFAULT' : 'text-slate-600 group-hover:text-slate-400'}`} />
                    <span>{label}</span>
                  </>
                )}
              </NavLink>
            ))}
          </>
        )}

        {isSuper && (
          <>
            <div className="pt-3 pb-1 px-3">
              <span className="text-xs font-display font-500 text-slate-700 uppercase tracking-widest">Platform</span>
            </div>
            {SUPER_NAV.map(({ to, icon: Icon, label }) => (
              <NavLink
                key={to}
                to={to}
                className={({ isActive }) =>
                  `flex items-center gap-2.5 px-3 py-2 rounded text-sm transition-all duration-150 group
                   ${isActive
                     ? 'bg-cyan-dim text-cyan-bright font-display font-500'
                     : 'text-slate-500 hover:text-slate-300 hover:bg-bg-elevated'
                   }`
                }
              >
                {({ isActive }) => (
                  <>
                    <Icon className={`w-4 h-4 shrink-0 ${isActive ? 'text-cyan-DEFAULT' : 'text-slate-600 group-hover:text-slate-400'}`} />
                    <span>{label}</span>
                  </>
                )}
              </NavLink>
            ))}
          </>
        )}
      </nav>

      {/* User */}
      <div className="border-t border-bg-border p-3">
        <div className="flex items-center gap-2.5 px-2 py-1.5 rounded mb-1">
          <div className="w-7 h-7 rounded bg-bg-border flex items-center justify-center shrink-0">
            <span className="text-xs font-display font-600 text-slate-400">
              {operator?.email?.[0]?.toUpperCase() || '?'}
            </span>
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs text-slate-300 truncate">{operator?.email}</p>
            <p className="text-xs text-slate-600 font-mono">{operator?.role}</p>
          </div>
        </div>
        <button
          onClick={handleLogout}
          className="w-full flex items-center gap-2 px-3 py-1.5 rounded text-sm text-slate-600 hover:text-red-DEFAULT hover:bg-red-dim transition-colors duration-150"
        >
          <LogOut className="w-4 h-4" />
          <span>Sign out</span>
        </button>
      </div>
    </aside>
  )
}
