import { createFileRoute } from '@tanstack/react-router'
import { AdminManagement } from '../components/admin-management.tsx'

export const Route = createFileRoute('/admin/participants')({
  validateSearch: (search: Record<string, unknown>) => ({
    participantId:
      typeof search.participantId === 'string'
        ? search.participantId
        : undefined,
  }),
  component: ParticipantsPage,
})

function ParticipantsPage() {
  return <AdminManagement page="participants" />
}
