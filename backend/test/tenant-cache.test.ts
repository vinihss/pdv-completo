// Partição do cache por schema de tenant — o bug independente do ALS.
//
// O `getCache()` é um singleton por PROCESSO e o processo atende vários
// tenants por Host. Sem prefixo de schema, a primeira loja a popular uma
// chave fixa (`store-settings`, `public-menu`…) serviria a outra por até o
// TTL. Este teste prova que `tenantCache` isola por schema, que o
// `invalidatePattern` usa o mesmo prefixo, e que o registry (global) segue
// sem partição.
import { beforeEach, describe, expect, it } from "vitest";
import { getCache, resetCache, tenantCache } from "../src/infra/cache/index.js";
import { runInTenantScope } from "../src/infra/db/tenant-context.js";

const SCOPE_A = { schemaName: "tenant_cache_a", slug: "a", isDefault: false };
const SCOPE_B = { schemaName: "tenant_cache_b", slug: "b", isDefault: false };

const inScope = <T>(scope: typeof SCOPE_A, fn: () => T | Promise<T>) => runInTenantScope(scope, async () => fn());

describe("tenantCache — partição por schema", () => {
  beforeEach(() => resetCache());

  it("a mesma chave em schemas diferentes não vaza entre tenants", async () => {
    await inScope(SCOPE_A, () => tenantCache.set("store-settings", { merchantName: "Loja A" }));

    // O schema B não enxerga o valor de A, e o dele não sobrescreve o de A.
    await inScope(SCOPE_B, async () => {
      expect(await tenantCache.get("store-settings")).toBeNull();
      await tenantCache.set("store-settings", { merchantName: "Loja B" });
      expect(await tenantCache.get("store-settings")).toEqual({ merchantName: "Loja B" });
    });

    await inScope(SCOPE_A, async () => {
      expect(await tenantCache.get("store-settings")).toEqual({ merchantName: "Loja A" });
    });
  });

  it("invalidate usa o mesmo prefixo (não apaga a chave de outro schema)", async () => {
    await inScope(SCOPE_A, () => tenantCache.set("store-settings", "A"));
    await inScope(SCOPE_B, () => tenantCache.set("store-settings", "B"));

    await inScope(SCOPE_A, () => tenantCache.invalidate("store-settings"));

    await inScope(SCOPE_A, async () => expect(await tenantCache.get("store-settings")).toBeNull());
    await inScope(SCOPE_B, async () => expect(await tenantCache.get("store-settings")).toBe("B"));
  });

  it("invalidatePattern só atinge as chaves do schema corrente", async () => {
    await inScope(SCOPE_A, async () => {
      await tenantCache.set("products:list:1", "A1");
      await tenantCache.set("products:list:2", "A2");
    });
    await inScope(SCOPE_B, () => tenantCache.set("products:list:1", "B1"));

    await inScope(SCOPE_A, () => tenantCache.invalidatePattern("products:*"));

    await inScope(SCOPE_A, async () => {
      expect(await tenantCache.get("products:list:1")).toBeNull();
      expect(await tenantCache.get("products:list:2")).toBeNull();
    });
    await inScope(SCOPE_B, async () => expect(await tenantCache.get("products:list:1")).toBe("B1"));
  });

  it("o registry segue GLOBAL (getCache cru, sem prefixo de schema)", async () => {
    await getCache().set("tenant-registry:slug:a", "registry-a");
    await inScope(SCOPE_B, async () => {
      // O registry é de `public`, não pode ganhar prefixo de schema de tenant.
      expect(await getCache().get("tenant-registry:slug:a")).toBe("registry-a");
    });
  });
});
