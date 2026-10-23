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
import { participantInputSchema } from '../../../../lib/models.server.ts'

export function createParticipantByIdGetHandler(
  dependencies?: AdminApiDependencies,
) {
  return createAdminGetHandler({
    schema: adminIdSchema,
    readInput: readIdParam,
    execute: (repositories, id) => repositories.getParticipantById(id),
    dependencies,
  })
}

export function createParticipantPatchHandler(
  dependencies?: AdminMutationApiDependencies,
) {
  return createAdminMutationHandler({
    schema: z.object({ id: adminIdSchema, body: participantInputSchema }),
    async readInput(request, params) {
      return { id: params.id, body: await readJsonBody(request) }
    },
    execute: (repositories, { id, body }) =>
      repositories.updateParticipant(id, body),
    dependencies,
  })
}

export function createParticipantDeleteHandler(
  dependencies?: AdminMutationApiDependencies,
) {
  return createAdminMutationHandler({
    schema: adminIdSchema,
    readInput: readIdParam,
    execute: (repositories, id) => repositories.deleteParticipant(id),
    dependencies,
  })
}

const getParticipantById = createParticipantByIdGetHandler()
const patchParticipant = createParticipantPatchHandler()
const deleteParticipant = createParticipantDeleteHandler()

export const Route = createFileRoute('/api/admin/participants/$id')({
  server: {
    handlers: {
      GET: ({ request, params }) => getParticipantById(request, params),
      PATCH: ({ request, params }) => patchParticipant(request, params),
      DELETE: ({ request, params }) => deleteParticipant(request, params),
    },
  },
})
