import { createFileRoute } from '@tanstack/react-router'
import {
  verificationIdentifierSchema,
  type SerializedCertificate,
} from '../../../lib/models.server.ts'
import { createRepositories } from '../../../lib/repositories.server.ts'
import {
  limitPublicCertificateVerification,
  type PublicVerificationRateLimiter,
} from '../../../lib/verification-rate-limit.server.ts'

type Repositories = ReturnType<typeof createRepositories>

export function createPublicCertificateVerificationGetHandler(
  getRepositories: () => Repositories = createRepositories,
  rateLimit: PublicVerificationRateLimiter =
    limitPublicCertificateVerification,
) {
  return async (
    request: Request,
    params: Record<string, string>,
  ): Promise<Response> => {
    try {
      if (await rateLimit(request)) {
        return publicJson({ valid: false }, 429)
      }
    } catch {
      return publicJson({ valid: false }, 503)
    }

    const token = verificationIdentifierSchema.safeParse(params.token)
    if (!token.success) {
      return publicJson({ valid: false })
    }

    try {
      const certificate = await getRepositories()
        .getCertificateByVerificationIdentifier(token.data)
      if (!certificate || certificate.status !== 'issued') {
        return publicJson({ valid: false })
      }
      const file = await getRepositories().getPublicCertificateFile(token.data)
      return publicJson({
        ...publicCertificateResult(certificate),
        ...(file
          ? { downloadUrl: `/api/verify/${encodeURIComponent(token.data)}/file` }
          : {}),
      })
    } catch {
      return publicJson({ valid: false }, 503)
    }
  }
}

function publicCertificateResult(certificate: SerializedCertificate) {
  return {
    valid: true,
    certificateId: certificate.certificateId,
    issueDate: certificate.issueDate,
  }
}

function publicJson(
  result:
    | (ReturnType<typeof publicCertificateResult> & { downloadUrl?: string })
    | { valid: false },
  status = 200,
): Response {
  return Response.json(result, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  })
}

const verifyCertificate = createPublicCertificateVerificationGetHandler()

export const Route = createFileRoute('/api/verify/$token')({
  server: {
    handlers: {
      GET: ({ request, params }) => verifyCertificate(request, params),
    },
  },
})
