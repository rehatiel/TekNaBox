import { useEffect, useState } from 'react'
import { Link, useLocation, useParams } from 'react-router-dom'
import { ChevronRight } from 'lucide-react'
import { api } from '../lib/api'

const TOP_LEVEL = new Set([
  '/', '/devices', '/tasks', '/monitoring', '/findings', '/security',
  '/network', '/network-history', '/network-tools', '/http-monitor',
  '/wireless', '/snmp', '/ad-report', '/reports', '/changelog',
  '/customers', '/sites', '/releases', '/audit', '/users', '/msps', '/alerts',
])

const ROUTE_LABELS = {
  devices:         'Devices',
  tasks:           'Tasks',
  monitoring:      'Monitoring',
  findings:        'Findings',
  security:        'Security Hub',
  network:         'Network Discovery',
  'network-history': 'Device History',
  'network-tools': 'Network Tools',
  'http-monitor':  'HTTP Monitor',
  wireless:        'Wireless Survey',
  snmp:            'SNMP',
  'ad-report':     'AD Report',
  reports:         'Reports',
  changelog:       'Changelog',
  customers:       'Customers',
  sites:           'Sites',
  releases:        'Releases',
  audit:           'Audit Log',
  users:           'Users',
  msps:            'MSPs',
  alerts:          'Alert Settings',
}

// Cache to avoid refetching device names on every render
const nameCache = {}

export default function Breadcrumbs() {
  const location = useLocation()
  const [crumbs, setCrumbs] = useState([])

  useEffect(() => {
    const path = location.pathname

    // Don't show breadcrumbs on top-level pages
    if (TOP_LEVEL.has(path)) { setCrumbs([]); return }

    const segments = path.split('/').filter(Boolean)
    // e.g. ['devices', ':id'] or ['devices', ':id', 'ad-report']

    const build = async () => {
      const result = [{ label: 'Home', to: '/' }]

      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i]
        const prev = segments[i - 1]
        const to = '/' + segments.slice(0, i + 1).join('/')

        // Segment after 'devices' is a device ID
        if (prev === 'devices' && seg.length > 8) {
          if (!nameCache[seg]) {
            try {
              const device = await api.get(`/v1/devices/${seg}`)
              nameCache[seg] = device.name || seg.slice(0, 8)
            } catch {
              nameCache[seg] = seg.slice(0, 8)
            }
          }
          result.push({ label: nameCache[seg], to })
          continue
        }

        // Segment after 'customers' is a customer ID
        if (prev === 'customers' && seg.length > 8) {
          if (!nameCache['customer_' + seg]) {
            try {
              const customers = await api.getCustomers()
              const c = customers.find(c => c.id === seg)
              nameCache['customer_' + seg] = c?.name || seg.slice(0, 8)
            } catch {
              nameCache['customer_' + seg] = seg.slice(0, 8)
            }
          }
          result.push({ label: nameCache['customer_' + seg], to })
          continue
        }

        // Segment after 'network-device' is a MAC address — show IP instead
        if (prev === 'network-device') {
          const cacheKey = 'netdev_' + seg
          if (!nameCache[cacheKey]) {
            try {
              const mac = decodeURIComponent(seg)
              const detail = await api.get(`/v1/network/discovered-devices/${encodeURIComponent(mac)}/detail`)
              nameCache[cacheKey] = detail?.ip || mac
            } catch {
              nameCache[cacheKey] = decodeURIComponent(seg)
            }
          }
          result.push({ label: nameCache[cacheKey], to })
          continue
        }

        const label = ROUTE_LABELS[seg]
        if (label) result.push({ label, to })
      }

      setCrumbs(result)
    }

    build()
  }, [location.pathname])

  if (crumbs.length <= 1) return null

  return (
    <nav className="flex items-center gap-1 mb-5 text-xs">
      {crumbs.map((c, i) => (
        <span key={c.to} className="flex items-center gap-1">
          {i > 0 && <ChevronRight className="w-3 h-3 text-slate-600" />}
          {i === crumbs.length - 1 ? (
            <span className="text-slate-400">{c.label}</span>
          ) : (
            <Link to={c.to} className="text-slate-600 hover:text-slate-400 transition-colors">
              {c.label}
            </Link>
          )}
        </span>
      ))}
    </nav>
  )
}
