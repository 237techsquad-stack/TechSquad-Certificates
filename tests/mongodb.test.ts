import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MongoConfigurationError,
  mongoEnvironmentSchema,
  parseMongoEnvironment,
  resolveDatabaseName,
} from '../src/lib/mongodb.server.ts'

test('database name resolves from the MongoDB URI path', () => {
  assert.equal(
    resolveDatabaseName('mongodb://localhost:27017/certificates'),
    'certificates',
  )
})

test('database name from the URI takes precedence over the environment fallback', () => {
  assert.equal(
    resolveDatabaseName(
      'mongodb://localhost:27017/uri-database',
      'environment-database',
    ),
    'uri-database',
  )
})

test('database name falls back to the configured environment value', () => {
  assert.equal(
    resolveDatabaseName('mongodb://localhost:27017/', 'certificates'),
    'certificates',
  )
})

test('database-name resolution fails when neither name is configured', () => {
  const uri = 'mongodb://safe-user:private-password@localhost:27017/'
  assert.throws(
    () => resolveDatabaseName(uri),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.equal(error.message, 'MongoDB configuration is invalid')
      assert.equal(error.message.includes(uri), false)
      assert.equal(error.message.includes('private-password'), false)
      return true
    },
  )
})

test('environment validation requires a valid MongoDB URI', () => {
  assert.equal(
    mongoEnvironmentSchema.safeParse({
      MONGODB_URI: 'mongodb+srv://example.mongodb.net/certificates',
    }).success,
    true,
  )
  assert.equal(
    mongoEnvironmentSchema.safeParse({
      MONGODB_DATABASE_NAME: 'certificates',
    }).success,
    false,
  )
  assert.equal(
    mongoEnvironmentSchema.safeParse({ MONGODB_URI: 'https://example.com' })
      .success,
    false,
  )
})

test('environment parsing accepts the optional database-name fallback', () => {
  assert.deepEqual(
    parseMongoEnvironment({
      MONGODB_URI: 'mongodb://localhost:27017/',
    }),
    { MONGODB_URI: 'mongodb://localhost:27017/' },
  )
  assert.deepEqual(
    parseMongoEnvironment({
      MONGODB_URI: 'mongodb://localhost:27017/',
      MONGODB_DATABASE_NAME: 'certificates',
    }),
    {
      MONGODB_URI: 'mongodb://localhost:27017/',
      MONGODB_DATABASE_NAME: 'certificates',
    },
  )
})

test('environment parsing fails with a generic error for invalid settings', () => {
  assert.throws(
    () => parseMongoEnvironment({ MONGODB_URI: '' }),
    /MongoDB configuration is invalid/,
  )
})

test('MongoDB configuration errors identify only the invalid setting names', () => {
  assert.throws(
    () =>
      parseMongoEnvironment({
        MONGODB_URI: '',
      }),
    (error: unknown) => {
      assert.ok(error instanceof MongoConfigurationError)
      assert.deepEqual(error.settings, ['MONGODB_URI'])
      assert.equal(error.message, 'MongoDB configuration is invalid')
      return true
    },
  )
  assert.throws(
    () => resolveDatabaseName('mongodb://localhost:27017/'),
    (error: unknown) => {
      assert.ok(error instanceof MongoConfigurationError)
      assert.deepEqual(error.settings, ['MONGODB_DATABASE_NAME'])
      assert.equal(error.message, 'MongoDB configuration is invalid')
      return true
    },
  )
})
