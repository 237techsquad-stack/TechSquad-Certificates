import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { createRepositories } from '../../../lib/repositories.server.ts'
import {
  limitPublicCertificateVerification,
  type PublicVerificationRateLimiter,
} from '../../../lib/verification-rate-limit.server.ts'

type Repositories = ReturnType<typeof createRepositories>

const publicNamesResponseSchema = z.object({
  names: z.array(z.string().trim().min(1).max(200)).max(12),
}).strict()

export function createPublicParticipantNamesGetHandler(
  getRepositories: () => Repositories = createRepositories,
  rateLimit: PublicVerificationRateLimiter =
    limitPublicCertificateVerification,
) {
  return async (request: Request): Promise<Response> => {
    if (new URL(request.url).search !== '') {
      return respond({ names: [] }, 400)
    }

    try {
      if (await rateLimit(request)) {
        return respond({ names: [] }, 429)
      }
    } catch {
      console.warn(
        '[public-names] rate limiter unavailable; continuing limited lookup',
      )
    }

    try {
      const parsed = publicNamesResponseSchema.safeParse({
        names: await getRepositories().listPublicParticipantNames(),
      })
      if (!parsed.success) return respond({ names: [] }, 503, false)
      return respond(parsed.data, 200, true)
    } catch {
      return respond({ names: [] }, 503, false)
    }
  }
}

function respond(
  payload: z.infer<typeof publicNamesResponseSchema>,
  status: number,
  cacheable = false,
): Response {
  return Response.json(payload, {
    status,
    headers: {
      'Cache-Control': cacheable
        ? 'public, max-age=60, stale-while-revalidate=120'
        : 'no-store',
    },
  })
}

const getPublicParticipantNames = createPublicParticipantNamesGetHandler()

export const Route = createFileRoute('/api/public/participant-names')({
  server: {
    handlers: {
      GET: ({ request }) => getPublicParticipantNames(request),
    },
  },
})
