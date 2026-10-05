import { QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'sonner'
import { BrowserRouter } from 'react-router-dom'
import { queryClient } from './query-client'
import { TenantProvider } from './tenant-provider'

interface AppProvidersProps {
  children: React.ReactNode
}

export function AppProviders({ children }: AppProvidersProps) {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <TenantProvider>
          {children}
          <Toaster richColors position="top-right" />
        </TenantProvider>
      </BrowserRouter>
    </QueryClientProvider>
  )
}
