import { createContext, useContext } from 'react'
import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
// Relativo, e não `@/`: o alias `@/` pertence ao `frontend/src` (é de lá que
// vem a página do cardápio, e o código herdado inteiro depende desse mapeamento
// para resolver `@/entities/*` e `@/shared/*`). Usar `@/` para um arquivo que
// é deste app jogaria a resolução em `frontend/src/shared/api/public-client`,
// que não existe. Dentro de `src/` deste app, o caminho é relativo.
import { publicApi } from '../../shared/api/public-client'

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

type TenantProviderProps = {
  children: ReactNode
}

// A assinatura era `({ children }: ReactNode)` — `ReactNode` é o tipo do
// FILHO, não o do objeto de props, então a desestruturação pegava uma
// propriedade `children` que esse tipo não tem. O efeito em cascata era o erro
// mais confuso do build: `TenantProvider` acabava aceitando `ReactNode` como
// props, e o `<TenantProvider>{children}</TenantProvider>` em `AppProviders`
// virava "atribua `{ children: ... }` para `IntrinsicAttributes & ReactNode`",
// que aponta para o provider errado.
export function TenantProvider({ children }: TenantProviderProps) {
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
