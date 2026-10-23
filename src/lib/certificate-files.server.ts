import '@tanstack/react-start/server-only'

import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { GridFSBucket, ObjectId, type Db } from 'mongodb'
import { getDatabase } from './mongodb.server.ts'

export const MAX_CERTIFICATE_FILE_BYTES = 3_500_000
const BUCKET_NAME = 'certificateFiles'

export class CertificateFileError extends Error {
  readonly code: 'invalid_file' | 'not_found' | 'operation_failed'

  constructor(code: CertificateFileError['code']) {
    super('Certificate file operation failed')
    this.name = 'CertificateFileError'
    this.code = code
  }
}

export function nodeReadableToWebStream(
  source: Readable,
): ReadableStream<Uint8Array> {
  const iterator = source[Symbol.asyncIterator]()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next()
        if (next.done) {
          controller.close()
          return
        }
        if (!(next.value instanceof Uint8Array)) {
          controller.error(new Error('Invalid file stream'))
          return
        }
        controller.enqueue(next.value)
      } catch {
        controller.error(new Error('File stream failed'))
      }
    },
    cancel() {
      source.destroy()
    },
  })
}

export function createCertificateFileStorage(
  getDb: () => Promise<Db> = getDatabase,
) {
  function bucket(database: Db): GridFSBucket {
    return new GridFSBucket(database, { bucketName: BUCKET_NAME })
  }

  async function storePdf(file: File): Promise<{
    fileId: ObjectId
    fileSize: number
  }> {
    if (
      file.size < 8 ||
      file.size > MAX_CERTIFICATE_FILE_BYTES ||
      file.type !== 'application/pdf'
    ) {
      throw new CertificateFileError('invalid_file')
    }

    const contents = Buffer.from(await file.arrayBuffer())
    if (
      contents.length !== file.size ||
      contents.subarray(0, 5).toString('ascii') !== '%PDF-'
    ) {
      throw new CertificateFileError('invalid_file')
    }

    const target = bucket(await getDb())
    const upload = target.openUploadStream(`${randomUUID()}.pdf`, {
      metadata: { contentType: 'application/pdf' },
    })
    try {
      await pipeline(Readable.from([contents]), upload)
      return { fileId: upload.id, fileSize: contents.length }
    } catch {
      if (upload.id instanceof ObjectId) {
        try {
          await target.delete(upload.id)
        } catch {
          console.error('[certificate-files] incomplete upload cleanup failed')
        }
      }
      throw new CertificateFileError('operation_failed')
    }
  }

  async function remove(fileId: ObjectId): Promise<void> {
    await bucket(await getDb()).delete(fileId)
  }

  async function stream(fileId: ObjectId): Promise<Readable> {
    const target = bucket(await getDb())
    const file = await target.find({ _id: fileId }).limit(1).next()
    if (!file) throw new CertificateFileError('not_found')
    return target.openDownloadStream(fileId)
  }

  return { storePdf, remove, stream }
}

export const certificateFileStorage = createCertificateFileStorage()
