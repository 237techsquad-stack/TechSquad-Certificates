import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'

export type AdminDashboardAccess =
  | { status: 'authenticated'; email: string }
  | { status: 'unauthenticated' }
  | {
      status: 'configuration_error'
      missing: readonly string[]
      invalid: readonly string[]
    }
  | { status: 'unavailable' }

export const getAdminDashboardAccess = createServerFn({ method: 'GET' }).handler(
  async (): Promise<AdminDashboardAccess> => {
    let authentication: typeof import('./auth.server.ts') | undefined
    try {
      authentication = await import('./auth.server.ts')
      const session = await authentication
        .createAuthentication(authentication.getAuthConfig())
        .requireAdmin(getRequest())
      return { status: 'authenticated', email: session.email }
    } catch (error) {
      if (
        authentication &&
        error instanceof authentication.AuthConfigurationError
      ) {
        return {
          status: 'configuration_error',
          missing: error.missing,
          invalid: error.invalid,
        }
      }
      if (
        authentication &&
        error instanceof authentication.AuthenticationError &&
        (error.code === 'unauthenticated' || error.code === 'forbidden')
      ) {
        return { status: 'unauthenticated' }
      }
      return { status: 'unavailable' }
    }
  },
)
