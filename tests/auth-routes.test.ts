import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import {
  createAuthentication,
  parseAuthConfig,
} from '../src/lib/auth.server.ts'
import { createAuthRouteHandlers } from '../src/lib/auth-routes.server.ts'

const environment = {
  AUTH_SESSION_KEY: randomBytes(32).toString('base64url'),
  APP_ORIGIN: 'https://certificates.example.test',
  NODE_ENV: 'production',
}

function setup(options: {
  validCredentials?: boolean
  rateLimited?: boolean
} = {}) {
  const config = parseAuthConfig(environment)
  const authentication = createAuthentication(config, async () => true)
  const handlers = createAuthRouteHandlers(
    () => ({ config, authentication }),
    async () =>
      options.validCredentials === false
        ? null
        : randomBytes(32).toString('base64url'),
    async () => !(options.rateLimited ?? false),
  )
  return { config, authentication, handlers }
}

function loginRequest(
  origin = environment.APP_ORIGIN,
  body: unknown = {
    email: 'admin@example.test',
    password: randomBytes(24).toString('base64url'),
  },
): Request {
  return new Request(`${origin}/api/auth/login`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

test('successful login issues only encrypted session and CSRF cookies', async () => {
  const { handlers } = setup()
  const response = await handlers.login(loginRequest())
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await response.json(), { authenticated: true })
  const cookies = response.headers.getSetCookie()
  assert.equal(cookies.length, 2)
  assert.match(cookies[0] ?? '', /^tsc_session=/)
  assert.match(cookies[0] ?? '', /HttpOnly/)
  assert.match(cookies[1] ?? '', /^tsc_csrf=/)
  assert.match(cookies[1] ?? '', /SameSite=Strict/)
  assert.doesNotMatch(JSON.stringify(cookies), /admin@example\.test/)
})

test('wrong credentials return a generic denial and issue no cookies', async () => {
  const { handlers } = setup({ validCredentials: false })
  const response = await handlers.login(loginRequest())
  assert.equal(response.status, 401)
  assert.deepEqual(await response.json(), { error: 'invalid_credentials' })
  assert.deepEqual(response.headers.getSetCookie(), [])
})

test('cross-origin login requests, invalid bodies, and excessive attempts are rejected', async () => {
  const crossOrigin = setup()
  assert.equal(
    (await crossOrigin.handlers.login(
      loginRequest('https://attacker.example.test'),
    )).status,
    403,
  )

  const invalidBody = setup()
  const response = await invalidBody.handlers.login(
    loginRequest(environment.APP_ORIGIN, { email: 'bad', password: 'short' }),
  )
  assert.equal(response.status, 400)

  const limited = setup({ rateLimited: true })
  assert.equal((await limited.handlers.login(loginRequest())).status, 429)
})

test('logout requires a valid session, exact-origin CSRF token, and clears both cookies', async () => {
  const { config, authentication, handlers } = setup()
  const session = await authentication.createSession(
    'admin@example.test',
    randomBytes(32).toString('base64url'),
  )
  const csrf = session.csrfCookie.match(/^tsc_csrf=([^;]+)/)?.[1]
  assert.ok(csrf)
  const cookiePair = (value: string) => value.split(';', 1)[0]
  const request = new Request(`${config.appOrigin}/api/auth/logout`, {
    method: 'POST',
    headers: {
      origin: config.appOrigin,
      cookie: `${cookiePair(session.sessionCookie)}; ${cookiePair(session.csrfCookie)}`,
      'x-csrf-token': decodeURIComponent(csrf),
    },
  })
  const response = await handlers.logout(request)
  assert.equal(response.status, 204)
  const cookies = response.headers.getSetCookie()
  assert.equal(cookies.length, 2)
  assert.ok(cookies.every((cookie) => cookie.includes('Max-Age=0')))

  const rejected = await handlers.logout(
    new Request(`${config.appOrigin}/api/auth/logout`, { method: 'POST' }),
  )
  assert.equal(rejected.status, 401)
})

test('missing auth configuration reports only required variable names', async () => {
  const previousKey = process.env.AUTH_SESSION_KEY
  const previousOrigin = process.env.APP_ORIGIN
  const previousEnvironment = process.env.NODE_ENV
  delete process.env.AUTH_SESSION_KEY
  delete process.env.APP_ORIGIN
  process.env.NODE_ENV = 'production'
  try {
    const response = await createAuthRouteHandlers().login(
      loginRequest(),
    )
    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), {
      error: 'configuration_error',
      missing: ['AUTH_SESSION_KEY', 'APP_ORIGIN'],
      invalid: [],
    })
  } finally {
    if (previousKey === undefined) delete process.env.AUTH_SESSION_KEY
    else process.env.AUTH_SESSION_KEY = previousKey
    if (previousOrigin === undefined) delete process.env.APP_ORIGIN
    else process.env.APP_ORIGIN = previousOrigin
    if (previousEnvironment === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previousEnvironment
  }
})
