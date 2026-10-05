import { createContext, useContext, ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { publicApi } from '@/shared/api/public-client'

export type Tenant = {
  storeId: string
  slug: string
  schema: string
  name: string
  logoUrl?: string | null
  primaryColor?: string | null
  usesDelivery: boolean
  kitchenEnabled: boolean
}

type TenantContextType = {
  tenant: Tenant | null
  isLoading: boolean
  error: Error | null
}

const TenantContext = createContext<TenantContextType>({
  tenant: null,
  isLoading: true,
  error: null,
})

export function TenantProvider({ children }: ReactNode) {
  const hostname = window.location.hostname

  const host =
    import.meta.env.DEV && (hostname === 'localhost' || hostname === '127.0.0.1')
      ? (import.meta.env.VITE_DEV_TENANT_HOST ?? 'pdv1.seudominio.com.br')
      : hostname

  const { data, isLoading, error } = useQuery({
    queryKey: ['tenant', host],
    queryFn: async () => {
      const { data } = await publicApi.get('/public/tenants/resolve', {
        params: { host },
      })

      if (!data.found) {
        throw new Error('Loja não encontrada para este subdomínio')
      }

      return data.tenant as Tenant
    },
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  })

  return (
    <TenantContext.Provider value={{ tenant: data ?? null, isLoading, error }}>
      {children}
    </TenantContext.Provider>
  )
}

export const useTenant = () => useContext(TenantContext)
