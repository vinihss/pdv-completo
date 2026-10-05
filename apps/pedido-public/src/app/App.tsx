import { CustomerMenuPage } from '@/pages/customer-menu'
import { AppProviders } from './providers'
import { useTenant } from './providers/tenant-provider'

function AppContent() {
  const { tenant, isLoading, error } = useTenant()

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <div className="animate-spin h-10 w-10 border-4 border-teal-600 border-t-transparent rounded-full mx-auto mb-4" />
          <p className="text-gray-600">Identificando loja...</p>
        </div>
      </div>
    )
  }

  if (error || !tenant) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
        <div className="text-center max-w-md">
          <h1 className="text-2xl font-bold text-gray-900 mb-2">Loja não encontrada</h1>
          <p className="text-gray-600 mb-4">
            O endereço{' '}
            <span className="font-mono text-sm break-all">{window.location.hostname}</span>{' '}
            não corresponde a nenhuma loja cadastrada.
          </p>
          <p className="text-sm text-gray-500">
            Verifique se você acessou o link correto do QR Code.
          </p>
        </div>
      </div>
    )
  }

  return <CustomerMenuPage />
}

export function App() {
  return (
    <AppProviders>
      <AppContent />
    </AppProviders>
  )
}
