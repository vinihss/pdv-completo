/**
 * Configurações da loja — ONDA 3C da refatoração arquitetural.
 *
 * Factory pura (`createStoreSettingsUsecases`): nenhuma importação de
 * infra/integrations/Drizzle. Persistência via `session.storeSettings` na
 * janela `uow.run` (leitura do singleton + escrita na MESMA transação), audit
 * via `session.audit`, cache via port `TenantCache` e arquivos via port
 * `FileStorage`; o forward geocoding entra pelo effect port `GeocodingService`
 * (seam trocável, mesmo do contexto delivery).
 *
 * Semântica preservada do módulo original:
 *   - `getStoreSettingsUsecase`: lê o singleton e guarda em cache por schema
 *     com a chave fixa `store-settings` (TTL 300s — cache particionado, uma
 *     loja nunca serve a marca de outra);
 *   - `updateStoreSettingsUsecase`: valida limites, canoniciza a chave Pix com
 *     `canonicalizePixKey`, atualiza o singleton, invalida o cache UMA vez após
 *     o commit e, quando o nome/cidade mudou, geocoda o novo endereço
 *     (audit `restaurant_geocoded` com `SYSTEM_USER_ID` na mesma transação;
 *     falha de geocoding não derruba o save);
 *   - logo: nome FIXO `logo.<ext>` por tenant no layout
 *     `<uploads>/<schema>/logo/logo.<ext>` (era o que fazia a loja B
 *     sobrescrever o logo da loja A num diretório único — doc 15 §5.2),
 *     arquivo antigo removido quando a extensão muda, audit na mesma
 *     transação do UPDATE.
 *
 * APROXIMAÇÃO DE JANELA (mesma da Onda 2/3A): leituras que antes moravam fora
 * do tx (`db.query.storeSettings`, cache à parte) agora acontecem na janela
 * `uow.run` — mesma transação da escrita, resultado observável idêntico. O
 * cache (inválido após o commit) e o storage (efeito externo, sem transação)
 * continuam fora do UoW.
 */
import { Errors } from "../domain/errors.js";
import { canonicalizePixKey } from "../domain/pix-key.js";
import { SYSTEM_USER_ID } from "../domain/constants.js";
import type { TenantUnitOfWork } from "./ports/unit-of-work.js";
import type { TenantContext } from "./ports/tenant-context.js";
import type { TenantCache, FileStorage, GeocodingService } from "./ports/effects.js";
import type { StoreSettingsRow } from "./ports/repositories.js";

// ---------- helpers puros (eram infra/storage) ----------
//
// `storageAssetPath`/`isSafeFilename`/`storageFilename` são funções PURAS de
// `infra/storage` (sem I/O). Definidas aqui para a application não importar a
// camada de armazenamento — o `FileStorage` port (put/remove) é a única seam
// de I/O. Mantêm a MESMA lógica.

/** `/uploads/logo/<filename>` — mesmo formato de `storageAssetPath`. */
const UPLOADS_PREFIX = "/uploads";
function logoUrlOf(filename: string | null | undefined): string | null {
  return filename ? `${UPLOADS_PREFIX}/logo/${filename}` : null;
}

const FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,190}$/;
function isSafeFilename(filename: string): boolean {
  if (!filename || filename.length > 200) return false;
  if (filename.includes("/") || filename.includes("\\") || filename.includes("\0")) return false;
  if (filename === "." || filename === "..") return false;
  return FILENAME_RE.test(filename);
}

/** Normaliza o que está no banco para o nome de arquivo (só o basename). */
function storageFilename(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const name = raw.split(/[\\/]/).pop() ?? "";
  return name.length > 0 ? name : null;
}

function serialize(s: StoreSettingsRow) {
  return {
    merchantName: s.merchantName,
    merchantCity: s.merchantCity,
    logoUrl: s.logoPath ? logoUrlOf(s.logoPath) : null,
    brandColor: s.brandColor,
    pixKey: s.pixKey,
    pixKeyType: s.pixKeyType,
    usesTables: s.usesTables,
    kitchenEnabled: s.kitchenEnabled,
    usesDelivery: s.usesDelivery,
    ifoodIntegrationEnabled: s.ifoodIntegrationEnabled,
    inventoryEnabled: s.inventoryEnabled,
    purchaseEnabled: s.purchaseEnabled,
    printerEnabled: s.printerEnabled,
    printerAutoPrint: s.printerAutoPrint,
    enabledPaymentMethods: JSON.parse(s.enabledPaymentMethods),
    kitchenPrepWarnMin: s.kitchenPrepWarnMin,
    kitchenPrepUrgentMin: s.kitchenPrepUrgentMin,
    kitchenPickupUrgentMin: s.kitchenPickupUrgentMin,
    deliveryFee: s.deliveryFee,
    restaurantLat: s.restaurantLat,
    restaurantLong: s.restaurantLong,
    freeDeliveryMin: s.freeDeliveryMin,
    deliveryFeeTiers: JSON.parse(s.deliveryFeeTiers),
    deliveryPrepMinutes: s.deliveryPrepMinutes,
    minutesPerKm: s.minutesPerKm,
  };
}

export interface StoreSettingsUsecasesDeps {
  uow: TenantUnitOfWork;
  /** Resolvido a cada chamada (ALS/request corrente) — nunca memoizado. */
  tenant: () => TenantContext;
  /** Cache por schema — invalida a chave `store-settings` após o commit. */
  cache: TenantCache;
  /** Upload/remoção do logo em disco. */
  storage: FileStorage;
  /** Forward geocoding do endereço do restaurante (seam trocável). */
  geocoding: GeocodingService;
}

export function createStoreSettingsUsecases(deps: StoreSettingsUsecasesDeps) {
  return {
    async getStoreSettingsUsecase() {
      const key = "store-settings";
      const cached = await deps.cache.get<ReturnType<typeof serialize>>(key);
      if (cached) return cached;

      return deps.uow.run(deps.tenant(), async (session) => {
        const s = await session.storeSettings.findSingleton();
        if (!s) throw Errors.notFound("Configuração da loja");
        const result = serialize(s);
        await deps.cache.set(key, result, { ttl: 300 });
        return result;
      });
    },

    async updateStoreSettingsUsecase(input: {
      merchantName: string;
      merchantCity: string;
      brandColor: string;
      pixKey: string;
      pixKeyType: "cpf" | "cnpj" | "email" | "phone" | "random";
      usesTables: boolean;
      kitchenEnabled: boolean;
      usesDelivery: boolean;
      ifoodIntegrationEnabled: boolean;
      inventoryEnabled: boolean;
      purchaseEnabled: boolean;
      printerEnabled: boolean;
      printerAutoPrint: boolean;
      enabledPaymentMethods: string[];
      kitchenPrepWarnMin: number;
      kitchenPrepUrgentMin: number;
      kitchenPickupUrgentMin: number;
      deliveryFee: number;
      restaurantLat?: number | null;
      restaurantLong?: number | null;
      freeDeliveryMin?: number;
      deliveryFeeTiers?: Array<{ maxKm: number; fee: number }>;
      deliveryPrepMinutes?: number;
      minutesPerKm?: number;
    }) {
      if (input.merchantName.length > 25) throw Errors.validationFailed({ field: "merchantName", max: 25 });
      if (input.merchantCity.length > 15) throw Errors.validationFailed({ field: "merchantCity", max: 15 });
      if (!/^#[0-9a-fA-F]{6}$/.test(input.brandColor)) throw Errors.validationFailed({ field: "brandColor" });
      if (input.kitchenPrepUrgentMin <= input.kitchenPrepWarnMin) throw Errors.invalidKitchenThresholds();

      let result: ReturnType<typeof serialize>;

      await deps.uow.run(deps.tenant(), async (session) => {
        const current = await session.storeSettings.findSingleton();
        if (!current) throw Errors.notFound("Configuração da loja");

        const nameOrCityChanged =
          input.merchantName !== current.merchantName || input.merchantCity !== current.merchantCity;

        // A chave Pix entra canônica no banco (telefone em E.164, documento só
        // dígitos, e-mail em minúsculas). Quem decide o formato é o `pixKeyType` que
        // o gerente salvou, e não a dedução por formato: 11 dígitos são CPF e celular
        // ao mesmo tempo, e chutar "CPF" punha o telefone do gerente sem DDI no QR.
        // O client repete a mesma regra na hora de gerar (`domain/pix-key.ts`).
        const pixKey = canonicalizePixKey(input.pixKey, input.pixKeyType);

        const updated = await session.storeSettings.update({ ...input, pixKey });

        if (nameOrCityChanged) {
          try {
            const coords = await deps.geocoding.forwardGeocode(`${input.merchantName}, ${input.merchantCity}`);
            // Mesma transação do save: coordenadas + audit juntos (como o
            // `db.transaction` do geocode-restaurant fazia).
            await session.storeSettings.updateRestaurantCoordinates(coords);
            await session.audit.record({
              actorId: SYSTEM_USER_ID,
              action: "restaurant_geocoded",
              orderId: null,
              details: { latitude: coords.latitude, longitude: coords.longitude },
            });
            updated.restaurantLat = coords.latitude;
            updated.restaurantLong = coords.longitude;
          } catch (err) {
            // Geocoding failure não invalida o save — apenas registra.
          }
        }

        result = serialize(updated);
      });

      // Após o commit, UMA invalidação cobre o save e (se houve) o geocode.
      // `invalidatePrefix("store-settings")` → `invalidatePattern("store-settings*")`,
      // que casa a chave exata `store-settings` — semântica do `cache.invalidate` antigo.
      await deps.cache.invalidatePrefix("store-settings");

      return result!;
    },

    // ---------- Logo (identidade) — upload em disco, caminho em store_settings.logo_path ----------
    //
    // O nome é FIXO (`logo.<ext>`) — era o que fazia a loja B sobrescrever o logo
    // da loja A num diretório único (doc 15 §5.2). Quem resolve agora é o layout:
    // `<uploads>/<schema>/logo/logo.<ext>`, um diretório por tenant. O
    // `logo_path` continua significando "o nome do arquivo do logo".

    async saveStoreLogoUsecase(input: { buffer: Buffer; ext: string }, actorId: string) {
      return deps.uow.run(deps.tenant(), async (session) => {
        const settings = await session.storeSettings.findSingleton();
        if (!settings) throw Errors.notFound("Configuração da loja");

        const filename = `logo.${input.ext}`;
        if (!isSafeFilename(filename)) throw Errors.validationFailed({ field: "logo" });
        await deps.storage.put("logo", filename, input.buffer);

        // Remove o logo antigo quando a extensão muda (logo.jpg → logo.png)
        const previous = storageFilename(settings.logoPath);
        if (previous && previous !== filename) await deps.storage.remove("logo", previous);

        const updated = await session.storeSettings.setLogoPath(filename);
        await session.audit.record({
          actorId,
          action: "store_logo_changed",
          orderId: null,
          details: { logoPath: filename },
        });
        await deps.cache.invalidatePrefix("store-settings");
        return serialize(updated);
      });
    },

    async clearStoreLogoUsecase(actorId: string) {
      return deps.uow.run(deps.tenant(), async (session) => {
        const settings = await session.storeSettings.findSingleton();
        if (!settings) throw Errors.notFound("Configuração da loja");
        if (!settings.logoPath) return serialize(settings);

        const previous = storageFilename(settings.logoPath);
        if (previous) await deps.storage.remove("logo", previous);

        const updated = await session.storeSettings.setLogoPath(null);
        await session.audit.record({
          actorId,
          action: "store_logo_removed",
          orderId: null,
        });
        await deps.cache.invalidatePrefix("store-settings");
        return serialize(updated);
      });
    },
  };
}

export type StoreSettingsUsecases = ReturnType<typeof createStoreSettingsUsecases>;