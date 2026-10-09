import { ICacheClient, CacheEntry, CacheOptions, matchesPattern } from "./cache-client.js"

import * as Redis from "ioredis"

let redisInstance: Redis.Redis | null = null

/**
 * Get or create the Redis instance (singleton pattern).
 * Em produção, a conexão deve ser gerenciada via Fastify plugin.
 */
export function getRedis(): Redis.Redis {
  if (!redisInstance) {
    const url = process.env.REDIS_URL || "redis://localhost:6379"
    redisInstance = new Redis.Redis(url)
  }
  return redisInstance
}

/**
 * Wait for Redis to be ready (usado no boot).
 */
export async function waitForRedisReady(): Promise<void> {
  const redis = getRedis()
  await redis.ping()
}

/**
 * RedisCacheClient implements ICacheClient using Redis.
 * 
 * TTL conventions:
 * - ttl em segundos -> expiresAt em ms (Date.now() + ttl * 1000)
 * - TTL 0 ou undefined -> sem expiração (persistente)
 * - Negative TTL -> chave expirada imediatamente
 */
export class RedisCacheClient implements ICacheClient {
  private readonly redis: Redis.Redis

  constructor(redis?: Redis.Redis) {
    this.redis = redis || getRedis()
  }

  /**
   * Get a value from cache.
   * Returns null if key doesn't exist or has expired.
   */
  async get<T>(key: string): Promise<T | null> {
    try {
      const raw = await this.redis.get(key)
      if (raw === null) return null

      // Tenta parsear JSON; se falhar, retorna raw string
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        parsed = raw
      }

      // Verificar se o valor tem metadata de expiry (formato estendido)
      // Formato: {"__ttl__": number, "value": ...}
      // Se não tiver __ttl__, assumimos que o caller gerencia expiração via SET EX
      if ((parsed as any)?.__ttl__ !== undefined) {
        const ttlFromCache = (parsed as any).__ttl__ as number
        const now = Math.floor(Date.now() / 1000)
        if (now >= ttlFromCache) {
          // Já expirou, deletar e retornar null
          await this.redis.del(key)
          return null
        }
        // Retornar value, mas também passar o tttl restante ao caller
        return (parsed as any).value as T
      }

      // Formato padrão: assume que o caller define TTL via SET with EX no momento do set
      // Se precisar de validação de expiry, o padrão é verificar a TTL do Redis
      return parsed as T
    } catch (err) {
      // Em caso de erro de conexão, lançar para o caller tratar
      // (pode ser fallback para memória ou operação sem cache)
      throw err
    }
  }

  /**
   * Set a value in cache with optional TTL.
   * 
   * OPTIONS:
   * - options really has ttl (seconds). If not provided, key persists forever.
   * - Para TTL dinâmico, chame redis.expire() separadamente após set.
   */
  async set<T>(key: string, value: T, options?: CacheOptions): Promise<void> {
    try {
      const ttl = options?.ttl

      if (ttl !== undefined && ttl > 0) {
        // Set with expiry
        const jsonValue = JSON.stringify(value)
        // Formato estendido: armazena ttl expiry timestamp junto com o value
        // Isso permite que o get() saiba quando expira sem precisar chamar TTL a cada vez
        const expiresAt = Math.floor(Date.now() / 1000) + ttl
        const extendedValue = JSON.stringify({
          __ttl__: expiresAt,
          value,
        })
        await this.redis.set(key, extendedValue, "EX", ttl)
      } else if (ttl === 0) {
        // TTL 0 significa expirar imediatamente
        await this.redis.del(key)
      } else {
        // Sem TTL - chave persistente
        const jsonValue = JSON.stringify(value)
        await this.redis.set(key, jsonValue)
      }
    } catch (err) {
      throw err
    }
  }

  /**
   * Invalidate (delete) a key from cache.
   */
  async invalidate(key: string): Promise<void> {
    try {
      await this.redis.del(key)
    } catch (err) {
      throw err
    }
  }

  /**
   * Invalidate all keys matching a pattern.
   * Uses SCAN iterator to avoid blocking on large datasets.
   */
  async invalidatePattern(pattern: string): Promise<void> {
    try {
      const cursor = "0"
      const keysToDelete: string[] = []

      let nextCursor: string = cursor
      do {
        const [newCursor, keys] = await this.redis.scan(
          nextCursor,
          "MATCH",
          pattern,
          "COUNT",
          500
        )
        keysToDelete.push(...keys)
        nextCursor = newCursor
      } while (nextCursor !== "0")

      if (keysToDelete.length > 0) {
        await this.redis.del(...keysToDelete)
      }
    } catch (err) {
      throw err
    }
  }

  /**
   * Clear all keys in the current database.
   * CUIDADO: isso limpa TUDO no schema/database atual.
   */
  async clear(): Promise<void> {
    try {
      // Use COMMAND FLUSHDB para limpar o banco atual de forma segura
      // Em produção, considere chaves com prefixo pdv: apenas
      // Note: ioredis uses flushdb (lowercase) as the command name
      await this.redis.flushdb()
    } catch (err) {
      throw err
    }
  }

  /**
   * Get the remaining TTL for a key.
   */
  async getTtl(key: string): Promise<number | null> {
    try {
      return await this.redis.ttl(key)
    } catch (err) {
      throw err
    }
  }
}

/**
 * Factory function to create a RedisCacheClient instance.
 * Permite injeção de dependência com Redis pré-conectado (para testes).
 */
export function createRedisCacheClient(
  redis?: Redis.Redis
): RedisCacheClient {
  return new RedisCacheClient(redis)
}