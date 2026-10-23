import { useEffect, useState, type FormEvent } from 'react'
import logoIconUrl from '../../images/logo icon.png'
import fullLogoUrl from '../../images/TechSquad Cameroon Logo.png'

type PublicSearchResult = {
  certificateId: string
  participantName: string
  courseName: string
  status: 'issued'
  issueDate: string
  downloadUrl: string
}

type PublicNamesState = 'loading' | 'ready' | 'unavailable'

export function PublicVerificationHome() {
  const [query, setQuery] = useState('')
  const [searchResults, setSearchResults] = useState<PublicSearchResult[]>([])
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [searched, setSearched] = useState(false)
  const [registeredNames, setRegisteredNames] = useState<string[]>([])
  const [publicNamesState, setPublicNamesState] =
    useState<PublicNamesState>('loading')

  useEffect(() => {
    const controller = new AbortController()
    async function loadRegisteredNames() {
      try {
        const response = await fetch('/api/public/participant-names', {
          headers: { Accept: 'application/json' },
          credentials: 'omit',
          cache: 'default',
          signal: controller.signal,
        })
        if (!response.ok) {
          if (!controller.signal.aborted) setPublicNamesState('unavailable')
          return
        }
        const payload: unknown = await response.json()
        if (!isPublicParticipantNamesPayload(payload)) {
          if (!controller.signal.aborted) setPublicNamesState('unavailable')
          return
        }
        const seen = new Set<string>()
        const names = payload.names
          .map((name) => name.trim())
          .filter((name) => {
            const key = name.toLocaleLowerCase()
            if (seen.has(key)) return false
            seen.add(key)
            return true
          })
        if (!controller.signal.aborted) {
          setRegisteredNames(names)
          setPublicNamesState('ready')
        }
      } catch {
        if (!controller.signal.aborted) {
          setRegisteredNames([])
          setPublicNamesState('unavailable')
        }
      }
    }
    void loadRegisteredNames()
    return () => controller.abort()
  }, [])

  async function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const searchTerm = query.trim()
    if (!searchTerm) {
      setSearchResults([])
      setSearched(false)
      setError('Enter a participant name, certificate ID, or verification code.')
      return
    }

    setPending(true)
    setSearchResults([])
    setError('')
    setSearched(true)

    try {
      const response = await fetch(
        `/api/certificates/search?q=${encodeURIComponent(searchTerm)}`,
        {
          method: 'GET',
          headers: { Accept: 'application/json' },
          credentials: 'omit',
          cache: 'no-store',
        },
      )

      if (response.status === 429) {
        setError('Too many attempts. Please wait a moment before trying again.')
        return
      }
      if (response.status === 503) {
        setError('Certificate search is temporarily unavailable. Please try again later.')
        return
      }
      if (!response.ok) {
        setError('We could not complete the certificate search. Please try again.')
        return
      }

      const payload: unknown = await response.json()
      if (
        typeof payload === 'object' &&
        payload !== null &&
        'results' in payload &&
        Array.isArray(payload.results)
      ) {
        const validatedResults = payload.results.filter(
          (item): item is PublicSearchResult =>
            typeof item === 'object' &&
            item !== null &&
            'certificateId' in item &&
            typeof item.certificateId === 'string' &&
            'participantName' in item &&
            typeof item.participantName === 'string' &&
            'courseName' in item &&
            typeof item.courseName === 'string' &&
            'status' in item &&
            item.status === 'issued' &&
            'issueDate' in item &&
            typeof item.issueDate === 'string' &&
            'downloadUrl' in item &&
            typeof item.downloadUrl === 'string' &&
            /^\/api\/verify\/[A-Za-z0-9_-]{43}\/file$/.test(item.downloadUrl),
        )
        setSearchResults(validatedResults)
        return
      }
      setError('The certificate search returned an unexpected response.')
    } catch {
      setError('We could not reach certificate search. Please try again.')
    } finally {
      setPending(false)
    }
  }

  const nameStreamDuration = Math.max(24, registeredNames.length * 4)

  return (
    <div className="public-site">
      <header className="public-navbar">
        <a className="public-brand" href="/" aria-label="TechSquad Certificates home">
          <img src={logoIconUrl} alt="" />
          <span className="public-brand-name">
            <strong>TechSquad</strong>
            <span>Certificates</span>
          </span>
        </a>
        <nav className="public-nav" aria-label="Main navigation">
          <a className="public-nav-link" href="#graduation-mode">
            Graduation mode
          </a>
          <a className="public-nav-link public-nav-admin" href="/admin/login">
            Admin
          </a>
        </nav>
      </header>

      <main>
        <section className="verification-hero" aria-labelledby="hero-title">
          <div className="verification-hero-inner">
            <p className="verification-eyebrow">
              TECHSQUAD CAMEROON <span aria-hidden="true">·</span> AI PROGRAM
            </p>
            <h1 id="hero-title">
              Your certificate,
              <br />
              <em>one search away.</em>
            </h1>
            <p className="verification-intro">
              Find issued certificates by participant name, certificate ID, or
              verification code.
            </p>

            <form
              className="verification-form"
              id="certificate-search"
              onSubmit={search}
              aria-label="Find a certificate"
            >
              <label className="visually-hidden" htmlFor="certificate-query">
                Participant name, certificate ID, or verification code
              </label>
              <span className="verification-search-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none">
                  <circle cx="10.8" cy="10.8" r="6.8" />
                  <path d="m16 16 4.2 4.2" />
                </svg>
              </span>
              <input
                id="certificate-query"
                className="verification-input"
                type="text"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                maxLength={200}
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
                placeholder="Search by participant name or certificate ID"
                disabled={pending}
                required
              />
              <button
                className="verification-submit"
                type="submit"
                disabled={pending || !query.trim()}
              >
                {pending ? 'Searching…' : 'Find Certificate'}
              </button>
            </form>

            <div className="verification-feedback" aria-live="polite">
              {pending && (
                <p className="verification-loading" role="status">
                  Searching certificates…
                </p>
              )}
              {!pending && error && (
                <p className="verification-error" role="alert">
                  {error}
                </p>
              )}
              {!pending && searched && !error && searchResults.length === 0 && (
                <p className="verification-error" role="status">
                  No certificates found. Try a participant name, certificate ID, or verification code.
                </p>
              )}
              {!pending && searchResults.length > 0 && (
                <>
                <p className="verification-match-count" role="status">
                  {searchResults.length} issued certificate{searchResults.length === 1 ? '' : 's'} found.
                </p>
                <ul className="public-certificate-results" aria-label="Matching certificates">
                  {searchResults.map((item) => (
                    <li key={item.certificateId}>
                      <div>
                        <strong>{item.participantName}</strong>
                        <span>{item.courseName} · Issued {formatIssueDate(item.issueDate)}</span>
                        <span>Status: Issued</span>
                        <span className="public-certificate-id">{item.certificateId}</span>
                      </div>
                      <span className="verification-file-actions">
                        <a href={`${item.downloadUrl}?inline=1`} target="_blank" rel="noreferrer">View Certificate</a>
                        <a href={item.downloadUrl}>Download Certificate</a>
                      </span>
                    </li>
                  ))}
                </ul>
                </>
              )}
            </div>
          </div>
        </section>

        <section
          className="verification-trust"
          id="graduation-mode"
          aria-labelledby="certificate-access-title"
        >
          <div className="trust-icon" aria-hidden="true">
            <svg viewBox="0 0 48 48" fill="none">
              <path d="M24 4.5 39 10v11.4c0 10.2-6.4 17.5-15 22.1-8.6-4.6-15-11.9-15-22.1V10l15-5.5Z" />
              <path d="m17.5 23.8 4.4 4.4 9.1-9.1" />
            </svg>
          </div>
          <h2 id="certificate-access-title">Get Your Certificate</h2>
          <p>
            Search above to find and download an issued certificate. Each
            certificate includes a unique verification code and QR code.
          </p>
          <div
            className="registered-names"
            aria-label="Participants who agreed to public name display"
          >
            {publicNamesState === 'loading' && (
              <p className="registered-names-message" role="status">
                Loading participant names…
              </p>
            )}
            {publicNamesState === 'ready' && registeredNames.length === 0 && (
              <p className="registered-names-message" role="status">
                No public names to display yet.
              </p>
            )}
            {publicNamesState === 'unavailable' && (
              <p className="registered-names-message" role="status">
                Participant names are temporarily unavailable.
              </p>
            )}
            {publicNamesState === 'ready' && registeredNames.length > 0 && (
              <>
                <ul className="registered-names-stream" aria-hidden="true">
                  {registeredNames.map((name, index) => (
                    <li
                      key={name.toLocaleLowerCase()}
                      style={{
                        animationDelay: `${-(index * nameStreamDuration / registeredNames.length)}s`,
                        animationDuration: `${nameStreamDuration}s`,
                        left: '50%',
                      }}
                    >
                      {name}
                    </li>
                  ))}
                </ul>
                <ul
                  className="visually-hidden"
                  aria-label="Publicly displayable participant names"
                >
                  {registeredNames.map((name) => (
                    <li key={name.toLocaleLowerCase()}>{name}</li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </section>
      </main>

      <footer className="public-footer">
        <div className="public-footer-inner">
          <img
            className="public-footer-logo"
            src={fullLogoUrl}
            alt="TechSquad Cameroon"
          />
          <div className="public-footer-about">
            <p>
              Certificate access for the TechSquad Cameroon AI program,
              connected to its AI training and learning offerings.
            </p>
            <a
              className="public-footer-link"
              href="https://techsquad-cameroon.netlify.app/"
              target="_blank"
              rel="noopener noreferrer"
            >
              Visit TechSquad Cameroon
            </a>
          </div>
        </div>
        <div className="public-footer-bottom">
          <span>TechSquad Cameroon</span>
          <span>Certificate access</span>
        </div>
      </footer>
    </div>
  )
}

function formatIssueDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? 'date unavailable'
    : new Intl.DateTimeFormat(undefined, {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      }).format(date)
}

function isPublicParticipantNamesPayload(
  value: unknown,
): value is { names: string[] } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'names' in value &&
    Array.isArray(value.names) &&
    value.names.length <= 12 &&
    value.names.every(
      (name): name is string =>
        typeof name === 'string' &&
        name.trim().length > 0 &&
        name.length <= 200,
    )
  )
}
