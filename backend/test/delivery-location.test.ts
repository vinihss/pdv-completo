import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { api, seedFixture, resetState, closeTestApp, FIXTURE } from "./helpers.js";
import { rawSqlite } from "../src/infra/db/client.js";
import { handleIncomingWhatsAppMessage } from "../src/application/self-service/whatsapp-bot.usecases.js";
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

function seedRestaurantCoords() {
  rawSqlite.exec(`
    UPDATE store_settings SET restaurant_lat = ${RESTAURANT_LAT}, restaurant_long = ${RESTAURANT_LONG} WHERE id = 'singleton';
  `);
}

describe("POST /calcular-entrega", () => {
  beforeAll(() => {
    seedFixture();
    seedRestaurantCoords();
  });

  afterAll(async () => {
    await closeTestApp();
  });

  beforeEach(() => {
    resetState();
    seedRestaurantCoords();
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
    rawSqlite.exec(`UPDATE store_settings SET restaurant_lat = NULL, restaurant_long = NULL WHERE id = 'singleton';`);
    const res = await api("post", "/calcular-entrega", {
      body: { latitude: -29.75, longitude: -51.14 },
    });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe("validation_failed");
  });
});

describe("Webhook WhatsApp - localização", () => {
  beforeAll(() => {
    seedFixture();
    seedRestaurantCoords();
  });

  afterAll(async () => {
    await closeTestApp();
  });

  beforeEach(() => {
    resetState();
    seedRestaurantCoords();
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
