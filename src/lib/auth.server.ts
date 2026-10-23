import '@tanstack/react-start/server-only'

import { EncryptJWT, jwtDecrypt } from 'jose'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { isPrimaryAdminSessionCurrent } from './admin-credentials.server.ts'

const SESSION_ISSUER = 'techsquad-certificates'
const SESSION_AUDIENCE = 'admin-session'
const SESSION_SECONDS = 8 * 60 * 60
const SESSION_COOKIE = 'tsc_session'
const CSRF_COOKIE = 'tsc_csrf'

const originSchema = z.string().url().transform((value, context) => {
  try {
    const url = new URL(value)
    if (
      url.origin !== value ||
      (url.protocol !== 'https:' &&
        url.hostname !== 'localhost' &&
        url.hostname !== '127.0.0.1')
    ) {
      context.addIssue({ code: 'custom', message: 'Invalid origin' })
      return z.NEVER
    }
    return url.origin
  } catch {
    context.addIssue({ code: 'custom', message: 'Invalid origin' })
    return z.NEVER
  }
})

const sessionKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/)
  .refine((value) => {
    const decoded = Buffer.from(value, 'base64url')
    return decoded.byteLength === 32 && decoded.toString('base64url') === value
  })
  .transform((value) => Buffer.from(value, 'base64url'))

const rawAuthConfigSchema = z.object({
  AUTH_SESSION_KEY: sessionKeySchema,
  APP_ORIGIN: originSchema,
  NODE_ENV: z.enum(['development', 'test', 'production']).optional(),
})

export interface AuthConfig {
  sessionKey: Uint8Array
  appOrigin: string
  secureCookies: boolean
}

export class AuthenticationError extends Error {
  readonly code: 'unauthenticated' | 'forbidden' | 'csrf_failed'

  constructor(code: AuthenticationError['code']) {
    super(authenticationErrorMessages[code])
    this.name = 'AuthenticationError'
    this.code = code
  }
}

export class AuthConfigurationError extends Error {
  readonly missing: readonly string[]
  readonly invalid: readonly string[]

  constructor(missing: string[], invalid: string[]) {
    super('Authentication configuration is invalid')
    this.name = 'AuthConfigurationError'
    this.missing = missing
    this.invalid = invalid
  }
}

const authenticationErrorMessages: Record<
  AuthenticationError['code'],
  string
> = {
  unauthenticated: 'Authentication is required',
  forbidden: 'Access is not permitted',
  csrf_failed: 'Request verification failed',
}

export interface AuthSession {
  email: string
  sessionVersion: string
  csrfToken: string
}

export function parseAuthConfig(
  environment: Record<string, string | undefined>,
): AuthConfig {
  const result = rawAuthConfigSchema.safeParse(environment)
  if (!result.success) {
    const missing = new Set<string>()
    const invalid = new Set<string>()
    for (const issue of result.error.issues) {
      const name = issue.path[0]
      if (typeof name !== 'string') continue
      const value = environment[name]
      if (value === undefined || value.trim() === '') {
        missing.add(name)
      } else {
        invalid.add(name)
      }
    }
    throw new AuthConfigurationError([...missing], [...invalid])
  }

  const localMode =
    result.data.NODE_ENV === 'development' || result.data.NODE_ENV === 'test'
  if (!localMode && !result.data.APP_ORIGIN.startsWith('https://')) {
    throw new AuthConfigurationError([], ['APP_ORIGIN'])
  }

  return {
    sessionKey: result.data.AUTH_SESSION_KEY,
    appOrigin: result.data.APP_ORIGIN,
    secureCookies: !localMode,
  }
}

export function getAuthConfig(): AuthConfig {
  return parseAuthConfig({
    AUTH_SESSION_KEY: process.env.AUTH_SESSION_KEY,
    APP_ORIGIN: process.env.APP_ORIGIN,
    NODE_ENV: process.env.NODE_ENV,
  })
}

function cookie(
  name: string,
  value: string,
  config: AuthConfig,
  options: { httpOnly: boolean; sameSite: 'Lax' | 'Strict'; maxAge: number },
): string {
  return [
    `${name}=${value}`,
    'Path=/',
    `Max-Age=${options.maxAge}`,
    `SameSite=${options.sameSite}`,
    ...(options.httpOnly ? ['HttpOnly'] : []),
    ...(config.secureCookies ? ['Secure'] : []),
  ].join('; ')
}

function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get('cookie')
  if (!header) return undefined
  for (const part of header.split(';')) {
    const separator = part.indexOf('=')
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue
    try {
      return decodeURIComponent(part.slice(separator + 1).trim())
    } catch {
      return undefined
    }
  }
  return undefined
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  return (
    leftBytes.byteLength === rightBytes.byteLength &&
    timingSafeEqual(leftBytes, rightBytes)
  )
}

async function encryptSession(
  email: string,
  sessionVersion: string,
  csrfToken: string,
  config: AuthConfig,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return new EncryptJWT({ sub: 'primary-admin', email, sessionVersion, csrfToken })
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
    .setIssuer(SESSION_ISSUER)
    .setAudience(SESSION_AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + SESSION_SECONDS)
    .encrypt(config.sessionKey)
}

const sessionPayloadSchema = z.object({
  sub: z.literal('primary-admin'),
  email: z.string().email(),
  sessionVersion: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  csrfToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
})

async function decryptSession(
  token: string,
  config: AuthConfig,
): Promise<z.infer<typeof sessionPayloadSchema> | null> {
  try {
    const { payload } = await jwtDecrypt(token, config.sessionKey, {
      issuer: SESSION_ISSUER,
      audience: SESSION_AUDIENCE,
      keyManagementAlgorithms: ['dir'],
      contentEncryptionAlgorithms: ['A256GCM'],
    })
    const result = sessionPayloadSchema.safeParse(payload)
    return result.success ? result.data : null
  } catch {
    return null
  }
}

export function createAuthentication(
  config: AuthConfig,
  isSessionCurrent: typeof isPrimaryAdminSessionCurrent =
    isPrimaryAdminSessionCurrent,
) {
  async function createSession(
    email: string,
    sessionVersion: string,
  ): Promise<{
    sessionCookie: string
    csrfCookie: string
  }> {
    const csrfToken = randomCsrfToken()
    const sessionToken = await encryptSession(
      email,
      sessionVersion,
      csrfToken,
      config,
    )
    return {
      sessionCookie: cookie(SESSION_COOKIE, sessionToken, config, {
        httpOnly: true,
        sameSite: 'Lax',
        maxAge: SESSION_SECONDS,
      }),
      csrfCookie: cookie(CSRF_COOKIE, csrfToken, config, {
        httpOnly: false,
        sameSite: 'Strict',
        maxAge: SESSION_SECONDS,
      }),
    }
  }

  async function getSession(request: Request): Promise<AuthSession | null> {
    const token = readCookie(request, SESSION_COOKIE)
    if (!token) return null
    const payload = await decryptSession(token, config)
    return payload
      ? {
          email: payload.email,
          sessionVersion: payload.sessionVersion,
          csrfToken: payload.csrfToken,
        }
      : null
  }

  async function requireAuthenticated(request: Request): Promise<AuthSession> {
    const session = await getSession(request)
    if (!session) throw new AuthenticationError('unauthenticated')
    return session
  }

  async function requireAdmin(request: Request): Promise<AuthSession> {
    const session = await requireAuthenticated(request)
    if (
      !(await isSessionCurrent(
        session.email,
        session.sessionVersion,
      ))
    ) {
      throw new AuthenticationError('forbidden')
    }
    return session
  }

  function assertCsrf(request: Request, session: AuthSession): void {
    const csrfHeader = request.headers.get('x-csrf-token') ?? ''
    const csrfCookie = readCookie(request, CSRF_COOKIE) ?? ''
    if (
      request.headers.get('origin') !== config.appOrigin ||
      !csrfHeader ||
      !constantTimeEqual(csrfHeader, session.csrfToken) ||
      !constantTimeEqual(csrfCookie, session.csrfToken)
    ) {
      throw new AuthenticationError('csrf_failed')
    }
  }

  function clearCookies(): string[] {
    return [
      cookie(SESSION_COOKIE, '', config, {
        httpOnly: true,
        sameSite: 'Lax',
        maxAge: 0,
      }),
      cookie(CSRF_COOKIE, '', config, {
        httpOnly: false,
        sameSite: 'Strict',
        maxAge: 0,
      }),
    ]
  }

  return { createSession, getSession, requireAuthenticated, requireAdmin, assertCsrf, clearCookies }
}

function randomCsrfToken(): string {
  return randomBytes(32).toString('base64url')
}
