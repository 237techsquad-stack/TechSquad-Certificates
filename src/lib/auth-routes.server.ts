import '@tanstack/react-start/server-only'

import { randomBytes, randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  AuthConfigurationError,
  AuthenticationError,
  createAuthentication,
  getAuthConfig,
} from './auth.server.ts'
import type { AuthConfig } from './auth.server.ts'
import { verifyPrimaryAdminCredentials } from './admin-credentials.server.ts'

type Authentication = ReturnType<typeof createAuthentication>
type AuthRouteContext = {
  config: AuthConfig
  authentication: Authentication
}

type GetAuthRouteContext = () => AuthRouteContext
type VerifyCredentials = (
  email: string,
  password: string,
) => Promise<string | null>
type RateLimit = (request: Request, email: string) => Promise<boolean>
type CreateRequestId = () => string

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  password: z.string().min(12).max(1024),
}).strict()

const loginAttempts = new Map<string, { count: number; resetAt: number }>()
const LOGIN_WINDOW_MS = 15 * 60 * 1000
const LOGIN_ATTEMPT_LIMIT = 5

type LoginDiagnosticStage =
  | 'request_id_generation'
  | 'authentication_configuration'
  | 'rate_limit'
  | 'credential_verification'
  | 'session_creation'

const SAFE_ERROR_NAMES = new Set([
  'AggregateError',
  'AuthConfigurationError',
  'Error',
  'MongoAPIError',
  'MongoAuthenticationError',
  'MongoDatabaseUnavailableError',
  'MongoNetworkError',
  'MongoParseError',
  'MongoRuntimeError',
  'MongoServerError',
  'MongoServerSelectionError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'TimeoutError',
  'TypeError',
  'URIError',
])

function getProductionContext(): AuthRouteContext {
  const config = getAuthConfig()
  return { config, authentication: createAuthentication(config) }
}

function allowLocalLoginAttempt(email: string): boolean {
  const now = Date.now()
  if (loginAttempts.size > 10_000) {
    for (const [key, attempt] of loginAttempts) {
      if (attempt.resetAt <= now) loginAttempts.delete(key)
    }
    if (loginAttempts.size > 10_000) return false
  }
  const previous = loginAttempts.get(email)
  if (!previous || previous.resetAt <= now) {
    loginAttempts.set(email, { count: 1, resetAt: now + LOGIN_WINDOW_MS })
    return true
  }
  if (previous.count >= LOGIN_ATTEMPT_LIMIT) return false
  previous.count += 1
  return true
}

async function rateLimitLogin(_request: Request, email: string): Promise<boolean> {
  return allowLocalLoginAttempt(email)
}

function clearLoginAttempts(email: string): void {
  loginAttempts.delete(email)
}

export function createAuthRouteHandlers(
  getContext: GetAuthRouteContext = getProductionContext,
  verifyCredentials: VerifyCredentials = verifyPrimaryAdminCredentials,
  rateLimit: RateLimit = rateLimitLogin,
  createRequestId: CreateRequestId = randomUUID,
) {
  async function login(request: Request): Promise<Response> {
    let requestId: string | null = null
    let stage: LoginDiagnosticStage = 'request_id_generation'
    try {
      const generatedRequestId = createRequestId()
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(generatedRequestId)) {
        throw new Error('Invalid request identifier')
      }
      requestId = generatedRequestId
      stage = 'authentication_configuration'
      const { config, authentication } = getContext()
      if (request.method !== 'POST') return authError(405, 'method_not_allowed')
      if (request.headers.get('origin') !== config.appOrigin) {
        return authError(403, 'request_rejected')
      }

      let rawInput: unknown
      try {
        rawInput = await request.json()
      } catch {
        return authError(400, 'invalid_request')
      }
      const input = loginSchema.safeParse(rawInput)
      if (!input.success) return authError(400, 'invalid_request')

      stage = 'rate_limit'
      if (!(await rateLimit(request, input.data.email))) {
        return authError(429, 'login_unavailable')
      }

      stage = 'credential_verification'
      const sessionVersion = await verifyCredentials(
        input.data.email,
        input.data.password,
      )
      if (!sessionVersion) return authError(401, 'invalid_credentials')

      clearLoginAttempts(input.data.email)
      stage = 'session_creation'
      const cookies = await authentication.createSession(
        input.data.email,
        sessionVersion,
      )
      const response = Response.json(
        { authenticated: true },
        { headers: { 'Cache-Control': 'no-store' } },
      )
      response.headers.append('Set-Cookie', cookies.sessionCookie)
      response.headers.append('Set-Cookie', cookies.csrfCookie)
      return response
    } catch (error) {
      if (stage === 'request_id_generation') {
        requestId = createFallbackRequestId()
      }
      logLoginFailure(requestId, stage, error)
      const configurationDetails = getSafeAuthConfigurationDetails(error)
      if (configurationDetails) {
        return authError(503, 'configuration_error', {
          missing: configurationDetails.missing,
          invalid: configurationDetails.invalid,
        })
      }
      return authError(503, 'authentication_unavailable')
    }
  }

  async function logout(request: Request): Promise<Response> {
    try {
      const { authentication } = getContext()
      const session = await authentication.requireAuthenticated(request)
      authentication.assertCsrf(request, session)
      const response = new Response(null, {
        status: 204,
        headers: { 'Cache-Control': 'no-store' },
      })
      for (const cookie of authentication.clearCookies()) {
        response.headers.append('Set-Cookie', cookie)
      }
      return response
    } catch (error) {
      if (error instanceof AuthenticationError) {
        if (error.code === 'unauthenticated') {
          return authError(401, 'unauthenticated')
        }
        if (error.code === 'csrf_failed') {
          return authError(403, 'csrf_failed')
        }
      }
      if (error instanceof AuthConfigurationError) {
        return authError(503, 'configuration_error', {
          missing: error.missing,
          invalid: error.invalid,
        })
      }
      return authError(503, 'authentication_unavailable')
    }
  }

  return { login, logout }
}

function createFallbackRequestId(): string | null {
  try {
    return randomBytes(16).toString('hex')
  } catch {
    return null
  }
}

function logLoginFailure(
  requestId: string | null,
  stage: LoginDiagnosticStage,
  error: unknown,
): void {
  try {
    const safeRequestId =
      requestId && /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|[0-9a-f]{32})$/i.test(requestId)
        ? requestId
        : null
    const errorName = getSafeErrorName(error)
    const errorCategory = getSafeErrorCategory(error)
    console.error(
      '[auth-login] request failed',
      JSON.stringify({
        requestId: safeRequestId,
        stage,
        errorCategory,
        errorName,
      }),
    )
  } catch {
    // Preserve the generic failure response if the runtime logger is unavailable.
  }
}

function getSafeErrorName(error: unknown): string {
  try {
    if (!(error instanceof Error)) return 'Error'
    const name = error.name
    return typeof name === 'string' && SAFE_ERROR_NAMES.has(name)
      ? name
      : 'Error'
  } catch {
    return 'Error'
  }
}

function getSafeErrorCategory(
  error: unknown,
): 'configuration' | 'unexpected' {
  try {
    return error instanceof AuthConfigurationError
      ? 'configuration'
      : 'unexpected'
  } catch {
    return 'unexpected'
  }
}

function getSafeAuthConfigurationDetails(
  error: unknown,
): { missing: readonly string[]; invalid: readonly string[] } | null {
  try {
    if (!(error instanceof AuthConfigurationError)) return null
    return { missing: error.missing, invalid: error.invalid }
  } catch {
    return null
  }
}

function authError(
  status: number,
  code: string,
  details?: { missing: readonly string[]; invalid: readonly string[] },
): Response {
  return Response.json(
    { error: code, ...details },
    { status, headers: { 'Cache-Control': 'no-store' } },
  )
}
