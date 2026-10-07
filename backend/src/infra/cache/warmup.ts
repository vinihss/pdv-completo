/**
 * Warm-up script para pré-popular o Redis cache na inicialização do backend.
 * 
 * Esta versão integra com o registry de tenant (Fase 1 do doc 15),
 * populando caches por schema de loja em vez de uma lista fixa.
 * 
 * Popula:
 * - Configurações da store_settings por schema (loja)
 * - Cardápio/menu por schema
 * - Categorias ativas por schema
 * - Produtos populares por schema
 * 
 * O registry de tenant já tem seu próprio cache (TTL 60s) em infra/tenant/registry.ts.
 * Este warm-up foca em caches de dados de operação (cardápio, produtos, etc).
 */

import { getRedis, waitForRedisReady } from "./redis-cache-client.js"
import { listActiveTenants, invalidateTenantRegistryCache } from "./../../infra/tenant/registry.js"

/**
 * Extrai o schemaName do registro de tenant para usar como chave de cache.
 * O schema isola os dados por loja no PostgreSQL (docs/15-multi-tenant-schema.md).
 */
function getSchemaName(tenant: { schemaName: string }): string {
  return tenant.schemaName
}

/**
 * Warm-up das configurações da loja usando o schema do tenant.
 * As store_settings são quase estáticas (horário, taxas, flags), TTL de 24h.
 */
async function warmupStoreSettingsByTenant(): Promise<void> {
  const redis = await getRedis()

  try {
    const tenants = await listActiveTenants()

    for (const tenant of tenants) {
      const schema = getSchemaName(tenant)

      // Verificar se já existe no cache
      const cacheKey = `store_settings:${schema}`
      const exists = await redis.exists(cacheKey)
      if (exists) continue

      // Em produção, viriam do banco do schema correspondente.
        // Para now, usar dados padrão consistentes com o .env.example
      const defaultSettings = {
        merchantName: "PDV Restaurante",
        merchantCity: "Rio de Janeiro",
        logoUrl: "/logo.png",
        brandColor: "#2D5A27",
        usesDelivery: true,
        deliveryFee: 12.50,
        deliveryFeeTiers: [
          { minDistance: 0, maxDistance: 2, fee: 0 },
          { minDistance: 2, maxDistance: 5, fee: 8.0 },
          { minDistance: 5, maxDistance: 10, fee: 15.0 }
        ],
        deliveryPrepMinutes: 20,
        minutesPerKm: 2,
        enabledPaymentMethods: ["dinheiro", "cartao", "pix", "ifood"],
        ifoodIntegrationEnabled: false,
        pixEnabled: true,
        pagarmeEnabled: true,
      }

      await redis.set(
        cacheKey,
        JSON.stringify(defaultSettings),
        "EX",
        86400 // 24 horas TTL - configurações mudam raramente
      )
      // eslint-disable-next-line no-console
      console.info(`✅ Store settings warm-up para schema ${schema} (loja ${tenant.slug})`)
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("⚠️ Erro warm-up store settings por tenant:", err)
  }
}

/**
 * Warm-up de categorias ativas usando o schema do tenant.
 * TTL de 10min - categorias mudam quando admin altera promoções.
 */
async function warmupCategoriasByTenant(): Promise<void> {
  const redis = await getRedis()

  try {
    const tenants = await listActiveTenants()

    for (const tenant of tenants) {
      const schema = getSchemaName(tenant)
      const cacheKey = `categorias:${schema}`

      const exists = await redis.exists(cacheKey)
      if (exists) continue

      // Em produção: SELECT * FROM categoria WHERE schema = ${schema} AND ativa = true
      // Agora usando dados mock consistentes
      const mockCategorias = [
        { id: "cat-1", nome: "Bebidas" },
        { id: "cat-2", nome: "Lanches" },
        { id: "cat-3", nome: "Acompanhamentos" },
        { id: "cat-4", nome: "Pizzas" },
        { id: "cat-5", nome: "Sobremesas" },
      ]

      await redis.set(
        cacheKey,
        JSON.stringify(mockCategorias.map(c => ({ id: c.id, nome: c.nome }))),
        "EX",
        600 // 10 minutos TTL
      )
      // eslint-disable-next-line no-console
      console.info(`✅ Categorias warm-up para schema ${schema} (loja ${tenant.slug})`)
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("⚠️ Erro warm-up categorias por tenant:", err)
  }
}

/**
 * Warm-up de produtos populares por schema de tenant.
 * Usa dados mock; em produção viriam do prisma do schema certo.
 */
async function warmupPopularProductsByTenant(): Promise<void> {
  const redis = await getRedis()

  try {
    const tenants = await listActiveTenants()

    for (const tenant of tenants) {
      const schema = getSchemaName(tenant)
      const cacheKey = `produtos:resumo:${schema}`

      // Dados mock de produtos populares
      const mockProducts = [
        { id: "prod-001", nome: "Cerveja Artesanal", preco: 15.90, ativo: true },
        { id: "prod-002", nome: "Hambúrguer Premium", preco: 28.50, ativo: true },
        { id: "prod-003", nome: "Refrigerante Lata", preco: 8.00, ativo: true },
      ]

      await redis.set(
        cacheKey,
        JSON.stringify(mockProducts),
        "EX",
        300 // 5 minutos TTL
      )

      // Cache individual por produto
      for (const product of mockProducts) {
        const prodKey = `produto:${product.id}:${schema}`
        const exists = await redis.exists(prodKey)
        if (exists) continue

        await redis.set(
          prodKey,
          JSON.stringify(product),
          "EX",
          300
        )
      }

      // eslint-disable-next-line no-console
      console.info(`✅ Produtos warm-up para schema ${schema} (loja ${tenant.slug})`)
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("⚠️ Erro warm-up produtos por tenant:", err)
  }
}

/**
 * Warm-up de último vendas resumo por schema.
 * TTL de 1 minuto - dados que mudam a cada pedido.
 */
async function warmupRecentSalesByTenant(): Promise<void> {
  const redis = await getRedis()

  try {
    const tenants = await listActiveTenants()

    for (const tenant of tenants) {
      const schema = getSchemaName(tenant)
      const cacheKey = `ultimas_vendas:resumo:${schema}`

      await redis.set(
        cacheKey,
        JSON.stringify([]),
        "EX",
        60 // 1 minuto TTL
      )
    }

    // eslint-disable-next-line no-console
    console.info("✅ Recent sales warm-up por tenant concluído")
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("⚠️ Erro recent sales by tenant:", err)
  }
}

/**
 * Função principal de warm-up integrada ao registry de tenant.
 * 
 * Em vez de lista fixa de lojas, itera sobre tenants ativos do registry,
 * usando o schemaName para isolamento de dados por loja no Redis.
 */
export async function runWarmupWithTenantRegistry(): Promise<void> {
  // eslint-disable-next-line no-console
  console.info("🔥 Iniciando warm-up de cache integrado ao registry de tenant...")

  // Aguardar Redis estar pronto
  await waitForRedisReady()

  // Executar warm-ups por tenant
  await Promise.allSettled([
    warmupStoreSettingsByTenant(),
    warmupCategoriasByTenant(),
    warmupPopularProductsByTenant(),
    warmupRecentSalesByTenant(),
  ])

  // Invalidar cache do registry (ele tem TTL próprio, mas isso garante limpeza)
  invalidateTenantRegistryCache()

  // eslint-disable-next-line no-console
  console.info("🔥 Warm-up de cache integrando ao registry de tenant concluído")
}

/**
 * Warm-up legado usando lista fixa de lojas (para compatibilidade/backward).
 * Usado quando o registry ainda não está populado.
 */
export async function runWarmupLegacy(): Promise<void> {
  // eslint-disable-next-line no-console
  console.info("🔥 Iniciando warm-up legado (lista fixa de lojas)...")

  await waitForRedisReady()

  // Usar listActiveTenants do registry se disponível, senão lista mock
  let tenants: Array<{ schemaName: string; slug: string }>

  try {
    tenants = await listActiveTenants()
    // eslint-disable-next-line no-console
    console.info(`📊 Encontradas ${tenants.length} lojas no registry`)
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("⚠️ Registry indisponível, usando lista legado", err)
    // Lista mock de exemplo para desenvolvimento
    tenants = [
      { schemaName: "loja_centro", slug: "centro" },
      { schemaName: "loja_copacabana", slug: "copacabana" }
    ]
  }

  // Executar warm-ups com dados por schema
  await Promise.allSettled([
    // warmupStoreSettingsBySchema(tenants), // future: usar schemas reais
    // warmupCategoriasBySchema(tenants), // future: usar schemas reais
    // warmupPopularProductsBySchema(tenants), // future: usar schemas reais
  ])

  // eslint-disable-next-line no-console
  console.info("🔥 Warm-up legado concluído")
}

export default runWarmupWithTenantRegistry