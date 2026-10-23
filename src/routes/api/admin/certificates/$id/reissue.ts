import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { certificateIdSchema } from '../../../../../lib/models.server.ts'
import {
  createAdminMutationHandler,
  type AdminMutationApiDependencies,
} from '../../../../../lib/admin-api.server.ts'

const requestCertificateReissueSchema = z.object({
  id: certificateIdSchema,
  body: z
    .object({
      idempotencyKey: z.string().trim().min(8).max(200),
    })
    .strict(),
})

export function createCertificateReissuePostHandler(
  dependencies?: AdminMutationApiDependencies,
) {
  return createAdminMutationHandler({
    schema: requestCertificateReissueSchema,
    async readInput(request, params) {
      return {
        id: params.id,
        body: await request.json(),
      }
    },
    async execute(repositories, { id, body }) {
      await repositories.requestCertificateReissue(id, body.idempotencyKey)
      return repositories.resumeCertificateReissue(body.idempotencyKey)
    },
    dependencies,
  })
}

const reissueCertificate = createCertificateReissuePostHandler()

export const Route = createFileRoute('/api/admin/certificates/$id/reissue')({
  server: {
    handlers: {
      POST: ({ request, params }) => reissueCertificate(request, params),
    },
  },
})
