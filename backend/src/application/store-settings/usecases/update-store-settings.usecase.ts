/**
 * `PUT /store-settings` — valida limites, canoniciza a chave Pix, atualiza o
 * singleton, invalida o cache UMA vez após o commit e, quando o nome/cidade
 * mudou, geocoda o novo endereço (audit `restaurant_geocoded` com
 * `SYSTEM_USER_ID` na mesma transação; falha de geocoding não derruba o save).
 *
 * APROXIMAÇÃO DE JANELA (mesma da Onda 2/3A): leituras que antes moravam fora
 * do tx agora acontecem na janela `uow.run` — mesma transação da escrita,
 * resultado observável idêntico. O cache (inválido após o commit) e o storage
 * (efeito externo, sem transação) continuam fora do UoW.
 */
import { Errors } from "../../../domain/errors.js";
import { canonicalizePixKey } from "../../../domain/pix-key.js";
import { SYSTEM_USER_ID } from "../../../domain/constants.js";
import type { StoreSettingsDependencies } from "../ports/store-settings-dependencies.js";
import { serializeStoreSettings } from "../shared/store-settings-helpers.js";

export type UpdateStoreSettingsInput = {
  merchantName: string;
  merchantCity: string;
  brandColor: string;
  pixKey: string;
  pixKeyType: "cpf" | "cnpj" | "email" | "phone" | "random";
  usesTables: boolean;
  kitchenEnabled: boolean;
  usesDelivery: boolean;
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
};

export class UpdateStoreSettingsUseCase {
  constructor(private readonly deps: StoreSettingsDependencies) {}

  async execute(input: UpdateStoreSettingsInput) {
    if (input.merchantName.length > 25) throw Errors.validationFailed({ field: "merchantName", max: 25 });
    if (input.merchantCity.length > 15) throw Errors.validationFailed({ field: "merchantCity", max: 15 });
    if (!/^#[0-9a-fA-F]{6}$/.test(input.brandColor)) throw Errors.validationFailed({ field: "brandColor" });
    if (input.kitchenPrepUrgentMin <= input.kitchenPrepWarnMin) throw Errors.invalidKitchenThresholds();

    let result: ReturnType<typeof serializeStoreSettings>;

    await this.deps.uow.run(this.deps.tenant(), async (session) => {
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
          const coords = await this.deps.geocoding.forwardGeocode(`${input.merchantName}, ${input.merchantCity}`);
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

      result = serializeStoreSettings(updated);
    });

    // Após o commit, UMA invalidação cobre o save e (se houve) o geocode.
    // `invalidatePrefix("store-settings")` → `invalidatePattern("store-settings*")`,
    // que casa a chave exata `store-settings` — semântica do `cache.invalidate` antigo.
    await this.deps.cache.invalidatePrefix("store-settings");

    return result!;
  }
}
