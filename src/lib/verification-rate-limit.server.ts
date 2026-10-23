import '@tanstack/react-start/server-only'

import { isIP } from 'node:net'
import { checkRateLimit } from '@vercel/firewall'

const VERIFICATION_RATE_LIMIT_ID = 'public-certificate-verification'
const ADMIN_LOGIN_RATE_LIMIT_ID = 'admin-password-login'
const RATE_LIMIT_TIMEOUT_MS = 1000

export type PublicVerificationRateLimiter = (
  request: Request,
) => Promise<boolean>

type RateLimitCheck = typeof checkRateLimit

export function createVercelVerificationRateLimiter(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  checkLimit: RateLimitCheck = checkRateLimit,
): PublicVerificationRateLimiter {
  return createVercelRateLimiter(
    VERIFICATION_RATE_LIMIT_ID,
    environment,
    checkLimit,
  )
}

export function createVercelAdminLoginRateLimiter(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  checkLimit: RateLimitCheck = checkRateLimit,
): PublicVerificationRateLimiter {
  return createVercelRateLimiter(
    ADMIN_LOGIN_RATE_LIMIT_ID,
    environment,
    checkLimit,
  )
}

function createVercelRateLimiter(
  ruleId: string,
  environment: Readonly<Record<string, string | undefined>>,
  checkLimit: RateLimitCheck,
): PublicVerificationRateLimiter {
  return async (request) => {
    if (
      environment.VERCEL !== '1' ||
      environment.NODE_ENV !== 'production'
    ) {
      throw new Error('Verification rate limiting is unavailable')
    }

    const clientIp = request.headers.get('x-forwarded-for')?.trim()
    if (!clientIp || isIP(clientIp) === 0) {
      throw new Error('Verification rate limiting is unavailable')
    }

    const result = await checkLimit(ruleId, {
      request,
      rateLimitKey: clientIp,
      timeout: RATE_LIMIT_TIMEOUT_MS,
    })
    if (result.error === 'not-found') {
      throw new Error('Verification rate limiting is unavailable')
    }

    return result.rateLimited
  }
}

export const limitPublicCertificateVerification =
  createVercelVerificationRateLimiter()
