import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/api/diagnostics/mongodb')({
  server: {
    handlers: {
      POST: async () => {
        // TEMPORARY: remove this route after local Atlas verification.
        const headers = { 'Cache-Control': 'no-store' }
        try {
          const { runMongoDiagnostic } = await import(
            '../../../lib/mongodb-diagnostic.server'
          )
          const result = await runMongoDiagnostic()
          return Response.json(result, {
            status: result.status === 'success' ? 200 : 503,
            headers,
          })
        } catch {
          console.error('[mongodb] diagnostic endpoint failed')
          return Response.json(
            { status: 'failure' },
            { status: 503, headers },
          )
        }
      },
    },
  },
})
