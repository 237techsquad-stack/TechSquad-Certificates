import '@tanstack/react-start/server-only'

import { MongoClient, type Db } from 'mongodb'
import { z } from 'zod'

const mongoUriSchema = z
  .string()
  .trim()
  .min(1)
  .refine(isMongoUri, 'Invalid MongoDB URI')

export const mongoEnvironmentSchema = z.object({
  MONGODB_URI: mongoUriSchema,
  MONGODB_DATABASE_NAME: z.string().trim().min(1).optional(),
})

export type MongoConfigurationSetting =
  | 'MONGODB_URI'
  | 'MONGODB_DATABASE_NAME'

export class MongoConfigurationError extends Error {
  readonly settings: readonly MongoConfigurationSetting[]

  constructor(settings: readonly MongoConfigurationSetting[]) {
    super('MongoDB configuration is invalid')
    this.name = 'MongoConfigurationError'
    this.settings = settings
  }
}

export class MongoDatabaseUnavailableError extends Error {
  readonly category: 'configuration' | 'connection'
  readonly settings: readonly MongoConfigurationSetting[]

  constructor(
    category: 'configuration' | 'connection',
    settings: readonly MongoConfigurationSetting[] = [],
  ) {
    super('Database service is unavailable')
    this.name = 'MongoDatabaseUnavailableError'
    this.category = category
    this.settings = settings
  }
}

type MongoConnectionState = {
  clientPromise?: Promise<MongoClient>
}

const mongoGlobal = globalThis as typeof globalThis & {
  __techSquadMongoConnection?: MongoConnectionState
}

function isMongoUri(value: string): boolean {
  try {
    const protocol = new URL(value).protocol
    return protocol === 'mongodb:' || protocol === 'mongodb+srv:'
  } catch {
    return false
  }
}

export function parseMongoEnvironment(
  environment: Record<string, string | undefined>,
) {
  const parsed = mongoEnvironmentSchema.safeParse(environment)
  if (!parsed.success) {
    const settings = [
      ...new Set(
        parsed.error.issues.map((issue) =>
          issue.path[0] === 'MONGODB_DATABASE_NAME'
            ? 'MONGODB_DATABASE_NAME' as const
            : 'MONGODB_URI' as const,
        ),
      ),
    ]
    throw new MongoConfigurationError(settings)
  }
  return parsed.data
}

export function resolveDatabaseName(
  uri: string,
  configuredDatabaseName?: string,
): string {
  let uriDatabaseName: string

  try {
    const pathname = new URL(uri).pathname
    uriDatabaseName = pathname.startsWith('/') ? pathname.slice(1) : pathname
    if (uriDatabaseName) {
      uriDatabaseName = decodeURIComponent(uriDatabaseName)
    }
  } catch {
    throw new MongoConfigurationError(['MONGODB_URI'])
  }

  if (uriDatabaseName) {
    return uriDatabaseName
  }

  const fallbackDatabaseName = configuredDatabaseName?.trim()
  if (fallbackDatabaseName) {
    return fallbackDatabaseName
  }

  throw new MongoConfigurationError(['MONGODB_DATABASE_NAME'])
}

function getConnectionState(): MongoConnectionState {
  mongoGlobal.__techSquadMongoConnection ??= {}
  return mongoGlobal.__techSquadMongoConnection
}

function connect(uri: string): Promise<MongoClient> {
  const state = getConnectionState()
  if (!state.clientPromise) {
    const client = new MongoClient(uri)
    const clientPromise = client.connect().then(() => client)
    state.clientPromise = clientPromise
    void clientPromise.catch(() => {
      if (state.clientPromise === clientPromise) {
        state.clientPromise = undefined
      }
    })
  }
  return state.clientPromise
}

export async function getDatabase(): Promise<Db> {
  try {
    const environment = parseMongoEnvironment(process.env)
    const databaseName = resolveDatabaseName(
      environment.MONGODB_URI,
      environment.MONGODB_DATABASE_NAME,
    )
    const client = await connect(environment.MONGODB_URI)
    return client.db(databaseName)
  } catch (error) {
    const category = error instanceof MongoConfigurationError
      ? 'configuration'
      : 'connection'
    const settings =
      error instanceof MongoConfigurationError ? error.settings : []
    const settingSummary = settings.length ? `: ${settings.join(', ')}` : ''
    console.error(`[mongodb] ${category} initialization failed${settingSummary}`)
    throw new MongoDatabaseUnavailableError(category, settings)
  }
}
