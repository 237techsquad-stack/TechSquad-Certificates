import { createFileRoute } from '@tanstack/react-router'
import {
  adminIdSchema,
  createAdminMutationHandler,
  readIdParam,
  type AdminMutationApiDependencies,
} from '../../../../../lib/admin-api.server.ts'

export function createEnrollmentCompletePostHandler(
  dependencies?: AdminMutationApiDependencies,
) {
  return createAdminMutationHandler({
    schema: adminIdSchema,
    readInput: readIdParam,
    execute: (repositories, id) => repositories.completeEnrollment(id),
    dependencies,
  })
}

const completeEnrollment = createEnrollmentCompletePostHandler()

export const Route = createFileRoute('/api/admin/enrollments/$id/complete')({
  server: {
    handlers: {
      POST: ({ request, params }) => completeEnrollment(request, params),
    },
  },
})
