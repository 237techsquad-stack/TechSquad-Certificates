import '@tanstack/react-start/server-only'

import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { getDatabase } from './mongodb.server.ts'

const ADMIN_RECORD_ID = 'primary'
const PASSWORD_COST = 32_768
const PASSWORD_BLOCK_SIZE = 8
const PASSWORD_PARALLELIZATION = 1
const PASSWORD_KEY_BYTES = 64
const emailSchema = z.string().trim().toLowerCase().email().max(320)
const passwordSchema = z.string().min(12).max(1024)

export interface PrimaryAdminDocument {
  _id: typeof ADMIN_RECORD_ID
  email: string
  passwordHash: string
  sessionVersion: string
  createdAt: Date
  updatedAt: Date
}

export interface PrimaryAdminProvisioningStore {
  create(document: PrimaryAdminDocument): Promise<void>
  reset(
    values: Pick<
      PrimaryAdminDocument,
      'email' | 'passwordHash' | 'sessionVersion' | 'updatedAt'
    >,
  ): Promise<boolean>
}

function encodedHash(salt: Buffer, derivedKey: Buffer): string {
  return [
    'scrypt',
    PASSWORD_COST,
    PASSWORD_BLOCK_SIZE,
    PASSWORD_PARALLELIZATION,
    salt.toString('base64url'),
    derivedKey.toString('base64url'),
  ].join('$')
}

async function derivePasswordKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(
      password,
      salt,
      PASSWORD_KEY_BYTES,
      {
        N: PASSWORD_COST,
        r: PASSWORD_BLOCK_SIZE,
        p: PASSWORD_PARALLELIZATION,
        maxmem: 64 * 1024 * 1024,
      },
      (error, derived) => {
        if (error) reject(error)
        else resolve(Buffer.from(derived))
      },
    )
  })
}

export async function hashAdminPassword(passwordInput: unknown): Promise<string> {
  const password = passwordSchema.parse(passwordInput)
  const salt = randomBytes(16)
  return encodedHash(salt, await derivePasswordKey(password, salt))
}

async function verifyPasswordHash(password: string, value: string): Promise<boolean> {
  const parts = value.split('$')
  if (
    parts.length !== 6 ||
    parts[0] !== 'scrypt' ||
    Number(parts[1]) !== PASSWORD_COST ||
    Number(parts[2]) !== PASSWORD_BLOCK_SIZE ||
    Number(parts[3]) !== PASSWORD_PARALLELIZATION
  ) {
    return false
  }
  const salt = Buffer.from(parts[4] ?? '', 'base64url')
  const expected = Buffer.from(parts[5] ?? '', 'base64url')
  if (salt.length !== 16 || expected.length !== PASSWORD_KEY_BYTES) return false
  const actual = await derivePasswordKey(password, salt)
  return timingSafeEqual(actual, expected)
}

export async function verifyAdminPassword(
  passwordInput: unknown,
  encoded: string,
): Promise<boolean> {
  const password = passwordSchema.safeParse(passwordInput)
  if (!password.success) return false
  return verifyPasswordHash(password.data, encoded)
}

let dummyPasswordHash: Promise<string> | undefined

export async function verifyPrimaryAdminCredentials(
  emailInput: unknown,
  passwordInput: unknown,
): Promise<string | null> {
  const email = emailSchema.safeParse(emailInput)
  const password = passwordSchema.safeParse(passwordInput)
  if (!email.success || !password.success) return null

  const database = await getDatabase()
  const record = await database
    .collection<PrimaryAdminDocument>('adminUsers')
    .findOne({ _id: ADMIN_RECORD_ID })
  const passwordHash =
    record?.passwordHash ??
    (await (dummyPasswordHash ??= hashAdminPassword(
      'unavailable-account-dummy-password',
    )))
  const passwordMatches = await verifyAdminPassword(password.data, passwordHash)
  return record && record.email === email.data && passwordMatches
    ? record.sessionVersion
    : null
}

export async function isPrimaryAdminSessionCurrent(
  email: string,
  sessionVersion: string,
): Promise<boolean> {
  const record = await (await getDatabase())
    .collection<PrimaryAdminDocument>('adminUsers')
    .findOne({ _id: ADMIN_RECORD_ID })
  if (!record || record.email !== email) return false
  const current = Buffer.from(record.sessionVersion)
  const received = Buffer.from(sessionVersion)
  return (
    current.byteLength === received.byteLength &&
    timingSafeEqual(current, received)
  )
}

export function createPrimaryAdminProvisioner(
  store: PrimaryAdminProvisioningStore = {
    async create(document) {
      await (await getDatabase())
        .collection<PrimaryAdminDocument>('adminUsers')
        .insertOne(document)
    },
    async reset(values) {
      const result = await (await getDatabase())
        .collection<PrimaryAdminDocument>('adminUsers')
        .updateOne(
          { _id: ADMIN_RECORD_ID },
          { $set: values },
        )
      return result.matchedCount > 0
    },
  },
) {
  return async function provisionPrimaryAdmin(
    emailInput: unknown,
    passwordInput: unknown,
    resetExisting = false,
  ): Promise<void> {
    const email = emailSchema.parse(emailInput)
    const passwordHash = await hashAdminPassword(passwordInput)
    const now = new Date()
    if (!resetExisting) {
      await store.create({
        _id: ADMIN_RECORD_ID,
        email,
        passwordHash,
        sessionVersion: randomBytes(32).toString('base64url'),
        createdAt: now,
        updatedAt: now,
      })
      return
    }

    const updated = await store.reset({
      email,
      passwordHash,
      sessionVersion: randomBytes(32).toString('base64url'),
      updatedAt: now,
    })
    if (!updated) throw new Error('Primary administrator does not exist')
  }
}

export const provisionPrimaryAdmin = createPrimaryAdminProvisioner()
