import { createFileRoute } from '@tanstack/react-router'
import { participantInputSchema } from '../../../../lib/models.server.ts'
import {
  createAdminGetHandler,
  createAdminMutationHandler,
  participantSearchQuerySchema,
  readJsonBody,
  readParticipantSearchQuery,
  type AdminApiDependencies,
  type AdminMutationApiDependencies,
} from '../../../../lib/admin-api.server.ts'

export function createParticipantsGetHandler(
  dependencies?: AdminApiDependencies,
) {
  return createAdminGetHandler({
    schema: participantSearchQuerySchema,
    readInput: (request) => readParticipantSearchQuery(request),
    execute: (repositories, input) => repositories.searchParticipants(input),
    dependencies,
  })
}

export function createParticipantPostHandler(
  dependencies?: AdminMutationApiDependencies,
) {
  return createAdminMutationHandler({
    schema: participantInputSchema,
    readInput: readJsonBody,
    execute: (repositories, input) => repositories.createParticipant(input),
    successStatus: 201,
    dependencies,
  })
}

const getParticipants = createParticipantsGetHandler()
const createParticipant = createParticipantPostHandler()

export const Route = createFileRoute('/api/admin/participants/')({
  server: {
    handlers: {
      GET: ({ request }) => getParticipants(request),
      POST: ({ request }) => createParticipant(request),
    },
  },
})
