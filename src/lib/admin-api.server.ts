import '@tanstack/react-start/server-only'

import type {} from '@tanstack/react-start'
import { z } from 'zod'
import {
  AuthenticationError,
  createAuthentication,
  getAuthConfig,
} from './auth.server.ts'
import {
  createRepositories,
  RepositoryError,
} from './repositories.server.ts'
import { CertificateFileError } from './certificate-files.server.ts'
import type { AuthSession } from './auth.server.ts'

type Repositories = ReturnType<typeof createRepositories>

export interface AdminApiDependencies {
  requireAdmin(request: Request): Promise<AuthSession>
  getRepositories(): Repositories
}

export interface AdminMutationApiDependencies extends AdminApiDependencies {
  assertCsrf(request: Request, session: AuthSession): void
}

const productionDependencies: AdminMutationApiDependencies = {
  requireAdmin: (request) =>
    createAuthentication(getAuthConfig()).requireAdmin(request),
  assertCsrf: (request, session) =>
    createAuthentication(getAuthConfig()).assertCsrf(request, session),
  getRepositories: () => createRepositories(),
}

export type AdminGetHandler = (
  request: Request,
  params?: Record<string, string>,
) => Promise<Response>

export function createAdminGetHandler<TInput>(options: {
  schema: z.ZodType<TInput>
  readInput(request: Request, params: Record<string, string>): unknown
  execute(repositories: Repositories, input: TInput): Promise<unknown>
  dependencies?: AdminApiDependencies
}): AdminGetHandler {
  const dependencies = options.dependencies ?? productionDependencies

  return async (request, params = {}) => {
    try {
      await dependencies.requireAdmin(request)
    } catch (error) {
      if (error instanceof AuthenticationError) {
        if (error.code === 'unauthenticated') {
          return jsonError(401, 'unauthenticated')
        }
        if (error.code === 'forbidden') {
          return jsonError(403, 'forbidden')
        }
      }
      return jsonError(503, 'authentication_unavailable')
    }

    const parsed = options.schema.safeParse(
      options.readInput(request, params),
    )
    if (!parsed.success) {
      return jsonError(400, 'invalid_request')
    }

    try {
      const repositories = dependencies.getRepositories()
      const result = await options.execute(repositories, parsed.data)
      if (result === null) {
        return jsonError(404, 'not_found')
      }
      return Response.json(result, { headers: noStoreHeaders })
    } catch (error) {
      if (error instanceof RepositoryError) {
        switch (error.code) {
          case 'invalid_input':
            return jsonError(400, 'invalid_request')
          case 'not_found':
            return jsonError(404, 'not_found')
          case 'duplicate':
          case 'conflict':
            return jsonError(409, 'conflict')
          case 'operation_failed':
            return jsonError(500, 'internal_error')
        }
      }
      return jsonError(500, 'internal_error')
    }
  }
}

export function createAdminMutationHandler<TInput>(options: {
  schema: z.ZodType<TInput>
  invalidRequestError?: (issues: readonly z.ZodIssue[]) => string
  readInput(request: Request, params: Record<string, string>): unknown | Promise<unknown>
  execute(repositories: Repositories, input: TInput): Promise<unknown>
  successStatus?: number
  dependencies?: AdminMutationApiDependencies
}): AdminGetHandler {
  const dependencies = options.dependencies ?? productionDependencies

  return async (request, params = {}) => {
    let session: AuthSession
    try {
      session = await dependencies.requireAdmin(request)
      dependencies.assertCsrf(request, session)
    } catch (error) {
      if (error instanceof AuthenticationError) {
        if (error.code === 'unauthenticated') {
          return jsonError(401, 'unauthenticated')
        }
        if (error.code === 'forbidden') {
          return jsonError(403, 'forbidden')
        }
        if (error.code === 'csrf_failed') {
          return jsonError(403, 'csrf_failed')
        }
      }
      return jsonError(503, 'authentication_unavailable')
    }

    let rawInput: unknown
    try {
      rawInput = await options.readInput(request, params)
    } catch {
      return jsonError(400, 'invalid_request')
    }
    const parsed = options.schema.safeParse(rawInput)
    if (!parsed.success) {
      return jsonError(
        400,
        options.invalidRequestError?.(parsed.error.issues) ?? 'invalid_request',
      )
    }

    try {
      const result = await options.execute(
        dependencies.getRepositories(),
        parsed.data,
      )
      return Response.json(result, {
        status: options.successStatus ?? 200,
        headers: noStoreHeaders,
      })
    } catch (error) {
      return mapRepositoryError(error)
    }
  }
}

export const adminIdSchema = z
  .string()
  .regex(/^[\da-f]{24}$/i)

export const participantSearchQuerySchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    email: z.string().trim().toLowerCase().email().optional(),
    page: z.preprocess(
      (value) => (value === undefined ? undefined : Number(value)),
      z.number().int().min(1).max(100_000).default(1),
    ),
    limit: z.preprocess(
      (value) => (value === undefined ? undefined : Number(value)),
      z.number().int().min(1).max(100).default(20),
    ),
  })

export function readParticipantSearchQuery(request: Request): unknown {
  const query = new URL(request.url).searchParams
  const getSingle = (name: string) => {
    const values = query.getAll(name)
    return values.length > 1 ? values : values[0] ?? undefined
  }
  return {
    name: getSingle('name'),
    email: getSingle('email'),
    page: getSingle('page'),
    limit: getSingle('limit'),
  }
}

export function readQueryParameters(
  request: Request,
  names: readonly string[],
): Record<string, unknown> {
  const query = new URL(request.url).searchParams
  return Object.fromEntries(
    names.map((name) => {
      const values = query.getAll(name)
      return [name, values.length > 1 ? values : values[0] ?? undefined]
    }),
  )
}

export function readIdParam(
  _request: Request,
  params: Record<string, string>,
): unknown {
  return params.id
}

export async function readJsonBody(request: Request): Promise<unknown> {
  return request.json()
}

const noStoreHeaders = { 'Cache-Control': 'no-store' }

function jsonError(status: number, error: string): Response {
  return Response.json({ error }, { status, headers: noStoreHeaders })
}

function mapRepositoryError(error: unknown): Response {
  if (error instanceof CertificateFileError) {
    if (error.code === 'invalid_file') return jsonError(400, 'invalid_request')
    if (error.code === 'not_found') return jsonError(404, 'not_found')
    return jsonError(500, 'internal_error')
  }
  if (error instanceof RepositoryError) {
    switch (error.code) {
      case 'invalid_input':
        return jsonError(400, 'invalid_request')
      case 'not_found':
        return jsonError(404, 'not_found')
      case 'duplicate':
      case 'conflict':
        return jsonError(409, 'conflict')
      case 'operation_failed':
        return jsonError(500, 'internal_error')
    }
  }
  return jsonError(500, 'internal_error')
}
