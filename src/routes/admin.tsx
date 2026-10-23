import { useEffect, useRef, useState } from 'react'
import {
  Link,
  Outlet,
  createFileRoute,
  useLocation,
} from '@tanstack/react-router'
import { getAdminDashboardAccess } from '../lib/admin-dashboard.functions.ts'
import type { AdminDashboardAccess } from '../lib/admin-dashboard.functions.ts'
import logoIconUrl from '../../images/logo icon.png'

export const Route = createFileRoute('/admin')({
  loader: ({ location }) =>
    location.pathname === '/admin/login'
      ? ({ status: 'login' } as const)
      : getAdminDashboardAccess(),
  pendingComponent: AdminLoading,
  component: AdminLayout,
})

type AdminLayoutAccess = AdminDashboardAccess | { status: 'login' }

const navigation = [
  { label: 'Overview', to: '/admin', icon: 'overview', group: 'WORKSPACE' },
  { label: 'Participants', to: '/admin/participants', icon: 'participants', group: 'WORKSPACE' },
  { label: 'Enrollments', to: '/admin/enrollments', icon: 'enrollments', group: 'WORKSPACE' },
  { label: 'Certificates', to: '/admin/certificates', icon: 'certificates', group: 'CERTIFICATE MANAGEMENT' },
] as const

const pageCopy: Record<string, { title: string; subtitle: string }> = {
  '/admin': { title: 'Overview', subtitle: 'A clear view of your certificate program.' },
  '/admin/participants': { title: 'Participants', subtitle: 'Manage participant records and enrollment details.' },
  '/admin/enrollments': { title: 'Enrollments', subtitle: 'Track progress and manage enrollment status.' },
  '/admin/certificates': { title: 'Certificates', subtitle: 'Issue, verify, and manage certificate records.' },
}

function AdminLoading() {
  return <main className="admin-access-state" role="status">Verifying administrator access…</main>
}

function AdminLayout() {
  const access = Route.useLoaderData() as AdminLayoutAccess
  const location = useLocation()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [logoutPending, setLogoutPending] = useState(false)
  const [logoutError, setLogoutError] = useState('')
  const [greeting, setGreeting] = useState('')
  const sidebarRef = useRef<HTMLElement>(null)
  const menuToggleRef = useRef<HTMLButtonElement>(null)
  const drawerWasOpen = useRef(false)

  useEffect(() => {
    const hour = new Date().getHours()
    setGreeting(hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening')
  }, [])

  useEffect(() => {
    if (drawerOpen) {
      sidebarRef.current
        ?.querySelector<HTMLAnchorElement>('.admin-nav-link')
        ?.focus()
      drawerWasOpen.current = true
    } else if (drawerWasOpen.current) {
      menuToggleRef.current?.focus()
      drawerWasOpen.current = false
    }
  }, [drawerOpen])

  useEffect(() => {
    if (!drawerOpen) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const manageDrawerKeys = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setDrawerOpen(false)
        return
      }
      if (event.key !== 'Tab') return
      const focusable = sidebarRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not(:disabled)',
      )
      if (!focusable?.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
    }
    window.addEventListener('keydown', manageDrawerKeys)
    return () => {
      window.removeEventListener('keydown', manageDrawerKeys)
      document.body.style.overflow = previousOverflow
    }
  }, [drawerOpen])

  if (access.status === 'login') return <Outlet />

  if (access.status !== 'authenticated') {
    const title =
      access.status === 'configuration_error'
        ? 'Administrator setup is incomplete'
        : access.status === 'unavailable'
          ? 'Admin access is unavailable'
          : 'Sign in to continue'
    const description =
      access.status === 'configuration_error'
        ? `Configure the required server settings: ${[...access.missing, ...access.invalid].join(', ')}.`
        : access.status === 'unavailable'
          ? 'We could not verify administrator access. Try again later.'
          : 'Use the provisioned administrator account to access certificate management.'
    return (
      <main className="admin-access-state">
        <section className="admin-access-card" role="status">
          <img src={logoIconUrl} alt="" />
          <p className="admin-eyebrow">ADMINISTRATION</p>
          <h1>{title}</h1>
          <p>{description}</p>
          {access.status === 'unauthenticated' && (
            <Link className="button button-primary" to="/admin/login">Sign in</Link>
          )}
        </section>
      </main>
    )
  }

  const copy = pageCopy[location.pathname] ?? pageCopy['/admin']
  const activePath = location.pathname.replace(/\/$/, '') || '/admin'

  async function logout() {
    setLogoutPending(true)
    setLogoutError('')
    try {
      const csrfToken = readCsrfCookie()
      if (!csrfToken) throw new Error()
      const response = await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'X-CSRF-Token': csrfToken },
      })
      if (!response.ok) throw new Error()
      window.location.assign('/')
    } catch {
      setLogoutError('Sign out could not be completed. Please try again.')
      setLogoutPending(false)
    }
  }

  return (
    <div className={`admin-app${sidebarCollapsed ? ' admin-app-collapsed' : ''}`}>
      {drawerOpen && (
        <button
          className="admin-drawer-backdrop"
          type="button"
          aria-label="Close navigation menu"
          tabIndex={-1}
          onClick={() => setDrawerOpen(false)}
        />
      )}
      <aside
        ref={sidebarRef}
        className={`admin-sidebar${drawerOpen ? ' admin-sidebar-open' : ''}`}
        id="admin-navigation"
        role={drawerOpen ? 'dialog' : undefined}
        aria-label={drawerOpen ? 'Administration navigation' : undefined}
        aria-modal={drawerOpen || undefined}
      >
        <div className="admin-sidebar-heading">
          <Link
            className="admin-sidebar-brand"
            to="/admin"
            aria-label="TechSquad Certificates overview"
            title={sidebarCollapsed && !drawerOpen ? 'TechSquad Certificates' : undefined}
            onClick={() => setDrawerOpen(false)}
          >
            <img src={logoIconUrl} alt="" />
            <span><strong>TechSquad</strong><small>Certificates</small></span>
          </Link>
          <button
            className="admin-sidebar-collapse"
            type="button"
            aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-pressed={sidebarCollapsed}
            title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}
          >
            <AdminIcon name={sidebarCollapsed ? 'expand' : 'collapse'} />
          </button>
        </div>
        <nav className="admin-sidebar-nav" aria-label="Administration">
          {['WORKSPACE', 'CERTIFICATE MANAGEMENT'].map((group) => (
            <div className="admin-nav-group" key={group}>
              <p>{group}</p>
              {navigation.filter((item) => item.group === group).map((item) => {
                const active = activePath === item.to
                return (
                  <Link
                    key={item.to}
                    className={`admin-nav-link${active ? ' admin-nav-link-active' : ''}`}
                    to={item.to}
                    aria-label={item.label}
                    title={sidebarCollapsed && !drawerOpen ? item.label : undefined}
                    aria-current={active ? 'page' : undefined}
                    onClick={() => setDrawerOpen(false)}
                  >
                    <AdminIcon name={item.icon} />
                    <span>{item.label}</span>
                  </Link>
                )
              })}
            </div>
          ))}
        </nav>
        <div className="admin-sidebar-bottom">
          <div className="admin-account">
            <span className="admin-avatar" aria-hidden="true">{access.email.slice(0, 1).toUpperCase()}</span>
            <span className="admin-account-copy"><strong>Administrator</strong><small title={access.email}>{access.email}</small></span>
          </div>
          <button
            className="admin-logout"
            type="button"
            onClick={logout}
            disabled={logoutPending}
            aria-label={logoutPending ? 'Signing out' : 'Sign out'}
            title={sidebarCollapsed && !drawerOpen ? 'Sign out' : undefined}
          >
            <AdminIcon name="logout" />
            <span>{logoutPending ? 'Signing out…' : 'Sign out'}</span>
          </button>
        </div>
      </aside>

      <div className="admin-main-column" inert={drawerOpen}>
        <header className="admin-topbar">
          <div className="admin-topbar-leading">
            <button
              ref={menuToggleRef}
              className="admin-menu-toggle"
              type="button"
              aria-label={drawerOpen ? 'Close navigation menu' : 'Open navigation menu'}
              aria-expanded={drawerOpen}
              aria-controls="admin-navigation"
              onClick={() => setDrawerOpen((open) => !open)}
            >
              <AdminIcon name="menu" />
            </button>
            <div>
              <p className="admin-breadcrumb">ADMINISTRATION <span>/</span> {copy.title.toUpperCase()}</p>
              <h1>{greeting ? `${greeting}, Admin` : 'Admin workspace'}</h1>
              <p className="admin-welcome-copy">{copy.subtitle}</p>
            </div>
          </div>
          <div className="admin-topbar-account">
            <span className="admin-avatar" aria-hidden="true">{access.email.slice(0, 1).toUpperCase()}</span>
            <span><strong>Administrator</strong><small title={access.email}>{access.email}</small></span>
          </div>
        </header>
        <main className={`admin-workspace${activePath !== '/admin' ? ' admin-workspace-management' : ''}`}>
          {logoutError && <p className="alert alert-error" role="alert">{logoutError}</p>}
          <Outlet />
        </main>
      </div>
    </div>
  )
}

function AdminIcon({ name }: { name: string }) {
  const common = {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true as const,
  }
  switch (name) {
    case 'overview':
      return <svg {...common}><rect x="3" y="3" width="8" height="8" rx="1.5" /><rect x="13" y="3" width="8" height="5" rx="1.5" /><rect x="13" y="10" width="8" height="11" rx="1.5" /><rect x="3" y="13" width="8" height="8" rx="1.5" /></svg>
    case 'participants':
      return <svg {...common}><circle cx="9" cy="8" r="3.5" /><path d="M2.8 20a6.2 6.2 0 0112.4 0M16 5.2a3.5 3.5 0 010 6.7M17 14a5.5 5.5 0 014.2 5.4" /></svg>
    case 'enrollments':
      return <svg {...common}><path d="M7 3.5h8l4 4V20a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 015 20V5a1.5 1.5 0 011.5-1.5Z" /><path d="M14.5 3.8V8H19M8 12h8M8 16h5" /></svg>
    case 'certificates':
      return <svg {...common}><path d="M5 3.5h14A1.5 1.5 0 0120.5 5v11a1.5 1.5 0 01-1.5 1.5h-14A1.5 1.5 0 013.5 16V5A1.5 1.5 0 015 3.5Z" /><path d="M7.5 8h9M7.5 11h9M8.5 17.5l-.5 4 4-2 4 2-.5-4" /></svg>
    case 'logout':
      return <svg {...common}><path d="M10 4H5.5A1.5 1.5 0 004 5.5v13A1.5 1.5 0 005.5 20H10M15 16l4-4-4-4M19 12H9" /></svg>
    case 'collapse':
      return <svg {...common}><path d="m14.5 5-7 7 7 7" /></svg>
    case 'expand':
      return <svg {...common}><path d="m9.5 5 7 7-7 7" /></svg>
    default:
      return <svg {...common}><path d="M4 6h16M4 12h16M4 18h16" /></svg>
  }
}

function readCsrfCookie(): string | undefined {
  const value = document.cookie.split('; ').find((cookie) => cookie.startsWith('tsc_csrf='))
  if (!value) return undefined
  try {
    return decodeURIComponent(value.slice('tsc_csrf='.length))
  } catch {
    return undefined
  }
}
