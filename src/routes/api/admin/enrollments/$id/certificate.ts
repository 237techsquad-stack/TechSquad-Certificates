import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { certificateFileStorage } from '../../../../../lib/certificate-files.server.ts'
import { MAX_CERTIFICATE_FILE_BYTES } from '../../../../../lib/certificate-files.server.ts'
import { certificateIssueInputSchema } from '../../../../../lib/models.server.ts'
import {
  adminIdSchema,
  createAdminMutationHandler,
  type AdminMutationApiDependencies,
} from '../../../../../lib/admin-api.server.ts'

const certificateUploadFieldsSchema = certificateIssueInputSchema
  .omit({ enrollmentId: true, templateId: true })
  .extend({
    file: z
      .instanceof(File)
      .refine((file) => file.size <= MAX_CERTIFICATE_FILE_BYTES),
  })

const issueCertificateUploadSchema = z.object({
  id: adminIdSchema,
  body: certificateUploadFieldsSchema.extend({
    issuanceMethod: z.literal('upload_existing'),
  }).strict(),
})

const MAX_REQUEST_BYTES = 4_000_000

export function createEnrollmentCertificatePostHandler(
  dependencies?: AdminMutationApiDependencies,
  storage = certificateFileStorage,
) {
  return createAdminMutationHandler({
    schema: issueCertificateUploadSchema,
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
      if (form.has('templateId')) {
        throw new Error('Template selection is no longer supported')
      }
      return {
        id: params.id,
        body: {
          issuanceMethod: form.get('issuanceMethod'),
          issueDate: form.get('issueDate') || undefined,
          file: form.get('file'),
        },
      }
    },
    async execute(repositories, { id, body }) {
      const stored = await storage.storePdf(body.file)
      try {
        const certificate = await repositories.createCertificate(
          {
            enrollmentId: id,
            issueDate: body.issueDate,
          },
          { fileId: stored.fileId.toHexString(), fileSize: stored.fileSize },
        )
        return { ...certificate, fileAvailable: true }
      } catch (error) {
        try {
          await storage.remove(stored.fileId)
        } catch {
          console.error('[certificate-files] unlinked upload cleanup failed')
        }
        throw error
      }
    },
    successStatus: 201,
    dependencies,
  })
}

const issueEnrollmentCertificate = createEnrollmentCertificatePostHandler()

export const Route = createFileRoute('/api/admin/enrollments/$id/certificate')(
  {
    server: {
      handlers: {
        POST: ({ request, params }) =>
          issueEnrollmentCertificate(request, params),
      },
    },
  },
)
