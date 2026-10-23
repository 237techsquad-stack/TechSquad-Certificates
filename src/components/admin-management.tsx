import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react'

type Participant = {
  id: string
  name: string
  email: string
  displayNamePublicly?: boolean
  createdAt: string
  updatedAt: string
}
type Enrollment = {
  id: string
  participantId: string
  courseId: string
  courseName: string
  status: 'in_progress' | 'completed' | 'withdrawn'
  completedAt: string | null
  createdAt: string
  updatedAt: string
}
type Certificate = {
  id: string
  certificateId: string
  enrollmentId: string
  issueDate: string
  status: 'issued' | 'revoked'
  revokedAt: string | null
  supersedesCertificateId: string | null
  createdAt: string
  updatedAt: string
  fileAvailable?: boolean
}
type Page<T> = { items: T[]; page: number; limit: number }
type Statistics = {
  participants: number
  enrollments: number
  inProgressEnrollments: number
  certificates: number
  activeCertificates: number
  revokedCertificates: number
}
type ManagementPage =
  | 'overview'
  | 'participants'
  | 'enrollments'
  | 'certificates'

const safeMessages: Record<string, string> = {
  unauthenticated: 'Your session expired. Sign in again and retry.',
  forbidden: 'Your account is not authorized for this action.',
  csrf_failed: 'Request verification failed. Refresh the page and retry.',
  invalid_request: 'Check the entered information and try again.',
  invalid_participant_id: 'Enter a valid 24-character participant record ID.',
  invalid_course_id: 'Enter a course ID using letters, numbers, and single hyphens.',
  invalid_course_name: 'Enter a course name between 1 and 200 characters.',
  not_found: 'No matching record was found.',
  conflict: 'This action is not allowed for the record’s current status or relationships.',
  authentication_unavailable: 'Authentication is temporarily unavailable.',
  internal_error: 'The request could not be completed. Please try again.',
  file_unavailable: 'The certificate file is temporarily unavailable.',
}

async function apiRequest<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase()
  const headers = new Headers(init.headers)
  if (method !== 'GET' && method !== 'HEAD') {
    const token = readCsrfCookie()
    if (!token) throw new Error('Refresh the page and retry the request.')
    headers.set('X-CSRF-Token', token)
    if (
      init.body &&
      !(init.body instanceof FormData) &&
      !headers.has('Content-Type')
    ) {
      headers.set('Content-Type', 'application/json')
    }
  }

  let response: Response
  try {
    response = await fetch(path, {
      ...init,
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
    })
  } catch {
    throw new Error('The service could not be reached. Please try again.')
  }

  if (response.status === 204) return undefined as T
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new Error('The service returned an unexpected response.')
  }
  if (!response.ok) {
    const code =
      typeof payload === 'object' &&
      payload !== null &&
      'error' in payload &&
      typeof payload.error === 'string'
        ? payload.error
        : ''
    throw new Error(
      safeMessages[code] ??
        (response.status === 400
          ? 'Check the entered information and try again.'
          : 'The request could not be completed. Please try again.'),
    )
  }
  return payload as T
}

function readCsrfCookie(): string | undefined {
  const cookie = document.cookie
    .split('; ')
    .find((value) => value.startsWith('tsc_csrf='))
  if (!cookie) return undefined
  try {
    return decodeURIComponent(cookie.slice('tsc_csrf='.length))
  } catch {
    return undefined
  }
}

function queryUrl(path: string, values: Record<string, string>): string {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) {
    if (value.trim()) query.set(key, value.trim())
  }
  const suffix = query.toString()
  return suffix ? `${path}?${suffix}` : path
}

function date(value: string | null): string {
  if (!value) return '—'
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? '—' : parsed.toLocaleDateString()
}

function FormMessage({ error, success }: { error?: string; success?: string }) {
  if (error) return <p className="form-message form-message-error" role="alert">{error}</p>
  if (success) return <p className="form-message form-message-success" role="status">{success}</p>
  return null
}

type IconName = 'plus' | 'pencil' | 'trash' | 'eye' | 'download' | 'ban' | 'refresh' | 'check'

function IconGlyph({ name }: { name: IconName }) {
  const paths: Record<IconName, ReactNode> = {
    plus: <><path d="M12 5v14M5 12h14" /></>,
    pencil: <><path d="m15 5 4 4M4 20l4-.8L19 8a2.1 2.1 0 0 0-3-3L5 16z" /></>,
    trash: <><path d="M4 7h16M10 11v6M14 11v6M5 7l1 13h12l1-13M9 7V4h6v3" /></>,
    eye: <><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z" /><circle cx="12" cy="12" r="2.5" /></>,
    download: <><path d="M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4" /></>,
    ban: <><circle cx="12" cy="12" r="9" /><path d="m5.6 5.6 12.8 12.8" /></>,
    refresh: <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M5.5 9a7 7 0 0 1 12-2L20 12M4 12l2.5 5a7 7 0 0 0 12-2" /></>,
    check: <><path d="m5 12 4 4L19 6" /></>,
  }

  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {paths[name]}
    </svg>
  )
}

function IconButton({
  icon,
  label,
  onClick,
  disabled = false,
  danger = false,
}: {
  icon: IconName
  label: string
  onClick(): void
  disabled?: boolean
  danger?: boolean
}) {
  return (
    <button
      className={`icon-button${danger ? ' icon-button-danger' : ''}`}
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      <IconGlyph name={icon} />
    </button>
  )
}

function IconLink({
  icon,
  label,
  href,
  target,
}: {
  icon: IconName
  label: string
  href: string
  target?: string
}) {
  return (
    <a
      className="icon-button"
      href={href}
      aria-label={label}
      title={label}
      {...(target ? { target, rel: 'noreferrer' } : {})}
    >
      <IconGlyph name={icon} />
    </a>
  )
}

function SearchToolbar({
  title,
  description,
  actionLabel,
  onAction,
  onSearch,
  children,
  query,
  onQueryChange,
  placeholder = 'Search records',
  required = false,
  maxLength,
  inputType = 'search',
}: {
  title: string
  description: string
  actionLabel: string
  onAction(): void
  onSearch(event: FormEvent): void
  children?: ReactNode
  query: string
  onQueryChange(value: string): void
  placeholder?: string
  required?: boolean
  maxLength?: number
  inputType?: 'search' | 'email'
}) {
  return (
    <div className="management-page-toolbar">
      <div className="management-page-title">
        <h3>{title}</h3>
        <p>{description}</p>
      </div>
      <div className="management-toolbar-actions">
        <button className="button button-primary" type="button" onClick={onAction}>
          <IconGlyph name="plus" />
          {actionLabel}
        </button>
        <form className="management-search" role="search" onSubmit={onSearch}>
          {children}
          <label className="visually-hidden" htmlFor={`search-${title.replaceAll(' ', '-')}`}>
            Search {title.toLowerCase()}
          </label>
          <input
            id={`search-${title.replaceAll(' ', '-')}`}
            type={inputType}
            value={query}
            onChange={(event) => onQueryChange(event.currentTarget.value)}
            placeholder={placeholder}
            required={required}
            maxLength={maxLength}
          />
          <button
            className="search-icon-button"
            type="submit"
            aria-label={`Search ${title.toLowerCase()}`}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="10.8" cy="10.8" r="6.8" />
              <path d="m16 16 5 5" />
            </svg>
          </button>
        </form>
      </div>
    </div>
  )
}

function CenteredModal({
  open,
  title,
  onClose,
  children,
  className = '',
  closeDisabled = false,
}: {
  open: boolean
  title: string
  onClose(): void
  children: ReactNode
  className?: string
  closeDisabled?: boolean
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const titleId = useId()

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  return (
    <dialog
      ref={dialogRef}
      className={`management-modal ${className}`}
      aria-labelledby={titleId}
      onCancel={(event) => {
        if (closeDisabled) event.preventDefault()
        else onClose()
      }}
      onClose={onClose}
    >
      <div className="management-modal-content">
        <div className="management-modal-heading">
          <h3 id={titleId}>{title}</h3>
          <button
            type="button"
            className="modal-close-button"
            aria-label={`Close ${title}`}
            disabled={closeDisabled}
            onClick={onClose}
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>
        {children}
      </div>
    </dialog>
  )
}

function TextField({
  label,
  value,
  onChange,
  type = 'text',
  required = false,
  maxLength,
  pattern,
  title,
  placeholder,
  autoFocus = false,
}: {
  label: string
  value: string
  onChange(value: string): void
  type?: string
  required?: boolean
  maxLength?: number
  pattern?: string
  title?: string
  placeholder?: string
  autoFocus?: boolean
}) {
  return (
    <label className="form-field">
      <span>{label}</span>
      <input
        type={type}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        required={required}
        maxLength={maxLength}
        pattern={pattern}
        title={title}
        placeholder={placeholder}
        autoFocus={autoFocus}
      />
    </label>
  )
}

export function AdminManagement({
  page,
  initialParticipantId = '',
  initialEnrollmentId = '',
}: {
  page: ManagementPage
  initialParticipantId?: string
  initialEnrollmentId?: string
}) {
  const [statistics, setStatistics] = useState<Statistics | null>(null)
  const [overviewError, setOverviewError] = useState('')
  const refreshStatistics = useCallback(async () => {
    try {
      setStatistics(await apiRequest<Statistics>('/api/admin/dashboard'))
      setOverviewError('')
    } catch (error) {
      setOverviewError(errorMessage(error))
    }
  }, [])
  useEffect(() => {
    if (page === 'overview') void refreshStatistics()
  }, [page, refreshStatistics])

  return (
    <div className="admin-management">
      {page === 'overview' && (
        <>
          <Section number="01" id="overview" title="Program overview" description="Current totals from your certificate records.">
            {overviewError && <FormMessage error={overviewError} />}
            {!statistics && !overviewError && <p className="panel-loading" role="status">Loading overview…</p>}
            {statistics && (
              <div className="statistics-grid">
                <Statistic label="Participants" value={statistics.participants} />
                <Statistic label="Enrollments" value={statistics.enrollments} />
                <Statistic label="In progress" value={statistics.inProgressEnrollments} />
                <Statistic label="Issued certificates" value={statistics.activeCertificates} />
                <Statistic label="Revoked certificates" value={statistics.revokedCertificates} />
              </div>
            )}
          </Section>
          <section className="admin-quick-actions" aria-labelledby="quick-actions-title">
            <div>
              <p className="admin-eyebrow">GET STARTED</p>
              <h2 id="quick-actions-title">Quick actions</h2>
              <p>Go directly to a common administration task.</p>
            </div>
            <div className="admin-quick-action-links">
              <a className="button button-primary" href="/admin/participants">Manage participants</a>
              <a className="button button-secondary" href="/admin/certificates">View certificates</a>
            </div>
          </section>
        </>
      )}
      {page === 'participants' && <ParticipantsPanel />}
      {page === 'enrollments' && <EnrollmentsPanel initialParticipantId={initialParticipantId} />}
      {page === 'certificates' && (
        <CertificatesPanel
          onChanged={refreshStatistics}
          initialEnrollmentId={initialEnrollmentId}
        />
      )}
    </div>
  )
}

function Statistic({ label, value }: { label: string; value: number }) {
  return (
    <article className="stat-card">
      <span>{label}</span>
      <strong>{value.toLocaleString()}</strong>
    </article>
  )
}

function Section({
  number,
  id,
  title,
  description,
  children,
  hideHeading = false,
}: {
  number: string
  id: string
  title: string
  description: string
  children: ReactNode
  hideHeading?: boolean
}) {
  return (
    <section className="workspace-section" id={id}>
      {!hideHeading && (
        <div className="workspace-heading">
          <span className="section-number">{number}</span>
          <div><h2>{title}</h2><p>{description}</p></div>
        </div>
      )}
      {children}
    </section>
  )
}

function ParticipantsPanel() {
  const [queryType, setQueryType] = useState<'name' | 'email'>('name')
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<Participant[]>([])
  const [page, setPage] = useState(1)
  const [limit, setLimit] = useState(20)
  const [searched, setSearched] = useState(false)
  const [pending, setPending] = useState(true)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [modalError, setModalError] = useState('')
  const [modalOpen, setModalOpen] = useState(false)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [displayNamePublicly, setDisplayNamePublicly] = useState(false)
  const [selected, setSelected] = useState<Participant | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Participant | null>(null)
  const requestId = useRef(0)
  const activeRequest = useRef<AbortController | null>(null)

  const search = useCallback(async (
    nextPage = 1,
    searchQuery = '',
    searchType: 'name' | 'email' = 'name',
  ) => {
    const currentRequestId = ++requestId.current
    activeRequest.current?.abort()
    const controller = new AbortController()
    activeRequest.current = controller
    setPending(true)
    setError('')
    setSearched(true)
    try {
      const result = await apiRequest<Page<Participant>>(
        queryUrl('/api/admin/participants/', {
          [searchType]: searchQuery,
          page: String(nextPage),
          limit: '20',
        }),
        { signal: controller.signal },
      )
      if (currentRequestId !== requestId.current) return
      setItems(result.items)
      setPage(result.page)
      setLimit(result.limit)
    } catch (requestError) {
      if (currentRequestId !== requestId.current) return
      setItems([])
      setError(errorMessage(requestError))
    } finally {
      if (currentRequestId === requestId.current) {
        activeRequest.current = null
        setPending(false)
      }
    }
  }, [])

  useEffect(() => {
    void search()
    return () => {
      requestId.current += 1
      activeRequest.current?.abort()
      activeRequest.current = null
    }
  }, [search])

  async function saveParticipant(event: FormEvent) {
    event.preventDefault()
    if (pending) return
    setPending(true)
    setModalError('')
    try {
      const wasEditing = Boolean(selected)
      const path = selected
        ? `/api/admin/participants/${encodeURIComponent(selected.id)}`
        : '/api/admin/participants/'
      const savedParticipant = await apiRequest<Participant>(path, {
        method: selected ? 'PATCH' : 'POST',
        body: JSON.stringify({ name, email, displayNamePublicly }),
      })
      setModalOpen(false)
      setSelected(null)
      setName('')
      setEmail('')
      setDisplayNamePublicly(false)
      setSuccess(wasEditing ? 'Participant updated.' : 'Participant added.')
      setQuery('')
      setPage(1)
      await search(1, '', queryType)
      setItems((current) => [
        savedParticipant,
        ...current.filter((item) => item.id !== savedParticipant.id),
      ].slice(0, 20))
    } catch (requestError) {
      setModalError(errorMessage(requestError))
    } finally {
      setPending(false)
    }
  }

  async function deleteParticipant() {
    if (!deleteTarget || pending) return
    setPending(true)
    setModalError('')
    setError('')
    setSuccess('')
    try {
      await apiRequest<{ deleted: true }>(
        `/api/admin/participants/${encodeURIComponent(deleteTarget.id)}`,
        { method: 'DELETE' },
      )
      setDeleteTarget(null)
      setSuccess('Participant deleted.')
      await search(page, query, queryType)
    } catch (requestError) {
      setModalError(errorMessage(requestError))
    } finally {
      setPending(false)
    }
  }

  function editParticipant(participant: Participant) {
    setSelected(participant)
    setName(participant.name)
    setEmail(participant.email)
    setDisplayNamePublicly(participant.displayNamePublicly === true)
    setModalError('')
    setModalOpen(true)
  }

  function startNew() {
    setSelected(null)
    setName('')
    setEmail('')
    setDisplayNamePublicly(false)
    setModalError('')
    setModalOpen(true)
  }

  return (
    <Section number="01" id="participants" title="Participants" description="Search, add, and update participant identity details. Email addresses are normalized by the server." hideHeading>
      <SearchToolbar
        title="Participants"
        description="Search, add, and update participant identity details."
        actionLabel="Add participant"
        onAction={startNew}
        onSearch={(event) => { event.preventDefault(); void search(1, query, queryType) }}
        query={query}
        onQueryChange={setQuery}
        placeholder={`Search by ${queryType}`}
        maxLength={queryType === 'email' ? 320 : 200}
        inputType={queryType === 'email' ? 'email' : 'search'}
      >
        <label className="visually-hidden" htmlFor="participant-search-type">Search field</label>
        <select id="participant-search-type" value={queryType} onChange={(event) => setQueryType(event.currentTarget.value as 'name' | 'email')}>
          <option value="name">Name</option>
          <option value="email">Email</option>
        </select>
      </SearchToolbar>
      <FormMessage error={error} success={success} />
      {pending && <p role="status">Loading participants…</p>}
      {error && !pending && <p className="empty-state">Participant records could not be loaded.</p>}
      {searched && !pending && !items.length && !error && <p className="empty-state">No participants found. Try a different search.</p>}
      {!!items.length && (
        <>
          <div className="table-wrap" role="region" aria-label="Participants table, horizontally scrollable" tabIndex={0}>
            <table className="data-table">
              <thead><tr><th>Name</th><th>Email</th><th>Record ID</th><th>Created</th><th>Actions</th></tr></thead>
              <tbody>
                {items.map((participant) => (
                  <tr key={participant.id}>
                    <td data-label="Name">{participant.name}</td>
                    <td data-label="Email">{participant.email}</td>
                    <td data-label="Record ID" className="mono">{participant.id}</td>
                    <td data-label="Created">{date(participant.createdAt)}</td>
                    <td data-label="Actions">
                      <div className="table-actions">
                        <IconButton
                          icon="pencil"
                          label={`Edit participant ${participant.name}`}
                          disabled={pending}
                          onClick={() => editParticipant(participant)}
                        />
                        <IconButton
                          icon="trash"
                          label={`Delete participant ${participant.name} (only when no enrollments exist)`}
                          danger
                          disabled={pending}
                          onClick={() => {
                            setModalError('')
                            setDeleteTarget(participant)
                          }}
                        />
                        <IconLink
                          icon="plus"
                          label={`Create enrollment for ${participant.name}`}
                          href={`/admin/enrollments?participantId=${encodeURIComponent(participant.id)}`}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="pagination">
            <span>Page {page}</span>
            <div>
              <button className="button button-secondary button-small" type="button" disabled={pending || page <= 1} onClick={() => void search(page - 1, query, queryType)}>Previous</button>
              <button className="button button-secondary button-small" type="button" disabled={pending || items.length < limit} onClick={() => void search(page + 1, query, queryType)}>Next</button>
            </div>
          </div>
        </>
      )}
      <CenteredModal
        open={modalOpen}
        title={selected ? 'Edit participant' : 'Add participant'}
        onClose={() => { if (!pending) setModalOpen(false) }}
        closeDisabled={pending}
      >
        <form className="stacked-form" onSubmit={saveParticipant}>
          <TextField label="Full name" value={name} onChange={setName} required maxLength={200} autoFocus />
          <TextField label="Email address" type="email" value={email} onChange={setEmail} required maxLength={320} />
          <label className="consent-checkbox">
            <input
              type="checkbox"
              checked={displayNamePublicly}
              onChange={(event) => setDisplayNamePublicly(event.currentTarget.checked)}
            />
            <span>I confirm this participant has agreed to display their name publicly on the homepage.</span>
          </label>
          <FormMessage error={modalError} />
          <div className="action-row">
            <button className="button button-primary" disabled={pending}>
              {pending ? 'Saving…' : selected ? 'Save changes' : 'Add participant'}
            </button>
            <button className="button button-secondary" type="button" disabled={pending} onClick={() => setModalOpen(false)}>Cancel</button>
          </div>
        </form>
      </CenteredModal>
      <CenteredModal
        open={deleteTarget !== null}
        title="Delete participant?"
        onClose={() => { if (!pending) { setDeleteTarget(null); setModalError('') } }}
        closeDisabled={pending}
      >
        <div className="stacked-form">
          <p>
            Delete participant <strong>{deleteTarget?.name}</strong>? This is only
            permitted when the participant has no enrollment records.
          </p>
          <FormMessage error={modalError} />
          <div className="action-row">
            <button className="button button-danger" type="button" disabled={pending} onClick={() => void deleteParticipant()}>
              {pending ? 'Deleting…' : 'Delete participant'}
            </button>
            <button className="button button-secondary" type="button" disabled={pending} onClick={() => { setDeleteTarget(null); setModalError('') }}>Cancel</button>
          </div>
        </div>
      </CenteredModal>
    </Section>
  )
}

function EnrollmentsPanel({
  initialParticipantId,
}: {
  initialParticipantId: string
}) {
  const [items, setItems] = useState<Enrollment[]>([])
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('')
  const [participantId, setParticipantId] = useState(initialParticipantId)
  const [courseId, setCourseId] = useState('')
  const [courseName, setCourseName] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [modalError, setModalError] = useState('')
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<Enrollment | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Enrollment | null>(null)
  const skipNextAutoSearch = useRef(false)

  const search = useCallback(async (
    searchQuery = query,
    searchStatus = status,
  ) => {
    setPending(true)
    setError('')
    try {
      const result = await apiRequest<Page<Enrollment>>(
        queryUrl('/api/admin/enrollments/', {
          query: searchQuery,
          status: searchStatus,
          limit: '50',
        }),
      )
      setItems(result.items)
    } catch (requestError) {
      setItems([])
      setError(errorMessage(requestError))
    } finally {
      setPending(false)
    }
  }, [query, status])

  useEffect(() => {
    if (skipNextAutoSearch.current) {
      skipNextAutoSearch.current = false
      return
    }
    void search()
  }, [search])
  useEffect(() => { setParticipantId(initialParticipantId) }, [initialParticipantId])

  function startCreate() {
    setEditing(null)
    setParticipantId(initialParticipantId)
    setCourseId('')
    setCourseName('')
    setModalError('')
    setModalOpen(true)
  }

  function startEdit(enrollment: Enrollment) {
    setEditing(enrollment)
    setParticipantId(enrollment.participantId)
    setCourseId(enrollment.courseId)
    setCourseName(enrollment.courseName)
    setModalError('')
    setModalOpen(true)
  }

  async function saveEnrollment(event: FormEvent) {
    event.preventDefault()
    if (pending) return
    setPending(true)
    setModalError('')
    try {
      if (editing) {
        const savedEnrollment = await apiRequest<Enrollment>(
          `/api/admin/enrollments/${encodeURIComponent(editing.id)}`,
          {
            method: 'PATCH',
            body: JSON.stringify({ courseId, courseName }),
          },
        )
        setModalOpen(false)
        setSuccess('Enrollment updated.')
        if (query || status) skipNextAutoSearch.current = true
        setQuery('')
        setStatus('')
        await search('', '')
        setItems((current) => [
          savedEnrollment,
          ...current.filter((item) => item.id !== savedEnrollment.id),
        ].slice(0, 50))
      } else {
        const savedEnrollment = await apiRequest<Enrollment>('/api/admin/enrollments/', {
          method: 'POST',
          body: JSON.stringify({ participantId, courseId, courseName }),
        })
        setModalOpen(false)
        setSuccess('Enrollment created.')
        if (query || status) skipNextAutoSearch.current = true
        setQuery('')
        setStatus('')
        await search('', '')
        setItems((current) => [
          savedEnrollment,
          ...current.filter((item) => item.id !== savedEnrollment.id),
        ].slice(0, 50))
      }
    } catch (requestError) {
      setModalError(errorMessage(requestError))
    } finally {
      setPending(false)
    }
  }

  async function deleteEnrollment() {
    if (!deleteTarget || pending) return
    setPending(true)
    setError('')
    setModalError('')
    setSuccess('')
    try {
      await apiRequest<{ deleted: true }>(
        `/api/admin/enrollments/${encodeURIComponent(deleteTarget.id)}`,
        { method: 'DELETE' },
      )
      setDeleteTarget(null)
      setSuccess('Enrollment deleted.')
      await search()
    } catch (requestError) {
      setModalError(errorMessage(requestError))
    } finally {
      setPending(false)
    }
  }

  async function transition(enrollment: Enrollment, action: 'complete' | 'withdraw') {
    if (pending) return
    const actionLabel = action === 'complete' ? 'complete' : 'withdraw'
    if (!window.confirm(`Are you sure you want to ${actionLabel} this enrollment?`)) return
    setPending(true)
    setError('')
    setSuccess('')
    try {
      await apiRequest<Enrollment>(`/api/admin/enrollments/${encodeURIComponent(enrollment.id)}/${action}`, { method: 'POST', body: '{}' })
      setSuccess(action === 'complete' ? 'Enrollment completed.' : 'Enrollment withdrawn.')
      await search()
    } catch (requestError) {
      setError(errorMessage(requestError))
    } finally {
      setPending(false)
    }
  }

  return (
    <Section number="02" id="enrollments" title="Enrollments" description="Search existing records and apply only the allowed in-progress transitions." hideHeading>
      <SearchToolbar
        title="Enrollments"
        description="Review participant course records and their current completion state."
        actionLabel="Add enrollment"
        onAction={startCreate}
        onSearch={(event) => { event.preventDefault(); void search() }}
        query={query}
        onQueryChange={setQuery}
        placeholder="Search course name or ID"
        maxLength={200}
      >
        <label className="visually-hidden" htmlFor="enrollment-search-status">Filter by status</label>
        <select id="enrollment-search-status" value={status} onChange={(event) => setStatus(event.currentTarget.value)}>
          <option value="">All statuses</option>
          <option value="in_progress">In progress</option>
          <option value="completed">Completed</option>
          <option value="withdrawn">Withdrawn</option>
        </select>
      </SearchToolbar>
      <FormMessage error={error} success={success} />
      {pending && <p role="status">Loading enrollments…</p>}
      {!pending && error && <p className="empty-state">Enrollment records could not be loaded.</p>}
      {!pending && !items.length && !error && <p className="empty-state">No enrollments match this search.</p>}
      {!!items.length && (
        <div className="table-wrap" role="region" aria-label="Enrollments table, horizontally scrollable" tabIndex={0}>
          <table className="data-table">
            <thead><tr><th>Course</th><th>Participant ID</th><th>Created</th><th>Completed</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>{items.map((item) => (
              <tr key={item.id}>
                <td data-label="Course">{item.courseName}<span className="subtext">{item.courseId}</span></td>
                <td data-label="Participant ID" className="mono">{item.participantId}</td>
                <td data-label="Created">{date(item.createdAt)}</td>
                <td data-label="Completed">{date(item.completedAt)}</td>
                <td data-label="Status"><StatusBadge status={item.status} /></td>
                <td data-label="Actions">
                  <div className="table-actions">
                    {item.status === 'in_progress' ? (
                      <>
                        <IconButton icon="pencil" label={`Edit enrollment for ${item.courseName}`} disabled={pending} onClick={() => startEdit(item)} />
                        <IconButton icon="trash" label={`Delete in-progress enrollment for ${item.courseName} (only if no certificate or reissue history exists)`} danger disabled={pending} onClick={() => { setModalError(''); setDeleteTarget(item) }} />
                        <IconButton icon="check" label={`Complete enrollment for ${item.courseName}`} disabled={pending} onClick={() => void transition(item, 'complete')} />
                        <IconButton icon="ban" label={`Withdraw enrollment for ${item.courseName}`} danger disabled={pending} onClick={() => void transition(item, 'withdraw')} />
                      </>
                    ) : (
                      <>
                        <span className="icon-button-disabled" title="Only in-progress enrollments can be edited or deleted." aria-label="Editing and deletion are unavailable for terminal enrollments">
                          <IconGlyph name="pencil" />
                        </span>
                        <span className="icon-button-disabled" title="Only in-progress enrollments without certificate history can be deleted." aria-label="Deletion is unavailable for terminal enrollments">
                          <IconGlyph name="trash" />
                        </span>
                        {item.status === 'completed' && (
                          <IconLink
                            icon="plus"
                            label={`Issue certificate for ${item.courseName}`}
                            href={`/admin/certificates?enrollmentId=${encodeURIComponent(item.id)}`}
                          />
                        )}
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      <CenteredModal
        open={modalOpen}
        title={editing ? 'Edit enrollment' : 'Add enrollment'}
        onClose={() => { if (!pending) setModalOpen(false) }}
        closeDisabled={pending}
      >
        <form className="stacked-form" onSubmit={saveEnrollment}>
          {editing ? (
            <p>Participant record <code className="mono">{editing.participantId}</code> cannot be changed.</p>
          ) : (
            <TextField label="Participant record ID" value={participantId} onChange={setParticipantId} required maxLength={24} pattern="[a-fA-F0-9]{24}" title="Enter the 24-character participant record ID." autoFocus />
          )}
          <TextField label="Stable course ID" value={courseId} onChange={setCourseId} required maxLength={200} pattern=" *[a-zA-Z0-9]+(-[a-zA-Z0-9]+)* *" title="Use letters and numbers separated by single hyphens." placeholder="web-foundations" />
          <TextField label="Course name" value={courseName} onChange={setCourseName} required maxLength={200} />
          <p className="field-help">Only in-progress enrollments without certificate history can be edited or deleted. Completion and withdrawal remain terminal actions.</p>
          <FormMessage error={modalError} />
          <div className="action-row">
            <button className="button button-primary" disabled={pending}>{pending ? 'Saving…' : editing ? 'Save changes' : 'Create enrollment'}</button>
            <button className="button button-secondary" type="button" disabled={pending} onClick={() => setModalOpen(false)}>Cancel</button>
          </div>
        </form>
      </CenteredModal>
      <CenteredModal
        open={deleteTarget !== null}
        title="Delete enrollment?"
        onClose={() => { if (!pending) { setDeleteTarget(null); setModalError('') } }}
        closeDisabled={pending}
      >
        <div className="stacked-form">
          <p>Delete the in-progress enrollment for <strong>{deleteTarget?.courseName}</strong>? Certificate-linked or terminal enrollments cannot be deleted.</p>
          <FormMessage error={modalError} />
          <div className="action-row">
            <button className="button button-danger" type="button" disabled={pending} onClick={() => void deleteEnrollment()}>
              {pending ? 'Deleting…' : 'Delete enrollment'}
            </button>
            <button className="button button-secondary" type="button" disabled={pending} onClick={() => { setDeleteTarget(null); setModalError('') }}>Cancel</button>
          </div>
        </div>
      </CenteredModal>
    </Section>
  )
}

function CertificatesPanel({
  onChanged,
  initialEnrollmentId,
}: {
  onChanged(): Promise<void>
  initialEnrollmentId: string
}) {
  const [items, setItems] = useState<Certificate[]>([])
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('')
  const [participantQuery, setParticipantQuery] = useState('')
  const [participants, setParticipants] = useState<Participant[]>([])
  const [selectedParticipantId, setSelectedParticipantId] = useState('')
  const [completedEnrollments, setCompletedEnrollments] = useState<Enrollment[]>([])
  const [selectedEnrollmentId, setSelectedEnrollmentId] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [selectedId, setSelectedId] = useState('')
  const [reason, setReason] = useState('')
  const [replacementFile, setReplacementFile] = useState<File | null>(null)
  const [modalMode, setModalMode] = useState<'issue' | 'revoke' | 'replace' | null>(null)
  const [modalError, setModalError] = useState('')
  const [pending, setPending] = useState(false)
  const [selectionPending, setSelectionPending] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const skipNextAutoSearch = useRef(false)

  const search = useCallback(async (
    searchQuery = query,
    searchStatus = status,
  ) => {
    setPending(true)
    setError('')
    try {
      const result = await apiRequest<Page<Certificate>>(
        queryUrl('/api/admin/certificates/', {
          query: searchQuery,
          status: searchStatus,
          limit: '50',
        }),
      )
      setItems(result.items)
    } catch (requestError) {
      setItems([])
      setError(errorMessage(requestError))
    } finally {
      setPending(false)
    }
  }, [query, status])
  useEffect(() => {
    if (skipNextAutoSearch.current) {
      skipNextAutoSearch.current = false
      return
    }
    void search()
  }, [search])

  useEffect(() => {
    if (!initialEnrollmentId) return
    let active = true
    async function loadInitialEnrollment() {
      setSelectionPending(true)
      try {
        const enrollment = await apiRequest<Enrollment>(
          `/api/admin/enrollments/${encodeURIComponent(initialEnrollmentId)}`,
        )
        if (enrollment.status !== 'completed') {
          throw new Error('Only completed enrollments can receive certificates.')
        }
        const participant = await apiRequest<Participant>(
          `/api/admin/participants/${encodeURIComponent(enrollment.participantId)}`,
        )
        if (!active) return
        setParticipants([participant])
        setParticipantQuery(`${participant.name} (${participant.email})`)
        setSelectedParticipantId(participant.id)
        setCompletedEnrollments([enrollment])
        setSelectedEnrollmentId(enrollment.id)
      } catch (requestError) {
        if (active) setModalError(errorMessage(requestError))
      } finally {
        if (active) setSelectionPending(false)
      }
    }
    void loadInitialEnrollment()
    return () => { active = false }
  }, [initialEnrollmentId])

  async function findParticipants() {
    const name = participantQuery.trim()
    if (!name) {
      setModalError('Enter a participant name to search.')
      return
    }
    setSelectionPending(true)
    setModalError('')
    setParticipants([])
    setSelectedParticipantId('')
    setCompletedEnrollments([])
    setSelectedEnrollmentId('')
    try {
      const result = await apiRequest<Page<Participant>>(
        queryUrl('/api/admin/participants/', { name, page: '1', limit: '50' }),
      )
      setParticipants(result.items)
      if (!result.items.length) setModalError('No participants matched that name.')
    } catch (requestError) {
      setModalError(errorMessage(requestError))
    } finally {
      setSelectionPending(false)
    }
  }

  async function loadCompletedEnrollments(participantId: string) {
    setSelectedParticipantId(participantId)
    setCompletedEnrollments([])
    setSelectedEnrollmentId('')
    if (!participantId) return
    setSelectionPending(true)
    setModalError('')
    try {
      const result = await apiRequest<Page<Enrollment>>(
        queryUrl('/api/admin/enrollments/', {
          participantId,
          status: 'completed',
          limit: '100',
        }),
      )
      setCompletedEnrollments(result.items)
      if (!result.items.length) {
        setModalError('This participant has no completed enrollments to issue.')
      }
    } catch (requestError) {
      setModalError(errorMessage(requestError))
    } finally {
      setSelectionPending(false)
    }
  }

  async function issue(event: FormEvent) {
    event.preventDefault()
    if (pending || selectionPending) return
    if (!selectedEnrollmentId) {
      setModalError('Select a completed enrollment before issuing.')
      return
    }
    if (!file) {
      setModalError('Choose a PDF certificate file before issuing.')
      return
    }
    setPending(true)
    setModalError('')
    setSuccess('')
    try {
      const body = new FormData()
      body.set('issuanceMethod', 'upload_existing')
      body.set('file', file)
      const issued = await apiRequest<Certificate>(
        `/api/admin/enrollments/${encodeURIComponent(selectedEnrollmentId)}/certificate`,
        { method: 'POST', body },
      )
      setModalMode(null)
      setSuccess('Certificate and PDF file were issued.')
      setSelectedEnrollmentId('')
      setFile(null)
      if (query || status) skipNextAutoSearch.current = true
      setQuery('')
      setStatus('')
      await search('', '')
      setItems((current) => [
        issued,
        ...current.filter((item) => item.id !== issued.id),
      ].slice(0, 50))
      await onChanged()
    } catch (requestError) {
      setModalError(errorMessage(requestError))
    } finally {
      setPending(false)
    }
  }

  async function revoke(event: FormEvent) {
    event.preventDefault()
    if (pending) return
    if (!window.confirm(`Revoke certificate ${selectedId}? This action cannot be undone.`)) return
    setPending(true)
    setModalError('')
    setSuccess('')
    try {
      await apiRequest<Certificate>(
        `/api/admin/certificates/${encodeURIComponent(selectedId.trim())}/revoke`,
        { method: 'POST', body: JSON.stringify({ reason }) },
      )
      setModalMode(null)
      setSuccess('Certificate revoked.')
      setReason('')
      await search()
      await onChanged()
    } catch (requestError) {
      setModalError(errorMessage(requestError))
    } finally {
      setPending(false)
    }
  }

  async function replace(event: FormEvent) {
    event.preventDefault()
    if (pending) return
    const previous = items.find((item) => item.certificateId === selectedId)
    if (!previous || previous.status !== 'issued' || !replacementFile) {
      setModalError('Select an active certificate and a replacement PDF.')
      return
    }
    if (!window.confirm('Replace this certificate? The current certificate will be revoked and retained in its history.')) {
      return
    }

    setPending(true)
    setModalError('')
    setSuccess('')
    const storageKey = `certificate-reissue:${previous.certificateId}`
    let idempotencyKey = sessionStorage.getItem(storageKey)
    if (!idempotencyKey) {
      idempotencyKey = crypto.randomUUID()
      sessionStorage.setItem(storageKey, idempotencyKey)
    }
    try {
      const body = new FormData()
      body.set('idempotencyKey', idempotencyKey)
      body.set('file', replacementFile)
      const replacement = await apiRequest<Certificate>(
        `/api/admin/certificates/${encodeURIComponent(previous.certificateId)}/replace`,
        { method: 'POST', body },
      )
      sessionStorage.removeItem(storageKey)
      setModalMode(null)
      setSuccess(`Replacement ${replacement.certificateId} issued; the previous certificate remains revoked in history.`)
      setSelectedId(replacement.certificateId)
      setReplacementFile(null)
      await search()
      await onChanged()
    } catch (requestError) {
      setModalError(errorMessage(requestError))
    } finally {
      setPending(false)
    }
  }

  function openCertificateAction(certificateId: string, mode: 'revoke' | 'replace') {
    setSelectedId(certificateId)
    setReason('')
    setReplacementFile(null)
    setModalError('')
    setModalMode(mode)
  }

  function closeModal() {
    if (pending || selectionPending) return
    setModalMode(null)
    setModalError('')
  }

  return (
    <Section number="03" id="certificates" title="Certificates" description="Upload a PDF while issuing against a completed enrollment. Search, download, and revoke issued certificates." hideHeading>
      <SearchToolbar
        title="Certificates"
        description="Search, issue participant-specific PDFs, download, revoke, and replace certificates."
        actionLabel="Issue certificate"
        onAction={() => { setModalError(''); setModalMode('issue') }}
        onSearch={(event) => { event.preventDefault(); void search() }}
        query={query}
        onQueryChange={setQuery}
        placeholder="Search certificate ID"
        maxLength={100}
      >
        <label className="visually-hidden" htmlFor="certificate-search-status">Filter by status</label>
        <select id="certificate-search-status" value={status} onChange={(event) => setStatus(event.currentTarget.value)}>
          <option value="">All statuses</option>
          <option value="issued">Active</option>
          <option value="revoked">Revoked</option>
        </select>
      </SearchToolbar>
      <FormMessage error={error} success={success} />
      {pending && <p role="status">Loading certificates…</p>}
      {!pending && error && <p className="empty-state">Certificate records could not be loaded.</p>}
      {!pending && !items.length && !error && <p className="empty-state">No certificates match this search.</p>}
      {!!items.length && (
        <div className="table-wrap" role="region" aria-label="Certificates table, horizontally scrollable" tabIndex={0}>
          <table className="data-table">
            <thead><tr><th>Certificate</th><th>Enrollment</th><th>Issued</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>{items.map((item) => (
              <tr key={item.id}>
                <td data-label="Certificate" className="mono">{item.certificateId}<span className="subtext">{item.supersedesCertificateId ? `Replaces ${item.supersedesCertificateId}` : ''}</span></td>
                <td data-label="Enrollment" className="mono">{item.enrollmentId}</td>
                <td data-label="Issued">{date(item.issueDate)}</td>
                <td data-label="Status"><StatusBadge status={item.status} /></td>
                <td data-label="Actions">
                  <div className="table-actions">
                    {item.fileAvailable ? <>
                      <IconLink
                        icon="eye"
                        label={`Open certificate ${item.certificateId}`}
                        href={`/api/admin/certificates/${encodeURIComponent(item.certificateId)}/file?inline=1`}
                        target="_blank"
                      />
                      <IconLink
                        icon="download"
                        label={`Download certificate ${item.certificateId}`}
                        href={`/api/admin/certificates/${encodeURIComponent(item.certificateId)}/file`}
                      />
                    </> : <span>No file</span>}
                    {item.status === 'issued' && <>
                      <IconButton
                        icon="ban"
                        label={`Revoke certificate ${item.certificateId}`}
                        danger
                        disabled={pending}
                        onClick={() => openCertificateAction(item.certificateId, 'revoke')}
                      />
                      <IconButton
                        icon="refresh"
                        label={`Replace certificate ${item.certificateId}`}
                        disabled={pending}
                        onClick={() => openCertificateAction(item.certificateId, 'replace')}
                      />
                    </>}
                    <IconButton
                      icon="trash"
                      label={`Deletion unavailable for certificate ${item.certificateId}; revoke to preserve audit history`}
                      danger
                      disabled
                      onClick={() => {}}
                    />
                  </div>
                </td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      <CenteredModal
        open={modalMode !== null}
        title={modalMode === 'issue' ? 'Issue certificate' : modalMode === 'revoke' ? 'Revoke certificate' : 'Replace certificate'}
        onClose={closeModal}
        className="management-modal-wide"
        closeDisabled={pending || selectionPending}
      >
        {modalMode === 'issue' && (
          <form className="stacked-form" onSubmit={issue}>
            {!initialEnrollmentId && (
              <>
                <div className="stacked-form">
                  <TextField label="Find participant by name" value={participantQuery} onChange={setParticipantQuery} />
                  <button className="button button-secondary" type="button" onClick={() => void findParticipants()} disabled={selectionPending}>
                    {selectionPending ? 'Searching…' : 'Search participants'}
                  </button>
                </div>
                {participants.length > 0 && (
                  <label className="form-field">
                    <span>Select participant</span>
                    <select value={selectedParticipantId} onChange={(event) => void loadCompletedEnrollments(event.currentTarget.value)} disabled={selectionPending} required>
                      <option value="">Choose a participant</option>
                      {participants.map((participant) => <option key={participant.id} value={participant.id}>{participant.name} — {participant.email}</option>)}
                    </select>
                  </label>
                )}
              </>
            )}
            {selectedParticipantId && (
              <label className="form-field">
                <span>Select completed enrollment</span>
                <select value={selectedEnrollmentId} onChange={(event) => setSelectedEnrollmentId(event.currentTarget.value)} disabled={selectionPending || !completedEnrollments.length} required>
                  <option value="">Choose a completed enrollment</option>
                  {completedEnrollments.map((enrollment) => <option key={enrollment.id} value={enrollment.id}>{enrollment.courseName} · {enrollment.completedAt ? date(enrollment.completedAt) : 'Completed'}</option>)}
                </select>
              </label>
            )}
            <label className="form-field"><span>Certificate PDF (max 3.5 MB)</span><input type="file" accept="application/pdf,.pdf" required onChange={(event) => setFile(event.currentTarget.files?.[0] ?? null)} /></label>
            <p className="field-help">Upload the participant-specific PDF. The server validates the PDF signature and enforces completed enrollment and duplicate prevention.</p>
            <FormMessage error={modalError} />
            <div className="action-row">
              <button className="button button-primary" disabled={pending || selectionPending || !selectedEnrollmentId || !file}>{pending ? 'Uploading…' : 'Upload and issue'}</button>
              <button className="button button-secondary" type="button" disabled={pending || selectionPending} onClick={closeModal}>Cancel</button>
            </div>
          </form>
        )}
        {modalMode === 'revoke' && (
          <form className="stacked-form" onSubmit={revoke}>
            <p>Revoke certificate <strong>{selectedId}</strong>? This action cannot be undone.</p>
            <TextField label="Reason" value={reason} onChange={setReason} required maxLength={1000} autoFocus />
            <FormMessage error={modalError} />
            <div className="action-row">
              <button className="button button-danger" disabled={pending}>{pending ? 'Revoking…' : 'Confirm revoke'}</button>
              <button className="button button-secondary" type="button" disabled={pending} onClick={closeModal}>Cancel</button>
            </div>
          </form>
        )}
        {modalMode === 'replace' && (
          <form className="stacked-form" onSubmit={replace}>
            <p>Replace active certificate <strong>{selectedId}</strong>? The current certificate will be revoked and retained in its history.</p>
            <label className="form-field"><span>Replacement PDF (max 3.5 MB)</span><input type="file" accept="application/pdf,.pdf" required onChange={(event) => setReplacementFile(event.currentTarget.files?.[0] ?? null)} /></label>
            <p className="field-help">A new certificate will be issued for the same completed enrollment.</p>
            <FormMessage error={modalError} />
            <div className="action-row">
              <button className="button button-primary" disabled={pending || !replacementFile}>{pending ? 'Replacing…' : 'Replace certificate'}</button>
              <button className="button button-secondary" type="button" disabled={pending} onClick={closeModal}>Cancel</button>
            </div>
          </form>
        )}
      </CenteredModal>
    </Section>
  )
}

function StatusBadge({ status }: { status: string }) {
  return <span className={`status-badge status-${status}`}>{status.replace('_', ' ')}</span>
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : 'The request could not be completed. Please try again.'
}
