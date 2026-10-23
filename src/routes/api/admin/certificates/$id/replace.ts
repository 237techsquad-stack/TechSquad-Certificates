import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import {
  certificateFileStorage,
  MAX_CERTIFICATE_FILE_BYTES,
} from '../../../../../lib/certificate-files.server.ts'
import { certificateIdSchema } from '../../../../../lib/models.server.ts'
import {
  createAdminMutationHandler,
  type AdminMutationApiDependencies,
} from '../../../../../lib/admin-api.server.ts'

const replacementSchema = z.object({
  id: certificateIdSchema,
  body: z.object({
    idempotencyKey: z.string().trim().min(8).max(200),
    file: z
      .instanceof(File)
      .refine((file) => file.size <= MAX_CERTIFICATE_FILE_BYTES),
  }).strict(),
})

const MAX_REQUEST_BYTES = 4_000_000

export function createCertificateReplacePostHandler(
  dependencies?: AdminMutationApiDependencies,
  storage = certificateFileStorage,
) {
  return createAdminMutationHandler({
    schema: replacementSchema,
    async readInput(request, params) {
      const contentLength = request.headers.get('content-length')
      if (!contentLength || !/^\d+$/.test(contentLength)) {
        throw new Error('Content length required')
      }
      const length = Number(contentLength)
      if (length > MAX_REQUEST_BYTES) {
        throw new Error('Request body too large')
      }
      const form = await request.formData()
      return {
        id: params.id,
        body: {
          idempotencyKey: form.get('idempotencyKey'),
          file: form.get('file'),
        },
      }
    },
    async execute(repositories, { id, body }) {
      const stored = await storage.storePdf(body.file)
      try {
        await repositories.requestCertificateReissue(id, body.idempotencyKey)
        await repositories.resumeCertificateReissue(body.idempotencyKey)
        const existing = await repositories.getCertificateReissueReplacement(
          body.idempotencyKey,
        )
        if (!existing) throw new Error('Replacement is not ready')
        if (existing.fileAvailable) {
          await storage.remove(stored.fileId)
          return existing
        }
        const replacement =
          await repositories.attachReplacementCertificateFile(
            existing.certificateId,
            stored.fileId.toHexString(),
            stored.fileSize,
          )
        return { ...replacement, fileAvailable: true }
      } catch (error) {
        try {
          await storage.remove(stored.fileId)
        } catch {
          console.error('[certificate-files] replacement cleanup failed')
        }
        throw error
      }
    },
    dependencies,
  })
}

const replaceCertificate = createCertificateReplacePostHandler()

export const Route = createFileRoute('/api/admin/certificates/$id/replace')({
  server: {
    handlers: {
      POST: ({ request, params }) => replaceCertificate(request, params),
    },
  },
})
