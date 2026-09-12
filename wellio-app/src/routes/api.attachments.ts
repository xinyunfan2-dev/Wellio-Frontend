import { createFileRoute } from '@tanstack/react-router'
import { handleBackendRequest } from '../server/app'

export const Route = createFileRoute('/api/attachments')({
  server: { handlers: { ANY: ({ request }) => handleBackendRequest(request) } },
})
