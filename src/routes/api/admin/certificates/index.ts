import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import {
  createAdminGetHandler,
  readQueryParameters,
  type AdminApiDependencies,
} from '../../../../lib/admin-api.server.ts'

const certificateSearchQuerySchema = z.object({
  query: z.string().trim().min(1).max(100).optional(),
  status: z.enum(['issued', 'revoked']).optional(),
  page: z.preprocess(
    (value) => (value === undefined ? undefined : Number(value)),
    z.number().int().min(1).max(100_000).default(1),
  ),
  limit: z.preprocess(
    (value) => (value === undefined ? undefined : Number(value)),
    z.number().int().min(1).max(100).default(20),
  ),
})

export function createCertificatesGetHandler(
  dependencies?: AdminApiDependencies,
) {
  return createAdminGetHandler({
    schema: certificateSearchQuerySchema,
    readInput: (request) =>
      readQueryParameters(request, ['query', 'status', 'page', 'limit']),
    execute: (repositories, input) => repositories.searchCertificates(input),
    dependencies,
  })
}

const getCertificates = createCertificatesGetHandler()

export const Route = createFileRoute('/api/admin/certificates/')({
  server: {
    handlers: {
      GET: ({ request }) => getCertificates(request),
    },
  },
})
