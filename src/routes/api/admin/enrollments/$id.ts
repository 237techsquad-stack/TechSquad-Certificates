import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import {
  adminIdSchema,
  createAdminGetHandler,
  createAdminMutationHandler,
  readIdParam,
  readJsonBody,
  type AdminApiDependencies,
  type AdminMutationApiDependencies,
} from '../../../../lib/admin-api.server.ts'
import { enrollmentDetailsInputSchema } from '../../../../lib/models.server.ts'

export function createEnrollmentByIdGetHandler(
  dependencies?: AdminApiDependencies,
) {
  return createAdminGetHandler({
    schema: adminIdSchema,
    readInput: readIdParam,
    execute: (repositories, id) => repositories.getEnrollmentById(id),
    dependencies,
  })
}

export function createEnrollmentPatchHandler(
  dependencies?: AdminMutationApiDependencies,
) {
  return createAdminMutationHandler({
    schema: z.object({
      id: adminIdSchema,
      body: enrollmentDetailsInputSchema.strict(),
    }),
    async readInput(request, params) {
      return { id: params.id, body: await readJsonBody(request) }
    },
    execute: (repositories, { id, body }) =>
      repositories.updateEnrollment(id, body),
    dependencies,
  })
}

export function createEnrollmentDeleteHandler(
  dependencies?: AdminMutationApiDependencies,
) {
  return createAdminMutationHandler({
    schema: adminIdSchema,
    readInput: readIdParam,
    execute: (repositories, id) => repositories.deleteEnrollment(id),
    dependencies,
  })
}

const getEnrollmentById = createEnrollmentByIdGetHandler()
const patchEnrollment = createEnrollmentPatchHandler()
const deleteEnrollment = createEnrollmentDeleteHandler()

export const Route = createFileRoute('/api/admin/enrollments/$id')({
  server: {
    handlers: {
      GET: ({ request, params }) => getEnrollmentById(request, params),
      PATCH: ({ request, params }) => patchEnrollment(request, params),
      DELETE: ({ request, params }) => deleteEnrollment(request, params),
    },
  },
})
