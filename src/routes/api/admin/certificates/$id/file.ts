import { createFileRoute } from '@tanstack/react-router'
import { AuthenticationError } from '../../../../../lib/auth.server.ts'
import {
  certificateFileStorage,
  nodeReadableToWebStream,
} from '../../../../../lib/certificate-files.server.ts'
import type { AdminApiDependencies } from '../../../../../lib/admin-api.server.ts'
import { createRepositories } from '../../../../../lib/repositories.server.ts'

type FileStorage = typeof certificateFileStorage

export function createAdminCertificateFileGetHandler(
  dependencies: AdminApiDependencies = {
    requireAdmin: async (request) => {
      const { createAuthentication, getAuthConfig } =
        await import('../../../../../lib/auth.server.ts')
      return createAuthentication(getAuthConfig()).requireAdmin(request)
    },
    getRepositories: createRepositories,
  },
  storage: FileStorage = certificateFileStorage,
) {
  return async (
    request: Request,
    params: Record<string, string>,
  ): Promise<Response> => {
    try {
      await dependencies.requireAdmin(request)
    } catch (error) {
      if (error instanceof AuthenticationError) {
        return Response.json(
          { error: error.code === 'unauthenticated' ? 'unauthenticated' : 'forbidden' },
          { status: error.code === 'unauthenticated' ? 401 : 403, headers: { 'Cache-Control': 'no-store' } },
        )
      }
      return Response.json(
        { error: 'authentication_unavailable' },
        { status: 503, headers: { 'Cache-Control': 'no-store' } },
      )
    }

    try {
      const certificateId = params.id
      const record = await dependencies
        .getRepositories()
        .getCertificateFileById(certificateId)
      if (!record) {
        return Response.json(
          { error: 'not_found' },
          { status: 404, headers: { 'Cache-Control': 'no-store' } },
        )
      }
      const file = await storage.stream(record.fileId)
      const disposition =
        new URL(request.url).searchParams.get('inline') === '1'
          ? 'inline'
          : 'attachment'
      return new Response(nodeReadableToWebStream(file), {
        headers: {
          'Cache-Control': 'no-store',
          'Content-Type': 'application/pdf',
          'Content-Disposition': `${disposition}; filename="certificate-${record.certificateId}.pdf"`,
          'X-Content-Type-Options': 'nosniff',
        },
      })
    } catch {
      return Response.json(
        { error: 'file_unavailable' },
        { status: 500, headers: { 'Cache-Control': 'no-store' } },
      )
    }
  }
}

const getCertificateFile = createAdminCertificateFileGetHandler()

export const Route = createFileRoute('/api/admin/certificates/$id/file')({
  server: {
    handlers: {
      GET: ({ request, params }) => getCertificateFile(request, params),
    },
  },
})
