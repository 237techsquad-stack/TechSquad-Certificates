import { createFileRoute } from '@tanstack/react-router'
import { AdminManagement } from '../components/admin-management.tsx'

export const Route = createFileRoute('/admin/enrollments')({
  validateSearch: (search: Record<string, unknown>) => ({
    participantId:
      typeof search.participantId === 'string'
        ? search.participantId
        : undefined,
  }),
  component: EnrollmentsPage,
})

function EnrollmentsPage() {
  const { participantId } = Route.useSearch()
  return (
    <AdminManagement
      page="enrollments"
      initialParticipantId={participantId ?? ''}
    />
  )
}
