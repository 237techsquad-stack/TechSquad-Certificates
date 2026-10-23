import { createFileRoute } from '@tanstack/react-router'
import { AdminManagement } from '../components/admin-management.tsx'

export const Route = createFileRoute('/admin/')({
  component: () => <AdminManagement page="overview" />,
})
