import '@tanstack/react-start/server-only'

import {
  MongoServerError,
  ObjectId,
  type Db,
  type Filter,
  type UpdateFilter,
} from 'mongodb'
import { z } from 'zod'
import { getDatabase } from './mongodb.server.ts'
import {
  MODEL_INDEXES,
  certificateIdSchema,
  certificateIssueInputSchema,
  certificateTemplateInputSchema,
  courseIdSchema,
  createCertificateId,
  createVerificationIdentifier,
  enrollmentInputSchema,
  enrollmentDetailsInputSchema,
  enrollmentStatusSchema,
  objectIdSchema,
  participantInputSchema,
  serializeCertificate,
  serializeCertificateTemplate,
  serializeEnrollment,
  serializeParticipant,
  serializeReissueWorkflow,
  verificationIdentifierSchema,
  type CertificateDocument,
  type CertificateReissueWorkflowDocument,
  type CertificateTemplateDocument,
  type EnrollmentDocument,
  type ParticipantDocument,
  type SerializedCertificate,
  type SerializedCertificateTemplate,
  type SerializedEnrollment,
  type SerializedParticipant,
  type SerializedReissueWorkflow,
} from './models.server.ts'

const participantSearchSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    email: z.string().trim().toLowerCase().email().optional(),
    page: z.number().int().min(1).max(100_000).default(1),
    limit: z.number().int().min(1).max(100).default(20),
  })

const idempotencyKeySchema = z.string().trim().min(8).max(200)
const revocationReasonSchema = z.string().trim().min(1).max(1000)
const pageSchema = z.object({
  page: z.number().int().min(1).max(100_000).default(1),
  limit: z.number().int().min(1).max(100).default(20),
})
const enrollmentSearchSchema = pageSchema.extend({
  participantId: objectIdSchema.optional(),
  status: enrollmentStatusSchema.optional(),
  query: z.string().trim().min(1).max(200).optional(),
})
const certificateSearchSchema = pageSchema.extend({
  query: z.string().trim().min(1).max(100).optional(),
  status: z.enum(['issued', 'revoked']).optional(),
})

class MissingReissueIndexesError extends Error {}
class MissingTemplateError extends Error {}

export type ParticipantSearchInput = z.input<typeof participantSearchSchema>

export interface ParticipantSearchResult {
  items: SerializedParticipant[]
  page: number
  limit: number
}

export interface DashboardStatistics {
  participants: number
  enrollments: number
  inProgressEnrollments: number
  certificates: number
  activeCertificates: number
  revokedCertificates: number
}

export type RepositoryErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'duplicate'
  | 'conflict'
  | 'operation_failed'

const repositoryErrorMessages: Record<RepositoryErrorCode, string> = {
  invalid_input: 'Repository input is invalid',
  not_found: 'Repository record was not found',
  duplicate: 'A record with the same unique value already exists',
  conflict: 'The requested lifecycle transition is not allowed',
  operation_failed: 'Repository operation failed',
}

export class RepositoryError extends Error {
  readonly code: RepositoryErrorCode

  constructor(code: RepositoryErrorCode) {
    super(repositoryErrorMessages[code])
    this.name = 'RepositoryError'
    this.code = code
  }
}

function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input)
  if (!result.success) {
    throw new RepositoryError('invalid_input')
  }
  return result.data
}

async function safely<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof RepositoryError) {
      throw error
    }
    if (error instanceof MongoServerError && error.code === 11000) {
      throw new RepositoryError('duplicate')
    }
    if (
      error instanceof MissingReissueIndexesError ||
      error instanceof MissingTemplateError
    ) {
      throw new RepositoryError('conflict')
    }
    throw new RepositoryError('operation_failed')
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function isDuplicate(error: unknown): boolean {
  return error instanceof MongoServerError && error.code === 11000
}

function generatedCertificateId(): string {
  return parseInput(certificateIdSchema, createCertificateId())
}

async function requireReissueIndexes(database: Db): Promise<void> {
  const requiredNames = [
    'certificates_one_issued_per_enrollment',
    'certificates_reissue_workflow_unique',
    'certificate_reissue_idempotency_unique',
    'certificate_reissue_active_enrollment_unique',
    'certificates_certificate_id_unique',
    'certificates_verification_identifier_unique',
  ]

  for (const name of requiredNames) {
    const required = MODEL_INDEXES.find((index) => index.options.name === name)
    if (!required) throw new MissingReissueIndexesError()
    const indexes = await database
      .collection(required.collection)
      .listIndexes()
      .toArray()
    if (
      !indexes.some((index) => {
        const expectedPartial =
          'partialFilterExpression' in required.options
            ? required.options.partialFilterExpression
            : undefined
        const expectedSparse =
          'sparse' in required.options && required.options.sparse === true
        return (
          index.name === name &&
          (index.unique === true) ===
            ('unique' in required.options && required.options.unique === true) &&
          (index.sparse === true) === expectedSparse &&
          JSON.stringify(index.key) === JSON.stringify(required.keys) &&
          JSON.stringify(index.partialFilterExpression) ===
            JSON.stringify(expectedPartial)
        )
      })
    ) {
      throw new MissingReissueIndexesError()
    }
  }
}

export function createRepositories(getDb: () => Promise<Db> = getDatabase) {
  async function createParticipant(
    input: unknown,
  ): Promise<SerializedParticipant> {
    const participant = parseInput(participantInputSchema, input)
    return safely(async () => {
      const collection =
        (await getDb()).collection<ParticipantDocument>('participants')
      if (await collection.findOne({ email: participant.email })) {
        throw new RepositoryError('duplicate')
      }
      const now = new Date()
      const document: ParticipantDocument = {
        ...participant,
        _id: new ObjectId(),
        createdAt: now,
        updatedAt: now,
      }
      await collection.insertOne(document)
      return serializeParticipant(document)
    })
  }

  async function getParticipantById(
    id: unknown,
  ): Promise<SerializedParticipant | null> {
    const participantId = parseInput(objectIdSchema, id)
    return safely(async () => {
      const document = await (await getDb())
        .collection<ParticipantDocument>('participants')
        .findOne({ _id: participantId })
      return document ? serializeParticipant(document) : null
    })
  }

  async function getParticipantByEmail(
    email: unknown,
  ): Promise<SerializedParticipant | null> {
    const normalizedEmail = parseInput(
      participantInputSchema.shape.email,
      email,
    )
    return safely(async () => {
      const document = await (await getDb())
        .collection<ParticipantDocument>('participants')
        .findOne({ email: normalizedEmail })
      return document ? serializeParticipant(document) : null
    })
  }

  async function updateParticipant(
    id: unknown,
    input: unknown,
  ): Promise<SerializedParticipant> {
    const participantId = parseInput(objectIdSchema, id)
    const participant = parseInput(participantInputSchema, input)
    return safely(async () => {
      const collection =
        (await getDb()).collection<ParticipantDocument>('participants')
      const result = await collection.updateOne(
        { _id: participantId },
        { $set: { ...participant, updatedAt: new Date() } },
      )
      if (!result.matchedCount) throw new RepositoryError('not_found')
      const updated = await collection.findOne({ _id: participantId })
      if (!updated) throw new RepositoryError('not_found')
      return serializeParticipant(updated)
    })
  }

  async function deleteParticipant(id: unknown): Promise<{ deleted: true }> {
    const participantId = parseInput(objectIdSchema, id)
    return safely(async () => {
      const database = await getDb()
      const session = database.client.startSession()
      try {
        return await session.withTransaction(async () => {
          const enrollments =
            database.collection<EnrollmentDocument>('enrollments')
          if (await enrollments.findOne({ participantId }, { session })) {
            throw new RepositoryError('conflict')
          }
          const result = await database
            .collection<ParticipantDocument>('participants')
            .deleteOne({ _id: participantId }, { session })
          if (!result.deletedCount) throw new RepositoryError('not_found')
          return { deleted: true as const }
        })
      } finally {
        await session.endSession()
      }
    })
  }

  async function searchParticipants(
    input: unknown,
  ): Promise<ParticipantSearchResult> {
    const search = parseInput(participantSearchSchema, input)
    const filter: Filter<ParticipantDocument> = {}
    if (search.name) {
      filter.name = { $regex: escapeRegex(search.name), $options: 'i' }
    }
    if (search.email) {
      filter.email = search.email
    }
    return safely(async () => {
      const documents = await (await getDb())
        .collection<ParticipantDocument>('participants')
        .find(filter)
        .sort({ name: 1, _id: 1 })
        .skip((search.page - 1) * search.limit)
        .limit(search.limit)
        .toArray()
      return {
        items: documents.map(serializeParticipant),
        page: search.page,
        limit: search.limit,
      }
    })
  }

  async function listPublicParticipantNames(): Promise<string[]> {
    return safely(async () => {
      const documents = await (await getDb())
        .collection<ParticipantDocument>('participants')
        .find(
          { displayNamePublicly: true },
          { projection: { _id: 0, name: 1 } },
        )
        .sort({ name: 1 })
        .limit(36)
        .toArray()
      const seen = new Set<string>()
      const names: string[] = []
      for (const document of documents) {
        const name = z.string().trim().min(1).max(200).safeParse(document.name)
        if (!name.success) continue
        const key = name.data.toLocaleLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        names.push(name.data)
        if (names.length === 12) break
      }
      return names
    })
  }

  async function createEnrollment(
    input: unknown,
  ): Promise<SerializedEnrollment> {
    const enrollmentInput = parseInput(enrollmentInputSchema, input)
    const participantId = parseInput(
      objectIdSchema,
      enrollmentInput.participantId,
    )
    return safely(async () => {
      const database = await getDb()
      const session = database.client.startSession()
      try {
        const created = await session.withTransaction(async () => {
          const participants =
            database.collection<ParticipantDocument>('participants')
          // This write serializes enrollment creation against participant deletion.
          const participantUpdate = await participants.updateOne(
            { _id: participantId },
            { $inc: { enrollmentVersion: 1 } },
            { session },
          )
          if (!participantUpdate.matchedCount) {
            throw new RepositoryError('not_found')
          }
          const enrollments =
            database.collection<EnrollmentDocument>('enrollments')
          if (
            await enrollments.findOne(
              {
                participantId,
                courseId: enrollmentInput.courseId,
              },
              { session },
            )
          ) {
            throw new RepositoryError('duplicate')
          }
          const now = new Date()
          const document: EnrollmentDocument = {
            ...enrollmentInput,
            participantId,
            _id: new ObjectId(),
            status: 'in_progress',
            createdAt: now,
            updatedAt: now,
          }
          await enrollments.insertOne(document, { session })
          return serializeEnrollment(document)
        })
        if (!created) throw new RepositoryError('operation_failed')
        return created
      } finally {
        await session.endSession()
      }
    })
  }

  async function getEnrollmentById(
    id: unknown,
  ): Promise<SerializedEnrollment | null> {
    const enrollmentId = parseInput(objectIdSchema, id)
    return safely(async () => {
      const document = await (await getDb())
        .collection<EnrollmentDocument>('enrollments')
        .findOne({ _id: enrollmentId })
      return document ? serializeEnrollment(document) : null
    })
  }

  async function updateEnrollment(
    id: unknown,
    input: unknown,
  ): Promise<SerializedEnrollment> {
    const enrollmentId = parseInput(objectIdSchema, id)
    const details = parseInput(enrollmentDetailsInputSchema, input)
    return safely(async () => {
      const database = await getDb()
      const enrollments =
        database.collection<EnrollmentDocument>('enrollments')
      const current = await enrollments.findOne({ _id: enrollmentId })
      if (!current) throw new RepositoryError('not_found')
      if (current.status !== 'in_progress') {
        throw new RepositoryError('conflict')
      }
      const certificates =
        database.collection<CertificateDocument>('certificates')
      const workflows =
        database.collection<CertificateReissueWorkflowDocument>(
          'certificateReissueWorkflows',
        )
      if (
        (await certificates.findOne({ enrollmentId })) ||
        (await workflows.findOne({ enrollmentId })) ||
        (await workflows.findOne({ activeEnrollmentId: enrollmentId }))
      ) {
        throw new RepositoryError('conflict')
      }
      const result = await enrollments.updateOne(
        { _id: enrollmentId, status: 'in_progress' },
        { $set: { ...details, updatedAt: new Date() } },
      )
      if (!result.matchedCount) throw new RepositoryError('conflict')
      const updated = await enrollments.findOne({ _id: enrollmentId })
      if (!updated) throw new RepositoryError('not_found')
      return serializeEnrollment(updated)
    })
  }

  async function deleteEnrollment(
    id: unknown,
  ): Promise<{ deleted: true }> {
    const enrollmentId = parseInput(objectIdSchema, id)
    return safely(async () => {
      const database = await getDb()
      const enrollments =
        database.collection<EnrollmentDocument>('enrollments')
      const current = await enrollments.findOne({ _id: enrollmentId })
      if (!current) throw new RepositoryError('not_found')
      if (current.status !== 'in_progress') {
        throw new RepositoryError('conflict')
      }
      const certificates =
        database.collection<CertificateDocument>('certificates')
      const workflows =
        database.collection<CertificateReissueWorkflowDocument>(
          'certificateReissueWorkflows',
        )
      if (
        (await certificates.findOne({ enrollmentId })) ||
        (await workflows.findOne({ enrollmentId })) ||
        (await workflows.findOne({ activeEnrollmentId: enrollmentId }))
      ) {
        throw new RepositoryError('conflict')
      }
      const result = await enrollments.deleteOne({
        _id: enrollmentId,
        status: 'in_progress',
      })
      if (!result.deletedCount) throw new RepositoryError('conflict')
      return { deleted: true }
    })
  }

  async function getEnrollmentByParticipantAndCourse(
    participantId: unknown,
    courseId: unknown,
  ): Promise<SerializedEnrollment | null> {
    const parsedParticipantId = parseInput(objectIdSchema, participantId)
    const parsedCourseId = parseInput(courseIdSchema, courseId)
    return safely(async () => {
      const document = await (await getDb())
        .collection<EnrollmentDocument>('enrollments')
        .findOne({
          participantId: parsedParticipantId,
          courseId: parsedCourseId,
        })
      return document ? serializeEnrollment(document) : null
    })
  }

  async function searchEnrollments(input: unknown): Promise<{
    items: SerializedEnrollment[]
    page: number
    limit: number
  }> {
    const search = parseInput(enrollmentSearchSchema, input)
    const filter: Filter<EnrollmentDocument> = {}
    if (search.participantId) filter.participantId = search.participantId
    if (search.status) filter.status = search.status
    if (search.query) {
      filter.$or = [
        { courseName: { $regex: escapeRegex(search.query), $options: 'i' } },
        { courseId: { $regex: escapeRegex(search.query), $options: 'i' } },
      ]
    }
    return safely(async () => {
      const documents = await (await getDb())
        .collection<EnrollmentDocument>('enrollments')
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((search.page - 1) * search.limit)
        .limit(search.limit)
        .toArray()
      return {
        items: documents.map(serializeEnrollment),
        page: search.page,
        limit: search.limit,
      }
    })
  }

  async function transitionEnrollment(
    id: unknown,
    targetStatus: unknown,
  ): Promise<SerializedEnrollment> {
    const enrollmentId = parseInput(objectIdSchema, id)
    const status = parseInput(enrollmentStatusSchema, targetStatus)
    if (status === 'in_progress') {
      throw new RepositoryError('conflict')
    }
    return safely(async () => {
      const collection =
        (await getDb()).collection<EnrollmentDocument>('enrollments')
      const current = await collection.findOne({ _id: enrollmentId })
      if (!current) throw new RepositoryError('not_found')
      if (current.status === status) return serializeEnrollment(current)
      if (current.status !== 'in_progress') {
        throw new RepositoryError('conflict')
      }
      const now = new Date()
      const update: UpdateFilter<EnrollmentDocument> = {
        $set: {
          status,
          updatedAt: now,
          ...(status === 'completed' ? { completedAt: now } : {}),
        },
        ...(status === 'withdrawn' ? { $unset: { completedAt: '' } } : {}),
      }
      const result = await collection.updateOne(
        { _id: enrollmentId, status: 'in_progress' },
        update,
      )
      if (result.matchedCount === 0) {
        throw new RepositoryError('conflict')
      }
      const updated = await collection.findOne({ _id: enrollmentId })
      if (!updated) throw new RepositoryError('not_found')
      return serializeEnrollment(updated)
    })
  }

  async function createCertificateTemplate(
    input: unknown,
  ): Promise<SerializedCertificateTemplate> {
    const template = parseInput(certificateTemplateInputSchema, input)
    return safely(async () => {
      const now = new Date()
      const document: CertificateTemplateDocument = {
        ...template,
        _id: new ObjectId(),
        createdAt: now,
        updatedAt: now,
      }
      await (await getDb())
        .collection<CertificateTemplateDocument>('certificateTemplates')
        .insertOne(document)
      return serializeCertificateTemplate(document)
    })
  }

  async function getCertificateTemplateById(
    id: unknown,
  ): Promise<SerializedCertificateTemplate | null> {
    const templateId = parseInput(objectIdSchema, id)
    return safely(async () => {
      const document = await (await getDb())
        .collection<CertificateTemplateDocument>('certificateTemplates')
        .findOne({ _id: templateId })
      return document ? serializeCertificateTemplate(document) : null
    })
  }

  async function getCertificateTemplateByName(
    name: unknown,
  ): Promise<SerializedCertificateTemplate | null> {
    const normalizedName = parseInput(
      certificateTemplateInputSchema.shape.name,
      name,
    )
    return safely(async () => {
      const document = await (await getDb())
        .collection<CertificateTemplateDocument>('certificateTemplates')
        .findOne({ name: normalizedName })
      return document ? serializeCertificateTemplate(document) : null
    })
  }

  async function listCertificateTemplates(input: unknown = {}): Promise<{
    items: SerializedCertificateTemplate[]
    page: number
    limit: number
  }> {
    const search = parseInput(pageSchema, input)
    return safely(async () => {
      const documents = await (await getDb())
        .collection<CertificateTemplateDocument>('certificateTemplates')
        .find({})
        .sort({ name: 1, _id: 1 })
        .skip((search.page - 1) * search.limit)
        .limit(search.limit)
        .toArray()
      return {
        items: documents.map(serializeCertificateTemplate),
        page: search.page,
        limit: search.limit,
      }
    })
  }

  async function updateCertificateTemplate(
    id: unknown,
    input: unknown,
  ): Promise<SerializedCertificateTemplate> {
    const templateId = parseInput(objectIdSchema, id)
    const template = parseInput(certificateTemplateInputSchema, input)
    return safely(async () => {
      const collection =
        (await getDb()).collection<CertificateTemplateDocument>(
          'certificateTemplates',
        )
      const result = await collection.updateOne(
        { _id: templateId },
        { $set: { ...template, updatedAt: new Date() } },
      )
      if (!result.matchedCount) throw new RepositoryError('not_found')
      const updated = await collection.findOne({ _id: templateId })
      if (!updated) throw new RepositoryError('not_found')
      return serializeCertificateTemplate(updated)
    })
  }

  async function searchCertificates(input: unknown): Promise<{
    items: Array<SerializedCertificate & { fileAvailable: boolean }>
    page: number
    limit: number
  }> {
    const search = parseInput(certificateSearchSchema, input)
    const filter: Filter<CertificateDocument> = {}
    if (search.query) {
      filter.certificateId = {
        $regex: escapeRegex(search.query.toUpperCase()),
        $options: 'i',
      }
    }
    if (search.status) filter.status = search.status
    return safely(async () => {
      const documents = await (await getDb())
        .collection<CertificateDocument>('certificates')
        .find(filter)
        .sort({ issueDate: -1, _id: -1 })
        .skip((search.page - 1) * search.limit)
        .limit(search.limit)
        .toArray()
      return {
        items: documents.map((document) => ({
          ...serializeCertificate(document),
          fileAvailable: Boolean(document.fileId),
        })),
        page: search.page,
        limit: search.limit,
      }
    })
  }

  async function getDashboardStatistics(): Promise<DashboardStatistics> {
    return safely(async () => {
      const database = await getDb()
      const [
        participants,
        enrollments,
        inProgressEnrollments,
        certificates,
        activeCertificates,
        revokedCertificates,
      ] =
        await Promise.all([
          database.collection<ParticipantDocument>('participants').countDocuments(),
          database.collection<EnrollmentDocument>('enrollments').countDocuments(),
          database.collection<EnrollmentDocument>('enrollments').countDocuments({
            status: 'in_progress',
          }),
          database.collection<CertificateDocument>('certificates').countDocuments(),
          database.collection<CertificateDocument>('certificates').countDocuments({
            status: 'issued',
          }),
          database.collection<CertificateDocument>('certificates').countDocuments({
            status: 'revoked',
          }),
        ])
      return {
        participants,
        enrollments,
        inProgressEnrollments,
        certificates,
        activeCertificates,
        revokedCertificates,
      }
    })
  }

  async function insertIssuedCertificate(input: {
    enrollmentId: ObjectId
    templateId?: ObjectId
    issueDate: Date
    supersedesCertificateId?: string
    reissueWorkflowId?: ObjectId
    fileId?: ObjectId
    fileSize?: number
  }): Promise<SerializedCertificate> {
    const database = await getDb()
    const document: CertificateDocument = {
      _id: new ObjectId(),
      certificateId: generatedCertificateId(),
      enrollmentId: input.enrollmentId,
      ...(input.templateId ? { templateId: input.templateId } : {}),
      issueDate: new Date(input.issueDate),
      verificationIdentifier: createVerificationIdentifier(),
      status: 'issued',
      ...(input.supersedesCertificateId
        ? { supersedesCertificateId: input.supersedesCertificateId }
        : {}),
      ...(input.reissueWorkflowId
        ? { reissueWorkflowId: input.reissueWorkflowId }
        : {}),
      ...(input.fileId ? { fileId: input.fileId } : {}),
      ...(input.fileSize !== undefined ? { fileSize: input.fileSize } : {}),
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    await database
      .collection<CertificateDocument>('certificates')
      .insertOne(document)
    return serializeCertificate(document)
  }

  async function createCertificate(
    input: unknown,
    uploadedFile?: { fileId: unknown; fileSize: unknown },
  ): Promise<SerializedCertificate> {
    const parsed = parseInput(certificateIssueInputSchema, input)
    const fileId =
      uploadedFile === undefined
        ? undefined
        : parseInput(objectIdSchema, uploadedFile.fileId)
    const fileSize =
      uploadedFile === undefined
        ? undefined
        : parseInput(z.number().int().min(1).max(3_500_000), uploadedFile.fileSize)
    return safely(async () => {
      const database = await getDb()
      const enrollment = await database
        .collection<EnrollmentDocument>('enrollments')
        .findOne({ _id: parsed.enrollmentId })
      if (!enrollment) throw new RepositoryError('not_found')
      if (enrollment.status !== 'completed' || !enrollment.completedAt) {
        throw new RepositoryError('conflict')
      }
      if (parsed.templateId) {
        const templateExists = await database
          .collection<CertificateTemplateDocument>('certificateTemplates')
          .findOne({ _id: parsed.templateId })
        if (!templateExists) throw new RepositoryError('not_found')
      }

      const activeWorkflow = await database
        .collection<CertificateReissueWorkflowDocument>(
          'certificateReissueWorkflows',
        )
        .findOne({ activeEnrollmentId: parsed.enrollmentId })
      if (activeWorkflow) throw new RepositoryError('conflict')

      const existingCertificate = await database
        .collection<CertificateDocument>('certificates')
        .findOne({ enrollmentId: parsed.enrollmentId })
      if (existingCertificate) throw new RepositoryError('conflict')

      return insertIssuedCertificate({ ...parsed, fileId, fileSize })
    })
  }

  async function getCertificateById(
    certificateId: unknown,
  ): Promise<SerializedCertificate | null> {
    const id = parseInput(certificateIdSchema, certificateId)
    return safely(async () => {
      const document = await (await getDb())
        .collection<CertificateDocument>('certificates')
        .findOne({ certificateId: id })
      return document ? serializeCertificate(document) : null
    })
  }

  async function getCertificateReissueReplacement(
    idempotencyKey: unknown,
  ): Promise<(SerializedCertificate & { fileAvailable: boolean }) | null> {
    const key = parseInput(idempotencyKeySchema, idempotencyKey)
    return safely(async () => {
      const database = await getDb()
      const workflow = await database
        .collection<CertificateReissueWorkflowDocument>(
          'certificateReissueWorkflows',
        )
        .findOne({ idempotencyKey: key })
      if (!workflow || workflow.state !== 'completed') return null
      const certificate = await database
        .collection<CertificateDocument>('certificates')
        .findOne({ reissueWorkflowId: workflow._id })
      return certificate
        ? {
            ...serializeCertificate(certificate),
            fileAvailable: Boolean(certificate.fileId),
          }
        : null
    })
  }

  async function attachReplacementCertificateFile(
    certificateId: unknown,
    fileIdInput: unknown,
    fileSizeInput: unknown,
  ): Promise<SerializedCertificate> {
    const id = parseInput(certificateIdSchema, certificateId)
    const fileId = parseInput(objectIdSchema, fileIdInput)
    const fileSize = parseInput(z.number().int().min(1).max(3_500_000), fileSizeInput)
    return safely(async () => {
      const collection =
        (await getDb()).collection<CertificateDocument>('certificates')
      const result = await collection.updateOne(
        {
          certificateId: id,
          status: 'issued',
          reissueWorkflowId: { $exists: true },
          fileId: { $exists: false },
        },
        { $set: { fileId, fileSize, updatedAt: new Date() } },
      )
      if (!result.matchedCount) {
        const existing = await collection.findOne({
          certificateId: id,
          status: 'issued',
          fileId,
        })
        if (!existing) throw new RepositoryError('conflict')
        return serializeCertificate(existing)
      }
      const updated = await collection.findOne({ certificateId: id })
      if (!updated) throw new RepositoryError('not_found')
      return serializeCertificate(updated)
    })
  }

  async function getCertificateByVerificationIdentifier(
    verificationIdentifier: unknown,
  ): Promise<SerializedCertificate | null> {
    const identifier = parseInput(
      verificationIdentifierSchema,
      verificationIdentifier,
    )
    return safely(async () => {
      const document = await (await getDb())
        .collection<CertificateDocument>('certificates')
        .findOne({ verificationIdentifier: identifier })
      return document ? serializeCertificate(document) : null
    })
  }

  async function getCertificateFileById(
    certificateId: unknown,
  ): Promise<{ fileId: ObjectId; certificateId: string } | null> {
    const id = parseInput(certificateIdSchema, certificateId)
    return safely(async () => {
      const certificate = await (await getDb())
        .collection<CertificateDocument>('certificates')
        .findOne({ certificateId: id, status: 'issued' })
      return certificate?.fileId
        ? { fileId: certificate.fileId, certificateId: certificate.certificateId }
        : null
    })
  }

  async function getPublicCertificateFile(
    verificationIdentifier: unknown,
  ): Promise<{ fileId: ObjectId; certificateId: string } | null> {
    const identifier = parseInput(
      verificationIdentifierSchema,
      verificationIdentifier,
    )
    return safely(async () => {
      const certificate = await (await getDb())
        .collection<CertificateDocument>('certificates')
        .findOne({
          verificationIdentifier: identifier,
          status: 'issued',
          fileId: { $exists: true },
        })
      return certificate?.fileId
        ? { fileId: certificate.fileId, certificateId: certificate.certificateId }
        : null
    })
  }

  async function searchPublicCertificates(queryInput: unknown): Promise<Array<{
    certificateId: string
    participantName: string
    courseName: string
    status: 'issued'
    issueDate: string
    downloadUrl: string
  }>> {
    const query = parseInput(z.string().trim().min(1).max(200), queryInput)
    return safely(async () => {
      const database = await getDb()
      const exactCode = verificationIdentifierSchema.safeParse(query)
      const exactCertificateId = certificateIdSchema.safeParse(query)
      const isExactCertificateId =
        exactCertificateId.success && /^TS-[\dA-F]{32}$/i.test(query)
      const certificateMatch: Filter<CertificateDocument> = {
        status: 'issued',
        fileId: { $exists: true },
        ...(exactCode.success
          ? { verificationIdentifier: exactCode.data }
          : isExactCertificateId
            ? { certificateId: exactCertificateId.data }
            : {}),
      }
      const pipeline = [
        { $match: certificateMatch },
        {
          $lookup: {
            from: 'certificateFiles.files',
            localField: 'fileId',
            foreignField: '_id',
            as: 'storedFile',
          },
        },
        { $match: { 'storedFile.0': { $exists: true } } },
        {
          $lookup: {
            from: 'enrollments',
            localField: 'enrollmentId',
            foreignField: '_id',
            as: 'enrollment',
          },
        },
        { $unwind: '$enrollment' },
        {
          $lookup: {
            from: 'participants',
            localField: 'enrollment.participantId',
            foreignField: '_id',
            as: 'participant',
          },
        },
        { $unwind: '$participant' },
        ...(!exactCode.success && !isExactCertificateId
          ? [{
              $match: {
                'participant.name': {
                  $regex: escapeRegex(query),
                  $options: 'i',
                },
              },
            }]
          : []),
        { $sort: { issueDate: -1, _id: -1 } },
        { $limit: 10 },
        {
          $project: {
            _id: 0,
            certificateId: 1,
            verificationIdentifier: 1,
            status: 1,
            issueDate: 1,
            participantName: '$participant.name',
            courseName: '$enrollment.courseName',
          },
        },
      ]
      const matches = await database
        .collection<CertificateDocument>('certificates')
        .aggregate<{
          certificateId: string
          verificationIdentifier: string
          status: 'issued'
          issueDate: Date
          participantName: string
          courseName: string
        }>(pipeline)
        .toArray()
      return matches.map((match) => ({
        certificateId: match.certificateId,
        participantName: match.participantName,
        courseName: match.courseName,
        status: match.status,
        issueDate: match.issueDate.toISOString(),
        downloadUrl: `/api/verify/${encodeURIComponent(match.verificationIdentifier)}/file`,
      }))
    })
  }

  async function revokeCertificate(
    certificateId: unknown,
    reason: unknown,
  ): Promise<SerializedCertificate> {
    const id = parseInput(certificateIdSchema, certificateId)
    const revocationReason = parseInput(revocationReasonSchema, reason)
    return safely(async () => {
      const database = await getDb()
      const certificates =
        database.collection<CertificateDocument>('certificates')
      const certificate = await certificates.findOne({ certificateId: id })
      if (!certificate) throw new RepositoryError('not_found')
      if (certificate.status === 'revoked') {
        if (certificate.revocationWorkflowId) {
          throw new RepositoryError('conflict')
        }
        return serializeCertificate(certificate)
      }
      const activeWorkflow = await database
        .collection<CertificateReissueWorkflowDocument>(
          'certificateReissueWorkflows',
        )
        .findOne({ activeEnrollmentId: certificate.enrollmentId })
      if (activeWorkflow) throw new RepositoryError('conflict')
      const now = new Date()
      const update: UpdateFilter<CertificateDocument> = {
        $set: {
          status: 'revoked',
          revokedAt: now,
          revocationReason,
          updatedAt: now,
        },
      }
      const result = await certificates.updateOne(
        {
          _id: certificate._id,
          status: 'issued',
          revocationWorkflowId: { $exists: false },
        },
        update,
      )
      if (!result.matchedCount) throw new RepositoryError('conflict')
      const updated = await certificates.findOne({ _id: certificate._id })
      if (!updated) throw new RepositoryError('not_found')
      return serializeCertificate(updated)
    })
  }

  async function requestCertificateReissue(
    certificateId: unknown,
    idempotencyKey: unknown,
  ): Promise<SerializedReissueWorkflow> {
    const previousId = parseInput(certificateIdSchema, certificateId)
    const key = parseInput(idempotencyKeySchema, idempotencyKey)
    return safely(async () => {
      const database = await getDb()
      const workflows =
        database.collection<CertificateReissueWorkflowDocument>(
          'certificateReissueWorkflows',
        )
      await requireReissueIndexes(database)
      const existingRequest = await workflows.findOne({ idempotencyKey: key })
      if (existingRequest) {
        const previous = await database
          .collection<CertificateDocument>('certificates')
          .findOne({ certificateId: previousId })
        if (
          !previous ||
          !previous._id.equals(existingRequest.previousCertificateId)
        ) {
          throw new RepositoryError('conflict')
        }
        return serializeReissueWorkflow(existingRequest)
      }

      const previous = await database
        .collection<CertificateDocument>('certificates')
        .findOne({ certificateId: previousId })
      if (!previous) throw new RepositoryError('not_found')
      if (previous.status !== 'issued') throw new RepositoryError('conflict')
      const enrollment = await database
        .collection<EnrollmentDocument>('enrollments')
        .findOne({ _id: previous.enrollmentId })
      if (!enrollment) throw new RepositoryError('not_found')
      if (enrollment.status !== 'completed') {
        throw new RepositoryError('conflict')
      }
      if (!previous.templateId) throw new MissingTemplateError()
      const template = await database
        .collection<CertificateTemplateDocument>('certificateTemplates')
        .findOne({ _id: previous.templateId })
      if (!template) throw new MissingTemplateError()

      const now = new Date()
      const workflow: CertificateReissueWorkflowDocument = {
        _id: new ObjectId(),
        idempotencyKey: key,
        enrollmentId: previous.enrollmentId,
        previousCertificateId: previous._id,
        replacementDocumentId: new ObjectId(),
        replacementCertificateId: generatedCertificateId(),
        replacementVerificationIdentifier: createVerificationIdentifier(),
        templateId: previous.templateId,
        issueDate: now,
        state: 'requested',
        activeEnrollmentId: previous.enrollmentId,
        createdAt: now,
        updatedAt: now,
      }
      try {
        await workflows.insertOne(workflow)
      } catch (error) {
        if (!isDuplicate(error)) throw error
        const retry = await workflows.findOne({ idempotencyKey: key })
        if (retry) {
          if (!retry.previousCertificateId.equals(previous._id)) {
            throw new RepositoryError('conflict')
          }
          return serializeReissueWorkflow(retry)
        }
        const active = await workflows.findOne({
          activeEnrollmentId: previous.enrollmentId,
        })
        if (active) throw new RepositoryError('conflict')
        throw new RepositoryError('duplicate')
      }
      return serializeReissueWorkflow(workflow)
    })
  }

  async function resumeCertificateReissue(
    idempotencyKey: unknown,
  ): Promise<SerializedReissueWorkflow> {
    const key = parseInput(idempotencyKeySchema, idempotencyKey)
    return safely(async () => {
      const database = await getDb()
      await requireReissueIndexes(database)
      const workflows =
        database.collection<CertificateReissueWorkflowDocument>(
          'certificateReissueWorkflows',
        )
      let workflow = await workflows.findOne({ idempotencyKey: key })
      if (!workflow) throw new RepositoryError('not_found')
      if (workflow.state === 'cancelled') {
        throw new RepositoryError('conflict')
      }
      if (workflow.state === 'requested') {
        const certificates =
          database.collection<CertificateDocument>('certificates')
        let previous = await certificates.findOne({
          _id: workflow.previousCertificateId,
        })
        if (!previous) throw new RepositoryError('not_found')
        const template = await database
          .collection<CertificateTemplateDocument>('certificateTemplates')
          .findOne({ _id: workflow.templateId })
        if (!template) throw new MissingTemplateError()
        if (previous.status === 'issued' && !previous.revocationWorkflowId) {
          const now = new Date()
          const update: UpdateFilter<CertificateDocument> = {
            $set: {
              status: 'revoked',
              revokedAt: now,
              revocationReason: 'Superseded by certificate reissue',
              revocationWorkflowId: workflow._id,
              updatedAt: now,
            },
          }
          await certificates.updateOne(
            {
              _id: previous._id,
              status: 'issued',
              revocationWorkflowId: { $exists: false },
            },
            update,
          )
          previous = await certificates.findOne({ _id: previous._id })
          if (!previous) throw new RepositoryError('not_found')
        }
        if (
          previous.status !== 'revoked' ||
          !previous.revocationWorkflowId?.equals(workflow._id)
        ) {
          await workflows.updateOne(
            { _id: workflow._id, state: 'requested' },
            {
              $set: { state: 'cancelled', updatedAt: new Date() },
              $unset: { activeEnrollmentId: '' },
            },
          )
          throw new RepositoryError('conflict')
        }
        await workflows.updateOne(
          { _id: workflow._id, state: 'requested' },
          { $set: { state: 'previous_revoked', updatedAt: new Date() } },
        )
        workflow = await workflows.findOne({ _id: workflow._id })
        if (!workflow) throw new RepositoryError('not_found')
      }

      if (workflow.state === 'previous_revoked') {
        const certificates =
          database.collection<CertificateDocument>('certificates')
        const template = await database
          .collection<CertificateTemplateDocument>('certificateTemplates')
          .findOne({ _id: workflow.templateId })
        if (!template) throw new MissingTemplateError()
        let replacement = await certificates.findOne({
          reissueWorkflowId: workflow._id,
        })
        if (!replacement) {
          const now = new Date()
          const candidate: CertificateDocument = {
            _id: workflow.replacementDocumentId,
            certificateId: workflow.replacementCertificateId,
            enrollmentId: workflow.enrollmentId,
            templateId: workflow.templateId,
            issueDate: workflow.issueDate,
            verificationIdentifier:
              workflow.replacementVerificationIdentifier,
            status: 'issued',
            supersedesCertificateId: (
              await certificates.findOne({
                _id: workflow.previousCertificateId,
              })
            )?.certificateId,
            reissueWorkflowId: workflow._id,
            createdAt: now,
            updatedAt: now,
          }
          try {
            await certificates.insertOne(candidate)
            replacement = candidate
          } catch (error) {
            if (!isDuplicate(error)) throw error
            replacement = await certificates.findOne({
              _id: workflow.replacementDocumentId,
            })
            if (!replacement) {
              replacement = await certificates.findOne({
                reissueWorkflowId: workflow._id,
              })
            }
            const sameReplacement =
              replacement?.reissueWorkflowId?.equals(workflow._id) &&
              replacement._id.equals(workflow.replacementDocumentId) &&
              replacement.certificateId === workflow.replacementCertificateId &&
              replacement.verificationIdentifier ===
                workflow.replacementVerificationIdentifier &&
              replacement.enrollmentId.equals(workflow.enrollmentId) &&
              replacement.templateId?.equals(workflow.templateId) &&
              replacement.issueDate.getTime() === workflow.issueDate.getTime() &&
              replacement.supersedesCertificateId ===
                candidate.supersedesCertificateId &&
              replacement.status === 'issued'
            if (
              !replacement ||
              !sameReplacement
            ) {
              throw new RepositoryError('duplicate')
            }
          }
        }
        await workflows.updateOne(
          { _id: workflow._id, state: 'previous_revoked' },
          { $set: { state: 'replacement_created', updatedAt: new Date() } },
        )
        workflow = await workflows.findOne({ _id: workflow._id })
        if (!workflow) throw new RepositoryError('not_found')
      }

      if (workflow.state === 'replacement_created') {
        await workflows.updateOne(
          { _id: workflow._id, state: 'replacement_created' },
          {
            $set: { state: 'completed', updatedAt: new Date() },
            $unset: { activeEnrollmentId: '' },
          },
        )
        workflow = await workflows.findOne({ _id: workflow._id })
        if (!workflow) throw new RepositoryError('not_found')
      }

      return serializeReissueWorkflow(workflow)
    })
  }

  return {
    createParticipant,
    updateParticipant,
    deleteParticipant,
    getParticipantById,
    getParticipantByEmail,
    searchParticipants,
    listPublicParticipantNames,
    createEnrollment,
    searchEnrollments,
    getEnrollmentById,
    updateEnrollment,
    deleteEnrollment,
    getEnrollmentByParticipantAndCourse,
    completeEnrollment: (id: unknown) =>
      transitionEnrollment(id, 'completed'),
    withdrawEnrollment: (id: unknown) =>
      transitionEnrollment(id, 'withdrawn'),
    createCertificateTemplate,
    listCertificateTemplates,
    updateCertificateTemplate,
    getCertificateTemplateById,
    getCertificateTemplateByName,
    createCertificate,
    searchCertificates,
    getDashboardStatistics,
    getCertificateById,
    getCertificateReissueReplacement,
    attachReplacementCertificateFile,
    getCertificateByVerificationIdentifier,
    getCertificateFileById,
    getPublicCertificateFile,
    searchPublicCertificates,
    revokeCertificate,
    requestCertificateReissue,
    resumeCertificateReissue,
  }
}
