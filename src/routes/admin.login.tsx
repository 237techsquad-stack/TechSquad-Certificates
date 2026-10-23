import { useState, type FormEvent } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import logoIconUrl from '../../images/logo icon.png'

export const Route = createFileRoute('/admin/login')({
  component: AdminLogin,
})

function AdminLogin() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending) return
    setPending(true)
    setError('')
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ email, password }),
      })
      if (!response.ok) {
        setError(
          response.status === 401
            ? 'Email or password is incorrect.'
            : response.status === 429
              ? 'Too many sign-in attempts. Wait before trying again.'
              : 'Sign in is temporarily unavailable. Please try again later.',
        )
        return
      }
      window.location.assign('/admin')
    } catch {
      setError('The sign-in service could not be reached. Please try again.')
    } finally {
      setPending(false)
    }
  }

  return (
    <main className="login-page">
      <div className="login-layout">
        <section className="login-card" aria-labelledby="login-heading">
          <header className="login-brand">
            <img src={logoIconUrl} alt="TechSquad Cameroon" />
            <span>TechSquad <span className="login-brand-light">Certificates</span></span>
          </header>

          <div className="login-intro">
            <p className="login-eyebrow">ADMIN PORTAL</p>
            <h1 id="login-heading">Welcome back</h1>
            <p>Sign in to manage certificates and enrollments.</p>
          </div>

          <form className="login-form" onSubmit={submit}>
            <label className="form-field login-field">
              <span>Email address</span>
              <input
                type="email"
                name="email"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                maxLength={320}
                required
                value={email}
                onChange={(event) => setEmail(event.currentTarget.value)}
              />
            </label>
            <div className="form-field login-field">
              <label htmlFor="admin-password">Password</label>
              <span className="login-password-control">
                <input
                  id="admin-password"
                  type={showPassword ? 'text' : 'password'}
                  name="password"
                  autoComplete="current-password"
                  minLength={12}
                  maxLength={1024}
                  required
                  value={password}
                  onChange={(event) => setPassword(event.currentTarget.value)}
                />
                <button
                  className="password-visibility-toggle"
                  type="button"
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  aria-pressed={showPassword}
                  onClick={() => setShowPassword((visible) => !visible)}
                >
                  {showPassword ? (
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M3 3l18 18M10.6 10.6a2 2 0 002.8 2.8" />
                      <path d="M9.9 5.2A10.8 10.8 0 0112 5c5 0 8.5 4.2 9.5 7-.4 1.1-1.3 2.5-2.6 3.7M6.2 6.2C4.3 7.4 3 9.2 2.5 12c.7 2.1 2.8 4.5 5.5 5.9A10.6 10.6 0 0012 19c1.1 0 2.1-.2 3-.5" />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M2.5 12S6 5 12 5s9.5 7 9.5 7-3.5 7-9.5 7-9.5-7-9.5-7Z" />
                      <circle cx="12" cy="12" r="2.5" />
                    </svg>
                  )}
                </button>
              </span>
            </div>
            {error && <p className="login-error" role="alert">{error}</p>}
            <button className="login-submit" type="submit" disabled={pending}>
              {pending && <span className="login-spinner" aria-hidden="true" />}
              {pending ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        </section>
        <footer className="login-footer">
          <span>TechSquad Certificates</span>
          <span>Authorized administrators only.</span>
        </footer>
      </div>
    </main>
  )
}
