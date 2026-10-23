import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import {
  AuthenticationError,
  createAuthentication,
  parseAuthConfig,
} from '../src/lib/auth.server.ts'
import {
  createPrimaryAdminProvisioner,
  hashAdminPassword,
  verifyAdminPassword,
} from '../src/lib/admin-credentials.server.ts'

const validEnvironment = {
  AUTH_SESSION_KEY: randomBytes(32).toString('base64url'),
  APP_ORIGIN: 'https://certificates.example.test',
  NODE_ENV: 'production',
}

function cookieValue(value: string): string {
  return value.split(';', 1)[0] ?? ''
}

test('auth configuration requires only the session key and canonical app origin', () => {
  const config = parseAuthConfig(validEnvironment)
  assert.equal(config.appOrigin, validEnvironment.APP_ORIGIN)
  assert.equal(config.secureCookies, true)

  assert.throws(
    () => parseAuthConfig({ ...validEnvironment, AUTH_SESSION_KEY: '' }),
    (error: unknown) =>
      error instanceof Error &&
      'missing' in error &&
      JSON.stringify(error).includes('AUTH_SESSION_KEY'),
  )
  assert.throws(
    () =>
      parseAuthConfig({
        ...validEnvironment,
        AUTH_SESSION_KEY: 'invalid-key',
      }),
    (error: unknown) =>
      error instanceof Error &&
      'invalid' in error &&
      !error.message.includes('invalid-key'),
  )
})

test('email/password admin sessions are encrypted and require an exact-origin CSRF token', async () => {
  const config = parseAuthConfig(validEnvironment)
  const authentication = createAuthentication(config, async () => true)
  const email = 'admin@example.test'
  const sessionVersion = randomBytes(32).toString('base64url')
  const cookies = await authentication.createSession(email, sessionVersion)
  assert.match(cookies.sessionCookie, /^tsc_session=/)
  assert.match(cookies.sessionCookie, /HttpOnly/)
  assert.match(cookies.sessionCookie, /Secure/)
  assert.match(cookies.csrfCookie, /^tsc_csrf=/)
  assert.match(cookies.csrfCookie, /SameSite=Strict/)
  assert.doesNotMatch(cookies.sessionCookie, new RegExp(email))

  const csrfToken = cookies.csrfCookie.match(/^tsc_csrf=([^;]+)/)?.[1]
  assert.ok(csrfToken)
  const request = new Request(config.appOrigin, {
    headers: {
      cookie: `${cookieValue(cookies.sessionCookie)}; ${cookieValue(cookies.csrfCookie)}`,
      origin: config.appOrigin,
      'x-csrf-token': decodeURIComponent(csrfToken),
    },
  })
  assert.deepEqual(await authentication.requireAdmin(request), {
    email,
    sessionVersion,
    csrfToken: decodeURIComponent(csrfToken),
  })
  authentication.assertCsrf(request, await authentication.requireAdmin(request))

  const invalidOrigin = new Request(config.appOrigin, {
    headers: {
      cookie: request.headers.get('cookie') ?? '',
      origin: 'https://attacker.example.test',
      'x-csrf-token': decodeURIComponent(csrfToken),
    },
  })
  assert.throws(
    () =>
      authentication.assertCsrf(
        invalidOrigin,
        { email, sessionVersion, csrfToken: decodeURIComponent(csrfToken) },
      ),
    (error: unknown) =>
      error instanceof AuthenticationError && error.code === 'csrf_failed',
  )
})

test('missing, expired, and malformed session cookies do not authenticate', async () => {
  const authentication = createAuthentication(
    parseAuthConfig(validEnvironment),
    async () => true,
  )
  for (const cookie of ['', 'tsc_session=not-a-session']) {
    await assert.rejects(
      authentication.requireAdmin(
        new Request('https://certificates.example.test/', {
          headers: cookie ? { cookie } : {},
        }),
      ),
      (error: unknown) =>
        error instanceof AuthenticationError &&
        error.code === 'unauthenticated',
    )
  }
})

test('password reset invalidates prior sessions', async () => {
  const config = parseAuthConfig(validEnvironment)
  const oldVersion = randomBytes(32).toString('base64url')
  let currentVersion = oldVersion
  const authentication = createAuthentication(
    config,
    async (_email, version) => version === currentVersion,
  )
  const session = await authentication.createSession(
    'admin@example.test',
    oldVersion,
  )
  const request = new Request(config.appOrigin, {
    headers: {
      cookie: `${cookieValue(session.sessionCookie)}; ${cookieValue(session.csrfCookie)}`,
    },
  })
  assert.equal((await authentication.requireAdmin(request)).sessionVersion, oldVersion)
  currentVersion = randomBytes(32).toString('base64url')
  await assert.rejects(
    authentication.requireAdmin(request),
    (error: unknown) =>
      error instanceof AuthenticationError && error.code === 'forbidden',
  )
})

test('passwords are stored as salted scrypt hashes and verified without a database', async () => {
  const password = randomBytes(24).toString('base64url')
  const hash = await hashAdminPassword(password)
  assert.notEqual(hash, password)
  assert.match(hash, /^scrypt\$32768\$8\$1\$/)
  assert.equal(await verifyAdminPassword(password, hash), true)
  assert.equal(await verifyAdminPassword(randomBytes(24).toString('base64url'), hash), false)
  assert.equal(await verifyAdminPassword('short', hash), false)
  assert.equal(await verifyAdminPassword(password, 'invalid-hash'), false)
  assert.notEqual(await hashAdminPassword(password), hash)
})

test('initial provisioning does not overwrite an existing account; reset is explicit', async () => {
  let account:
    | {
        _id: string
        email: string
        passwordHash: string
        sessionVersion: string
        createdAt: Date
        updatedAt: Date
      }
    | undefined
  let resetCalls = 0
  const provision = createPrimaryAdminProvisioner({
    async create(document) {
      if (account) throw new Error('duplicate primary account')
      account = document
    },
    async reset(values) {
      resetCalls += 1
      if (!account) return false
      account = { ...account, ...values }
      return true
    },
  })
  const originalPassword = randomBytes(24).toString('base64url')
  await provision('ADMIN@example.test', originalPassword)
  assert.ok(account)
  assert.equal(account.email, 'admin@example.test')
  assert.notEqual(account.passwordHash, originalPassword)
  const originalHash = account.passwordHash
  const originalSessionVersion = account.sessionVersion

  await assert.rejects(
    provision('admin@example.test', randomBytes(24).toString('base64url')),
  )
  assert.equal(account.passwordHash, originalHash)
  assert.equal(resetCalls, 0)

  const resetPassword = randomBytes(24).toString('base64url')
  await provision('admin@example.test', resetPassword, true)
  assert.notEqual(account.passwordHash, originalHash)
  assert.notEqual(account.sessionVersion, originalSessionVersion)
  assert.equal(resetCalls, 1)
})
