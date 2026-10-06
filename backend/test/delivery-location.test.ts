import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { api, seedFixture, resetState, closeTestApp, FIXTURE, manager, raw } from "./helpers.js";
import { handleIncomingWhatsAppMessage } from "../src/application/self-service/whatsapp-bot.usecases.js";
import { createSelfServiceOrderUsecase } from "../src/application/self-service/order-intake.usecase.js";
import { setMapServices } from "../src/application/delivery/calcular-entrega.usecase.js";

setMapServices(
  {
    async reverseGeocode() {
      return {
        street: "Rua Teste",
        number: "123",
        neighborhood: "Centro",
        city: "São Paulo",
        state: "SP",
        postalCode: "01000-000",
        formattedAddress: "Rua Teste, 123, Centro, São Paulo, SP",
      };
    },
    async forwardGeocode() {
      return { latitude: -29.76, longitude: -51.14 };
    },
  },
  {
    async calculateRoute() {
      return { distanceKm: 5.2, durationMinutes: 11 };
    },
  }
);

const RESTAURANT_LAT = -29.76;
const RESTAURANT_LONG = -51.14;

async function seedRestaurantCoords() {
  await raw.exec(`
    UPDATE store_settings SET restaurant_lat = ${RESTAURANT_LAT}, restaurant_long = ${RESTAURANT_LONG} WHERE id = 'singleton';
  `);
}

describe("POST /calcular-entrega", () => {
  beforeAll(async () => {
    await seedFixture();
    await seedRestaurantCoords();
  });

  afterAll(async () => {
    await closeTestApp();
  });

  beforeEach(async () => {
    await resetState();
    await seedRestaurantCoords();
  });

  it("rejeita latitude fora do intervalo", async () => {
    const res = await api("post", "/calcular-entrega", {
      body: { latitude: 91, longitude: -51.14 },
    });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe("validation_failed");
  });

  it("rejeita longitude fora do intervalo", async () => {
    const res = await api("post", "/calcular-entrega", {
      body: { latitude: -29.75, longitude: -181 },
    });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe("validation_failed");
  });

  it("rejeita latitude não numérica", async () => {
    const res = await api("post", "/calcular-entrega", {
      body: { latitude: "abc", longitude: -51.14 },
    });
    expect(res.status).toBe(400);
  });

  it("rejeita quando restaurante não tem coordenadas", async () => {
    await raw.exec(`UPDATE store_settings SET restaurant_lat = NULL, restaurant_long = NULL WHERE id = 'singleton';`);
    const res = await api("post", "/calcular-entrega", {
      body: { latitude: -29.75, longitude: -51.14 },
    });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe("validation_failed");
  });
});

describe("Webhook WhatsApp - localização", () => {
  beforeAll(async () => {
    await seedFixture();
    await seedRestaurantCoords();
  });

  afterAll(async () => {
    await closeTestApp();
  });

  beforeEach(async () => {
    await resetState();
    await seedRestaurantCoords();
  });

  it("extrai localização do payload", async () => {
    const { extractIncomingMessage } = await import("../src/integrations/whatsapp/webhook-payload.js");
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    from: "5511999999999",
                    type: "location",
                    location: { latitude: -29.7542, longitude: -51.1496 },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    const result = extractIncomingMessage(payload as any);
    expect(result).not.toBeNull();
    expect(result!.phone).toBe("5511999999999");
    expect(result!.location).toEqual({ latitude: -29.7542, longitude: -51.1496 });
    expect(result!.text).toBeNull();
  });

  it("extrai texto do payload", async () => {
    const { extractIncomingMessage } = await import("../src/integrations/whatsapp/webhook-payload.js");
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                messages: [{ from: "5511999999999", type: "text", text: { body: "Olá" } }],
              },
            },
          ],
        },
      ],
    };
    const result = extractIncomingMessage(payload as any);
    expect(result).not.toBeNull();
    expect(result!.text).toBe("Olá");
    expect(result!.location).toBeNull();
  });

  it("retorna null para mensagem sem localização nem texto", async () => {
    const { extractIncomingMessage } = await import("../src/integrations/whatsapp/webhook-payload.js");
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                messages: [{ from: "5511999999999", type: "image" }],
              },
            },
          ],
        },
      ],
    };
    expect(extractIncomingMessage(payload as any)).toBeNull();
  });

  it("bot responde com menu quando recebe texto sem localização", async () => {
    const { replyText } = await handleIncomingWhatsAppMessage("5511999999999", "Olá", null);
    expect(replyText).toContain("cardápio");
  });

  it("bot responde ao pedir correção de endereço", async () => {
    const { replyText } = await handleIncomingWhatsAppMessage("5511999999999", "não", null);
    expect(replyText.toLowerCase()).toContain("cardápio");
  });
});

// ---------- Previsão gravada na delivery ----------
// O checkout calcula a estimativa ANTES do insert (order-intake.usecase.ts §4.1)
// e grava `distance_km`/`estimated_minutes` na delivery — são essas duas
// colunas que o card do gerente no mapa precisa expor. Chamado direto no
// usecase porque o zod da rota pública descarta o `deliveryZoneKm` (ver §05), o
// que deixaria `distance_km` sempre null no fluxo HTTP.
describe("previsão gravada na delivery sai nas listas", () => {
  beforeAll(async () => {
    await seedFixture();
    await seedRestaurantCoords();
  });

  afterAll(async () => {
    await closeTestApp();
  });

  beforeEach(async () => {
    await resetState();
    await seedRestaurantCoords();
  });

  it("a faixa escolhida no checkout vira distanceKm/estimatedMinutes na lista do gerente", async () => {
    // Faixa de 5 km → preparo 40 + viagem max(5, 5 km × 2 min) = 50.
    const created = await createSelfServiceOrderUsecase({
      channel: "web",
      customerPhone: "11988887777",
      customerName: "Cliente Rota",
      newAddress: { street: "Rua Rota", number: "10", neighborhood: "Centro", city: "Sao Paulo" },
      items: [{ productId: FIXTURE.product, quantity: 1 }],
      paymentMethodIntent: "cash",
      deliveryZoneKm: 5,
    });
    expect(created.estimatedMinutes).toBe(50);

    const row = await raw.get(`SELECT distance_km, estimated_minutes FROM delivery WHERE order_id = $1`, [
      created.orderId,
    ]);
    expect(row.distance_km).toBeCloseTo(5);
    expect(row.estimated_minutes).toBe(50);

    // Antes desta mudança as duas colunas existiam na tabela e não saíam em
    // NENHUMA lista — o gerente não tinha a previsão no card da entrega.
    const res = await api("get", "/manager/deliveries", { token: manager });
    expect(res.status).toBe(200);
    const item = res.json.find((d: any) => d.orderId === created.orderId);
    expect(item).toBeTruthy();
    expect(item.distanceKm).toBeCloseTo(5);
    expect(item.estimatedMinutes).toBe(50);
  });
});
