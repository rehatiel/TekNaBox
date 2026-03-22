import { useState } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import {
  LayoutDashboard, Monitor, CheckSquare, Users,
  Building2, MapPin, PackageOpen, ScrollText,
  LogOut, Radio, ChevronRight, ChevronLeft, UserCog,
  ShieldAlert, ShieldCheck, Wifi, FileText, BookOpen, Network,
  BookMarked, Wrench, History, Globe, Search, Bell, Activity,
} from 'lucide-react'

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
  { to: '/http-monitor',    icon: Globe,    label: 'HTTP Monitor' },
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

const ADMIN_NAV = [
  { to: '/users',  icon: UserCog, label: 'Users' },
  { to: '/alerts', icon: Bell,    label: 'Alerts' },
]

const SUPER_NAV = [
  { to: '/msps', icon: Users, label: 'MSPs' },
]

export default function Sidebar({ onSearchOpen }) {
  const { operator, logout, isSuper } = useAuth()
  const isAdmin = isSuper || operator?.role === 'msp_admin'
  const navigate = useNavigate()

  const [collapsed, setCollapsed] = useState(() =>
    localStorage.getItem('sidebar-collapsed') === 'true'
  )

  const toggleCollapse = () => {
    setCollapsed(c => {
      const next = !c
      localStorage.setItem('sidebar-collapsed', String(next))
      return next
    })
  }

  const handleLogout = async () => {
    await logout()
    navigate('/login')
  }

  const navLinkClass = ({ isActive }) =>
    `flex items-center gap-2.5 px-2 py-2 rounded text-sm transition-all duration-150 group
     ${collapsed ? 'justify-center' : ''}
     ${isActive
       ? 'bg-cyan-dim text-cyan-bright font-display font-500'
       : 'text-slate-500 hover:text-slate-300 hover:bg-bg-elevated'
     }`

  return (
    <aside
      className={`${collapsed ? 'w-14' : 'w-56'} shrink-0 bg-bg-surface border-r border-bg-border flex flex-col h-screen sticky top-0 transition-all duration-200 relative`}
    >
      {/* Collapse toggle — sits on the right edge */}
      <button
        onClick={toggleCollapse}
        title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        className="absolute -right-3 top-[22px] z-10 w-6 h-6 rounded-full bg-bg-elevated border border-bg-border flex items-center justify-center text-slate-500 hover:text-slate-300 hover:border-slate-500 transition-all duration-150"
      >
        {collapsed
          ? <ChevronRight className="w-3 h-3" />
          : <ChevronLeft  className="w-3 h-3" />
        }
      </button>

      {/* Logo + search */}
      <div className="px-3 py-4 border-b border-bg-border flex items-center gap-2 min-h-[57px]">
        <div className="w-7 h-7 rounded bg-cyan-DEFAULT flex items-center justify-center shrink-0">
          <Radio className="w-4 h-4 text-bg-base" />
        </div>
        {!collapsed && (
          <>
            <span className="font-display font-700 text-slate-100 tracking-tight flex-1">TekNaBox</span>
            <button
              onClick={onSearchOpen}
              title="Search devices (Ctrl+K)"
              className="w-6 h-6 flex items-center justify-center text-slate-600 hover:text-slate-300 transition-colors rounded hover:bg-bg-elevated"
            >
              <Search className="w-3.5 h-3.5" />
            </button>
          </>
        )}
      </div>

      {/* Search button (collapsed mode — shown as a nav-style row) */}
      {collapsed && (
        <button
          onClick={onSearchOpen}
          title="Search devices (Ctrl+K)"
          className="mx-2 mt-2 py-2 rounded flex items-center justify-center text-slate-500 hover:text-slate-300 hover:bg-bg-elevated transition-colors"
        >
          <Search className="w-4 h-4" />
        </button>
      )}

      {/* Nav */}
      <nav className="flex-1 px-2 py-3 space-y-0.5 overflow-y-auto">
        {NAV.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            title={collapsed ? label : undefined}
            className={navLinkClass}
          >
            {({ isActive }) => (
              <>
                <Icon className={`w-4 h-4 shrink-0 ${isActive ? 'text-cyan-DEFAULT' : 'text-slate-600 group-hover:text-slate-400'}`} />
                {!collapsed && <span>{label}</span>}
                {!collapsed && isActive && <ChevronRight className="w-3 h-3 ml-auto text-cyan-muted" />}
              </>
            )}
          </NavLink>
        ))}

        {isAdmin && (
          <>
            {!collapsed && (
              <div className="pt-3 pb-1 px-2">
                <span className="text-xs font-display font-500 text-slate-700 uppercase tracking-widest">Admin</span>
              </div>
            )}
            {collapsed && <div className="border-t border-bg-border my-2 mx-1" />}
            {ADMIN_NAV.map(({ to, icon: Icon, label }) => (
              <NavLink key={to} to={to} title={collapsed ? label : undefined} className={navLinkClass}>
                {({ isActive }) => (
                  <>
                    <Icon className={`w-4 h-4 shrink-0 ${isActive ? 'text-cyan-DEFAULT' : 'text-slate-600 group-hover:text-slate-400'}`} />
                    {!collapsed && <span>{label}</span>}
                  </>
                )}
              </NavLink>
            ))}
          </>
        )}

        {isSuper && (
          <>
            {!collapsed && (
              <div className="pt-3 pb-1 px-2">
                <span className="text-xs font-display font-500 text-slate-700 uppercase tracking-widest">Platform</span>
              </div>
            )}
            {collapsed && <div className="border-t border-bg-border my-2 mx-1" />}
            {SUPER_NAV.map(({ to, icon: Icon, label }) => (
              <NavLink key={to} to={to} title={collapsed ? label : undefined} className={navLinkClass}>
                {({ isActive }) => (
                  <>
                    <Icon className={`w-4 h-4 shrink-0 ${isActive ? 'text-cyan-DEFAULT' : 'text-slate-600 group-hover:text-slate-400'}`} />
                    {!collapsed && <span>{label}</span>}
                  </>
                )}
              </NavLink>
            ))}
          </>
        )}
      </nav>

      {/* User / logout */}
      <div className="border-t border-bg-border p-2">
        {!collapsed && (
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
        )}
        <button
          onClick={handleLogout}
          title={collapsed ? 'Sign out' : undefined}
          className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm text-slate-600 hover:text-red-DEFAULT hover:bg-red-dim transition-colors duration-150
            ${collapsed ? 'justify-center' : ''}`}
        >
          <LogOut className="w-4 h-4 shrink-0" />
          {!collapsed && <span>Sign out</span>}
        </button>
      </div>
    </aside>
  )
}
