import { createFileRoute } from '@tanstack/react-router'
import {
  adminIdSchema,
  createAdminMutationHandler,
  readIdParam,
  type AdminMutationApiDependencies,
} from '../../../../../lib/admin-api.server.ts'

export function createEnrollmentWithdrawPostHandler(
  dependencies?: AdminMutationApiDependencies,
) {
  return createAdminMutationHandler({
    schema: adminIdSchema,
    readInput: readIdParam,
    execute: (repositories, id) => repositories.withdrawEnrollment(id),
    dependencies,
  })
}

const withdrawEnrollment = createEnrollmentWithdrawPostHandler()

export const Route = createFileRoute('/api/admin/enrollments/$id/withdraw')({
  server: {
    handlers: {
      POST: ({ request, params }) => withdrawEnrollment(request, params),
    },
  },
})
