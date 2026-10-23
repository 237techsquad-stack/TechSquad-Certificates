import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { certificateIdSchema } from '../../../../../lib/models.server.ts'
import {
  createAdminMutationHandler,
  type AdminMutationApiDependencies,
} from '../../../../../lib/admin-api.server.ts'

const revokeCertificateRequestSchema = z.object({
  id: certificateIdSchema,
  body: z
    .object({
      reason: z.string().trim().min(1).max(1000),
    })
    .strict(),
})

export function createCertificateRevokePostHandler(
  dependencies?: AdminMutationApiDependencies,
) {
  return createAdminMutationHandler({
    schema: revokeCertificateRequestSchema,
    async readInput(request, params) {
      return {
        id: params.id,
        body: await request.json(),
      }
    },
    execute: (repositories, { id, body }) =>
      repositories.revokeCertificate(id, body.reason),
    dependencies,
  })
}

const revokeCertificate = createCertificateRevokePostHandler()

export const Route = createFileRoute('/api/admin/certificates/$id/revoke')({
  server: {
    handlers: {
      POST: ({ request, params }) => revokeCertificate(request, params),
    },
  },
})
