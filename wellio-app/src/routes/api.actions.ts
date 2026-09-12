import { createFileRoute } from '@tanstack/react-router'
import { handleBackendRequest } from '../server/app'

export const Route = createFileRoute('/api/actions')({
  server: { handlers: { ANY: ({ request }) => handleBackendRequest(request) } },
})
