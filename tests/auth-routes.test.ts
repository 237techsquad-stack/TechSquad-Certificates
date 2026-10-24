import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import {
  AuthConfigurationError,
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

test('production login uses the local throttle and clears it after successful authentication', async () => {
  const previousNodeEnv = process.env.NODE_ENV
  const previousVercel = process.env.VERCEL
  process.env.NODE_ENV = 'production'
  delete process.env.VERCEL

  try {
    const config = parseAuthConfig(environment)
    const authentication = createAuthentication(config, async () => true)
    const email = `admin-${randomBytes(8).toString('hex')}@example.test`
    let credentialsValid = false
    const handler = createAuthRouteHandlers(
      () => ({ config, authentication }),
      async () =>
        credentialsValid ? randomBytes(32).toString('base64url') : null,
    )
    const request = () =>
      loginRequest(environment.APP_ORIGIN, {
        email,
        password: randomBytes(24).toString('base64url'),
      })

    for (let attempt = 0; attempt < 4; attempt += 1) {
      assert.equal((await handler.login(request())).status, 401)
    }
    credentialsValid = true
    assert.equal((await handler.login(request())).status, 200)
    credentialsValid = false

    for (let attempt = 0; attempt < 5; attempt += 1) {
      assert.equal((await handler.login(request())).status, 401)
    }
    assert.equal((await handler.login(request())).status, 429)
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previousNodeEnv
    if (previousVercel === undefined) delete process.env.VERCEL
    else process.env.VERCEL = previousVercel
  }
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

test('login failures log one sanitized correlation diagnostic and preserve 503 responses', async () => {
  const diagnostics: string[][] = []
  const originalConsoleError = console.error
  console.error = (...args: Parameters<typeof console.error>) => {
    diagnostics.push(args.map((value) => String(value)))
  }

  try {
    const config = parseAuthConfig(environment)
    const requestIds = new Set<string>()
    const failure = (name: string) => {
      const error = new Error('private credential and connection detail')
      error.name = name
      return error
    }
    const cases = [
      {
        stage: 'rate_limit',
        getContext: () => ({
          config,
          authentication: createAuthentication(config, async () => true),
        }),
        verify: async () => randomBytes(32).toString('base64url'),
        rateLimit: async () => {
          throw failure('private error name')
        },
        expectedName: 'Error',
      },
      {
        stage: 'credential_verification',
        getContext: () => ({
          config,
          authentication: createAuthentication(config, async () => true),
        }),
        verify: async () => {
          throw failure('MongoServerSelectionError')
        },
        rateLimit: async () => true,
        expectedName: 'MongoServerSelectionError',
      },
      {
        stage: 'session_creation',
        getContext: () => {
          const authentication = createAuthentication(config, async () => true)
          authentication.createSession = async () => {
            throw failure('TypeError')
          }
          return { config, authentication }
        },
        verify: async () => randomBytes(32).toString('base64url'),
        rateLimit: async () => true,
        expectedName: 'TypeError',
      },
    ] as const

    const requestBody = {
      email: 'admin@example.test',
      password: 'private-login-password',
    }

    for (const testCase of cases) {
      diagnostics.length = 0
      const handler = createAuthRouteHandlers(
        testCase.getContext,
        testCase.verify,
        testCase.rateLimit,
      )
      const response = await handler.login(
        loginRequest(environment.APP_ORIGIN, requestBody),
      )
      assert.equal(response.status, 503)
      assert.deepEqual(await response.json(), {
        error: 'authentication_unavailable',
      })
      assert.equal(diagnostics.length, 1)
      assert.equal(diagnostics[0]?.[0], '[auth-login] request failed')
      const details = JSON.parse(diagnostics[0]?.[1] ?? '{}') as {
        requestId: string
        stage: string
        errorCategory: string
        errorName: string
      }
      assert.match(details.requestId, /^[0-9a-f-]{36}$/)
      requestIds.add(details.requestId)
      assert.equal(details.stage, testCase.stage)
      assert.equal(details.errorCategory, 'unexpected')
      assert.equal(details.errorName, testCase.expectedName)
      const loggedText = diagnostics[0]?.join(' ') ?? ''
      assert.doesNotMatch(
        loggedText,
        /private credential|connection detail|private-login-password|admin@example\.test/,
      )
    }

    diagnostics.length = 0
    const configurationHandler = createAuthRouteHandlers(
      () => {
        throw new AuthConfigurationError(['AUTH_SESSION_KEY'], [])
      },
      async () => randomBytes(32).toString('base64url'),
      async () => true,
    )
    const configurationResponse = await configurationHandler.login(
      loginRequest(environment.APP_ORIGIN, requestBody),
    )
    assert.equal(configurationResponse.status, 503)
    assert.deepEqual(await configurationResponse.json(), {
      error: 'configuration_error',
      missing: ['AUTH_SESSION_KEY'],
      invalid: [],
    })
    assert.equal(diagnostics.length, 1)
    const configurationDetails = JSON.parse(
      diagnostics[0]?.[1] ?? '{}',
    ) as Record<string, unknown>
    assert.match(String(configurationDetails.requestId), /^[0-9a-f-]{36}$/)
    requestIds.add(String(configurationDetails.requestId))
    assert.equal(requestIds.size, 4)
    assert.deepEqual(
      {
        stage: configurationDetails.stage,
        errorCategory: configurationDetails.errorCategory,
        errorName: configurationDetails.errorName,
      },
      {
        stage: 'authentication_configuration',
        errorCategory: 'configuration',
        errorName: 'AuthConfigurationError',
      },
    )
  } finally {
    console.error = originalConsoleError
  }
})

test('request ID generation failure uses a random fallback and returns one generic 503', async () => {
  const diagnostics: string[][] = []
  const originalConsoleError = console.error
  const consoleError = (...args: Parameters<typeof console.error>) => {
    diagnostics.push(args.map((value) => String(value)))
  }
  console.error = consoleError

  try {
    const config = parseAuthConfig(environment)
    let contextCalls = 0
    let rateLimitCalls = 0
    let credentialCalls = 0
    const authentication = createAuthentication(config, async () => true)
    const handler = createAuthRouteHandlers(
      () => {
        contextCalls += 1
        return { config, authentication }
      },
      async () => {
        credentialCalls += 1
        return randomBytes(32).toString('base64url')
      },
      async () => {
        rateLimitCalls += 1
        return true
      },
      () => {
        throw new Error('private identifier-generation detail')
      },
    )

    const fallbackIds = new Set<string>()
    for (let attempt = 0; attempt < 2; attempt += 1) {
      diagnostics.length = 0
      const response = await handler.login(loginRequest())
      assert.equal(response.status, 503)
      assert.deepEqual(await response.json(), {
        error: 'authentication_unavailable',
      })
      assert.equal(diagnostics.length, 1)
      assert.equal(diagnostics[0]?.[0], '[auth-login] request failed')
      const loggedDetails = JSON.parse(diagnostics[0]?.[1] ?? '{}') as {
        requestId: string | null
        stage: string
        errorCategory: string
        errorName: string
      }
      assert.match(loggedDetails.requestId ?? '', /^[0-9a-f]{32}$/)
      fallbackIds.add(loggedDetails.requestId ?? '')
      assert.equal(loggedDetails.stage, 'request_id_generation')
      assert.equal(loggedDetails.errorCategory, 'unexpected')
      assert.equal(loggedDetails.errorName, 'Error')
      assert.doesNotMatch(
        diagnostics[0]?.join(' ') ?? '',
        /private identifier-generation detail|admin@example\.test/,
      )
    }

    assert.equal(fallbackIds.size, 2)
    assert.equal(contextCalls, 0)
    assert.equal(rateLimitCalls, 0)
    assert.equal(credentialCalls, 0)
  } finally {
    console.error = originalConsoleError
  }
})

test('diagnostic inspection failures cannot escape login error handling', async () => {
  const diagnostics: string[][] = []
  const originalConsoleError = console.error
  console.error = (...args: Parameters<typeof console.error>) => {
    diagnostics.push(args.map((value) => String(value)))
  }

  try {
    const config = parseAuthConfig(environment)
    const authentication = createAuthentication(config, async () => true)
    const throwingName = new Error('private raw error detail')
    Object.defineProperty(throwingName, 'name', {
      get() {
        throw new Error('private name getter detail')
      },
    })
    const hostileProxy = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error('private proxy inspection detail')
        },
      },
    )
    const errors: unknown[] = [throwingName, hostileProxy]

    for (const error of errors) {
      diagnostics.length = 0
      const handler = createAuthRouteHandlers(
        () => ({ config, authentication }),
        async () => {
          throw error
        },
        async () => true,
      )
      const response = await handler.login(loginRequest())

      assert.equal(response.status, 503)
      assert.deepEqual(await response.json(), {
        error: 'authentication_unavailable',
      })
      assert.equal(diagnostics.length, 1)
      assert.equal(diagnostics[0]?.[0], '[auth-login] request failed')
      const loggedDetails = JSON.parse(diagnostics[0]?.[1] ?? '{}') as {
        requestId: string
        stage: string
        errorCategory: string
        errorName: string
      }
      assert.match(loggedDetails.requestId, /^[0-9a-f-]{36}$/)
      assert.equal(loggedDetails.stage, 'credential_verification')
      assert.equal(loggedDetails.errorCategory, 'unexpected')
      assert.equal(loggedDetails.errorName, 'Error')
      assert.doesNotMatch(
        diagnostics[0]?.join(' ') ?? '',
        /private raw error detail|private name getter detail|private proxy inspection detail/,
      )
    }
  } finally {
    console.error = originalConsoleError
  }
})
