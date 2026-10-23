import { createFileRoute } from '@tanstack/react-router'
import {
  certificateFileStorage,
  nodeReadableToWebStream,
  CertificateFileError,
} from '../../../lib/certificate-files.server.ts'
import { createRepositories } from '../../../lib/repositories.server.ts'
import { verificationIdentifierSchema } from '../../../lib/models.server.ts'
import {
  limitPublicCertificateVerification,
  type PublicVerificationRateLimiter,
} from '../../../lib/verification-rate-limit.server.ts'

type Repositories = ReturnType<typeof createRepositories>
type FileStorage = typeof certificateFileStorage

export function createPublicCertificateFileGetHandler(
  getRepositories: () => Repositories = createRepositories,
  rateLimit: PublicVerificationRateLimiter =
    limitPublicCertificateVerification,
  storage: FileStorage = certificateFileStorage,
) {
  return async (
    request: Request,
    params: Record<string, string>,
  ): Promise<Response> => {
    try {
      if (await rateLimit(request)) return error(429, 'unavailable')
    } catch {
      console.warn(
        '[certificates] public download rate limiter unavailable; continuing retrieval',
      )
    }

    const token = verificationIdentifierSchema.safeParse(params.token)
    if (!token.success) return error(404, 'not_found')

    try {
      const file = await getRepositories().getPublicCertificateFile(token.data)
      if (!file) return error(404, 'not_found')
      const stream = await storage.stream(file.fileId)
      const disposition =
        new URL(request.url).searchParams.get('inline') === '1'
          ? 'inline'
          : 'attachment'
      return new Response(nodeReadableToWebStream(stream), {
        headers: {
          'Cache-Control': 'no-store',
          'Content-Type': 'application/pdf',
          'Content-Disposition': `${disposition}; filename="certificate-${file.certificateId}.pdf"`,
          'X-Content-Type-Options': 'nosniff',
        },
      })
    } catch (caughtError) {
      if (
        caughtError instanceof CertificateFileError &&
        caughtError.code === 'not_found'
      ) {
        return error(404, 'not_found')
      }
      return error(503, 'unavailable')
    }
  }
}

function error(status: number, code: string): Response {
  return Response.json(
    { error: code },
    { status, headers: { 'Cache-Control': 'no-store' } },
  )
}

const getPublicCertificateFile = createPublicCertificateFileGetHandler()

export const Route = createFileRoute('/api/verify/$token/file')({
  server: {
    handlers: {
      GET: ({ request, params }) => getPublicCertificateFile(request, params),
    },
  },
})
