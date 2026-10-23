import { z } from 'zod'

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

function createJsonValueSchema(depth = 0): z.ZodType<JsonValue> {
  const scalarSchema = z.union([
    z.string().max(10_000),
    z.number().finite(),
    z.boolean(),
    z.null(),
  ])
  if (depth >= 20) return scalarSchema

  const nestedSchema: z.ZodType<JsonValue> = z.lazy(() =>
    z.union([
      scalarSchema,
      z.array(createJsonValueSchema(depth + 1)).max(1_000),
      z.record(z.string().max(200), createJsonValueSchema(depth + 1)),
    ]),
  )
  return nestedSchema
}

const jsonValueSchema = createJsonValueSchema()

export const templateDynamicFieldSchema = z.enum([
  'participant.name',
  'participant.email',
  'enrollment.courseName',
  'certificate.id',
  'certificate.issueDate',
  'enrollment.completedAt',
  'signer.name',
  'signer.title',
])

export type TemplateDynamicField = z.infer<typeof templateDynamicFieldSchema>

export const templateTextAlignmentSchema = z.enum([
  'left',
  'center',
  'right',
])

const templateElementIdSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/)

const templateColorSchema = z.string().regex(/^#[\da-fA-F]{6}$/)
const templateAssetIdSchema = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/)

// Layout coordinates are points from the page's top-left corner.
const templateElementGeometrySchema = z.object({
  id: templateElementIdSchema,
  x: z.number().finite().min(0).max(4_000),
  y: z.number().finite().min(0).max(4_000),
  width: z.number().finite().gt(0).max(4_000),
  height: z.number().finite().gt(0).max(4_000),
  required: z.boolean().default(false),
}).strict()

const templateFontSchema = z.object({
  family: z.enum(['Helvetica', 'Times-Roman', 'Courier']),
  size: z.number().finite().min(4).max(144),
  color: templateColorSchema,
  weight: z.enum(['normal', 'bold']).default('normal'),
  italic: z.boolean().default(false),
  lineSpacing: z.number().finite().min(0.5).max(3).default(1),
}).strict()

const templateTextElementSchema = templateElementGeometrySchema.extend({
  type: z.literal('text'),
  text: z.string().max(2_000).optional(),
  binding: templateDynamicFieldSchema.optional(),
  alignment: templateTextAlignmentSchema,
  font: templateFontSchema,
}).strict().refine((element) => {
  return Boolean(element.binding) || Boolean(element.text?.trim())
}, {
  message: 'Text elements require static text or an allowed dynamic binding',
  path: ['text'],
})

const templateImageElementSchema = templateElementGeometrySchema.extend({
  type: z.literal('image'),
  assetId: templateAssetIdSchema,
  fit: z.enum(['contain', 'cover']).default('contain'),
}).strict()

const templatePhotoElementSchema = templateElementGeometrySchema.extend({
  type: z.literal('photo'),
  binding: z.literal('participant.photo'),
  fit: z.enum(['contain', 'cover']).default('cover'),
}).strict()

const templateSignatureElementSchema = templateElementGeometrySchema.extend({
  type: z.literal('signature'),
  binding: z.literal('signer.signature'),
  nameBinding: z.literal('signer.name').optional(),
  titleBinding: z.literal('signer.title').optional(),
  fit: z.enum(['contain', 'cover']).default('contain'),
}).strict()

const templateShapeElementSchema = templateElementGeometrySchema.extend({
  type: z.literal('shape'),
  shape: z.enum(['rectangle', 'ellipse', 'line']),
  fill: templateColorSchema.optional(),
  stroke: templateColorSchema.optional(),
  strokeWidth: z.number().finite().min(0).max(40).default(1),
}).strict().refine(
  (element) => element.fill !== undefined || element.stroke !== undefined,
  { message: 'Shapes require a fill or stroke', path: ['fill'] },
)

export const certificateTemplateElementSchema = z.discriminatedUnion('type', [
  templateTextElementSchema,
  templateImageElementSchema,
  templatePhotoElementSchema,
  templateSignatureElementSchema,
  templateShapeElementSchema,
])

export type CertificateTemplateElement = z.output<
  typeof certificateTemplateElementSchema
>

export const certificateTemplateLayoutSchema = z.object({
  schemaVersion: z.literal(1),
  page: z.object({
    width: z.number().finite().min(72).max(4_000),
    height: z.number().finite().min(72).max(4_000),
    orientation: z.enum(['landscape', 'portrait']),
    backgroundColor: templateColorSchema.optional(),
    background: z.object({
      assetId: templateAssetIdSchema,
      fit: z.enum(['contain', 'cover']).default('cover'),
    }).strict().optional(),
  }).strict().refine(
    (page) =>
      page.width * page.height <= 8_000_000 &&
      (page.orientation === 'landscape'
        ? page.width >= page.height
        : page.height >= page.width),
    {
      message: 'Page dimensions must match the orientation and stay within the area limit',
      path: ['orientation'],
    },
  ),
  elements: z.array(certificateTemplateElementSchema).max(100),
}).strict().superRefine((layout, context) => {
  const ids = new Set<string>()
  layout.elements.forEach((element, index) => {
    if (ids.has(element.id)) {
      context.addIssue({
        code: 'custom',
        message: 'Element IDs must be unique',
        path: ['elements', index, 'id'],
      })
    }
    ids.add(element.id)

    if (
      element.x + element.width > layout.page.width ||
      element.y + element.height > layout.page.height
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Elements must fit within the page bounds',
        path: ['elements', index],
      })
    }
  })
})

export type CertificateTemplateLayout = z.output<
  typeof certificateTemplateLayoutSchema
>

export type LegacyCertificateTemplateLayout = Record<string, JsonValue>

const legacyCertificateTemplateLayoutSchema = z
  .record(z.string().max(200), jsonValueSchema)
  .refine((layout) => !Object.hasOwn(layout, 'schemaVersion'), {
    message: 'Layouts with a schemaVersion must use a supported versioned schema',
  })

export const certificateTemplateLayoutInputSchema = z.union([
  certificateTemplateLayoutSchema,
  legacyCertificateTemplateLayoutSchema,
])

export const certificateTemplateInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000),
  layout: certificateTemplateLayoutInputSchema,
  allowedDynamicFields: z
    .array(templateDynamicFieldSchema)
    .refine((fields) => new Set(fields).size === fields.length, {
      message: 'Dynamic fields must be unique',
    }),
})

export type CertificateTemplateInput = z.input<
  typeof certificateTemplateInputSchema
>
export type CertificateTemplate = z.output<
  typeof certificateTemplateInputSchema
>
