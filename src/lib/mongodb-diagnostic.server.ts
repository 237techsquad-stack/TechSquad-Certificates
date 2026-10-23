import '@tanstack/react-start/server-only'

import { getDatabase } from './mongodb.server.ts'

type PingDatabase = {
  command(command: { ping: 1 }): Promise<unknown>
}

export async function runMongoDiagnostic(
  getDb: () => Promise<PingDatabase> = getDatabase,
  enabled = process.env.NODE_ENV === 'development',
): Promise<{ status: 'success' | 'failure' }> {
  if (!enabled) {
    return { status: 'failure' }
  }

  try {
    const database = await getDb()
    await database.command({ ping: 1 })
    return { status: 'success' }
  } catch {
    console.error('[mongodb] diagnostic check failed')
    return { status: 'failure' }
  }
}
