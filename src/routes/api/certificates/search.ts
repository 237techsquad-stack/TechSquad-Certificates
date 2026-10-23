import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { createRepositories } from '../../../lib/repositories.server.ts'
import {
  limitPublicCertificateVerification,
  type PublicVerificationRateLimiter,
} from '../../../lib/verification-rate-limit.server.ts'

type Repositories = ReturnType<typeof createRepositories>

export function createPublicCertificateSearchGetHandler(
  getRepositories: () => Repositories = createRepositories,
  rateLimit: PublicVerificationRateLimiter =
    limitPublicCertificateVerification,
) {
  return async (request: Request): Promise<Response> => {
    try {
      if (await rateLimit(request)) return json({ results: [] }, 429)
    } catch {
      console.warn(
        '[certificates] public search rate limiter unavailable; continuing lookup',
      )
    }

    const values = new URL(request.url).searchParams.getAll('q')
    const query = z.string().trim().min(1).max(200).safeParse(
      values.length === 1 ? values[0] : undefined,
    )
    if (!query.success) return json({ results: [] }, 400)

    try {
      const results = await getRepositories().searchPublicCertificates(query.data)
      return json({ results })
    } catch {
      return json({ results: [] }, 503)
    }
  }
}

function json(result: { results: unknown[] }, status = 200): Response {
  return Response.json(result, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  })
}

const searchCertificates = createPublicCertificateSearchGetHandler()

export const Route = createFileRoute('/api/certificates/search')({
  server: {
    handlers: {
      GET: ({ request }) => searchCertificates(request),
    },
  },
})
