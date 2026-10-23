import '@tanstack/react-start/server-only'

import { randomBytes } from 'node:crypto'
import {
  ObjectId,
  type CreateIndexesOptions,
  type Db,
  type IndexSpecification,
} from 'mongodb'
import { z } from 'zod'
import type {
  CertificateTemplate,
  CertificateTemplateLayout,
  LegacyCertificateTemplateLayout,
} from './template-layout.ts'

export * from './template-layout.ts'

export const participantInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().toLowerCase().max(320).email(),
  displayNamePublicly: z.boolean().default(false),
})

export type ParticipantInput = z.input<typeof participantInputSchema>
export type Participant = z.output<typeof participantInputSchema>

export interface ParticipantDocument
  extends Omit<Participant, 'displayNamePublicly'> {
  _id: ObjectId
  enrollmentVersion?: number
  displayNamePublicly?: boolean
  createdAt: Date
  updatedAt: Date
}

export interface SerializedParticipant {
  id: string
  name: string
  email: string
  displayNamePublicly?: boolean
  createdAt: string
  updatedAt: string
}

export interface CertificateTemplateDocument extends CertificateTemplate {
  _id: ObjectId
  createdAt: Date
  updatedAt: Date
}

export interface SerializedCertificateTemplate {
  id: string
  name: string
  description: string
  layout: CertificateTemplateLayout | LegacyCertificateTemplateLayout
  allowedDynamicFields: CertificateTemplate['allowedDynamicFields']
  createdAt: string
  updatedAt: string
}

export const objectIdStringSchema = z.string().regex(/^[\da-f]{24}$/i)

export const objectIdSchema = objectIdStringSchema.transform(
  (id) => new ObjectId(id),
)

export const courseIdSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Invalid stable course identifier')

export const enrollmentStatusSchema = z.enum([
  'in_progress',
  'completed',
  'withdrawn',
])

export const enrollmentInputSchema = z.object({
  participantId: objectIdStringSchema,
  courseId: courseIdSchema,
  courseName: z.string().trim().min(1).max(200),
})

export const enrollmentDetailsInputSchema = enrollmentInputSchema.pick({
  courseId: true,
  courseName: true,
})

export type EnrollmentInput = z.input<typeof enrollmentInputSchema>

export interface EnrollmentDocument {
  _id: ObjectId
  participantId: ObjectId
  courseId: string
  courseName: string
  status: z.infer<typeof enrollmentStatusSchema>
  completedAt?: Date
  createdAt: Date
  updatedAt: Date
}

export interface SerializedEnrollment {
  id: string
  participantId: string
  courseId: string
  courseName: string
  status: EnrollmentDocument['status']
  completedAt: string | null
  createdAt: string
  updatedAt: string
}

export const certificateIdSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9_-]{2,99}$/)

export const verificationIdentifierSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/, 'Invalid verification identifier')

const issueDateSchema = z
  .union([z.date(), z.iso.datetime({ offset: true })])
  .transform((value) =>
    value instanceof Date ? new Date(value.getTime()) : new Date(value),
  )

export const certificateIssueInputSchema = z.object({
  enrollmentId: objectIdSchema,
  templateId: objectIdSchema.optional(),
  issueDate: issueDateSchema.default(() => new Date()),
})

export const certificateStatusSchema = z.enum(['issued', 'revoked'])
export const certificateRevocationSchema = z.object({
  revokedAt: z.date(),
  revocationReason: z.string().trim().min(1).max(1000),
})

export interface CertificateDocument {
  _id: ObjectId
  certificateId: string
  enrollmentId: ObjectId
  templateId?: ObjectId
  issueDate: Date
  verificationIdentifier: string
  status: z.infer<typeof certificateStatusSchema>
  revokedAt?: Date
  revocationReason?: string
  revocationWorkflowId?: ObjectId
  supersedesCertificateId?: string
  reissueWorkflowId?: ObjectId
  fileId?: ObjectId
  fileSize?: number
  createdAt: Date
  updatedAt: Date
}

export interface SerializedCertificate {
  id: string
  certificateId: string
  enrollmentId: string
  templateId?: string
  issueDate: string
  status: CertificateDocument['status']
  revokedAt: string | null
  supersedesCertificateId: string | null
  createdAt: string
  updatedAt: string
}

export const reissueWorkflowStateSchema = z.enum([
  'requested',
  'previous_revoked',
  'replacement_created',
  'completed',
  'cancelled',
])

export interface CertificateReissueWorkflowDocument {
  _id: ObjectId
  idempotencyKey: string
  enrollmentId: ObjectId
  previousCertificateId: ObjectId
  replacementDocumentId: ObjectId
  replacementCertificateId: string
  replacementVerificationIdentifier: string
  templateId: ObjectId
  issueDate: Date
  state: z.infer<typeof reissueWorkflowStateSchema>
  activeEnrollmentId?: ObjectId
  createdAt: Date
  updatedAt: Date
}

export interface SerializedReissueWorkflow {
  state: CertificateReissueWorkflowDocument['state']
}

export function createVerificationIdentifier(): string {
  return randomBytes(32).toString('base64url')
}

export function createCertificateId(): string {
  return `TS-${randomBytes(16).toString('hex').toUpperCase()}`
}

export function serializeParticipant(
  document: ParticipantDocument,
): SerializedParticipant {
  return {
    id: document._id.toHexString(),
    name: document.name,
    email: document.email,
    displayNamePublicly: document.displayNamePublicly === true,
    createdAt: document.createdAt.toISOString(),
    updatedAt: document.updatedAt.toISOString(),
  }
}

export function serializeEnrollment(
  document: EnrollmentDocument,
): SerializedEnrollment {
  return {
    id: document._id.toHexString(),
    participantId: document.participantId.toHexString(),
    courseId: document.courseId,
    courseName: document.courseName,
    status: document.status,
    completedAt: document.completedAt?.toISOString() ?? null,
    createdAt: document.createdAt.toISOString(),
    updatedAt: document.updatedAt.toISOString(),
  }
}

export function serializeCertificateTemplate(
  document: CertificateTemplateDocument,
): SerializedCertificateTemplate {
  return {
    id: document._id.toHexString(),
    name: document.name,
    description: document.description,
    layout: document.layout,
    allowedDynamicFields: document.allowedDynamicFields,
    createdAt: document.createdAt.toISOString(),
    updatedAt: document.updatedAt.toISOString(),
  }
}

export function serializeCertificate(
  document: CertificateDocument,
): SerializedCertificate {
  return {
    id: document._id.toHexString(),
    certificateId: document.certificateId,
    enrollmentId: document.enrollmentId.toHexString(),
    ...(document.templateId
      ? { templateId: document.templateId.toHexString() }
      : {}),
    issueDate: document.issueDate.toISOString(),
    status: document.status,
    revokedAt: document.revokedAt?.toISOString() ?? null,
    supersedesCertificateId: document.supersedesCertificateId ?? null,
    createdAt: document.createdAt.toISOString(),
    updatedAt: document.updatedAt.toISOString(),
  }
}

export function serializeReissueWorkflow(
  document: CertificateReissueWorkflowDocument,
): SerializedReissueWorkflow {
  return {
    state: document.state,
  }
}

export interface ModelIndexDefinition {
  collection:
    | 'participants'
    | 'enrollments'
    | 'certificateTemplates'
    | 'certificates'
    | 'certificateReissueWorkflows'
  keys: IndexSpecification
  options: CreateIndexesOptions
}

export const MODEL_INDEXES = [
  {
    collection: 'participants',
    keys: { email: 1 },
    options: { name: 'participants_email_unique', unique: true },
  },
  {
    collection: 'enrollments',
    keys: { participantId: 1, courseId: 1 },
    options: { name: 'enrollments_participant_course_unique', unique: true },
  },
  {
    collection: 'enrollments',
    keys: { courseId: 1, status: 1 },
    options: { name: 'enrollments_course_status_lookup' },
  },
  {
    collection: 'enrollments',
    keys: { participantId: 1, status: 1 },
    options: { name: 'enrollments_participant_status_lookup' },
  },
  {
    collection: 'certificateTemplates',
    keys: { name: 1 },
    options: { name: 'certificate_templates_name_unique', unique: true },
  },
  {
    collection: 'certificates',
    keys: { certificateId: 1 },
    options: { name: 'certificates_certificate_id_unique', unique: true },
  },
  {
    collection: 'certificates',
    keys: { verificationIdentifier: 1 },
    options: {
      name: 'certificates_verification_identifier_unique',
      unique: true,
    },
  },
  {
    collection: 'certificates',
    keys: { enrollmentId: 1, issueDate: -1 },
    options: { name: 'certificates_enrollment_history_lookup' },
  },
  {
    collection: 'certificates',
    keys: { templateId: 1 },
    options: { name: 'certificates_template_lookup' },
  },
  {
    collection: 'certificates',
    keys: { enrollmentId: 1 },
    options: {
      name: 'certificates_one_issued_per_enrollment',
      unique: true,
      partialFilterExpression: { status: 'issued' },
    },
  },
  {
    collection: 'certificates',
    keys: { reissueWorkflowId: 1 },
    options: {
      name: 'certificates_reissue_workflow_unique',
      unique: true,
      sparse: true,
    },
  },
  {
    collection: 'certificateReissueWorkflows',
    keys: { idempotencyKey: 1 },
    options: { name: 'certificate_reissue_idempotency_unique', unique: true },
  },
  {
    collection: 'certificateReissueWorkflows',
    keys: { activeEnrollmentId: 1 },
    options: {
      name: 'certificate_reissue_active_enrollment_unique',
      unique: true,
      sparse: true,
    },
  },
] as const satisfies readonly ModelIndexDefinition[]

export async function createModelIndexes(database: Db): Promise<void> {
  for (const index of MODEL_INDEXES) {
    await database
      .collection(index.collection)
      .createIndex(index.keys, index.options)
  }
}
