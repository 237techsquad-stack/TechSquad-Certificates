import { createFileRoute } from '@tanstack/react-router'
import { createAuthRouteHandlers } from '../../../lib/auth-routes.server.ts'

const authRoutes = createAuthRouteHandlers()

export const Route = createFileRoute('/api/auth/logout')({
  server: {
    handlers: {
      POST: ({ request }) => authRoutes.logout(request),
    },
  },
})
