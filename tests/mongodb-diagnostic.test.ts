import assert from 'node:assert/strict'
import test from 'node:test'

import { runMongoDiagnostic } from '../src/lib/mongodb-diagnostic.server.ts'

test('diagnostic returns only a success status after a ping', async () => {
  let receivedPing = false

  const result = await runMongoDiagnostic(
    async () => ({
      command: async (command) => {
        receivedPing = command.ping === 1
        return { ok: 1, database: 'must not be returned' }
      },
    }),
    true,
  )

  assert.equal(receivedPing, true)
  assert.deepEqual(result, { status: 'success' })
})

test('diagnostic returns only a failure status when connection fails', async () => {
  const result = await runMongoDiagnostic(
    async () => {
      throw new Error('mongodb://user:password@private-host/database')
    },
    true,
  )

  assert.deepEqual(result, { status: 'failure' })
  assert.equal(JSON.stringify(result).includes('private-host'), false)
})

test('diagnostic returns failure without accessing the database when disabled', async () => {
  let databaseAccessed = false

  const result = await runMongoDiagnostic(async () => {
    databaseAccessed = true
    throw new Error('Should not be reached')
  }, false)

  assert.deepEqual(result, { status: 'failure' })
  assert.equal(databaseAccessed, false)
})
