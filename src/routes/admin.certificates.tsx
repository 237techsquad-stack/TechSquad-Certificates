import { createFileRoute } from '@tanstack/react-router'
import { AdminManagement } from '../components/admin-management.tsx'

export const Route = createFileRoute('/admin/certificates')({
  validateSearch: (search: Record<string, unknown>) => ({
    enrollmentId:
      typeof search.enrollmentId === 'string'
        ? search.enrollmentId
        : undefined,
  }),
  component: CertificatesPage,
})

function CertificatesPage() {
  const { enrollmentId } = Route.useSearch()
  return (
    <AdminManagement
      page="certificates"
      initialEnrollmentId={enrollmentId ?? ''}
    />
  )
}
