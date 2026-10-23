import assert from 'node:assert/strict'
import { ObjectId } from 'mongodb'
import test from 'node:test'

import { AuthenticationError } from '../src/lib/auth.server.ts'
import {
  createRepositories,
  RepositoryError,
} from '../src/lib/repositories.server.ts'
import { createEnrollmentCompletePostHandler } from '../src/routes/api/admin/enrollments/$id/complete.ts'
import { createEnrollmentWithdrawPostHandler } from '../src/routes/api/admin/enrollments/$id/withdraw.ts'
import { createEnrollmentPostHandler } from '../src/routes/api/admin/enrollments/index.ts'
import { createEnrollmentCertificatePostHandler } from '../src/routes/api/admin/enrollments/$id/certificate.ts'
import { createCertificateRevokePostHandler } from '../src/routes/api/admin/certificates/$id/revoke.ts'
import { createCertificateReissuePostHandler } from '../src/routes/api/admin/certificates/$id/reissue.ts'
import { createPublicCertificateVerificationGetHandler } from '../src/routes/api/verify/$token.ts'
import {
  createVercelAdminLoginRateLimiter,
  createVercelVerificationRateLimiter,
} from '../src/lib/verification-rate-limit.server.ts'
import { createEnrollmentByIdGetHandler } from '../src/routes/api/admin/enrollments/$id.ts'
import { createParticipantByIdGetHandler } from '../src/routes/api/admin/participants/$id.ts'
import {
  createParticipantDeleteHandler,
  createParticipantPatchHandler,
} from '../src/routes/api/admin/participants/$id.ts'
import {
  createEnrollmentDeleteHandler,
  createEnrollmentPatchHandler,
} from '../src/routes/api/admin/enrollments/$id.ts'
import { createParticipantsGetHandler } from '../src/routes/api/admin/participants/index.ts'
import { CertificateFileError } from '../src/lib/certificate-files.server.ts'
import { createPublicCertificateSearchGetHandler } from '../src/routes/api/certificates/search.ts'
import { createPublicParticipantNamesGetHandler } from '../src/routes/api/public/participant-names.ts'
import { createPublicCertificateFileGetHandler } from '../src/routes/api/verify/$token.file.ts'
import { createAdminCertificateFileGetHandler } from '../src/routes/api/admin/certificates/$id/file.ts'
import { createCertificateReplacePostHandler } from '../src/routes/api/admin/certificates/$id/replace.ts'

const validId = '65a12b34cd56ef7890123456'

function setup(
  authenticate: () => Promise<void> = async () => {},
  verifyCsrf?: (request: Request) => void,
) {
  let repositoryAccesses = 0
  let csrfChecks = 0
  const repositories = createRepositories(async () => {
    throw new Error('tests must not access a database')
  })
  const dependencies = {
    async requireAdmin() {
      await authenticate()
      return {
        email: 'admin@example.test',
        sessionVersion: 'a'.repeat(43),
        csrfToken: 'not-used-by-GET',
      }
    },
    assertCsrf(request: Request) {
      csrfChecks += 1
      if (verifyCsrf) {
        verifyCsrf(request)
        return
      }
      const token = request.headers.get('x-csrf-token')
      const cookie = request.headers.get('cookie') ?? ''
      if (
        request.headers.get('origin') !== 'https://certificates.example.test' ||
        token !== 'test-csrf-token' ||
        !cookie.split(';').some((part) => part.trim() === 'tsc_csrf=test-csrf-token')
      ) {
        throw new AuthenticationError('csrf_failed')
      }
    },
    getRepositories() {
      repositoryAccesses += 1
      return repositories
    },
  }
  return {
    dependencies,
    repositories,
    get csrfChecks() {
      return csrfChecks
    },
    get repositoryAccesses() {
      return repositoryAccesses
    },
  }
}

function request(path: string): Request {
  return new Request(`https://certificates.example.test${path}`)
}

function mutationRequest(
  path: string,
  body?: string,
  headers: Record<string, string> = {},
): Request {
  return new Request(`https://certificates.example.test${path}`, {
    method: 'POST',
    ...(body === undefined ? {} : { body }),
    headers: {
      origin: 'https://certificates.example.test',
      cookie: 'tsc_csrf=test-csrf-token',
      'x-csrf-token': 'test-csrf-token',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
  })
}

function certificateUploadRequest(path: string, fields: Record<string, string> = {}): Request {
  const form = new FormData()
  form.set('issuanceMethod', fields.issuanceMethod ?? 'upload_existing')
  if (Object.hasOwn(fields, 'templateId')) {
    form.set('templateId', fields.templateId)
  }
  if (fields.idempotencyKey) form.set('idempotencyKey', fields.idempotencyKey)
  form.set('file', new File(['%PDF-1.7\nsample'], 'uploaded.pdf', { type: 'application/pdf' }))
  return new Request(`https://certificates.example.test${path}`, {
    method: 'POST',
    body: form,
    headers: {
      origin: 'https://certificates.example.test',
      cookie: 'tsc_csrf=test-csrf-token',
      'x-csrf-token': 'test-csrf-token',
      'content-length': '1000',
    },
  })
}

function fakeFileStorage() {
  const fileId = new ObjectId()
  let removed = 0
  return {
    async storePdf() {
      return { fileId, fileSize: 16 }
    },
    async remove() {
      removed += 1
    },
    async stream() {
      const { Readable } = await import('node:stream')
      return Readable.from([Buffer.from('%PDF-1.7')])
    },
    get removed() {
      return removed
    },
  }
}

async function body(response: Response): Promise<Record<string, unknown>> {
  return response.json() as Promise<Record<string, unknown>>
}

test('participant search validates bounded pagination and returns serialized shape without caching', async () => {
  const mock = setup()
  let receivedInput: unknown
  mock.repositories.searchParticipants = async (input) => {
    receivedInput = input
    return {
      items: [
        {
          id: validId,
          name: 'Participant',
          email: 'participant@example.test',
          createdAt: '2026-10-23T00:00:00.000Z',
          updatedAt: '2026-10-23T00:00:00.000Z',
        },
      ],
      page: 2,
      limit: 10,
    }
  }
  const response = await createParticipantsGetHandler(mock.dependencies)(
    request('/api/admin/participants?name=Participant&page=2&limit=10'),
  )
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await body(response), {
    items: [
      {
        id: validId,
        name: 'Participant',
        email: 'participant@example.test',
        createdAt: '2026-10-23T00:00:00.000Z',
        updatedAt: '2026-10-23T00:00:00.000Z',
      },
    ],
    page: 2,
    limit: 10,
  })
  assert.deepEqual(receivedInput, {
    name: 'Participant',
    email: undefined,
    page: 2,
    limit: 10,
  })
})

test('participant search rejects malformed query and duplicate query values', async () => {
  const mock = setup()
  const handler = createParticipantsGetHandler(mock.dependencies)
  for (const url of [
    '/api/admin/participants?page=0&name=x',
    '/api/admin/participants?page=1.5&name=x',
    '/api/admin/participants?limit=101&name=x',
    '/api/admin/participants?email=invalid&name=x',
    '/api/admin/participants?name=x&page=1&page=2',
  ]) {
    const response = await handler(request(url))
    assert.equal(response.status, 400)
    assert.deepEqual(await body(response), { error: 'invalid_request' })
    assert.equal(response.headers.get('cache-control'), 'no-store')
  }
  assert.equal(mock.repositoryAccesses, 0)
})

test('participant list accepts omitted search criteria and preserves pagination response shape', async () => {
  const mock = setup()
  let receivedInput: unknown
  mock.repositories.searchParticipants = async (input) => {
    receivedInput = input
    return { items: [], page: 1, limit: 20 }
  }

  const response = await createParticipantsGetHandler(mock.dependencies)(
    request('/api/admin/participants/'),
  )

  assert.equal(response.status, 200)
  assert.deepEqual(await body(response), { items: [], page: 1, limit: 20 })
  assert.deepEqual(receivedInput, {
    name: undefined,
    email: undefined,
    page: 1,
    limit: 20,
  })
})

test('all ID endpoints reject malformed IDs before repository access', async () => {
  const mock = setup()
  const endpoints = [
    createParticipantByIdGetHandler(mock.dependencies),
    createEnrollmentByIdGetHandler(mock.dependencies),
  ]
  for (const endpoint of endpoints) {
    const response = await endpoint(request('/api/admin/resource/not-an-id'), {
      id: 'not-an-id',
    })
    assert.equal(response.status, 400)
    assert.deepEqual(await body(response), { error: 'invalid_request' })
    assert.equal(response.headers.get('cache-control'), 'no-store')
  }
  assert.equal(mock.repositoryAccesses, 0)
})

test('unauthenticated requests are rejected before repository access', async () => {
  const mock = setup(async () => {
    throw new AuthenticationError('unauthenticated')
  })
  const response = await createParticipantByIdGetHandler(mock.dependencies)(
    request('/api/admin/participants/not-an-id'),
    { id: 'not-an-id' },
  )
  assert.equal(response.status, 401)
  assert.deepEqual(await body(response), { error: 'unauthenticated' })
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(mock.repositoryAccesses, 0)
})

test('participant and enrollment ID routes return serialized data', async () => {
  const mock = setup()
  mock.repositories.getParticipantById = async () => ({
    id: validId,
    name: 'Participant',
    email: 'participant@example.test',
    createdAt: '2026-10-23T00:00:00.000Z',
    updatedAt: '2026-10-23T00:00:00.000Z',
  })
  mock.repositories.getEnrollmentById = async () => ({
    id: validId,
    participantId: '65a12b34cd56ef7890123457',
    courseId: 'web-foundations',
    courseName: 'Web Foundations',
    status: 'completed',
    completedAt: '2026-10-23T00:00:00.000Z',
    createdAt: '2026-10-23T00:00:00.000Z',
    updatedAt: '2026-10-23T00:00:00.000Z',
  })
  const calls = [
    createParticipantByIdGetHandler(mock.dependencies),
    createEnrollmentByIdGetHandler(mock.dependencies),
  ]
  for (const call of calls) {
    const response = await call(request('/api/admin/resource'), { id: validId })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal((await body(response)).id, validId)
  }
  assert.equal(mock.repositoryAccesses, 2)
})

test('participant deletion uses the authenticated mutation handler and generic errors', async () => {
  const mock = setup()
  let receivedId = ''
  mock.repositories.deleteParticipant = async (id) => {
    receivedId = String(id)
    return { deleted: true }
  }
  const handler = createParticipantDeleteHandler(mock.dependencies)
  const response = await handler(
    mutationRequest(`/api/admin/participants/${validId}`),
    { id: validId },
  )
  assert.equal(response.status, 200)
  assert.deepEqual(await body(response), { deleted: true })
  assert.equal(receivedId, validId)
  assert.equal(mock.csrfChecks, 1)

  mock.repositories.deleteParticipant = async () => {
    throw new RepositoryError('conflict')
  }
  const blocked = await handler(
    mutationRequest(`/api/admin/participants/${validId}`),
    { id: validId },
  )
  assert.equal(blocked.status, 409)
  assert.deepEqual(await body(blocked), { error: 'conflict' })
})

test('public participant names response is limited to validated names and cache-safe', async () => {
  const repositories = createRepositories(async () => {
    throw new Error('public-name endpoint test must not access a database')
  })
  let lookups = 0
  repositories.listPublicParticipantNames = async () => {
    lookups += 1
    return ['Amelie Ngu', 'Samuel Tabi']
  }
  const handler = createPublicParticipantNamesGetHandler(
    () => repositories,
    async () => false,
  )
  const response = await handler(request('/api/public/participant-names'))
  assert.equal(response.status, 200)
  assert.deepEqual(await body(response), {
    names: ['Amelie Ngu', 'Samuel Tabi'],
  })
  assert.equal(response.headers.get('cache-control'), 'public, max-age=60, stale-while-revalidate=120')
  assert.equal(lookups, 1)

  const malformed = await handler(
    request('/api/public/participant-names?limit=1000'),
  )
  assert.equal(malformed.status, 400)
  assert.equal(lookups, 1)
})

test('public participant names endpoint fails safely and honors rate limits', async () => {
  const repositories = createRepositories(async () => {
    throw new Error('private database details')
  })
  repositories.listPublicParticipantNames = async () => {
    throw new Error('private database details')
  }
  const failed = await createPublicParticipantNamesGetHandler(
    () => repositories,
    async () => false,
  )(request('/api/public/participant-names'))
  assert.equal(failed.status, 503)
  const failureText = await failed.clone().text()
  assert.deepEqual(await body(failed), { names: [] })
  assert.equal(failed.headers.get('cache-control'), 'no-store')
  assert.equal(failureText.includes('private'), false)

  let lookups = 0
  repositories.listPublicParticipantNames = async () => {
    lookups += 1
    return ['Participant']
  }
  const limited = await createPublicParticipantNamesGetHandler(
    () => repositories,
    async () => true,
  )(request('/api/public/participant-names'))
  assert.equal(limited.status, 429)
  assert.equal(lookups, 0)
})

test('enrollment edits accept only course details and deletion uses authenticated mutation handling', async () => {
  const mock = setup()
  let received: unknown
  mock.repositories.updateEnrollment = async (id, input) => {
    received = { id, input }
    return {
      id: validId,
      participantId: '65a12b34cd56ef7890123457',
      courseId: 'data-foundations',
      courseName: 'Data Foundations',
      status: 'in_progress',
      completedAt: null,
      createdAt: '2026-10-23T00:00:00.000Z',
      updatedAt: '2026-10-23T00:00:00.000Z',
    }
  }
  const patch = createEnrollmentPatchHandler(mock.dependencies)
  const updated = await patch(
    mutationRequest(
      `/api/admin/enrollments/${validId}`,
      JSON.stringify({
        courseId: 'data-foundations',
        courseName: 'Data Foundations',
      }),
    ),
    { id: validId },
  )
  assert.equal(updated.status, 200)
  assert.deepEqual(received, {
    id: validId,
    input: { courseId: 'data-foundations', courseName: 'Data Foundations' },
  })

  const forbiddenFields = await patch(
    mutationRequest(
      `/api/admin/enrollments/${validId}`,
      JSON.stringify({
        participantId: '65a12b34cd56ef7890123457',
        courseId: 'data-foundations',
        courseName: 'Data Foundations',
      }),
    ),
    { id: validId },
  )
  assert.equal(forbiddenFields.status, 400)

  let deletedId = ''
  mock.repositories.deleteEnrollment = async (id) => {
    deletedId = String(id)
    return { deleted: true }
  }
  const deleted = await createEnrollmentDeleteHandler(mock.dependencies)(
    mutationRequest(`/api/admin/enrollments/${validId}`),
    { id: validId },
  )
  assert.equal(deleted.status, 200)
  assert.deepEqual(await body(deleted), { deleted: true })
  assert.equal(deletedId, validId)

  const unauthorized = setup(async () => {
    throw new AuthenticationError('unauthenticated')
  })
  const unauthorizedResponse = await createParticipantPatchHandler(
    unauthorized.dependencies,
  )(
    mutationRequest(`/api/admin/participants/${validId}`, JSON.stringify({
      name: 'New name',
      email: 'new@example.test',
    })),
    { id: validId },
  )
  assert.equal(unauthorizedResponse.status, 401)
  assert.equal(unauthorized.repositoryAccesses, 0)
})

test('missing records and repository failures return generic responses', async () => {
  const mock = setup()
  mock.repositories.getParticipantById = async () => null
  const handler = createParticipantByIdGetHandler(mock.dependencies)
  const missing = await handler(request('/api/admin/participants'), {
    id: validId,
  })
  assert.equal(missing.status, 404)
  assert.deepEqual(await body(missing), { error: 'not_found' })
  assert.equal(missing.headers.get('cache-control'), 'no-store')

  mock.repositories.getParticipantById = async () => {
    throw new RepositoryError('operation_failed')
  }
  const failure = await handler(request('/api/admin/participants'), {
    id: validId,
  })
  assert.equal(failure.status, 500)
  assert.deepEqual(await body(failure), { error: 'internal_error' })
  assert.equal(failure.headers.get('cache-control'), 'no-store')
})

test('unexpected authentication and repository errors never expose details', async () => {
  const mock = setup(async () => {
    throw new Error('private authentication stack')
  })
  const authFailure = await createParticipantByIdGetHandler(mock.dependencies)(
    request('/api/admin/participants'),
    { id: validId },
  )
  assert.equal(authFailure.status, 503)
  assert.deepEqual(await body(authFailure), {
    error: 'authentication_unavailable',
  })
  assert.equal(mock.repositoryAccesses, 0)

  const repoMock = setup()
  repoMock.repositories.getParticipantById = async () => {
    throw new Error('private database stack and verification token')
  }
  const repoFailure = await createParticipantByIdGetHandler(
    repoMock.dependencies,
  )(request('/api/admin/participants'), { id: validId })
  assert.equal(repoFailure.status, 500)
  const errorBody = await repoFailure.text()
  assert.equal(errorBody.includes('private'), false)
  assert.equal(errorBody.includes('verification'), false)
  assert.equal(repoFailure.headers.get('cache-control'), 'no-store')
})

test('enrollment creation validates its body and returns a safe 201 response', async () => {
  const mock = setup()
  let receivedInput: unknown
  mock.repositories.createEnrollment = async (input) => {
    receivedInput = input
    return {
      id: validId,
      participantId: '65a12b34cd56ef7890123457',
      courseId: 'web-foundations',
      courseName: 'Web Foundations',
      status: 'in_progress',
      completedAt: null,
      createdAt: '2026-10-23T00:00:00.000Z',
      updatedAt: '2026-10-23T00:00:00.000Z',
    }
  }
  const response = await createEnrollmentPostHandler(mock.dependencies)(
    mutationRequest(
      '/api/admin/enrollments',
      JSON.stringify({
        participantId: '65a12b34cd56ef7890123457',
        courseId: ' WEB-FOUNDATIONS ',
        courseName: ' Web Foundations ',
        status: 'completed',
      }),
    ),
  )
  assert.equal(response.status, 201)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await body(response), {
    id: validId,
    participantId: '65a12b34cd56ef7890123457',
    courseId: 'web-foundations',
    courseName: 'Web Foundations',
    status: 'in_progress',
    completedAt: null,
    createdAt: '2026-10-23T00:00:00.000Z',
    updatedAt: '2026-10-23T00:00:00.000Z',
  })
  assert.equal(
    (receivedInput as { status?: string }).status,
    undefined,
    'request status is not passed through the enrollment schema',
  )
  assert.equal(
    typeof (receivedInput as { participantId: unknown }).participantId,
    'string',
    'the validated participant ID remains a string until repository parsing',
  )
  assert.equal(mock.csrfChecks, 1)
})

test('enrollment creation reports safe field-specific validation errors', async () => {
  const mock = setup()
  const handler = createEnrollmentPostHandler(mock.dependencies)
  const invalidInputs = [
    [
      JSON.stringify({
        participantId: 'invalid',
        courseId: 'web-foundations',
        courseName: 'Web Foundations',
      }),
      'invalid_participant_id',
    ],
    [
      JSON.stringify({
        participantId: '65a12b34cd56ef7890123457',
        courseId: 'bad course id',
        courseName: 'Web Foundations',
      }),
      'invalid_course_id',
    ],
    [
      JSON.stringify({
        participantId: '65a12b34cd56ef7890123457',
        courseId: 'web-foundations',
        courseName: '',
      }),
      'invalid_course_name',
    ],
  ] as const
  for (const [rawBody, error] of invalidInputs) {
    const response = await handler(
      mutationRequest('/api/admin/enrollments', rawBody),
    )
    assert.equal(response.status, 400)
    assert.deepEqual(await body(response), { error })
    assert.equal(response.headers.get('cache-control'), 'no-store')
  }
  const malformedJson = await handler(
    mutationRequest('/api/admin/enrollments', '{'),
  )
  assert.equal(malformedJson.status, 400)
  assert.deepEqual(await body(malformedJson), { error: 'invalid_request' })
  assert.equal(mock.repositoryAccesses, 0)
})

test('enrollment validation errors never expose rejected values', async () => {
  const mock = setup()
  const response = await createEnrollmentPostHandler(mock.dependencies)(
    mutationRequest(
      '/api/admin/enrollments',
      JSON.stringify({
        participantId: 'private-user-value',
        courseId: 'web-foundations',
        courseName: 'Web Foundations',
      }),
    ),
  )
  assert.equal(response.status, 400)
  const responseBody = await response.text()
  assert.equal(responseBody, JSON.stringify({ error: 'invalid_participant_id' }))
  assert.equal(responseBody.includes('private-user-value'), false)
  assert.equal(mock.repositoryAccesses, 0)
})

test('unauthenticated and non-admin mutation requests never reach CSRF or repositories', async () => {
  for (const [authError, status, error] of [
    ['unauthenticated', 401, 'unauthenticated'],
    ['forbidden', 403, 'forbidden'],
  ] as const) {
    const mock = setup(async () => {
      throw new AuthenticationError(authError)
    })
    const response = await createEnrollmentPostHandler(mock.dependencies)(
      mutationRequest(
        '/api/admin/enrollments',
        JSON.stringify({
          participantId: '65a12b34cd56ef7890123457',
          courseId: 'web-foundations',
          courseName: 'Web Foundations',
        }),
      ),
    )
    assert.equal(response.status, status)
    assert.deepEqual(await body(response), { error })
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal(mock.csrfChecks, 0)
    assert.equal(mock.repositoryAccesses, 0)
  }
})

test('CSRF-invalid origins or tokens are rejected before mutation repository access', async () => {
  const invalidRequests = [
    new Request('https://certificates.example.test/api/admin/enrollments', {
      method: 'POST',
      headers: {
        origin: 'https://certificates.example.test',
        cookie: 'tsc_csrf=test-csrf-token',
      },
    }),
    new Request('https://certificates.example.test/api/admin/enrollments', {
      method: 'POST',
      headers: {
        origin: 'https://certificates.example.test',
        'x-csrf-token': 'test-csrf-token',
      },
    }),
    mutationRequest('/api/admin/enrollments', undefined, {
      'x-csrf-token': '',
    }),
    mutationRequest('/api/admin/enrollments', undefined, {
      origin: 'https://attacker.example.test',
    }),
    mutationRequest('/api/admin/enrollments', undefined, {
      origin: '',
    }),
    mutationRequest('/api/admin/enrollments', undefined, {
      origin: 'not-an-origin',
    }),
    mutationRequest('/api/admin/enrollments', undefined, {
      'x-csrf-token': 'wrong-token',
    }),
    mutationRequest('/api/admin/enrollments', undefined, {
      cookie: 'tsc_csrf=wrong-token',
    }),
  ]
  for (const invalidRequest of invalidRequests) {
    const mock = setup()
    let mutations = 0
    mock.repositories.createEnrollment = async () => {
      mutations += 1
      throw new Error('should not run')
    }
    const response = await createEnrollmentPostHandler(mock.dependencies)(
      invalidRequest,
    )
    assert.equal(response.status, 403)
    assert.deepEqual(await body(response), { error: 'csrf_failed' })
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal(mock.csrfChecks, 1)
    assert.equal(mock.repositoryAccesses, 0)
    assert.equal(mutations, 0)
  }
})

test('completion and withdrawal invoke only their lifecycle repository operations', async () => {
  const mock = setup()
  const completed = {
    id: validId,
    participantId: '65a12b34cd56ef7890123457',
    courseId: 'web-foundations',
    courseName: 'Web Foundations',
    status: 'completed' as const,
    completedAt: '2026-10-23T00:00:00.000Z',
    createdAt: '2026-10-23T00:00:00.000Z',
    updatedAt: '2026-10-23T00:00:00.000Z',
  }
  const withdrawn = {
    ...completed,
    status: 'withdrawn' as const,
    completedAt: null,
  }
  const receivedIds: unknown[] = []
  mock.repositories.completeEnrollment = async (id) => {
    receivedIds.push(id)
    return completed
  }
  mock.repositories.withdrawEnrollment = async (id) => {
    receivedIds.push(id)
    return withdrawn
  }
  for (const [handler, expectedStatus] of [
    [createEnrollmentCompletePostHandler(mock.dependencies), 'completed'],
    [createEnrollmentWithdrawPostHandler(mock.dependencies), 'withdrawn'],
  ] as const) {
    const response = await handler(
      mutationRequest('/api/admin/enrollments'),
      { id: validId },
    )
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal((await body(response)).status, expectedStatus)
  }
  assert.deepEqual(receivedIds, [validId, validId])
})

test('invalid enrollment IDs, missing records, invalid transitions, and repository failures are safe', async () => {
  const mock = setup()
  const handler = createEnrollmentCompletePostHandler(mock.dependencies)
  const invalidId = await handler(
    mutationRequest('/api/admin/enrollments/not-an-id/complete'),
    { id: 'not-an-id' },
  )
  assert.equal(invalidId.status, 400)
  assert.deepEqual(await body(invalidId), { error: 'invalid_request' })
  assert.equal(invalidId.headers.get('cache-control'), 'no-store')
  assert.equal(mock.repositoryAccesses, 0)

  mock.repositories.completeEnrollment = async () => {
    throw new RepositoryError('not_found')
  }
  const missing = await handler(
    mutationRequest('/api/admin/enrollments/missing/complete'),
    { id: validId },
  )
  assert.equal(missing.status, 404)
  assert.deepEqual(await body(missing), { error: 'not_found' })
  assert.equal(missing.headers.get('cache-control'), 'no-store')

  mock.repositories.completeEnrollment = async () => {
    throw new RepositoryError('conflict')
  }
  const conflict = await handler(
    mutationRequest('/api/admin/enrollments/complete/complete'),
    { id: validId },
  )
  assert.equal(conflict.status, 409)
  assert.deepEqual(await body(conflict), { error: 'conflict' })
  assert.equal(conflict.headers.get('cache-control'), 'no-store')

  mock.repositories.withdrawEnrollment = async () => {
    throw new Error('private database details')
  }
  const failure = await createEnrollmentWithdrawPostHandler(mock.dependencies)(
    mutationRequest('/api/admin/enrollments/withdraw/withdraw'),
    { id: validId },
  )
  assert.equal(failure.status, 500)
  assert.deepEqual(await body(failure), { error: 'internal_error' })
  assert.equal(failure.headers.get('cache-control'), 'no-store')
})

test('certificate issuance uploads the participant-specific PDF and returns only safe certificate fields', async () => {
  const mock = setup()
  const storage = fakeFileStorage()
  let receivedInput: unknown
  mock.repositories.createCertificate = async (input) => {
    receivedInput = input
    return {
      id: '65a12b34cd56ef7890123458',
      certificateId: 'CERT-12345',
      enrollmentId: validId,
      issueDate: '2026-10-23T00:00:00.000Z',
      status: 'issued',
      revokedAt: null,
      supersedesCertificateId: null,
      createdAt: '2026-10-23T00:00:00.000Z',
      updatedAt: '2026-10-23T00:00:00.000Z',
    }
  }
  const response = await createEnrollmentCertificatePostHandler(
    mock.dependencies,
    storage,
  )(
    certificateUploadRequest(
      `/api/admin/enrollments/${validId}/certificate`,
    ),
    { id: validId },
  )
  assert.equal(response.status, 201)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const serialized = await body(response)
  assert.deepEqual(serialized, {
    id: '65a12b34cd56ef7890123458',
    certificateId: 'CERT-12345',
    enrollmentId: validId,
    issueDate: '2026-10-23T00:00:00.000Z',
    status: 'issued',
    revokedAt: null,
    supersedesCertificateId: null,
    createdAt: '2026-10-23T00:00:00.000Z',
    updatedAt: '2026-10-23T00:00:00.000Z',
    fileAvailable: true,
  })
  assert.equal('verificationIdentifier' in serialized, false)
  assert.equal(
    (receivedInput as { enrollmentId: string }).enrollmentId,
    validId,
  )
  assert.equal('templateId' in (receivedInput as Record<string, unknown>), false)
  assert.ok((receivedInput as { issueDate: Date }).issueDate instanceof Date)
})

test('certificate issuance supports an existing PDF without a template reference', async () => {
  const mock = setup()
  const storage = fakeFileStorage()
  let receivedInput: unknown
  mock.repositories.createCertificate = async (input) => {
    receivedInput = input
    return {
      id: '65a12b34cd56ef7890123458',
      certificateId: 'CERT-12345',
      enrollmentId: validId,
      issueDate: '2026-10-23T00:00:00.000Z',
      status: 'issued',
      revokedAt: null,
      supersedesCertificateId: null,
      createdAt: '2026-10-23T00:00:00.000Z',
      updatedAt: '2026-10-23T00:00:00.000Z',
    }
  }
  const response = await createEnrollmentCertificatePostHandler(
    mock.dependencies,
    storage,
  )(
    certificateUploadRequest(
      `/api/admin/enrollments/${validId}/certificate`,
      { issuanceMethod: 'upload_existing' },
    ),
    { id: validId },
  )

  assert.equal(response.status, 201)
  const serialized = await body(response)
  assert.ok(receivedInput && typeof receivedInput === 'object')
  assert.equal('templateId' in serialized, false)
  assert.equal('verificationIdentifier' in serialized, false)
  assert.equal(
    (receivedInput as Record<string, unknown>).enrollmentId,
    validId,
  )
  assert.equal('templateId' in (receivedInput as Record<string, unknown>), false)
  assert.equal(storage.removed, 0)
})

test('certificate issuance rejects invalid IDs, malformed bodies, and untrusted fields before repository access', async () => {
  const mock = setup()
  const handler = createEnrollmentCertificatePostHandler(mock.dependencies)
  const cases: Array<{ id: string; body: string }> = [
    { id: 'not-an-id', body: JSON.stringify({ templateId: validId }) },
    { id: validId, body: '{' },
    { id: validId, body: JSON.stringify({ templateId: 'invalid' }) },
    {
      id: validId,
      body: JSON.stringify({
        templateId: validId,
        verificationIdentifier: 'caller-controlled',
      }),
    },
  ]
  for (const item of cases) {
    const response = await handler(
      mutationRequest(
        `/api/admin/enrollments/${item.id}/certificate`,
        item.body,
      ),
      { id: item.id },
    )
    assert.equal(response.status, 400)
    assert.deepEqual(await body(response), { error: 'invalid_request' })
    assert.equal(response.headers.get('cache-control'), 'no-store')
  }
  assert.equal(mock.repositoryAccesses, 0)

  const invalidMethods = [
    { issuanceMethod: 'not-supported', templateId: validId },
    { issuanceMethod: 'upload_with_template', templateId: '' },
    { issuanceMethod: 'upload_existing', templateId: validId },
  ]
  for (const fields of invalidMethods) {
    const response = await handler(
      certificateUploadRequest(
        `/api/admin/enrollments/${validId}/certificate`,
        fields,
      ),
      { id: validId },
    )
    assert.equal(response.status, 400)
    assert.deepEqual(await body(response), { error: 'invalid_request' })
  }
  assert.equal(mock.repositoryAccesses, 0)
})

test('unauthorized and CSRF-invalid certificate requests never call issuance', async () => {
  for (const [authenticate, expectedStatus, expectedError] of [
    [
      async () => {
        throw new AuthenticationError('unauthenticated')
      },
      401,
      'unauthenticated',
    ],
    [
      async () => {
        throw new AuthenticationError('forbidden')
      },
      403,
      'forbidden',
    ],
    [
      async () => {},
      403,
      'csrf_failed',
    ],
  ] as const) {
    const mock = setup(
      authenticate,
      expectedError === 'csrf_failed'
        ? () => {
            throw new AuthenticationError('csrf_failed')
          }
        : undefined,
    )
    let issuanceCalls = 0
    mock.repositories.createCertificate = async () => {
      issuanceCalls += 1
      throw new Error('must not be called')
    }
    const response = await createEnrollmentCertificatePostHandler(
      mock.dependencies,
    )(
      mutationRequest(
        `/api/admin/enrollments/${validId}/certificate`,
        JSON.stringify({ templateId: validId }),
      ),
      { id: validId },
    )
    assert.equal(response.status, expectedStatus)
    assert.deepEqual(await body(response), { error: expectedError })
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal(issuanceCalls, 0)
    assert.equal(mock.repositoryAccesses, 0)
  }
})

test('ineligible enrollments and missing records or templates return safe lifecycle errors', async () => {
  const mock = setup()
  const handler = createEnrollmentCertificatePostHandler(
    mock.dependencies,
    fakeFileStorage(),
  )
  for (const code of ['conflict', 'not_found'] as const) {
    mock.repositories.createCertificate = async () => {
      throw new RepositoryError(code)
    }
    const response = await handler(
      certificateUploadRequest(`/api/admin/enrollments/${validId}/certificate`),
      { id: validId },
    )
    assert.equal(response.status, code === 'not_found' ? 404 : 409)
    assert.deepEqual(await body(response), {
      error: code === 'not_found' ? 'not_found' : 'conflict',
    })
    assert.equal(response.headers.get('cache-control'), 'no-store')
  }
})

test('repeated certificate issuance returns conflict instead of replacing an existing certificate', async () => {
  const mock = setup()
  const storage = fakeFileStorage()
  let issuanceCalls = 0
  mock.repositories.createCertificate = async () => {
    issuanceCalls += 1
    if (issuanceCalls > 1) {
      throw new RepositoryError('conflict')
    }
    return {
      id: '65a12b34cd56ef7890123458',
      certificateId: 'CERT-12345',
      enrollmentId: validId,
      templateId: '65a12b34cd56ef7890123457',
      issueDate: '2026-10-23T00:00:00.000Z',
      status: 'issued',
      revokedAt: null,
      supersedesCertificateId: null,
      createdAt: '2026-10-23T00:00:00.000Z',
      updatedAt: '2026-10-23T00:00:00.000Z',
    }
  }
  const handler = createEnrollmentCertificatePostHandler(
    mock.dependencies,
    storage,
  )
  const issue = () =>
    handler(
      certificateUploadRequest(`/api/admin/enrollments/${validId}/certificate`),
      { id: validId },
    )
  assert.equal((await issue()).status, 201)
  const repeated = await issue()
  assert.equal(repeated.status, 409)
  assert.deepEqual(await body(repeated), { error: 'conflict' })
  assert.equal(repeated.headers.get('cache-control'), 'no-store')
  assert.equal(issuanceCalls, 2)
})

test('certificate repository failures return generic no-store responses', async () => {
  const mock = setup()
  const storage = fakeFileStorage()
  mock.repositories.createCertificate = async () => {
    throw new Error('private database error and verification token')
  }
  const response = await createEnrollmentCertificatePostHandler(
    mock.dependencies,
    storage,
  )(
    certificateUploadRequest(`/api/admin/enrollments/${validId}/certificate`),
    { id: validId },
  )
  assert.equal(response.status, 500)
  assert.deepEqual(await body(response), { error: 'internal_error' })
  assert.equal(response.headers.get('cache-control'), 'no-store')
})

test('certificate upload rejects invalid file content before issuing a record', async () => {
  const mock = setup()
  let issuanceCalls = 0
  mock.repositories.createCertificate = async () => {
    issuanceCalls += 1
    throw new Error('must not issue an invalid PDF')
  }
  const invalidStorage = {
    async storePdf() {
      throw new CertificateFileError('invalid_file')
    },
    async remove() {},
    async stream() {
      const { Readable } = await import('node:stream')
      return Readable.from([])
    },
  }
  const response = await createEnrollmentCertificatePostHandler(
    mock.dependencies,
    invalidStorage,
  )(
    certificateUploadRequest(`/api/admin/enrollments/${validId}/certificate`),
    { id: validId },
  )
  assert.equal(response.status, 400)
  assert.deepEqual(await body(response), { error: 'invalid_request' })
  assert.equal(issuanceCalls, 0)
  assert.equal(mock.repositoryAccesses, 1)
})

test('certificate revocation uses the path certificate ID and returns the safe serialized result', async () => {
  const mock = setup()
  let receivedCertificateId: unknown
  let receivedReason: unknown
  mock.repositories.revokeCertificate = async (certificateId, reason) => {
    receivedCertificateId = certificateId
    receivedReason = reason
    return {
      id: '65a12b34cd56ef7890123458',
      certificateId: 'CERT-12345',
      enrollmentId: validId,
      templateId: '65a12b34cd56ef7890123457',
      issueDate: '2026-10-23T00:00:00.000Z',
      status: 'revoked',
      revokedAt: '2026-10-23T00:01:00.000Z',
      supersedesCertificateId: null,
      createdAt: '2026-10-23T00:00:00.000Z',
      updatedAt: '2026-10-23T00:01:00.000Z',
    }
  }
  const response = await createCertificateRevokePostHandler(mock.dependencies)(
    mutationRequest(
      '/api/admin/certificates/CERT-12345/revoke',
      JSON.stringify({ reason: ' Administrative correction ' }),
    ),
    { id: 'cert-12345' },
  )
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await body(response), {
    id: '65a12b34cd56ef7890123458',
    certificateId: 'CERT-12345',
    enrollmentId: validId,
    templateId: '65a12b34cd56ef7890123457',
    issueDate: '2026-10-23T00:00:00.000Z',
    status: 'revoked',
    revokedAt: '2026-10-23T00:01:00.000Z',
    supersedesCertificateId: null,
    createdAt: '2026-10-23T00:00:00.000Z',
    updatedAt: '2026-10-23T00:01:00.000Z',
  })
  assert.equal(receivedCertificateId, 'CERT-12345')
  assert.equal(receivedReason, 'Administrative correction')
})

test('certificate revocation rejects invalid IDs and malformed or extra request fields', async () => {
  const mock = setup()
  const handler = createCertificateRevokePostHandler(mock.dependencies)
  for (const [id, rawBody] of [
    ['CERT-12345', '{'],
    ['bad id', JSON.stringify({ reason: 'Valid reason' })],
    ['CERT-12345', JSON.stringify({ reason: '' })],
    [
      'CERT-12345',
      JSON.stringify({
        reason: 'Valid reason',
        verificationIdentifier: 'untrusted',
      }),
    ],
  ]) {
    const response = await handler(
      mutationRequest(
        `/api/admin/certificates/${id}/revoke`,
        rawBody,
      ),
      { id },
    )
    assert.equal(response.status, 400)
    assert.deepEqual(await body(response), { error: 'invalid_request' })
    assert.equal(response.headers.get('cache-control'), 'no-store')
  }
  assert.equal(mock.repositoryAccesses, 0)
})

test('unauthorized, non-admin, and CSRF-invalid revocation requests never invoke the repository', async () => {
  const cases = [
    {
      authenticate: async () => {
        throw new AuthenticationError('unauthenticated')
      },
      verifyCsrf: undefined,
      status: 401,
      error: 'unauthenticated',
    },
    {
      authenticate: async () => {
        throw new AuthenticationError('forbidden')
      },
      verifyCsrf: undefined,
      status: 403,
      error: 'forbidden',
    },
    {
      authenticate: async () => {},
      verifyCsrf: () => {
        throw new AuthenticationError('csrf_failed')
      },
      status: 403,
      error: 'csrf_failed',
    },
  ] as const
  for (const item of cases) {
    const mock = setup(item.authenticate, item.verifyCsrf)
    let revokeCalls = 0
    mock.repositories.revokeCertificate = async () => {
      revokeCalls += 1
      throw new Error('must not be called')
    }
    const response = await createCertificateRevokePostHandler(
      mock.dependencies,
    )(
      mutationRequest(
        '/api/admin/certificates/CERT-12345/revoke',
        JSON.stringify({ reason: 'Administrative correction' }),
      ),
      { id: 'CERT-12345' },
    )
    assert.equal(response.status, item.status)
    assert.deepEqual(await body(response), { error: item.error })
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal(revokeCalls, 0)
    assert.equal(mock.repositoryAccesses, 0)
  }
})

test('revocation rejects missing or mismatched CSRF tokens and origins before repository access', async () => {
  const invalidRequests = [
    new Request('https://certificates.example.test/api/admin/certificates/CERT-12345/revoke', {
      method: 'POST',
      headers: {
        origin: 'https://certificates.example.test',
        cookie: 'tsc_csrf=test-csrf-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ reason: 'Administrative correction' }),
    }),
    mutationRequest(
      '/api/admin/certificates/CERT-12345/revoke',
      JSON.stringify({ reason: 'Administrative correction' }),
      { 'x-csrf-token': 'wrong-token' },
    ),
    mutationRequest(
      '/api/admin/certificates/CERT-12345/revoke',
      JSON.stringify({ reason: 'Administrative correction' }),
      { cookie: 'tsc_csrf=wrong-token' },
    ),
    mutationRequest(
      '/api/admin/certificates/CERT-12345/revoke',
      JSON.stringify({ reason: 'Administrative correction' }),
      { origin: 'https://attacker.example.test' },
    ),
  ]
  for (const invalidRequest of invalidRequests) {
    const mock = setup()
    let revokeCalls = 0
    mock.repositories.revokeCertificate = async () => {
      revokeCalls += 1
      throw new Error('must not be called')
    }
    const response = await createCertificateRevokePostHandler(
      mock.dependencies,
    )(invalidRequest, { id: 'CERT-12345' })
    assert.equal(response.status, 403)
    assert.deepEqual(await body(response), { error: 'csrf_failed' })
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal(revokeCalls, 0)
    assert.equal(mock.repositoryAccesses, 0)
  }
})

test('missing certificates and lifecycle conflicts map to safe revocation responses', async () => {
  const mock = setup()
  const handler = createCertificateRevokePostHandler(mock.dependencies)
  for (const [code, expectedStatus, expectedBody] of [
    ['not_found', 404, { error: 'not_found' }],
    ['conflict', 409, { error: 'conflict' }],
  ] as const) {
    mock.repositories.revokeCertificate = async () => {
      throw new RepositoryError(code)
    }
    const response = await handler(
      mutationRequest(
        '/api/admin/certificates/CERT-12345/revoke',
        JSON.stringify({ reason: 'Administrative correction' }),
      ),
      { id: 'CERT-12345' },
    )
    assert.equal(response.status, expectedStatus)
    assert.deepEqual(await body(response), expectedBody)
    assert.equal(response.headers.get('cache-control'), 'no-store')
  }
})

test('revocation repository failures never expose database details', async () => {
  const mock = setup()
  mock.repositories.revokeCertificate = async () => {
    throw new Error('private database error and verification token')
  }
  const response = await createCertificateRevokePostHandler(mock.dependencies)(
    mutationRequest(
      '/api/admin/certificates/CERT-12345/revoke',
      JSON.stringify({ reason: 'Administrative correction' }),
    ),
    { id: 'CERT-12345' },
  )
  assert.equal(response.status, 500)
  assert.deepEqual(await body(response), { error: 'internal_error' })
  assert.equal(response.headers.get('cache-control'), 'no-store')
})

test('certificate reissue creates and resumes the durable workflow, returning only serialized workflow state', async () => {
  const mock = setup()
  const calls: unknown[][] = []
  mock.repositories.requestCertificateReissue = async (
    certificateId,
    idempotencyKey,
  ) => {
    calls.push(['request', certificateId, idempotencyKey])
    return { state: 'requested' }
  }
  mock.repositories.resumeCertificateReissue = async (idempotencyKey) => {
    calls.push(['resume', idempotencyKey])
    return { state: 'completed' }
  }
  const response = await createCertificateReissuePostHandler(
    mock.dependencies,
  )(
    mutationRequest(
      '/api/admin/certificates/CERT-12345/reissue',
      JSON.stringify({ idempotencyKey: 'reissue-request-key-01' }),
    ),
    { id: 'cert-12345' },
  )
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const result = await body(response)
  assert.deepEqual(result, { state: 'completed' })
  assert.deepEqual(calls, [
    ['request', 'CERT-12345', 'reissue-request-key-01'],
    ['resume', 'reissue-request-key-01'],
  ])
  for (const forbiddenField of [
    'idempotencyKey',
    'workflowId',
    'replacementDocumentId',
    'replacementVerificationIdentifier',
    'verificationIdentifier',
    'activeEnrollmentId',
  ]) {
    assert.equal(forbiddenField in result, false)
  }
})

test('reissue validates certificate IDs, idempotency input, and strict request body', async () => {
  const mock = setup()
  const handler = createCertificateReissuePostHandler(mock.dependencies)
  const cases = [
    ['bad id', JSON.stringify({ idempotencyKey: 'reissue-request-key-01' })],
    ['CERT-12345', '{'],
    ['CERT-12345', JSON.stringify({ idempotencyKey: 'short' })],
    [
      'CERT-12345',
      JSON.stringify({
        idempotencyKey: 'reissue-request-key-01',
        replacementVerificationIdentifier: 'untrusted',
      }),
    ],
  ]
  for (const [id, rawBody] of cases) {
    const response = await handler(
      mutationRequest(
        `/api/admin/certificates/${id}/reissue`,
        rawBody,
      ),
      { id },
    )
    assert.equal(response.status, 400)
    assert.deepEqual(await body(response), { error: 'invalid_request' })
    assert.equal(response.headers.get('cache-control'), 'no-store')
  }
  assert.equal(mock.repositoryAccesses, 0)
})

test('unauthorized, non-admin, and CSRF-invalid reissue requests never call workflow operations', async () => {
  const cases = [
    {
      authenticate: async () => {
        throw new AuthenticationError('unauthenticated')
      },
      verifyCsrf: undefined,
      status: 401,
      error: 'unauthenticated',
    },
    {
      authenticate: async () => {
        throw new AuthenticationError('forbidden')
      },
      verifyCsrf: undefined,
      status: 403,
      error: 'forbidden',
    },
    {
      authenticate: async () => {},
      verifyCsrf: () => {
        throw new AuthenticationError('csrf_failed')
      },
      status: 403,
      error: 'csrf_failed',
    },
  ] as const
  for (const item of cases) {
    const mock = setup(item.authenticate, item.verifyCsrf)
    let workflowCalls = 0
    mock.repositories.requestCertificateReissue = async () => {
      workflowCalls += 1
      throw new Error('must not be called')
    }
    mock.repositories.resumeCertificateReissue = async () => {
      workflowCalls += 1
      throw new Error('must not be called')
    }
    const response = await createCertificateReissuePostHandler(
      mock.dependencies,
    )(
      mutationRequest(
        '/api/admin/certificates/CERT-12345/reissue',
        JSON.stringify({ idempotencyKey: 'reissue-request-key-01' }),
      ),
      { id: 'CERT-12345' },
    )
    assert.equal(response.status, item.status)
    assert.deepEqual(await body(response), { error: item.error })
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal(workflowCalls, 0)
    assert.equal(mock.repositoryAccesses, 0)
  }
})

test('repeated reissue requests use the same idempotency key and safely resume workflow', async () => {
  const mock = setup()
  const requestedKeys: unknown[] = []
  const resumedKeys: unknown[] = []
  mock.repositories.requestCertificateReissue = async (
    _certificateId,
    idempotencyKey,
  ) => {
    requestedKeys.push(idempotencyKey)
    return { state: 'requested' }
  }
  mock.repositories.resumeCertificateReissue = async (idempotencyKey) => {
    resumedKeys.push(idempotencyKey)
    return { state: 'completed' }
  }
  const handler = createCertificateReissuePostHandler(mock.dependencies)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await handler(
      mutationRequest(
        '/api/admin/certificates/CERT-12345/reissue',
        JSON.stringify({ idempotencyKey: 'retryable-reissue-key-01' }),
      ),
      { id: 'CERT-12345' },
    )
    assert.equal(response.status, 200)
    assert.deepEqual(await body(response), { state: 'completed' })
    assert.equal(response.headers.get('cache-control'), 'no-store')
  }
  assert.deepEqual(requestedKeys, [
    'retryable-reissue-key-01',
    'retryable-reissue-key-01',
  ])
  assert.deepEqual(resumedKeys, [
    'retryable-reissue-key-01',
    'retryable-reissue-key-01',
  ])
})

test('missing reissue certificates, lifecycle conflicts, and repository failures are generic', async () => {
  const mock = setup()
  const handler = createCertificateReissuePostHandler(mock.dependencies)
  for (const code of ['not_found', 'conflict'] as const) {
    mock.repositories.requestCertificateReissue = async () => {
      throw new RepositoryError(code)
    }
    const response = await handler(
      mutationRequest(
        '/api/admin/certificates/CERT-12345/reissue',
        JSON.stringify({ idempotencyKey: 'reissue-request-key-01' }),
      ),
      { id: 'CERT-12345' },
    )
    assert.equal(response.status, code === 'not_found' ? 404 : 409)
    assert.deepEqual(await body(response), {
      error: code === 'not_found' ? 'not_found' : 'conflict',
    })
    assert.equal(response.headers.get('cache-control'), 'no-store')
  }

  mock.repositories.requestCertificateReissue = async () => ({
    state: 'requested',
  })
  mock.repositories.resumeCertificateReissue = async () => {
    throw new Error('private MongoDB details and workflow secrets')
  }
  const failure = await handler(
    mutationRequest(
      '/api/admin/certificates/CERT-12345/reissue',
      JSON.stringify({ idempotencyKey: 'reissue-request-key-01' }),
    ),
    { id: 'CERT-12345' },
  )
  assert.equal(failure.status, 500)
  assert.deepEqual(await body(failure), { error: 'internal_error' })
  assert.equal(failure.headers.get('cache-control'), 'no-store')
})

test('replacement uploads use the idempotent reissue workflow and attach the stored PDF', async () => {
  const mock = setup()
  const storage = fakeFileStorage()
  let requestedId = ''
  let attachedFileId: ObjectId | null = null
  mock.repositories.requestCertificateReissue = async (id, key) => {
    requestedId = `${String(id)}:${String(key)}`
    return { state: 'requested' }
  }
  mock.repositories.resumeCertificateReissue = async () => ({
    state: 'completed',
  })
  mock.repositories.getCertificateReissueReplacement = async () => ({
    id: validId,
    certificateId: 'TS-REPLACEMENT',
    enrollmentId: validId,
    templateId: validId,
    issueDate: '2026-10-23T00:00:00.000Z',
    status: 'issued',
    revokedAt: null,
    supersedesCertificateId: 'TS-ORIGINAL',
    createdAt: '2026-10-23T00:00:00.000Z',
    updatedAt: '2026-10-23T00:00:00.000Z',
    fileAvailable: false,
  })
  mock.repositories.attachReplacementCertificateFile = async (
    certificateId,
    fileId,
  ) => {
    assert.equal(certificateId, 'TS-REPLACEMENT')
    assert.ok(typeof fileId === 'string')
    assert.ok(ObjectId.isValid(fileId))
    attachedFileId = new ObjectId(fileId)
    return {
      id: validId,
      certificateId: 'TS-REPLACEMENT',
      enrollmentId: validId,
      templateId: validId,
      issueDate: '2026-10-23T00:00:00.000Z',
      status: 'issued',
      revokedAt: null,
      supersedesCertificateId: 'TS-ORIGINAL',
      createdAt: '2026-10-23T00:00:00.000Z',
      updatedAt: '2026-10-23T00:00:00.000Z',
    }
  }

  const form = new FormData()
  form.set('idempotencyKey', 'replace-reissue-key-01')
  form.set('file', new File(['%PDF-1.7\nsample'], 'replacement.pdf', { type: 'application/pdf' }))
  const response = await createCertificateReplacePostHandler(
    mock.dependencies,
    storage,
  )(
    new Request(
      `https://certificates.example.test/api/admin/certificates/TS-ORIGINAL/replace`,
      {
        method: 'POST',
        body: form,
        headers: {
          origin: 'https://certificates.example.test',
          cookie: 'tsc_csrf=test-csrf-token',
          'x-csrf-token': 'test-csrf-token',
          'content-length': '1000',
        },
      },
    ),
    { id: 'TS-ORIGINAL' },
  )
  assert.equal(response.status, 200)
  assert.equal(requestedId, 'TS-ORIGINAL:replace-reissue-key-01')
  assert.ok(attachedFileId)
  assert.deepEqual(await body(response), {
    id: validId,
    certificateId: 'TS-REPLACEMENT',
    enrollmentId: validId,
    templateId: validId,
    issueDate: '2026-10-23T00:00:00.000Z',
    status: 'issued',
    revokedAt: null,
    supersedesCertificateId: 'TS-ORIGINAL',
    createdAt: '2026-10-23T00:00:00.000Z',
    updatedAt: '2026-10-23T00:00:00.000Z',
    fileAvailable: true,
  })
})

test('public verification returns only allowlisted fields for an issued certificate without auth or CSRF', async () => {
  let repositoryCalls = 0
  const repositories = createRepositories(async () => {
    throw new Error('test must not access a database')
  })
  repositories.getCertificateByVerificationIdentifier = async () => {
    repositoryCalls += 1
    return {
      id: validId,
      certificateId: 'CERT-12345',
      enrollmentId: '65a12b34cd56ef7890123457',
      templateId: '65a12b34cd56ef7890123458',
      issueDate: '2026-10-23T00:00:00.000Z',
      status: 'issued',
      revokedAt: null,
      supersedesCertificateId: null,
      createdAt: '2026-10-23T00:00:00.000Z',
      updatedAt: '2026-10-23T00:00:00.000Z',
    }
  }
  repositories.getPublicCertificateFile = async () => null
  const handler = createPublicCertificateVerificationGetHandler(
    () => repositories,
    async () => false,
  )
  const response = await handler(
    request(`/api/verify/${'A'.repeat(43)}`),
    { token: 'A'.repeat(43) },
  )
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const result = await body(response)
  assert.deepEqual(result, {
    valid: true,
    certificateId: 'CERT-12345',
    issueDate: '2026-10-23T00:00:00.000Z',
  })
  for (const hiddenField of [
    'id',
    'enrollmentId',
    'templateId',
    'verificationIdentifier',
    'revocationReason',
    'supersedesCertificateId',
    'reissueWorkflowId',
    'workflowId',
    'email',
  ]) {
    assert.equal(hiddenField in result, false)
  }
  assert.equal(repositoryCalls, 1)
})

test('public name search returns a minimal list of issued certificate results', async () => {
  const repositories = createRepositories(async () => {
    throw new Error('test must not access a database')
  })
  let receivedQuery = ''
  repositories.searchPublicCertificates = async (query) => {
    receivedQuery = String(query)
    return [{
      certificateId: 'TS-ABC123',
      participantName: 'Amelie Ngu',
      courseName: 'Web Foundations',
      status: 'issued',
      issueDate: '2026-10-23T00:00:00.000Z',
      downloadUrl: `/api/verify/${'A'.repeat(43)}/file`,
    }]
  }
  const handler = createPublicCertificateSearchGetHandler(
    () => repositories,
    async () => false,
  )
  const response = await handler(
    request('/api/certificates/search?q=Amelie'),
  )
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(receivedQuery, 'Amelie')
  assert.deepEqual(await body(response), {
    results: [{
      certificateId: 'TS-ABC123',
      participantName: 'Amelie Ngu',
      courseName: 'Web Foundations',
      status: 'issued',
      issueDate: '2026-10-23T00:00:00.000Z',
      downloadUrl: `/api/verify/${'A'.repeat(43)}/file`,
    }],
  })

  const invalid = await handler(
    request('/api/certificates/search?q=Amelie&q=Other'),
  )
  assert.equal(invalid.status, 400)
  assert.deepEqual(await body(invalid), { results: [] })
})

test('public certificate search continues when the optional limiter is unavailable', async () => {
  const repositories = createRepositories(async () => {
    throw new Error('test must not access a database')
  })
  let receivedQuery = ''
  repositories.searchPublicCertificates = async (query) => {
    receivedQuery = String(query)
    return []
  }
  const response = await createPublicCertificateSearchGetHandler(
    () => repositories,
    async () => {
      throw new Error('private rate-limit service configuration')
    },
  )(request('/api/certificates/search?q=Amelie'))

  assert.equal(response.status, 200)
  assert.deepEqual(await body(response), { results: [] })
  assert.equal(receivedQuery, 'Amelie')
  assert.equal(response.headers.get('cache-control'), 'no-store')
})

test('public certificate search reports database failures without private details', async () => {
  const repositories = createRepositories(async () => {
    throw new Error('test must not access a database')
  })
  repositories.searchPublicCertificates = async () => {
    throw new Error('private database credentials and stack trace')
  }
  const response = await createPublicCertificateSearchGetHandler(
    () => repositories,
    async () => false,
  )(request('/api/certificates/search?q=Amelie'))
  assert.equal(response.status, 503)
  const responseBody = await response.text()
  assert.equal(responseBody, JSON.stringify({ results: [] }))
  assert.equal(responseBody.includes('private'), false)
  assert.equal(response.headers.get('cache-control'), 'no-store')
})

test('public download streams only a currently issued certificate file', async () => {
  const repositories = createRepositories(async () => {
    throw new Error('test must not access a database')
  })
  const storage = fakeFileStorage()
  let readCalls = 0
  repositories.getPublicCertificateFile = async () => {
    readCalls += 1
    return { fileId: new ObjectId(), certificateId: 'TS-ABC123' }
  }
  const handler = createPublicCertificateFileGetHandler(
    () => repositories,
    async () => false,
    storage,
  )
  const response = await handler(
    request(`/api/verify/${'A'.repeat(43)}/file`),
    { token: 'A'.repeat(43) },
  )
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'application/pdf')
  assert.match(response.headers.get('content-disposition') ?? '', /attachment/)
  assert.equal(
    Buffer.from(await response.arrayBuffer()).toString(),
    '%PDF-1.7',
  )
  const viewResponse = await handler(
    request(`/api/verify/${'A'.repeat(43)}/file?inline=1`),
    { token: 'A'.repeat(43) },
  )
  assert.equal(viewResponse.status, 200)
  assert.match(viewResponse.headers.get('content-disposition') ?? '', /^inline;/)
  assert.equal(
    Buffer.from(await viewResponse.arrayBuffer()).toString(),
    '%PDF-1.7',
  )

  repositories.getPublicCertificateFile = async () => null
  const revokedOrMissing = await handler(
    request(`/api/verify/${'B'.repeat(43)}/file`),
    { token: 'B'.repeat(43) },
  )
  assert.equal(revokedOrMissing.status, 404)
  assert.equal(readCalls, 2)

  const missingStoredFileHandler = createPublicCertificateFileGetHandler(
    () => repositories,
    async () => false,
    {
      ...storage,
      async stream() {
        throw new CertificateFileError('not_found')
      },
    },
  )
  repositories.getPublicCertificateFile = async () => ({
    fileId: new ObjectId(),
    certificateId: 'TS-MISSING-FILE',
  })
  const missingStoredFile = await missingStoredFileHandler(
    request(`/api/verify/${'C'.repeat(43)}/file`),
    { token: 'C'.repeat(43) },
  )
  assert.equal(missingStoredFile.status, 404)
  assert.deepEqual(await body(missingStoredFile), { error: 'not_found' })
})

test('public certificate download continues when the optional limiter is unavailable', async () => {
  const repositories = createRepositories(async () => {
    throw new Error('test must not access a database')
  })
  const storage = fakeFileStorage()
  repositories.getPublicCertificateFile = async () => ({
    fileId: new ObjectId(),
    certificateId: 'TS-ABC123',
  })
  const response = await createPublicCertificateFileGetHandler(
    () => repositories,
    async () => {
      throw new Error('private rate-limit service configuration')
    },
    storage,
  )(request(`/api/verify/${'A'.repeat(43)}/file`), {
    token: 'A'.repeat(43),
  })
  assert.equal(response.status, 200)
  assert.equal(
    Buffer.from(await response.arrayBuffer()).toString(),
    '%PDF-1.7',
  )
})

test('admin file download is authorized and does not open storage for denied requests', async () => {
  const storage = fakeFileStorage()
  let storageCalls = 0
  const fileStorage = {
    ...storage,
    async stream() {
      storageCalls += 1
      return storage.stream()
    },
  }
  const mock = setup()
  mock.repositories.getCertificateFileById = async () => ({
    fileId: new ObjectId(),
    certificateId: 'TS-ABC123',
  })
  const handler = createAdminCertificateFileGetHandler(
    mock.dependencies,
    fileStorage,
  )
  const response = await handler(
    request('/api/admin/certificates/TS-ABC123/file'),
    { id: 'TS-ABC123' },
  )
  assert.equal(response.status, 200)
  assert.equal(storageCalls, 1)

  const denied = setup(async () => {
    throw new AuthenticationError('unauthenticated')
  })
  const deniedHandler = createAdminCertificateFileGetHandler(
    denied.dependencies,
    fileStorage,
  )
  const deniedResponse = await deniedHandler(
    request('/api/admin/certificates/TS-ABC123/file'),
    { id: 'TS-ABC123' },
  )
  assert.equal(deniedResponse.status, 401)
  assert.equal(storageCalls, 1)
})

test('malformed and unknown public verification tokens safely return the same invalid result', async () => {
  let repositoryCalls = 0
  let rateLimitCalls = 0
  const repositories = createRepositories(async () => {
    throw new Error('test must not access a database')
  })
  repositories.getCertificateByVerificationIdentifier = async () => {
    repositoryCalls += 1
    return null
  }
  const handler = createPublicCertificateVerificationGetHandler(
    () => repositories,
    async () => {
      rateLimitCalls += 1
      return false
    },
  )
  const malformed = await handler(request('/api/verify/bad'), {
    token: 'bad',
  })
  assert.equal(malformed.status, 200)
  assert.deepEqual(await body(malformed), { valid: false })
  assert.equal(malformed.headers.get('cache-control'), 'no-store')
  assert.equal(repositoryCalls, 0)
  assert.equal(rateLimitCalls, 1)

  const unknown = await handler(
    request(`/api/verify/${'B'.repeat(43)}`),
    { token: 'B'.repeat(43) },
  )
  assert.equal(unknown.status, 200)
  assert.deepEqual(await body(unknown), { valid: false })
  assert.equal(unknown.headers.get('cache-control'), 'no-store')
  assert.equal(repositoryCalls, 1)
  assert.equal(rateLimitCalls, 2)
})

test('revoked and otherwise non-issued certificates are never reported as valid', async () => {
  const repositories = createRepositories(async () => {
    throw new Error('test must not access a database')
  })
  repositories.getCertificateByVerificationIdentifier = async () => ({
    id: validId,
    certificateId: 'CERT-REVOKED',
    enrollmentId: '65a12b34cd56ef7890123457',
    templateId: '65a12b34cd56ef7890123458',
    issueDate: '2026-10-23T00:00:00.000Z',
    status: 'revoked',
    revokedAt: '2026-10-23T00:01:00.000Z',
    supersedesCertificateId: null,
    createdAt: '2026-10-23T00:00:00.000Z',
    updatedAt: '2026-10-23T00:01:00.000Z',
  })
  const handler = createPublicCertificateVerificationGetHandler(
    () => repositories,
    async () => false,
  )
  const response = await handler(
    request(`/api/verify/${'C'.repeat(43)}`),
    { token: 'C'.repeat(43) },
  )
  assert.equal(response.status, 200)
  assert.deepEqual(await body(response), { valid: false })
  assert.equal(response.headers.get('cache-control'), 'no-store')
})

test('public verification repository errors return a generic no-store response', async () => {
  const repositories = createRepositories(async () => {
    throw new Error('test must not access a database')
  })
  repositories.getCertificateByVerificationIdentifier = async () => {
    throw new Error('private database error and verification secret')
  }
  const response = await createPublicCertificateVerificationGetHandler(
    () => repositories,
    async () => false,
  )(request(`/api/verify/${'D'.repeat(43)}`), {
    token: 'D'.repeat(43),
  })
  assert.equal(response.status, 503)
  assert.deepEqual(await body(response), { valid: false })
  assert.equal(response.headers.get('cache-control'), 'no-store')
})

test('public verification rate limits before repository lookup without revealing token validity', async () => {
  let repositoryCalls = 0
  const repositories = createRepositories(async () => {
    throw new Error('tests must not access a database')
  })
  repositories.getCertificateByVerificationIdentifier = async () => {
    repositoryCalls += 1
    return null
  }
  const handler = createPublicCertificateVerificationGetHandler(
    () => repositories,
    async () => true,
  )

  const limitedKnown = await handler(
    request(`/api/verify/${'A'.repeat(43)}`),
    { token: 'A'.repeat(43) },
  )
  const limitedUnknown = await handler(
    request(`/api/verify/${'B'.repeat(43)}`),
    { token: 'B'.repeat(43) },
  )

  assert.equal(limitedKnown.status, 429)
  assert.equal(limitedUnknown.status, 429)
  assert.deepEqual(await body(limitedKnown), { valid: false })
  assert.deepEqual(await body(limitedUnknown), { valid: false })
  assert.equal(limitedKnown.headers.get('cache-control'), 'no-store')
  assert.equal(limitedUnknown.headers.get('cache-control'), 'no-store')
  assert.equal(repositoryCalls, 0)
})

test('public verification fails closed when rate limiting is unavailable', async () => {
  let repositoryCalls = 0
  const repositories = createRepositories(async () => {
    throw new Error('tests must not access a database')
  })
  repositories.getCertificateByVerificationIdentifier = async () => {
    repositoryCalls += 1
    return null
  }
  const handler = createPublicCertificateVerificationGetHandler(
    () => repositories,
    async () => {
      throw new Error('private limiter configuration detail')
    },
  )
  const response = await handler(
    request(`/api/verify/${'C'.repeat(43)}`),
    { token: 'C'.repeat(43) },
  )

  assert.equal(response.status, 503)
  assert.deepEqual(await body(response), { valid: false })
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(repositoryCalls, 0)
})

test('Vercel limiter requires the trusted platform IP header and configured Firewall rule', async () => {
  let sdkCalls = 0
  const sdkCheck: Parameters<typeof createVercelVerificationRateLimiter>[1] =
    async (id, options) => {
      sdkCalls += 1
      assert.equal(id, 'public-certificate-verification')
      assert.equal(options?.rateLimitKey, '203.0.113.7')
      assert.equal(options?.timeout, 1000)
      return { rateLimited: false }
    }
  const limiter = createVercelVerificationRateLimiter(
      { VERCEL: '1', NODE_ENV: 'production' },
    sdkCheck,
  )
  await limiter(
    new Request('https://certificates.example.test/api/verify/token', {
      headers: {
        'x-forwarded-for': '203.0.113.7',
        'x-real-ip': '198.51.100.8',
      },
    }),
  )
  assert.equal(sdkCalls, 1)

  const localLimiter = createVercelVerificationRateLimiter({}, sdkCheck)
  await assert.rejects(
    () => localLimiter(request('/api/verify/token')),
    /unavailable/,
  )
  const missingIpLimiter = createVercelVerificationRateLimiter(
    { VERCEL: '1', NODE_ENV: 'production' },
    sdkCheck,
  )
  await assert.rejects(
    () => missingIpLimiter(request('/api/verify/token')),
    /unavailable/,
  )
  const unconfiguredRuleLimiter = createVercelVerificationRateLimiter(
    { VERCEL: '1', NODE_ENV: 'production' },
    async () => ({ rateLimited: false, error: 'not-found' }),
  )
  await assert.rejects(
    () =>
      unconfiguredRuleLimiter(
        new Request('https://certificates.example.test/api/verify/token', {
          headers: { 'x-forwarded-for': '203.0.113.7' },
        }),
      ),
    /unavailable/,
  )
  const developmentLimiter = createVercelVerificationRateLimiter(
    { VERCEL: '1', NODE_ENV: 'development' },
    sdkCheck,
  )
  await assert.rejects(
    () =>
      developmentLimiter(
        new Request('https://certificates.example.test/api/verify/token', {
          headers: { 'x-forwarded-for': '203.0.113.7' },
        }),
      ),
    /unavailable/,
  )
  assert.equal(sdkCalls, 1)
})

test('admin login rate limiter uses its separate configured Firewall rule', async () => {
  let callCount = 0
  const limiter = createVercelAdminLoginRateLimiter(
    { VERCEL: '1', NODE_ENV: 'production' },
    async (id, options) => {
      callCount += 1
      assert.equal(id, 'admin-password-login')
      assert.equal(options?.rateLimitKey, '203.0.113.9')
      return { rateLimited: true }
    },
  )
  const result = await limiter(
    new Request('https://certificates.example.test/api/auth/login', {
      method: 'POST',
      headers: { 'x-forwarded-for': '203.0.113.9' },
    }),
  )
  assert.equal(result, true)
  assert.equal(callCount, 1)

  const unavailable = createVercelAdminLoginRateLimiter(
    { VERCEL: '1', NODE_ENV: 'production' },
    async () => ({ rateLimited: false, error: 'not-found' }),
  )
  await assert.rejects(
    unavailable(
      new Request('https://certificates.example.test/api/auth/login', {
        method: 'POST',
        headers: { 'x-forwarded-for': '203.0.113.9' },
      }),
    ),
    /unavailable/,
  )
})
