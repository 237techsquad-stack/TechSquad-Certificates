import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import {
  createAdminGetHandler,
  type AdminApiDependencies,
} from '../../../lib/admin-api.server.ts'

export function createAdminDashboardGetHandler(
  dependencies?: AdminApiDependencies,
) {
  return createAdminGetHandler({
    schema: z.object({}),
    readInput: () => ({}),
    execute: (repositories) => repositories.getDashboardStatistics(),
    dependencies,
  })
}

const getDashboardStatistics = createAdminDashboardGetHandler()

export const Route = createFileRoute('/api/admin/dashboard')({
  server: {
    handlers: {
      GET: ({ request }) => getDashboardStatistics(request),
    },
  },
})
