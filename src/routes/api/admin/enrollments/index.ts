import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { enrollmentInputSchema } from '../../../../lib/models.server.ts'
import {
  adminIdSchema,
  createAdminGetHandler,
  createAdminMutationHandler,
  readQueryParameters,
  readJsonBody,
  type AdminApiDependencies,
  type AdminMutationApiDependencies,
} from '../../../../lib/admin-api.server.ts'

const enrollmentSearchQuerySchema = z.object({
  participantId: adminIdSchema.optional(),
  status: z.enum(['in_progress', 'completed', 'withdrawn']).optional(),
  query: z.string().trim().min(1).max(200).optional(),
  page: z.preprocess(
    (value) => (value === undefined ? undefined : Number(value)),
    z.number().int().min(1).max(100_000).default(1),
  ),
  limit: z.preprocess(
    (value) => (value === undefined ? undefined : Number(value)),
    z.number().int().min(1).max(100).default(20),
  ),
})

export function createEnrollmentsGetHandler(
  dependencies?: AdminApiDependencies,
) {
  return createAdminGetHandler({
    schema: enrollmentSearchQuerySchema,
    readInput: (request) =>
      readQueryParameters(request, [
        'participantId',
        'status',
        'query',
        'page',
        'limit',
      ]),
    execute: (repositories, input) => repositories.searchEnrollments(input),
    dependencies,
  })
}

export function createEnrollmentPostHandler(
  dependencies?: AdminMutationApiDependencies,
) {
  return createAdminMutationHandler({
    schema: enrollmentInputSchema,
    invalidRequestError: (issues) => {
      const field = issues[0]?.path[0]
      if (field === 'participantId') return 'invalid_participant_id'
      if (field === 'courseId') return 'invalid_course_id'
      if (field === 'courseName') return 'invalid_course_name'
      return 'invalid_request'
    },
    readInput: readJsonBody,
    execute: (repositories, input) => repositories.createEnrollment(input),
    successStatus: 201,
    dependencies,
  })
}

const getEnrollments = createEnrollmentsGetHandler()
const createEnrollment = createEnrollmentPostHandler()

export const Route = createFileRoute('/api/admin/enrollments/')({
  server: {
    handlers: {
      GET: ({ request }) => getEnrollments(request),
      POST: ({ request }) => createEnrollment(request),
    },
  },
})
