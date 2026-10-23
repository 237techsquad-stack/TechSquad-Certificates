import { createFileRoute } from '@tanstack/react-router'
import { PublicVerificationHome } from '../components/public-verification-home.tsx'

export const Route = createFileRoute('/')({
  component: PublicVerificationHome,
})
