import assert from 'node:assert/strict'
import test from 'node:test'

import { MongoServerError, ObjectId, type Db } from 'mongodb'
import {
  createRepositories,
  RepositoryError,
} from '../src/lib/repositories.server.ts'
import {
  MODEL_INDEXES,
  type CertificateDocument,
} from '../src/lib/models.server.ts'

type Document = Record<string, unknown>
type MockIndex = {
  name: string
  key: Record<string, 1 | -1>
  unique?: boolean
  sparse?: boolean
  partialFilterExpression?: Document
}

const reissueIndexNames = new Set([
  'certificates_one_issued_per_enrollment',
  'certificates_reissue_workflow_unique',
  'certificate_reissue_idempotency_unique',
  'certificate_reissue_active_enrollment_unique',
  'certificates_certificate_id_unique',
  'certificates_verification_identifier_unique',
])

function configuredReissueIndexes(): MockIndex[] {
  return MODEL_INDEXES.filter((index) =>
    reissueIndexNames.has(index.options.name ?? ''),
  ).map((index) => ({
    name: index.options.name ?? '',
    key: index.keys as Record<string, 1 | -1>,
    ...('unique' in index.options ? { unique: index.options.unique } : {}),
    ...('sparse' in index.options ? { sparse: index.options.sparse } : {}),
    ...('partialFilterExpression' in index.options
      ? { partialFilterExpression: index.options.partialFilterExpression as Document }
      : {}),
  }))
}

function duplicateKeyError(): MongoServerError {
  const error = new MongoServerError({ message: 'duplicate key' })
  error.code = 11000
  return error
}

function equalValue(left: unknown, right: unknown): boolean {
  if (left instanceof ObjectId && right instanceof ObjectId) {
    return left.equals(right)
  }
  return left === right
}

function matches(document: Document, filter: Document): boolean {
  return Object.entries(filter).every(([key, expected]) => {
    const actual = document[key]
    if (
      expected !== null &&
      typeof expected === 'object' &&
      '$regex' in expected
    ) {
      const options = '$options' in expected ? String(expected.$options) : ''
      return new RegExp(String(expected.$regex), options).test(String(actual))
    }
    if (
      expected !== null &&
      typeof expected === 'object' &&
      '$exists' in expected
    ) {
      return (actual !== undefined) === Boolean(expected.$exists)
    }
    return equalValue(actual, expected)
  })
}

function cloneDocument<T extends Document>(document: T): T {
  return { ...document }
}

function createFakeDatabase(options: {
  indexes?: MockIndex[]
  beforeInsert?: (collection: string, document: Document) => Promise<void>
  afterInsert?: (collection: string, document: Document) => Promise<void>
  beforeUpdate?: (
    collection: string,
    filter: Document,
    update: Document,
  ) => Promise<void>
} = {}) {
  const documents = new Map<string, Document[]>()
  const duplicateIndexHits: string[] = []
  let configuredIndexes = options.indexes ?? []
  let beforeListIndexes: (() => Promise<void>) | undefined

  const db = {
    collection(collectionName: string) {
      const collectionDocuments = documents.get(collectionName) ?? []
      documents.set(collectionName, collectionDocuments)
      return {
        listIndexes() {
          return {
            async toArray() {
              await beforeListIndexes?.()
              return configuredIndexes.filter((index) =>
                index.name.startsWith('certificates_')
                  ? collectionName === 'certificates'
                  : collectionName === 'certificateReissueWorkflows',
              )
            },
          }
        },
        async insertOne(document: Document) {
          await options.beforeInsert?.(collectionName, document)
          const candidateIndexes: MockIndex[] = [
            { name: '_id_', key: { _id: 1 }, unique: true },
            ...configuredIndexes.filter(
              (index) =>
                index.unique &&
                (index.name.startsWith('certificates_')
                  ? collectionName === 'certificates'
                  : collectionName === 'certificateReissueWorkflows'),
            ),
          ]
          for (const index of candidateIndexes) {
            if (
              index.partialFilterExpression &&
              !matches(document, index.partialFilterExpression)
            ) {
              continue
            }
            const fields = Object.keys(index.key)
            if (
              index.sparse &&
              fields.some((field) => document[field] === undefined)
            ) {
              continue
            }
            const duplicate = collectionDocuments.some((existing) =>
              (!index.partialFilterExpression ||
                matches(existing, index.partialFilterExpression)) &&
                fields.every((field) =>
                  equalValue(existing[field], document[field]),
                ),
            )
            if (duplicate) {
              duplicateIndexHits.push(index.name)
              throw duplicateKeyError()
            }
          }
          collectionDocuments.push(document)
          await options.afterInsert?.(collectionName, document)
          return { insertedId: document._id }
        },
        async findOne(filter: Document) {
          const document = collectionDocuments.find((candidate) =>
            matches(candidate, filter),
          )
          return document ? cloneDocument(document) : null
        },
        async countDocuments(filter: Document = {}) {
          return collectionDocuments.filter((document) =>
            matches(document, filter),
          ).length
        },
        find(filter: Document) {
          let found = collectionDocuments.filter((candidate) =>
            matches(candidate, filter),
          )
          let offset = 0
          let limit = Number.POSITIVE_INFINITY
          let sort: Record<string, 1 | -1> = {}
          const cursor = {
            sort(definition: Record<string, 1 | -1>) {
              sort = definition
              return cursor
            },
            skip(count: number) {
              offset = count
              return cursor
            },
            limit(count: number) {
              limit = count
              return cursor
            },
            async toArray() {
              found = [...found].sort((left, right) => {
                for (const [key, direction] of Object.entries(sort)) {
                  const comparison = String(left[key]).localeCompare(
                    String(right[key]),
                  )
                  if (comparison) return comparison * direction
                }
                return 0
              })
              return found.slice(offset, offset + limit).map(cloneDocument)
            },
          }
          return cursor
        },
        aggregate(pipeline: Document[]) {
          return {
            async toArray() {
              const filters = pipeline.flatMap((stage) =>
                '$match' in stage ? [stage.$match as Document] : [],
              )
              const certificateFilter = filters[0] ?? {}
              const requiresStoredFileLookup = pipeline.some(
                (stage) =>
                  '$lookup' in stage &&
                  (stage.$lookup as Document).from === 'certificateFiles.files',
              )
              const participantFilter = filters.find((filter) =>
                'participant.name' in filter,
              )
              const nameCondition = participantFilter?.['participant.name'] as
                | { $regex: string; $options: string }
                | undefined
              const namePattern = nameCondition
                ? new RegExp(nameCondition.$regex, nameCondition.$options)
                : undefined
              const results: Document[] = []
              for (const certificate of collectionDocuments) {
                if (!matches(certificate, certificateFilter)) continue
                if (
                  requiresStoredFileLookup &&
                  !(documents.get('certificateFiles.files') ?? []).some(
                    (file) => equalValue(file._id, certificate.fileId),
                  )
                ) {
                  continue
                }
                const enrollmentDocuments = documents.get('enrollments') ?? []
                const enrollment = enrollmentDocuments.find((candidate) =>
                  equalValue(candidate._id, certificate.enrollmentId),
                )
                if (!enrollment) continue
                const participantDocuments = documents.get('participants') ?? []
                const participant = participantDocuments.find((candidate) =>
                  equalValue(candidate._id, enrollment.participantId),
                )
                if (!participant) continue
                if (namePattern && !namePattern.test(String(participant.name))) {
                  continue
                }
                results.push({
                  certificateId: certificate.certificateId,
                  verificationIdentifier: certificate.verificationIdentifier,
                  status: certificate.status,
                  issueDate: certificate.issueDate,
                  participantName: participant.name,
                  courseName: enrollment.courseName,
                })
              }
              return results
                .sort(
                  (left, right) =>
                    new Date(String(right.issueDate)).getTime() -
                    new Date(String(left.issueDate)).getTime(),
                )
                .slice(0, 10)
            },
          }
        },
        async updateOne(filter: Document, update: Document) {
          await options.beforeUpdate?.(collectionName, filter, update)
          const document = collectionDocuments.find((candidate) =>
            matches(candidate, filter),
          )
          if (!document) return { matchedCount: 0 }
          const updated = cloneDocument(document)
          const set = update.$set as Document | undefined
          const unset = update.$unset as Document | undefined
          const increment = update.$inc as Document | undefined
          if (set) Object.assign(updated, set)
          if (increment) {
            for (const [key, value] of Object.entries(increment)) {
              updated[key] = Number(updated[key] ?? 0) + Number(value)
            }
          }
          if (unset) {
            for (const key of Object.keys(unset)) delete updated[key]
          }
          Object.assign(document, updated)
          return { matchedCount: 1 }
        },
        async deleteOne(filter: Document) {
          const index = collectionDocuments.findIndex((candidate) =>
            matches(candidate, filter),
          )
          if (index < 0) return { deletedCount: 0 }
          collectionDocuments.splice(index, 1)
          return { deletedCount: 1 }
        },
      }
    },
    client: {
      startSession() {
        return {
          async withTransaction<T>(operation: () => Promise<T>) {
            return operation()
          },
          async endSession() {},
        }
      },
    },
  }

  return {
    db: db as unknown as Db,
    setIndexes(indexes: MockIndex[]) {
      configuredIndexes = indexes
    },
    setBeforeListIndexes(callback: () => Promise<void>) {
      beforeListIndexes = callback
    },
    replaceDocument(collection: string, document: Document) {
      const collectionDocuments = documents.get(collection) ?? []
      documents.set(collection, collectionDocuments)
      const existingIndex = collectionDocuments.findIndex((candidate) =>
        equalValue(candidate._id, document._id),
      )
      if (existingIndex < 0) {
        collectionDocuments.push(document)
      } else {
        collectionDocuments[existingIndex] = document
      }
    },
    removeDocument(collection: string, id: ObjectId) {
      const collectionDocuments = documents.get(collection) ?? []
      const index = collectionDocuments.findIndex((candidate) =>
        equalValue(candidate._id, id),
      )
      if (index >= 0) collectionDocuments.splice(index, 1)
    },
    getDocuments<T>(collection: string): T[] {
      return (documents.get(collection) ?? []).map(cloneDocument) as unknown as T[]
    },
    getDuplicateIndexHits() {
      return [...duplicateIndexHits]
    },
  }
}

function setup(
  fakeOptions: Parameters<typeof createFakeDatabase>[0] = {},
) {
  const fake = createFakeDatabase(fakeOptions)
  let databaseAccesses = 0
  const repositories = createRepositories(async () => {
    databaseAccesses += 1
    return fake.db
  })
  return {
    ...repositories,
    fake,
    get databaseAccesses() {
      return databaseAccesses
    },
  }
}

async function createCompletedEnrollment(
  repositories: ReturnType<typeof setup>,
  email = 'person@example.com',
  courseId = 'web-foundations',
  participantName = 'Participant',
) {
  const participant = await repositories.createParticipant({
    name: participantName,
    email,
  })
  const enrollment = await repositories.createEnrollment({
    participantId: participant.id,
    courseId,
    courseName: 'Web Foundations',
  })
  const completed = await repositories.completeEnrollment(enrollment.id)
  return { participant, enrollment: completed }
}

async function createTemplate(repositories: ReturnType<typeof setup>) {
  return repositories.createCertificateTemplate({
    name: 'Completion',
    description: 'Course completion certificate',
    layout: { page: { width: 1200 } },
    allowedDynamicFields: ['participant.name', 'enrollment.courseName'],
  })
}

test('repositories are lazy and participant results preserve display name', async () => {
  const repositories = setup()
  assert.equal(repositories.databaseAccesses, 0)
  const participant = await repositories.createParticipant({
    name: '  Amelie Ngu ',
    email: ' AMELIE@EXAMPLE.COM ',
  })
  assert.equal(participant.name, 'Amelie Ngu')
  assert.equal(participant.email, 'amelie@example.com')
  assert.equal('_id' in participant, false)
  assert.deepEqual(await repositories.getParticipantByEmail(' AMELIE@EXAMPLE.COM '), participant)
  assert.deepEqual(await repositories.getParticipantById(participant.id), participant)
})

test('participants can only be deleted after related enrollments are removed', async () => {
  const repositories = setup()
  const participant = await repositories.createParticipant({
    name: 'Amelie Ngu',
    email: 'amelie@example.test',
  })
  const enrollment = await repositories.createEnrollment({
    participantId: participant.id,
    courseId: 'web-foundations',
    courseName: 'Web Foundations',
  })

  await assert.rejects(
    repositories.deleteParticipant(participant.id),
    (error: unknown) => error instanceof RepositoryError && error.code === 'conflict',
  )
  assert.ok(await repositories.getParticipantById(participant.id))

  await repositories.deleteEnrollment(enrollment.id)
  assert.deepEqual(await repositories.deleteParticipant(participant.id), {
    deleted: true,
  })
  assert.equal(await repositories.getParticipantById(participant.id), null)
})

test('public participant names include only opted-in distinct display names', async () => {
  const repositories = setup()
  await repositories.createParticipant({
    name: 'Amelie Ngu',
    email: 'amelie@example.test',
    displayNamePublicly: true,
  })
  await repositories.createParticipant({
    name: '  amelie ngu ',
    email: 'amelie2@example.test',
    displayNamePublicly: true,
  })
  await repositories.createParticipant({
    name: 'Private Person',
    email: 'private@example.test',
  })

  assert.deepEqual(await repositories.listPublicParticipantNames(), [
    'amelie ngu',
  ])
})

test('only unlinked in-progress enrollments can be edited or deleted', async () => {
  const repositories = setup()
  const participant = await repositories.createParticipant({
    name: 'Participant',
    email: 'participant@example.test',
  })
  const enrollment = await repositories.createEnrollment({
    participantId: participant.id,
    courseId: 'web-foundations',
    courseName: 'Web Foundations',
  })

  const updated = await repositories.updateEnrollment(enrollment.id, {
    courseId: 'data-foundations',
    courseName: 'Data Foundations',
  })
  assert.equal(updated.participantId, participant.id)
  assert.equal(updated.courseId, 'data-foundations')
  assert.equal(updated.courseName, 'Data Foundations')

  await repositories.deleteEnrollment(enrollment.id)
  assert.equal(await repositories.getEnrollmentById(enrollment.id), null)

  const completed = await repositories.createEnrollment({
    participantId: participant.id,
    courseId: 'web-foundations',
    courseName: 'Web Foundations',
  })
  await repositories.completeEnrollment(completed.id)
  await assert.rejects(
    repositories.updateEnrollment(completed.id, {
      courseId: 'data-foundations',
      courseName: 'Data Foundations',
    }),
    (error: unknown) => error instanceof RepositoryError && error.code === 'conflict',
  )
  await assert.rejects(
    repositories.deleteEnrollment(completed.id),
    (error: unknown) => error instanceof RepositoryError && error.code === 'conflict',
  )
  assert.ok(await repositories.getEnrollmentById(completed.id))
})

test('enrollments linked to certificate or reissue records cannot be deleted', async () => {
  const repositories = setup()
  const participant = await repositories.createParticipant({
    name: 'Participant',
    email: 'participant@example.test',
  })
  const enrollment = await repositories.createEnrollment({
    participantId: participant.id,
    courseId: 'web-foundations',
    courseName: 'Web Foundations',
  })
  repositories.fake.replaceDocument('certificates', {
    _id: new ObjectId(),
    enrollmentId: new ObjectId(enrollment.id),
    certificateId: 'TS-TEST-CERT',
  })

  await assert.rejects(
    repositories.deleteEnrollment(enrollment.id),
    (error: unknown) => error instanceof RepositoryError && error.code === 'conflict',
  )
  assert.ok(await repositories.getEnrollmentById(enrollment.id))
})

test('dashboard statistics count participants, enrollments, progress and certificates', async () => {
  const repositories = setup()
  const completed = await createCompletedEnrollment(repositories, 'complete@example.test')
  const participant = await repositories.createParticipant({
    name: 'In progress',
    email: 'progress@example.test',
  })
  await repositories.createEnrollment({
    participantId: participant.id,
    courseId: 'data-foundations',
    courseName: 'Data Foundations',
  })
  const statistics = await repositories.getDashboardStatistics()
  assert.deepEqual(statistics, {
    participants: 2,
    enrollments: 2,
    inProgressEnrollments: 1,
    certificates: 0,
    activeCertificates: 0,
    revokedCertificates: 0,
  })
  assert.equal(completed.enrollment.status, 'completed')
})

test('public certificate search returns only issued uploaded certificates and minimal fields', async () => {
  const repositories = setup()
  const { participant, enrollment } = await createCompletedEnrollment(
    repositories,
    'private@example.test',
    'web-foundations',
    'Amelie Ngu',
  )
  const template = await createTemplate(repositories)
  const certificate = await repositories.createCertificate(
    {
      enrollmentId: enrollment.id,
      templateId: template.id,
    },
    { fileId: new ObjectId().toHexString(), fileSize: 1024 },
  )
  const documents =
    repositories.fake.getDocuments<CertificateDocument>('certificates')
  const verificationIdentifier = documents[0]?.verificationIdentifier
  assert.ok(verificationIdentifier)
  const storedFileId = documents[0]?.fileId
  assert.ok(storedFileId)
  repositories.fake.replaceDocument('certificateFiles.files', {
    _id: storedFileId,
    length: 1024,
    filename: 'certificate.pdf',
  })

  const results = await repositories.searchPublicCertificates(participant.name)
  assert.equal(results.length, 1)
  assert.deepEqual(results[0], {
    certificateId: certificate.certificateId,
    participantName: participant.name,
    courseName: enrollment.courseName,
    status: 'issued',
    issueDate: certificate.issueDate,
    downloadUrl: `/api/verify/${verificationIdentifier}/file`,
  })
  assert.equal('email' in (results[0] ?? {}), false)
  assert.equal('verificationIdentifier' in (results[0] ?? {}), false)
  assert.deepEqual(
    await repositories.searchPublicCertificates(verificationIdentifier),
    results,
  )
  assert.deepEqual(
    await repositories.searchPublicCertificates(certificate.certificateId),
    results,
  )
  assert.deepEqual(
    await repositories.searchPublicCertificates('ameliE'),
    results,
    'partial participant names match case-insensitively',
  )

  const similarParticipant = await repositories.createParticipant({
    name: 'Amelie Nguem',
    email: 'amelie.nguem@example.test',
  })
  const similarEnrollment = await repositories.createEnrollment({
    participantId: similarParticipant.id,
    courseId: 'data-foundations',
    courseName: 'Data Foundations',
  })
  await repositories.completeEnrollment(similarEnrollment.id)
  const similarCertificate = await repositories.createCertificate(
    { enrollmentId: similarEnrollment.id, templateId: template.id },
    { fileId: new ObjectId().toHexString(), fileSize: 1024 },
  )
  const similarCertificateDocument =
    repositories.fake.getDocuments<CertificateDocument>('certificates')
      .find((item) => item.certificateId === similarCertificate.certificateId)
  assert.ok(similarCertificateDocument?.fileId)
  repositories.fake.replaceDocument('certificateFiles.files', {
    _id: similarCertificateDocument.fileId,
    length: 1024,
    filename: 'similar-certificate.pdf',
  })
  const partialNameResults = await repositories.searchPublicCertificates('Amelie')
  assert.equal(partialNameResults.length, 2)
  assert.deepEqual(
    partialNameResults.map((result) => result.participantName).sort(),
    ['Amelie Ngu', 'Amelie Nguem'],
  )
  assert.ok(partialNameResults.every((result) => result.status === 'issued'))
  for (const privateField of ['email', 'enrollmentId', 'templateId', 'fileId']) {
    assert.equal(privateField in (partialNameResults[0] ?? {}), false)
  }

  const orphanParticipant = await repositories.createParticipant({
    name: 'Orphaned PDF participant',
    email: 'orphaned@example.test',
  })
  const orphanEnrollment = await repositories.createEnrollment({
    participantId: orphanParticipant.id,
    courseId: 'orphaned-course',
    courseName: 'Orphaned Course',
  })
  await repositories.completeEnrollment(orphanEnrollment.id)
  await repositories.createCertificate(
    { enrollmentId: orphanEnrollment.id, templateId: template.id },
    { fileId: new ObjectId().toHexString(), fileSize: 1024 },
  )
  assert.deepEqual(
    await repositories.searchPublicCertificates('Orphaned PDF'),
    [],
    'certificates with missing GridFS files are not offered as public downloads',
  )

  await repositories.revokeCertificate(certificate.certificateId, 'Test revoke')
  assert.deepEqual(
    await repositories.searchPublicCertificates(certificate.certificateId),
    [],
  )
  assert.deepEqual(
    await repositories.searchPublicCertificates(verificationIdentifier),
    [],
  )
  assert.equal(
    (await repositories.searchPublicCertificates('Amelie')).length,
    1,
    'a separate matching participant remains visible',
  )
  assert.deepEqual(
    await repositories.searchPublicCertificates('No matching participant'),
    [],
  )
})

test('one participant can have multiple enrollments but duplicates are rejected', async () => {
  const repositories = setup()
  const participant = await repositories.createParticipant({
    name: 'Participant',
    email: 'person@example.com',
  })
  const first = await repositories.createEnrollment({
    participantId: participant.id,
    courseId: 'web-foundations',
    courseName: 'Web Foundations',
  })
  const second = await repositories.createEnrollment({
    participantId: participant.id,
    courseId: 'data-basics',
    courseName: 'Data Basics',
  })
  assert.notEqual(first.id, second.id)
  await assert.rejects(
    repositories.createEnrollment({
      participantId: participant.id,
      courseId: 'web-foundations',
      courseName: 'Web Foundations',
    }),
    (error: unknown) =>
      error instanceof RepositoryError && error.code === 'duplicate',
  )
  await assert.rejects(
    repositories.createParticipant({
      name: 'Duplicate identity',
      email: ' PERSON@example.com ',
    }),
    (error: unknown) =>
      error instanceof RepositoryError && error.code === 'duplicate',
  )
})

test('enrollment completion and withdrawal transitions are validated', async () => {
  const repositories = setup()
  const participant = await repositories.createParticipant({
    name: 'Participant',
    email: 'person@example.com',
  })
  const enrollment = await repositories.createEnrollment({
    participantId: participant.id,
    courseId: 'web-foundations',
    courseName: 'Web Foundations',
  })
  const completed = await repositories.completeEnrollment(enrollment.id)
  assert.equal(completed.status, 'completed')
  assert.ok(completed.completedAt)
  assert.deepEqual(await repositories.completeEnrollment(enrollment.id), completed)
  await assert.rejects(
    repositories.withdrawEnrollment(enrollment.id),
    (error: unknown) =>
      error instanceof RepositoryError && error.code === 'conflict',
  )

  const another = await repositories.createEnrollment({
    participantId: participant.id,
    courseId: 'data-basics',
    courseName: 'Data Basics',
  })
  const withdrawn = await repositories.withdrawEnrollment(another.id)
  assert.equal(withdrawn.status, 'withdrawn')
  assert.equal(withdrawn.completedAt, null)
  await assert.rejects(
    repositories.completeEnrollment(another.id),
    (error: unknown) =>
      error instanceof RepositoryError && error.code === 'conflict',
  )
})

test('issuance requires completed enrollment, an existing template, and no active certificate', async () => {
  const repositories = setup()
  const participant = await repositories.createParticipant({
    name: 'Participant',
    email: 'person@example.com',
  })
  const inProgress = await repositories.createEnrollment({
    participantId: participant.id,
    courseId: 'web-foundations',
    courseName: 'Web Foundations',
  })
  const template = await createTemplate(repositories)
  await assert.rejects(
    repositories.createCertificate({
      enrollmentId: inProgress.id,
      templateId: template.id,
    }),
    (error: unknown) =>
      error instanceof RepositoryError && error.code === 'conflict',
  )

  const completed = await repositories.completeEnrollment(inProgress.id)
  const certificate = await repositories.createCertificate({
    enrollmentId: completed.id,
    templateId: template.id,
  })
  assert.equal(certificate.status, 'issued')
  assert.equal('verificationIdentifier' in certificate, false)
  await assert.rejects(
    repositories.createCertificate({
      enrollmentId: completed.id,
      templateId: template.id,
    }),
    (error: unknown) =>
      error instanceof RepositoryError && error.code === 'conflict',
  )
})

test('upload-only issuance stores no template reference and remains ineligible for reissue', async () => {
  const repositories = setup({ indexes: configuredReissueIndexes() })
  const { enrollment } = await createCompletedEnrollment(repositories)
  const issued = await repositories.createCertificate({ enrollmentId: enrollment.id })

  assert.equal(issued.status, 'issued')
  assert.equal('templateId' in issued, false)
  const stored = repositories.fake.getDocuments<CertificateDocument>('certificates')[0]
  assert.ok(stored)
  assert.equal('templateId' in stored, false)

  await assert.rejects(
    repositories.requestCertificateReissue(
      issued.certificateId,
      'upload-only-reissue-request-01',
    ),
    (error: unknown) =>
      error instanceof RepositoryError && error.code === 'conflict',
  )
  assert.equal(
    repositories.fake.getDocuments('certificateReissueWorkflows').length,
    0,
  )
})

test('withdrawn enrollment cannot receive a certificate', async () => {
  const repositories = setup()
  const participant = await repositories.createParticipant({
    name: 'Participant',
    email: 'person@example.com',
  })
  const enrollment = await repositories.createEnrollment({
    participantId: participant.id,
    courseId: 'web-foundations',
    courseName: 'Web Foundations',
  })
  const withdrawn = await repositories.withdrawEnrollment(enrollment.id)
  const template = await createTemplate(repositories)
  await assert.rejects(
    repositories.createCertificate({
      enrollmentId: withdrawn.id,
      templateId: template.id,
    }),
    (error: unknown) =>
      error instanceof RepositoryError && error.code === 'conflict',
  )
})

test('certificate lookup is exact and serializers omit verification identifiers and revocation details', async () => {
  const repositories = setup()
  const { enrollment } = await createCompletedEnrollment(repositories)
  const template = await createTemplate(repositories)
  const issued = await repositories.createCertificate({
    enrollmentId: enrollment.id,
    templateId: template.id,
  })
  assert.deepEqual(await repositories.getCertificateById(issued.certificateId), issued)
  const stored = repositories.fake.getDocuments<CertificateDocument>('certificates')[0]
  assert.ok(stored)
  assert.deepEqual(
    await repositories.getCertificateByVerificationIdentifier(
      stored.verificationIdentifier,
    ),
    issued,
  )
  assert.equal('verificationIdentifier' in issued, false)
  assert.equal(
    await repositories.getCertificateById(`${issued.certificateId}-OTHER`),
    null,
  )

  const revoked = await repositories.revokeCertificate(
    issued.certificateId,
    'Administrative correction',
  )
  assert.equal(revoked.status, 'revoked')
  assert.ok(revoked.revokedAt)
  assert.equal('revocationReason' in revoked, false)
  assert.equal('verificationIdentifier' in revoked, false)
  assert.deepEqual(
    await repositories.revokeCertificate(
      issued.certificateId,
      'Administrative correction',
    ),
    revoked,
  )
  await assert.rejects(
    repositories.createCertificate({
      enrollmentId: enrollment.id,
      templateId: template.id,
      verificationIdentifier: 'caller-controlled',
    }),
    (error: unknown) =>
      error instanceof RepositoryError && error.code === 'conflict',
  )
})

test('manual revocation first prevents reissue from adopting its certificate', async () => {
  const repositories = setup()
  const { enrollment } = await createCompletedEnrollment(repositories)
  const template = await createTemplate(repositories)
  const issued = await repositories.createCertificate({
    enrollmentId: enrollment.id,
    templateId: template.id,
  })

  const revoked = await repositories.revokeCertificate(
    issued.certificateId,
    'Manual revocation',
  )
  assert.equal(revoked.status, 'revoked')
  await assert.rejects(
    repositories.requestCertificateReissue(
      issued.certificateId,
      'manual-first-request-01',
    ),
    (error: unknown) =>
      error instanceof RepositoryError && error.code === 'conflict',
  )
  assert.equal(
    repositories.fake.getDocuments('certificateReissueWorkflows').length,
    0,
  )
  const stored = repositories.fake.getDocuments<CertificateDocument>('certificates')
  assert.equal(stored.length, 1)
  assert.equal(stored[0]?.status, 'revoked')
  assert.equal(stored[0]?.revocationWorkflowId, undefined)
})

test('manual revocation conflicts when reissue already owns the revocation', async () => {
  const repositories = setup()
  const { enrollment } = await createCompletedEnrollment(repositories)
  const template = await createTemplate(repositories)
  const issued = await repositories.createCertificate({
    enrollmentId: enrollment.id,
    templateId: template.id,
  })
  const stored = repositories.fake.getDocuments<CertificateDocument>('certificates')[0]
  assert.ok(stored)
  const workflowId = new ObjectId()
  repositories.fake.replaceDocument('certificates', {
    ...stored,
    status: 'revoked',
    revokedAt: new Date(),
    revocationReason: 'Superseded by certificate reissue',
    revocationWorkflowId: workflowId,
  })

  await assert.rejects(
    repositories.revokeCertificate(issued.certificateId, 'Manual reason'),
    (error: unknown) =>
      error instanceof RepositoryError && error.code === 'conflict',
  )
  const afterAttempt =
    repositories.fake.getDocuments<CertificateDocument>('certificates')[0]
  assert.equal(afterAttempt?.revocationWorkflowId?.toHexString(), workflowId.toHexString())
  assert.equal(afterAttempt?.revocationReason, 'Superseded by certificate reissue')
})

test('reissue claim and manual revocation compete atomically; losing manual revocation cannot overwrite it', async () => {
  let reachedManualUpdate!: () => void
  let releaseManualUpdate!: () => void
  const atManualUpdate = new Promise<void>((resolve) => {
    reachedManualUpdate = resolve
  })
  const continueManualUpdate = new Promise<void>((resolve) => {
    releaseManualUpdate = resolve
  })
  const repositories = setup({
    indexes: configuredReissueIndexes(),
    beforeUpdate: async (collection, _filter, update) => {
      const set = update.$set as Document | undefined
      if (
        collection === 'certificates' &&
        set?.revocationReason === 'Manual revocation competing'
      ) {
        reachedManualUpdate()
        await continueManualUpdate
      }
    },
  })
  const { enrollment } = await createCompletedEnrollment(repositories)
  const template = await createTemplate(repositories)
  const issued = await repositories.createCertificate({
    enrollmentId: enrollment.id,
    templateId: template.id,
  })
  const key = 'atomic-revocation-race-01'

  const manualRevocation = repositories.revokeCertificate(
    issued.certificateId,
    'Manual revocation competing',
  )
  await atManualUpdate
  await repositories.requestCertificateReissue(issued.certificateId, key)
  const resumed = await repositories.resumeCertificateReissue(key)
  assert.equal(resumed.state, 'completed')
  releaseManualUpdate()

  await assert.rejects(
    manualRevocation,
    (error: unknown) =>
      error instanceof RepositoryError && error.code === 'conflict',
  )
  const certificates =
    repositories.fake.getDocuments<CertificateDocument>('certificates')
  const previous = certificates.find(
    (certificate) => certificate.certificateId === issued.certificateId,
  )
  const replacement = certificates.find(
    (certificate) => certificate.supersedesCertificateId === issued.certificateId,
  )
  assert.equal(previous?.status, 'revoked')
  assert.ok(previous?.revocationWorkflowId)
  assert.equal(previous?.revocationReason, 'Superseded by certificate reissue')
  assert.equal(replacement?.status, 'issued')
  assert.equal(certificates.filter((certificate) => certificate.status === 'issued').length, 1)
})

test('reissue fails closed without deployed indexes and manual revocation remains consistent', async () => {
  const repositories = setup()
  const { enrollment } = await createCompletedEnrollment(repositories)
  const template = await createTemplate(repositories)
  const issued = await repositories.createCertificate({
    enrollmentId: enrollment.id,
    templateId: template.id,
  })
  let reachIndexCheck!: () => void
  let releaseIndexCheck!: () => void
  const atIndexCheck = new Promise<void>((resolve) => {
    reachIndexCheck = resolve
  })
  const continueIndexCheck = new Promise<void>((resolve) => {
    releaseIndexCheck = resolve
  })
  repositories.fake.setBeforeListIndexes(async () => {
    reachIndexCheck()
    await continueIndexCheck
  })

  const reissue = repositories.requestCertificateReissue(
    issued.certificateId,
    'reissue-interleave-0001',
  )
  await atIndexCheck
  const revoked = await repositories.revokeCertificate(
    issued.certificateId,
    'Manual revocation during reissue request',
  )
  assert.equal(revoked.status, 'revoked')
  releaseIndexCheck()
  await assert.rejects(
    reissue,
    (error: unknown) =>
      error instanceof RepositoryError && error.code === 'conflict',
  )

  const stored = repositories.fake.getDocuments<CertificateDocument>('certificates')
  assert.equal(stored.length, 1)
  assert.equal(stored[0]?.status, 'revoked')
  assert.equal(stored[0]?.revocationWorkflowId, undefined)
  assert.equal(
    repositories.fake.getDocuments('certificateReissueWorkflows').length,
    0,
  )
  assert.ok(enrollment.id)
})

test('competing reissue requests with different idempotency keys fail closed without indexes', async () => {
  const repositories = setup()
  const { enrollment } = await createCompletedEnrollment(repositories)
  const template = await createTemplate(repositories)
  const issued = await repositories.createCertificate({
    enrollmentId: enrollment.id,
    templateId: template.id,
  })
  const results = await Promise.allSettled([
    repositories.requestCertificateReissue(
      issued.certificateId,
      'competing-request-key-1',
    ),
    repositories.requestCertificateReissue(
      issued.certificateId,
      'competing-request-key-2',
    ),
  ])
  assert.equal(results.filter((result) => result.status === 'rejected').length, 2)
  assert.ok(
    results.every(
      (result) =>
        result.status === 'rejected' &&
        result.reason instanceof RepositoryError &&
        result.reason.code === 'conflict',
    ),
  )
  assert.equal(
    repositories.fake.getDocuments('certificateReissueWorkflows').length,
    0,
  )
  assert.equal(
    repositories.fake.getDocuments<CertificateDocument>('certificates')[0]
      ?.status,
    'issued',
  )
})

test('simultaneous reissue resumes fail closed when required indexes are absent', async () => {
  const repositories = setup()
  const results = await Promise.allSettled([
    repositories.resumeCertificateReissue('resume-workflow-key-0001'),
    repositories.resumeCertificateReissue('resume-workflow-key-0001'),
  ])
  assert.ok(
    results.every(
      (result) =>
        result.status === 'rejected' &&
        result.reason instanceof RepositoryError &&
        result.reason.code === 'conflict',
    ),
  )
  assert.equal(
    repositories.fake.getDocuments('certificateReissueWorkflows').length,
    0,
  )
  assert.equal(repositories.fake.getDocuments('certificates').length, 0)
})

test('readiness rejects a missing required index and unexpected sparse behavior', async () => {
  const exactIndexes = configuredReissueIndexes()
  const enrollmentIndexName = 'certificates_one_issued_per_enrollment'
  for (const configured of [
    exactIndexes.filter((index) => index.name !== enrollmentIndexName),
    exactIndexes.map((index) =>
      index.name === enrollmentIndexName ? { ...index, sparse: true } : index,
    ),
    exactIndexes.flatMap((index) =>
      index.name === enrollmentIndexName
        ? [{ name: index.name, key: index.key, unique: index.unique }]
        : [index],
    ),
  ]) {
    const repositories = setup({ indexes: configured })
    const { enrollment } = await createCompletedEnrollment(repositories)
    const template = await createTemplate(repositories)
    const issued = await repositories.createCertificate({
      enrollmentId: enrollment.id,
      templateId: template.id,
    })
    await assert.rejects(
      repositories.requestCertificateReissue(
        issued.certificateId,
        'index-readiness-test-01',
      ),
      (error: unknown) =>
        error instanceof RepositoryError && error.code === 'conflict',
    )
    assert.equal(
      repositories.fake.getDocuments('certificateReissueWorkflows').length,
      0,
    )
    assert.equal(
      repositories.fake.getDocuments<CertificateDocument>('certificates')[0]
        ?.status,
      'issued',
    )
  }
})

test('idempotent reissue request still verifies indexes before returning its workflow', async () => {
  const repositories = setup({ indexes: configuredReissueIndexes() })
  const { enrollment } = await createCompletedEnrollment(repositories)
  const template = await createTemplate(repositories)
  const issued = await repositories.createCertificate({
    enrollmentId: enrollment.id,
    templateId: template.id,
  })
  const key = 'idempotent-index-check-01'
  const first = await repositories.requestCertificateReissue(
    issued.certificateId,
    key,
  )
  repositories.fake.setIndexes([])

  await assert.rejects(
    repositories.requestCertificateReissue(issued.certificateId, key),
    (error: unknown) =>
      error instanceof RepositoryError && error.code === 'conflict',
  )
  assert.equal(
    repositories.fake.getDocuments('certificateReissueWorkflows').length,
    1,
  )
  assert.equal(first.state, 'requested')
})

test('mock unique indexes reject competing reissue requests with different keys', async () => {
  const repositories = setup({ indexes: configuredReissueIndexes() })
  const { enrollment } = await createCompletedEnrollment(repositories)
  const template = await createTemplate(repositories)
  const issued = await repositories.createCertificate({
    enrollmentId: enrollment.id,
    templateId: template.id,
  })

  const results = await Promise.allSettled([
    repositories.requestCertificateReissue(
      issued.certificateId,
      'competing-mock-request-01',
    ),
    repositories.requestCertificateReissue(
      issued.certificateId,
      'competing-mock-request-02',
    ),
  ])
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1)
  assert.equal(
    repositories.fake.getDocuments('certificateReissueWorkflows').length,
    1,
  )
  assert.equal(
    repositories.fake.getDocuments<CertificateDocument>('certificates')
      .filter((certificate) => certificate.status === 'issued').length,
    1,
  )
})

test('mock _id uniqueness makes simultaneous resumes reuse one replacement', async () => {
  const repositories = setup({ indexes: configuredReissueIndexes() })
  const { enrollment } = await createCompletedEnrollment(repositories)
  const template = await createTemplate(repositories)
  const issued = await repositories.createCertificate({
    enrollmentId: enrollment.id,
    templateId: template.id,
  })
  const key = 'simultaneous-resume-mock-01'
  await repositories.requestCertificateReissue(issued.certificateId, key)

  const results = await Promise.allSettled([
    repositories.resumeCertificateReissue(key),
    repositories.resumeCertificateReissue(key),
  ])
  assert.ok(
    results.every(
      (result) =>
        result.status === 'fulfilled' && result.value.state === 'completed',
    ),
    `resume failures: ${JSON.stringify(repositories.fake.getDuplicateIndexHits())}`,
  )
  const certificates =
    repositories.fake.getDocuments<CertificateDocument>('certificates')
  assert.equal(certificates.length, 2)
  assert.equal(
    certificates.filter((certificate) => certificate.status === 'issued').length,
    1,
  )
  assert.equal(
    certificates.filter((certificate) => certificate.reissueWorkflowId).length,
    1,
  )
})

test('manual revocation winning a reissue-request interleaving is preserved on resume', async () => {
  let reachedWorkflowInsert!: () => void
  let releaseWorkflowInsert!: () => void
  const atWorkflowInsert = new Promise<void>((resolve) => {
    reachedWorkflowInsert = resolve
  })
  const continueWorkflowInsert = new Promise<void>((resolve) => {
    releaseWorkflowInsert = resolve
  })
  const repositories = setup({
    indexes: configuredReissueIndexes(),
    beforeInsert: async (collection, document) => {
      if (
        collection === 'certificateReissueWorkflows' &&
        document.state === 'requested'
      ) {
        reachedWorkflowInsert()
        await continueWorkflowInsert
      }
    },
  })
  const { enrollment } = await createCompletedEnrollment(repositories)
  const template = await createTemplate(repositories)
  const issued = await repositories.createCertificate({
    enrollmentId: enrollment.id,
    templateId: template.id,
  })
  const key = 'revocation-race-mock-01'
  const request = repositories.requestCertificateReissue(issued.certificateId, key)
  await atWorkflowInsert
  const revoked = await repositories.revokeCertificate(
    issued.certificateId,
    'Manual revocation won',
  )
  assert.equal(revoked.status, 'revoked')
  releaseWorkflowInsert()
  await request

  await assert.rejects(
    repositories.resumeCertificateReissue(key),
    (error: unknown) =>
      error instanceof RepositoryError && error.code === 'conflict',
  )
  const certificates =
    repositories.fake.getDocuments<CertificateDocument>('certificates')
  assert.equal(certificates.length, 1)
  assert.equal(certificates[0]?.status, 'revoked')
  assert.equal(certificates[0]?.revocationWorkflowId, undefined)
  assert.equal(
    repositories.fake.getDocuments<{
      state: string
    }>('certificateReissueWorkflows')[0]?.state,
    'cancelled',
  )
})

test('retry recovers when replacement insertion succeeded but its result was lost', async () => {
  let lostInsertResult = false
  const repositories = setup({
    indexes: configuredReissueIndexes(),
    afterInsert: async (collection, document) => {
      if (
        !lostInsertResult &&
        collection === 'certificates' &&
        document.reissueWorkflowId
      ) {
        lostInsertResult = true
        throw new Error('simulated lost insert response')
      }
    },
  })
  const { enrollment } = await createCompletedEnrollment(repositories)
  const template = await createTemplate(repositories)
  const issued = await repositories.createCertificate({
    enrollmentId: enrollment.id,
    templateId: template.id,
  })
  const key = 'lost-insert-response-mock-01'
  await repositories.requestCertificateReissue(issued.certificateId, key)
  await assert.rejects(
    repositories.resumeCertificateReissue(key),
    (error: unknown) =>
      error instanceof RepositoryError && error.code === 'operation_failed',
  )
  assert.equal(
    repositories.fake.getDocuments<CertificateDocument>('certificates').length,
    2,
  )

  const resumed = await repositories.resumeCertificateReissue(key)
  assert.equal(resumed.state, 'completed')
  const certificates =
    repositories.fake.getDocuments<CertificateDocument>('certificates')
  assert.equal(certificates.length, 2)
  assert.equal(
    certificates.filter((certificate) => certificate.status === 'issued').length,
    1,
  )
})

test('unrelated replacement identifier collision fails safely and leaves workflow recoverable', async () => {
  const repositories = setup({ indexes: configuredReissueIndexes() })
  const { enrollment } = await createCompletedEnrollment(repositories)
  const template = await createTemplate(repositories)
  const issued = await repositories.createCertificate({
    enrollmentId: enrollment.id,
    templateId: template.id,
  })
  const key = 'replacement-collision-mock-01'
  await repositories.requestCertificateReissue(issued.certificateId, key)
  const workflow =
    repositories.fake.getDocuments<Document>('certificateReissueWorkflows')[0]
  assert.ok(workflow)
  repositories.fake.replaceDocument('certificates', {
    _id: new ObjectId(),
    certificateId: workflow.replacementCertificateId,
    enrollmentId: new ObjectId(),
    templateId: new ObjectId(),
    issueDate: new Date(),
    verificationIdentifier: 'unrelated-verification-id',
    status: 'revoked',
    createdAt: new Date(),
    updatedAt: new Date(),
  })

  await assert.rejects(
    repositories.resumeCertificateReissue(key),
    (error: unknown) =>
      error instanceof RepositoryError && error.code === 'duplicate',
  )
  const certificates =
    repositories.fake.getDocuments<CertificateDocument>('certificates')
  assert.equal(certificates.length, 2)
  assert.equal(
    certificates.filter((certificate) => certificate.reissueWorkflowId).length,
    0,
  )
  assert.equal(certificates.find((certificate) =>
    certificate.certificateId === issued.certificateId,
  )?.status, 'revoked')
  assert.equal(
    repositories.fake.getDocuments<Document>('certificateReissueWorkflows')[0]
      ?.state,
    'previous_revoked',
  )
})

test('reissue resumes after a missing template is restored', async () => {
  let removeTemplate!: () => void
  const repositories = setup({
    indexes: configuredReissueIndexes(),
    beforeUpdate: async (collection, _filter, update) => {
      const set = update.$set as Document | undefined
      if (
        collection === 'certificateReissueWorkflows' &&
        set?.state === 'previous_revoked'
      ) {
        removeTemplate()
      }
    },
  })
  const { enrollment } = await createCompletedEnrollment(repositories)
  const template = await createTemplate(repositories)
  const storedTemplate =
    repositories.fake.getDocuments<Document>('certificateTemplates')[0]
  assert.ok(storedTemplate)
  removeTemplate = () => {
    repositories.fake.removeDocument(
      'certificateTemplates',
      storedTemplate._id as ObjectId,
    )
  }
  const issued = await repositories.createCertificate({
    enrollmentId: enrollment.id,
    templateId: template.id,
  })
  const key = 'restored-template-mock-01'
  await repositories.requestCertificateReissue(issued.certificateId, key)

  await assert.rejects(
    repositories.resumeCertificateReissue(key),
    (error: unknown) =>
      error instanceof RepositoryError && error.code === 'conflict',
  )
  assert.equal(
    repositories.fake.getDocuments<CertificateDocument>('certificates')[0]
      ?.status,
    'revoked',
  )
  repositories.fake.replaceDocument('certificateTemplates', storedTemplate)
  const resumed = await repositories.resumeCertificateReissue(key)
  assert.equal(resumed.state, 'completed')
  assert.equal(
    repositories.fake.getDocuments<CertificateDocument>('certificates')
      .filter((certificate) => certificate.status === 'issued').length,
    1,
  )
})

test('invalid input is rejected before database access', async () => {
  const repositories = setup()
  await assert.rejects(
    repositories.createParticipant({ name: 'Invalid', email: 'bad' }),
    (error: unknown) =>
      error instanceof RepositoryError && error.code === 'invalid_input',
  )
  await assert.rejects(
    repositories.createEnrollment({
      participantId: 'bad',
      courseId: 'course',
      courseName: 'Course',
    }),
    (error: unknown) =>
      error instanceof RepositoryError && error.code === 'invalid_input',
  )
  assert.equal(repositories.databaseAccesses, 0)
})

test('duplicate-key errors are safely mapped without database details', async () => {
  const repositories = setup()
  const participant = await repositories.createParticipant({
    name: 'Participant',
    email: 'duplicate@example.com',
  })
  const one = await repositories.createEnrollment({
    participantId: participant.id,
    courseId: 'web-foundations',
    courseName: 'Web Foundations',
  })
  await assert.rejects(
    repositories.createEnrollment({
      participantId: participant.id,
      courseId: 'web-foundations',
      courseName: 'Web Foundations',
    }),
    (error: unknown) => {
      assert.ok(error instanceof RepositoryError)
      assert.equal(error.code, 'duplicate')
      assert.equal(error.message.includes('private'), false)
      return true
    },
  )
  assert.ok(one.id)
})

test('index definitions enforce one active issued certificate and durable reissue idempotency', () => {
  const activeCertificateIndex = MODEL_INDEXES.find(
    (index) =>
      index.options.name === 'certificates_one_issued_per_enrollment',
  )
  assert.ok(activeCertificateIndex)
  assert.deepEqual(activeCertificateIndex?.keys, { enrollmentId: 1 })
  assert.equal(
    'partialFilterExpression' in activeCertificateIndex.options
      ? activeCertificateIndex.options.partialFilterExpression.status
      : undefined,
    'issued',
  )
  assert.ok(
    MODEL_INDEXES.some(
      (index) =>
        index.options.name === 'certificate_reissue_idempotency_unique' &&
        index.collection === 'certificateReissueWorkflows',
    ),
  )
  assert.ok(
    MODEL_INDEXES.some(
      (index) =>
        index.options.name === 'certificates_enrollment_history_lookup',
    ),
  )
})
