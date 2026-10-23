import assert from 'node:assert/strict'
import test from 'node:test'

import { ObjectId } from 'mongodb'
import {
  MODEL_INDEXES,
  certificateIssueInputSchema,
  certificateTemplateElementSchema,
  certificateTemplateInputSchema,
  certificateTemplateLayoutInputSchema,
  certificateTemplateLayoutSchema,
  createCertificateId,
  createVerificationIdentifier,
  enrollmentInputSchema,
  objectIdSchema,
  participantInputSchema,
  serializeCertificate,
  serializeEnrollment,
  serializeParticipant,
  serializeReissueWorkflow,
  type CertificateReissueWorkflowDocument,
} from '../src/lib/models.server.ts'

test('participant schema preserves display name and normalizes unique email', () => {
  assert.deepEqual(
    participantInputSchema.parse({
      name: '  Amelie Ngu ',
      email: ' AMELIE@EXAMPLE.COM ',
    }),
    {
      name: 'Amelie Ngu',
      email: 'amelie@example.com',
      displayNamePublicly: false,
    },
  )
  assert.equal(
    participantInputSchema.parse({
      name: 'Amelie Ngu',
      email: 'amelie@example.com',
      displayNamePublicly: true,
    }).displayNamePublicly,
    true,
  )
})

test('enrollment schema normalizes stable course identifiers', () => {
  const participantId = new ObjectId().toHexString()
  const enrollment = enrollmentInputSchema.parse({
    participantId,
    courseId: '  WEB-FOUNDATIONS ',
    courseName: ' Web Foundations ',
  })
  assert.equal(enrollment.courseId, 'web-foundations')
  assert.equal(enrollment.courseName, 'Web Foundations')
  assert.equal(enrollment.participantId, participantId)
  assert.ok(objectIdSchema.parse(enrollment.participantId) instanceof ObjectId)
  assert.equal(
    enrollmentInputSchema.safeParse({
      participantId: 'invalid',
      courseId: 'not a stable id',
      courseName: '',
    }).success,
    false,
  )
})

test('legacy template input remains readable and preserves distinct allowed fields', () => {
  const valid = {
    name: '  Completion  ',
    description: '  Course completion certificate  ',
    layout: { page: { width: 1200, units: 'px' }, labels: ['Name'] },
    allowedDynamicFields: ['participant.name', 'enrollment.courseName'],
  }
  assert.equal(certificateTemplateInputSchema.parse(valid).name, 'Completion')
  assert.equal(
    certificateTemplateInputSchema.safeParse({
      ...valid,
      allowedDynamicFields: ['participant.name', 'participant.name'],
    }).success,
    false,
  )
  assert.equal(
    certificateTemplateInputSchema.safeParse({
      ...valid,
      layout: { invalid: Number.POSITIVE_INFINITY },
    }).success,
    false,
  )
  assert.deepEqual(
    certificateTemplateLayoutInputSchema.parse(valid.layout),
    valid.layout,
  )
})

const validTemplateLayout = {
  schemaVersion: 1,
  page: {
    width: 792,
    height: 612,
    orientation: 'landscape',
    backgroundColor: '#FFFFFF',
    background: {
      assetId: 'asset_background_123',
      fit: 'cover',
    },
  },
  elements: [
    {
      id: 'participant-name',
      type: 'text',
      x: 100,
      y: 120,
      width: 592,
      height: 60,
      required: true,
      binding: 'participant.name',
      alignment: 'center',
      font: {
        family: 'Helvetica',
        size: 32,
        color: '#123456',
        weight: 'bold',
        italic: false,
        lineSpacing: 1.1,
      },
    },
    {
      id: 'brand-logo',
      type: 'image',
      x: 24,
      y: 24,
      width: 120,
      height: 80,
      assetId: 'asset_asset_123456',
      fit: 'contain',
    },
    {
      id: 'participant-photo',
      type: 'photo',
      x: 600,
      y: 340,
      width: 120,
      height: 150,
      binding: 'participant.photo',
      fit: 'cover',
      required: false,
    },
    {
      id: 'director-signature',
      type: 'signature',
      x: 320,
      y: 480,
      width: 180,
      height: 60,
      binding: 'signer.signature',
      nameBinding: 'signer.name',
      titleBinding: 'signer.title',
    },
    {
      id: 'frame',
      type: 'shape',
      x: 12,
      y: 12,
      width: 768,
      height: 588,
      shape: 'rectangle',
      fill: '#FFFFFF',
      stroke: '#123456',
      strokeWidth: 2,
    },
  ],
} as const

test('versioned template layout validates typed elements and point coordinates', () => {
  const parsed = certificateTemplateLayoutSchema.parse(validTemplateLayout)
  assert.equal(parsed.schemaVersion, 1)
  assert.equal(parsed.page.orientation, 'landscape')
  assert.equal(parsed.page.width, 792)
  assert.equal(parsed.elements.length, 5)
  assert.equal(parsed.elements[0]?.type, 'text')
  assert.equal(parsed.elements[1]?.type, 'image')
  assert.equal(parsed.elements[2]?.type, 'photo')
  assert.equal(parsed.elements[3]?.type, 'signature')
  assert.equal(parsed.elements[4]?.type, 'shape')
  assert.deepEqual(
    certificateTemplateLayoutInputSchema.parse(parsed),
    parsed,
  )
})

test('versioned layouts reject missing, invalid, and unsupported schema versions', () => {
  assert.equal(
    certificateTemplateLayoutSchema.safeParse({
      ...validTemplateLayout,
      schemaVersion: undefined,
    }).success,
    false,
  )
  assert.deepEqual(
    certificateTemplateLayoutInputSchema.parse({
      page: { width: 1200, units: 'px' },
      labels: ['Legacy'],
    }),
    {
      page: { width: 1200, units: 'px' },
      labels: ['Legacy'],
    },
  )
  for (const layout of [
    { ...validTemplateLayout, schemaVersion: 0 },
    { ...validTemplateLayout, schemaVersion: 2 },
    { ...validTemplateLayout, schemaVersion: '1' },
  ]) {
    assert.equal(certificateTemplateLayoutSchema.safeParse(layout).success, false)
    assert.equal(certificateTemplateLayoutInputSchema.safeParse(layout).success, false)
  }
})

test('versioned layouts reject unsupported element types and properties', () => {
  assert.equal(
    certificateTemplateElementSchema.safeParse({
      ...validTemplateLayout.elements[0],
      type: 'html',
    }).success,
    false,
  )
  assert.equal(
    certificateTemplateLayoutSchema.safeParse({
      ...validTemplateLayout,
      extra: true,
    }).success,
    false,
  )
  assert.equal(
    certificateTemplateLayoutSchema.safeParse({
      ...validTemplateLayout,
      page: { ...validTemplateLayout.page, url: 'https://example.test' },
    }).success,
    false,
  )
  assert.equal(
    certificateTemplateElementSchema.safeParse({
      ...validTemplateLayout.elements[0],
      html: '<script>run()</script>',
    }).success,
    false,
  )
})

test('versioned layouts reject duplicate element IDs', () => {
  const duplicate = {
    ...validTemplateLayout.elements[1],
    id: validTemplateLayout.elements[0].id,
  }
  assert.equal(
    certificateTemplateLayoutSchema.safeParse({
      ...validTemplateLayout,
      elements: [validTemplateLayout.elements[0], duplicate],
    }).success,
    false,
  )
})

test('versioned layouts reject invalid coordinates, dimensions, orientation, and numeric values', () => {
  for (const element of [
    { ...validTemplateLayout.elements[0], x: -1 },
    { ...validTemplateLayout.elements[0], y: Number.POSITIVE_INFINITY },
    { ...validTemplateLayout.elements[0], width: Number.NaN },
    { ...validTemplateLayout.elements[0], height: 0 },
    { ...validTemplateLayout.elements[0], x: 700, width: 100 },
    { ...validTemplateLayout.elements[0], y: 600, height: 20 },
  ]) {
    assert.equal(
      certificateTemplateLayoutSchema.safeParse({
        ...validTemplateLayout,
        elements: [element],
      }).success,
      false,
    )
  }
  assert.equal(
    certificateTemplateLayoutSchema.safeParse({
      ...validTemplateLayout,
      page: { ...validTemplateLayout.page, width: Number.POSITIVE_INFINITY },
    }).success,
    false,
  )
  assert.equal(
    certificateTemplateLayoutSchema.safeParse({
      ...validTemplateLayout,
      page: { ...validTemplateLayout.page, width: 600, height: 800 },
    }).success,
    false,
  )
})

test('versioned layouts enforce element, text, font, and nesting limits', () => {
  const tooManyElements = Array.from(
    { length: 101 },
    (_, index) => ({
      ...validTemplateLayout.elements[0],
      id: `element-${index}`,
      x: 0,
      y: 0,
      width: 10,
      height: 10,
    }),
  )
  assert.equal(
    certificateTemplateLayoutSchema.safeParse({
      ...validTemplateLayout,
      elements: tooManyElements,
    }).success,
    false,
  )
  assert.equal(
    certificateTemplateElementSchema.safeParse({
      ...validTemplateLayout.elements[0],
      text: 'x'.repeat(2_001),
      binding: undefined,
    }).success,
    false,
  )
  assert.equal(
    certificateTemplateElementSchema.safeParse({
      ...validTemplateLayout.elements[0],
      font: { ...validTemplateLayout.elements[0].font, size: 145 },
    }).success,
    false,
  )

  let nested: unknown = 'leaf'
  for (let depth = 0; depth < 22; depth += 1) {
    nested = { child: nested }
  }
  assert.equal(
    certificateTemplateLayoutInputSchema.safeParse({ nested }).success,
    false,
  )
})

test('dynamic bindings reject unknown, forbidden, and executable expressions', () => {
  for (const binding of [
    'participant.password',
    'participant.photoUrl',
    'certificate.verificationIdentifier',
    'signer.signature',
    '({}).constructor',
    'process.env.SECRET',
    '${participant.name}',
  ]) {
    assert.equal(
      certificateTemplateElementSchema.safeParse({
        ...validTemplateLayout.elements[0],
        binding,
      }).success,
      false,
    )
  }
  assert.equal(
    certificateTemplateLayoutSchema.safeParse({
      ...validTemplateLayout,
      elements: [
        {
          ...validTemplateLayout.elements[0],
          binding: 'certificate.verificationIdentifier',
        },
      ],
    }).success,
    false,
  )
})

test('image elements accept opaque asset IDs and reject URLs, paths, and data URLs', () => {
  assert.equal(
    certificateTemplateElementSchema.safeParse(
      validTemplateLayout.elements[1],
    ).success,
    true,
  )
  for (const assetId of [
    'https://example.test/logo.png',
    'data:image/png;base64,AAAA',
    'C:\\certificates\\logo.png',
    '/etc/passwd',
  ]) {
    assert.equal(
      certificateTemplateElementSchema.safeParse({
        ...validTemplateLayout.elements[1],
        assetId,
      }).success,
      false,
    )
  }
  assert.equal(
    certificateTemplateLayoutSchema.safeParse({
      ...validTemplateLayout,
      page: {
        ...validTemplateLayout.page,
        background: { assetId: 'https://example.test/background.png' },
      },
    }).success,
    false,
  )
})

test('legacy template layout compatibility does not reinterpret versioned layouts', () => {
  const legacy = { page: { width: 1200, units: 'px' }, labels: ['Name'] }
  assert.deepEqual(certificateTemplateLayoutInputSchema.parse(legacy), legacy)
  assert.equal(
    certificateTemplateLayoutInputSchema.safeParse({
      schemaVersion: 9,
      page: { width: 1200 },
    }).success,
    false,
  )
  assert.equal(
    certificateTemplateInputSchema.safeParse({
      name: 'Legacy',
      description: '',
      layout: legacy,
      allowedDynamicFields: ['participant.name'],
    }).success,
    true,
  )
})

test('certificate issuance schema supports optional templates and no caller-supplied identifiers', () => {
  const enrollmentId = new ObjectId()
  const templateId = new ObjectId()
  const parsed = certificateIssueInputSchema.parse({
    enrollmentId: enrollmentId.toHexString(),
    templateId: templateId.toHexString(),
    issueDate: '2026-10-22T12:00:00.000Z',
    verificationIdentifier: 'caller-controlled',
    certificateId: 'caller-controlled',
  })
  assert.equal(parsed.enrollmentId.toHexString(), enrollmentId.toHexString())
  assert.ok(parsed.templateId)
  assert.equal(parsed.templateId.toHexString(), templateId.toHexString())
  const uploadOnly = certificateIssueInputSchema.parse({
    enrollmentId: enrollmentId.toHexString(),
  })
  assert.equal(uploadOnly.templateId, undefined)
  assert.equal(uploadOnly.enrollmentId.toHexString(), enrollmentId.toHexString())
  assert.ok(parsed.issueDate instanceof Date)
  assert.equal('verificationIdentifier' in parsed, false)
  assert.equal('certificateId' in parsed, false)
})

test('generated certificate and verification identifiers have strong formats', () => {
  assert.match(createCertificateId(), /^TS-[A-F0-9]{32}$/)
  assert.match(createVerificationIdentifier(), /^[A-Za-z0-9_-]{43}$/)
  assert.notEqual(createVerificationIdentifier(), createVerificationIdentifier())
})

test('safe serializers include admin participant email but omit internal fields and verification identifiers', () => {
  const id = new ObjectId()
  const timestamp = new Date('2026-10-22T12:00:00.000Z')
  const participant = serializeParticipant({
    name: 'Participant',
    email: 'person@example.com',
    _id: id,
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  assert.equal(participant.email, 'person@example.com')
  assert.equal('_id' in participant, false)

  const enrollment = serializeEnrollment({
    _id: id,
    participantId: id,
    courseId: 'web-foundations',
    courseName: 'Web Foundations',
    status: 'completed',
    completedAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  assert.equal(enrollment.completedAt, timestamp.toISOString())
  assert.equal('_id' in enrollment, false)

  const certificate = serializeCertificate({
    _id: id,
    certificateId: 'TS-ABC',
    enrollmentId: id,
    templateId: id,
    issueDate: timestamp,
    verificationIdentifier: 'A'.repeat(43),
    status: 'revoked',
    revokedAt: timestamp,
    revocationReason: 'private reason',
    revocationWorkflowId: id,
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  assert.equal(certificate.revokedAt, timestamp.toISOString())
  assert.equal('verificationIdentifier' in certificate, false)
  assert.equal('revocationReason' in certificate, false)
  assert.equal('revocationWorkflowId' in certificate, false)
  assert.equal('_id' in certificate, false)

  const uploadOnlyCertificate = serializeCertificate({
    _id: id,
    certificateId: 'TS-DEF',
    enrollmentId: id,
    issueDate: timestamp,
    verificationIdentifier: 'B'.repeat(43),
    status: 'issued',
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  assert.equal('templateId' in uploadOnlyCertificate, false)
})

test('reissue workflow serializer exposes only its public state', () => {
  const timestamp = new Date('2026-10-22T12:00:00.000Z')
  const workflow: CertificateReissueWorkflowDocument = {
    _id: new ObjectId(),
    idempotencyKey: 'private-idempotency-key',
    enrollmentId: new ObjectId(),
    previousCertificateId: new ObjectId(),
    replacementDocumentId: new ObjectId(),
    replacementCertificateId: 'TS-INTERNAL-REPLACEMENT',
    replacementVerificationIdentifier: 'private-verification-identifier',
    templateId: new ObjectId(),
    issueDate: timestamp,
    state: 'requested',
    activeEnrollmentId: new ObjectId(),
    createdAt: timestamp,
    updatedAt: timestamp,
  }
  assert.deepEqual(serializeReissueWorkflow(workflow), { state: 'requested' })
})

test('indexes cover identities, enrollment uniqueness, active certificate and workflow recovery', () => {
  const names = MODEL_INDEXES.map((index) => index.options.name)
  assert.ok(names.includes('participants_email_unique'))
  assert.ok(names.includes('enrollments_participant_course_unique'))
  assert.ok(names.includes('certificates_certificate_id_unique'))
  assert.ok(names.includes('certificates_verification_identifier_unique'))
  assert.ok(names.includes('certificates_one_issued_per_enrollment'))
  assert.ok(names.includes('certificate_reissue_idempotency_unique'))
  assert.ok(names.includes('certificate_reissue_active_enrollment_unique'))

  const activeCertificateIndex = MODEL_INDEXES.find(
    (index) =>
      index.options.name === 'certificates_one_issued_per_enrollment',
  )
  assert.ok(activeCertificateIndex)
  assert.equal(
    'partialFilterExpression' in activeCertificateIndex.options
      ? activeCertificateIndex.options.partialFilterExpression.status
      : undefined,
    'issued',
  )
})
