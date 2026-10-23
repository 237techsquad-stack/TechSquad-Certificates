import { pathToFileURL } from 'node:url'
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { loadEnv } from 'vite'
import { provisionPrimaryAdmin } from '../src/lib/admin-credentials.server.ts'
import {
  MongoConfigurationError,
  MongoDatabaseUnavailableError,
  parseMongoEnvironment,
  resolveDatabaseName,
} from '../src/lib/mongodb.server.ts'

function readHidden(prompt: string): Promise<string> {
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
    throw new Error('A local interactive terminal is required')
  }

  stdout.write(prompt)
  stdin.setRawMode(true)
  stdin.resume()
  stdin.setEncoding('utf8')

  return new Promise((resolve, reject) => {
    let value = ''
    function finish(error?: Error) {
      stdin.setRawMode(false)
      stdin.pause()
      stdin.removeListener('data', onData)
      stdout.write('\n')
      if (error) reject(error)
      else resolve(value)
    }

    function onData(chunk: string) {
      for (const character of chunk) {
        if (character === '\u0003') {
          finish(new Error('Setup cancelled'))
          return
        }
        if (character === '\r' || character === '\n') {
          finish()
          return
        }
        if (character === '\u0008' || character === '\u007f') {
          value = value.slice(0, -1)
          continue
        }
        if (character >= ' ') value += character
      }
    }

    stdin.on('data', onData)
  })
}

async function run(): Promise<void> {
  const environment = loadEnv('development', process.cwd(), [
    'MONGODB_URI',
    'MONGODB_DATABASE_NAME',
  ])
  for (const name of ['MONGODB_URI', 'MONGODB_DATABASE_NAME'] as const) {
    const value = environment[name]
    if (value !== undefined) process.env[name] = value
  }
  const mongoEnvironment = parseMongoEnvironment(process.env)
  resolveDatabaseName(
    mongoEnvironment.MONGODB_URI,
    mongoEnvironment.MONGODB_DATABASE_NAME,
  )

  const args = process.argv.slice(2)
  const resetExisting = args.length === 1 && args[0] === '--reset-primary-admin'
  if (args.length > 0 && !resetExisting) {
    throw new Error('Unsupported setup option')
  }

  const readline = createInterface({ input: stdin, output: stdout })
  let email: string
  let confirmation = ''
  try {
    email = await readline.question('Administrator email: ')
    if (resetExisting) {
      confirmation = await readline.question(
        'Type RESET to explicitly authorize the password reset: ',
      )
    }
  } finally {
    readline.close()
  }
  if (resetExisting && confirmation !== 'RESET') {
    throw new Error('Password reset was not confirmed')
  }

  const password = await readHidden('Administrator password (12+ characters): ')
  const repeatedPassword = await readHidden('Confirm administrator password: ')
  if (password !== repeatedPassword) {
    throw new Error('Passwords do not match')
  }

  await provisionPrimaryAdmin(email, password, resetExisting)
  stdout.write(
    resetExisting
      ? 'Primary administrator password reset completed.\n'
      : 'Primary administrator provisioned.\n',
  )
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  run().catch((error: unknown) => {
    if (error instanceof MongoConfigurationError) {
      stdout.write(
        `Administrator setup failed: invalid MongoDB configuration (${error.settings.join(', ')}).\n`,
      )
      if (error.settings.includes('MONGODB_DATABASE_NAME')) {
        stdout.write(
          'Set MONGODB_DATABASE_NAME locally, or configure a database path in MONGODB_URI.\n',
        )
      } else {
        stdout.write('Set a valid MONGODB_URI in the local environment.\n')
      }
    } else if (error instanceof MongoDatabaseUnavailableError) {
      stdout.write(
        error.category === 'configuration'
          ? `Administrator setup failed: invalid MongoDB configuration (${error.settings.join(', ')}).\n`
          : 'Administrator setup failed: MongoDB connection could not be established. Check URI syntax, Atlas network access, and database-user permissions.\n',
      )
    } else {
      stdout.write(
        'Administrator setup failed. Check account state and terminal input, then retry.\n',
      )
    }
    process.exitCode = 1
  })
}
