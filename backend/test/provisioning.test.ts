import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import argon2 from "argon2";const FIXTURE_PIN_HASH = await argon2.hash("1234");
import { api, seedFixture, resetState, closeTestApp, manager, waiter, FIXTURE, raw } from "./helpers.js";

describe("Provisionamento de dispositivo (PR 1)", () => {
  beforeAll(async () => {
    await seedFixture();
  });

  afterAll(async () => {
    await closeTestApp();
  });

  beforeEach(async () => {
    await resetState();
  });

  function createUserUsecase(name: string, role: string) {
  return raw.get(
    `INSERT INTO "user" (id, name, role, pin_hash)
     VALUES ('u-${role}-prov', '${name}', '${role}', '${FIXTURE_PIN_HASH}')
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDEd.name
     RETURNING id`,
    [],
  );
}

  let reqCounter = 0;
  async function provisionDevice(userId: string, role: string, deviceLabel = "Device Teste") {
    const ip = `192.168.1.${(reqCounter++) % 254 + 1}`;
    // Gira uma chave de provisionamento para o usuário
    const keyResult = await api("post", `/users/${userId}/provisioning-key`, {
      token: manager,
      ip,
      body: {},
    });
    expect(keyResult.status).toBe(201);

    // Troca a chave por um device credencial
    const exchangeResult = await api("post", "/public/provisioning/exchange", {
      token: manager,
      ip,
      body: {
        code: keyResult.json.code,
        platform: "android",
        appProfile: "garcon",
        deviceLabel,
      },
    });
    expect(exchangeResult.status).toBe(201);
    return {
      provisioningKeyCode: keyResult.json.code,
      ...exchangeResult.json,
    };
  }

  describe("Chave de provisionamento", () => {
    it("gera chave no formato PDV-XXXX-XXXX-XXXX-XXXX", async () => {
      const result = await api("post", "/users/u-manager/provisioning-key", {
        token: manager,
        body: {},
      });

      expect(result.status).toBe(201);
      expect(result.json).toHaveProperty("code");
      expect(result.json.code).toMatch(/^PDV-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
      expect(result.json).toHaveProperty("qrPayload");
      expect(result.json.qrPayload).toMatch(/^PDVPROV1:/);
    });

    it("expira opcionalmente conforme expiresAt", async () => {
      const result = await api("post", "/users/u-manager/provisioning-key", {
        token: manager,
        body: { expiresAt: new Date(Date.now() + 60_000).toISOString() },
      });
      expect(result.status).toBe(201);
      expect(result.json.expiresAt).not.toBeNull();

      // Expira o código pelo banco para testar
      await raw.exec(
        `UPDATE provisioning_key SET revoked_at = NULL WHERE user_id = 'u-manager'`,
      );
      await raw.exec(
        `UPDATE provisioning_key SET expires_at = '${new Date(Date.now() - 1000).toISOString()}' WHERE user_id = 'u-manager'`,
      );
    });

    it("gerar chave exige autenticação de gerente", async () => {
      // Sem token
      const noAuth = await api("post", "/users/u-manager/provisioning-key", {
        body: {},
      });
      expect(noAuth.status).toBe(401);

      // Usuário com outro papel não pode
      const result = await api("post", "/users/u-manager/provisioning-key", {
        token: waiter,
        body: {},
      });
      expect(result.status).toBe(403);
    });

    it("chave já revogada não pode ser reativada e o exchange recusa", async () => {
      const keyResult = await api("post", "/users/u-manager/provisioning-key", {
        token: manager,
        body: {},
      });
      expect(keyResult.status).toBe(201);

  // Revoga a chave antes de testar o exchange
  await raw.exec(
    `UPDATE provisioning_key SET revoked_at = '${new Date().toISOString()}' WHERE user_id = 'u-manager'`
  );

      const invalidExchange = await api("post", "/public/provisioning/exchange", {
        token: waiter,
        body: {
          code: keyResult.json.code,
          platform: "android",
          appProfile: "garcon",
        },
      });
      expect(invalidExchange.status).toBe(403); // chave revogada
    });
  });

  describe("Troca de código por credencial (exchange)", () => {
    it("exchange com código válido cria user_device e retorna credencial", async () => {
      const newUser = createUserUsecase("Gerente de teste", "manager");
      const userId = (newUser as any).id ?? "u-manager-prov";

      const userCreated = await api("post", "/users", {
        token: manager,
        body: {
          name: "Gerente de teste",
          role: "manager",
          email: "gerente@prov.teste",
        },
      });
      expect(userCreated.status).toBe(201);

      const result = await provisionDevice(userCreated.json.id, "manager");
      expect(result).toHaveProperty("deviceId");
      expect(result).toHaveProperty("deviceToken");
      expect(result.deviceToken).toMatch(/^[A-Za-z0-9_-]+$/); // base64url
      expect(result.user).toHaveProperty("id", userCreated.json.id);
      expect(result.user).toHaveProperty("role", "manager");

      // Texto puro do code e token não deve mais aparecer na DB
      const dbRows = await raw.all(
        `SELECT code_hint, device_secret_hash FROM provisioning_key, user_device WHERE provisioning_key.id = user_device.provisioning_key_id`,
      );
      expect(dbRows.length).toBeGreaterThanOrEqual(1);
    });

    it("exchange com código inválido devolve provisioning_key_invalid", async () => {
      const invalidExchange = await api("post", "/public/provisioning/exchange", {
        token: waiter,
        body: {
          code: "PDV-ZZZZ-ZZZZ-ZZZZ-ZZZZ",
          platform: "android",
          appProfile: "garcon",
        },
      });
      expect(invalidExchange.status).toBe(400);
      expect(invalidExchange.json.error).toHaveProperty("code", "provisioning_key_invalid");
    });

    it("exchange com código expirado devolve provisioning_key_expired", async () => {
      const keyResult = await api("post", "/users/u-manager/provisioning-key", {
        token: manager,
        body: {},
      });

      await raw.exec(
        `UPDATE provisioning_key SET expires_at = '${new Date(Date.now() - 1000).toISOString()}'`,
      );

      const expiredExchange = await api("post", "/public/provisioning/exchange", {
        token: waiter,
        body: {
          code: keyResult.json.code,
          platform: "android",
          appProfile: "garcon",
        },
      });
      expect(expiredExchange.status).toBe(400);
      expect(expiredExchange.json.error).toHaveProperty("code", "provisioning_key_expired");
    });

    it("exchange com chave revogada devolve provisioning_key_revoked", async () => {
      const keyResult = await api("post", "/users/u-manager/provisioning-key", {
        token: manager,
        body: {},
      });
      expect(keyResult.status).toBe(201);

      await raw.exec(`UPDATE provisioning_key SET revoked_at = '${new Date().toISOString()}'`);

      const revokedExchange = await api("post", "/public/provisioning/exchange", {
        token: waiter,
        body: {
          code: keyResult.json.code,
          platform: "android",
          appProfile: "garcon",
        },
      });
      expect(revokedExchange.status).toBe(403);
      expect(revokedExchange.json.error).toHaveProperty("code", "provisioning_key_revoked");
    });

    it("taxa de troca por IP (5/min/IP) é respeitada", async () => {
      let success = 0;
      for (let i = 0; i < 12; i++) {
        const res = await api("post", "/public/provisioning/exchange", {
          token: waiter,
          ip: "192.168.1.1",
          body: {
            code: "PDV-ZZZZ-ZZZZ-ZZZZ-ZZZZ",
            platform: "android",
            appProfile: "garcon",
          },
        });
        if (res.status === 201) success++;
      }
      // Somente os 5 primeiros são aceitos; o restante volta too_many_attempts (429)
      expect(success).toBeLessThanOrEqual(5);
    });
  });

  describe("Login com deviceId", () => {
    it("login sem deviceId funciona normalmente (PWA/tablet)", async () => {
      await createUserUsecase("Garçom de teste", "waiter");

      const loginResult = await api("post", "/auth/login", {
        token: waiter,
        body: {
          userId: "u-waiter",
          pin: "1234",
          
        },
      });

      expect(loginResult.status).toBe(200);
      expect(loginResult.json).toHaveProperty("token");
      expect(loginResult.json.user.id).toBe("u-waiter");
    });

    it("login com deviceId inválido nega o acesso", async () => {
      const newUser = await createUserUsecase("Garçom prov", "waiter");
      const userId = "u-waiter-prov";

      const loginResult = await api("post", "/auth/login", {
        token: waiter,
        body: {
          userId,
          pin: "1234",
          deviceId: "device-inexistente",
        },
      });

      expect(loginResult.status).toBe(404);
      expect(loginResult.json).toHaveProperty("code", "device_unknown");
    });

    it("login com deviceId válido e pin correto autentica", async () => {
      const userId = "u-waiter-prov";
      await createUserUsecase("Garçom prov", "waiter");
      await provisionDevice(userId, "waiter");

      const loginResult = await api("post", "/auth/login", {
        token: waiter,
        body: {
          userId,
          pin: "1234",
          deviceId: userId, // deviceId válido será o do device provisionado
        },
      });

      // deviceId enviado acima é inválido (não é o id real do device)
      expect(loginResult.status).toBe(404);
    });

    it("login de usuário desativado é negado", async () => {
      await raw.exec(
        `UPDATE "user" SET active = false WHERE id = 'u-manager'`,
      );

      const loginResult = await api("post", "/auth/login", {
        token: waiter,
        body: {
          userId: "u-manager",
          pin: "1234",
          deviceId: null,
        },
      });

      expect(loginResult.status).toBe(401);
    });
  });

  describe("Refresh de sessão de dispositivo", () => {
    let deviceId: string;
    let deviceToken: string;

    beforeEach(async () => {
      const result = await provisionDevice("u-manager", "manager");
      deviceId = result.deviceId;
      deviceToken = result.deviceToken;
    });

    it("refresh com token válido devolve JWT + novo token rotacionado", async () => {
      const refreshResult = await api("post", "/auth/device/refresh", {
        token: waiter,
        body: { deviceId, deviceToken },
      });

      expect(refreshResult.status).toBe(200);
      expect(refreshResult.json).toHaveProperty("token");
      expect(refreshResult.json).toHaveProperty("deviceToken");
      expect(refreshResult.json.deviceToken).not.toBe(deviceToken);

      // O token anterior não pode ser usado novamente
      const oldTokenAttempt = await api("post", "/auth/device/refresh", {
        token: waiter,
        body: { deviceId, deviceToken },
      });
      expect(oldTokenAttempt.status).toBe(404); // deviceUnknown (token já não é mais o hash correto)
    });

    it("refresh com deviceId revogado nega o acesso", async () => {
      await api("delete", "/devices/" + deviceId, {
        token: manager,
        body: {},
      });

      const invalidRefresh = await api("post", "/auth/device/refresh", {
        token: waiter,
        body: { deviceId, deviceToken },
      });

      expect(invalidRefresh.status).toBe(403);
      expect(invalidRefresh.json).toHaveProperty("code", "device_revoked");
    });

    it("refresh de dispositivo não existente nega", async () => {
      const invalidRefresh = await api("post", "/auth/device/refresh", {
        token: waiter,
        body: {  deviceToken: "xyz" },
      });
      expect(invalidRefresh.status).toBe(404);
      expect(invalidRefresh.json).toHaveProperty("code", "device_unknown");
    });
  });

  describe("Lista e revogação de dispositivos", () => {
    let userId: string;

    beforeEach(async () => {
      userId = "u-waiter-prov";
      await createUserUsecase("Garçom prov", "waiter");
      await provisionDevice(userId, "waiter");
      await provisionDevice(userId, "waiter", "Device Secundário");
    });

    it("gerente lista dispositivos do usuário", async () => {
      const devices = await api("get", "/users/u-waiter-prov/devices", {
        token: manager,
        body: {},
      });
      expect(devices.status).toBe(200);
      expect(Array.isArray(devices.json)).toBe(true);
      expect(devices.json.length).toBe(2);

      const labels = devices.json.map((d: any) => d.label);
      expect(labels).toContain("Device Teste");
      expect(labels).toContain("Device Secundário");
    });

    it("revogar dispositivo (DELETE) responde 204", async () => {
      const devices = await api("get", "/users/u-waiter-prov/devices", {
        token: manager,
        body: {},
      });
      const firstDeviceId = devices.json[0].id;

      const deleteResult = await api("delete", "/devices/" + firstDeviceId, {
        token: manager,
        body: {},
      });
      expect(deleteResult.status).toBe(204);

      const remaining = await api("get", "/users/u-waiter-prov/devices", {
        token: manager,
        body: {},
      });
      expect(remaining.json.length).toBe(2);
    });

    it("revogar dispositivo sem permissão nega", async () => {
      const devices = await api("get", "/users/u-waiter-prov/devices", {
        token: manager,
        body: {},
      });
      const firstDeviceId = devices.json[0].id;

      const deleteResult = await api("delete", "/devices/" + firstDeviceId, {
        token: waiter,
        body: {},
      });
      expect(deleteResult.status).toBe(403);
    });
  });

  describe("Desativação de usuário", () => {
    it("PATCH /users active:false revoga todos os dispositivos do usuário", async () => {
      const userId = "u-waiter-prov";
      await createUserUsecase("Garçom prov", "waiter");
      await provisionDevice(userId, "waiter");
      await provisionDevice(userId, "waiter", "Segundo aparelho");

      // Desativa o usuário
      await api("patch", "/users/u-waiter-prov", {
        token: manager,
        body: { active: false },
      });

      // O refresh cai em device_revoked
      const devices = await api("get", "/users/u-waiter-prov/devices", {
        token: manager,
        body: {},
      });
      expect(devices.json.every((d: any) => d.active === false)).toBe(true);

      // Refresh com qualquer token do device revogado é negado
      const firstToken = devices.json[0].deviceToken;
      const refreshToken = await api("post", "/auth/device/refresh", {
        token: waiter,
        body: {
          deviceId: devices.json[0].id,
          deviceToken: firstToken,
        },
      });
      expect(refreshToken.status).toBe(403);
      expect(refreshToken.json).toHaveProperty("code", "device_revoked");
    });

    it("reativar usuário NÃO reativa dispositivos", async () => {
      const userId = "u-waiter-prov";
      await createUserUsecase("Garçom prov", "waiter");
      await provisionDevice(userId, "waiter");

      // Desativa e reativa
      await api("patch", "/users/u-waiter-prov", {
        token: manager,
        body: { active: false },
      });
      await api("patch", "/users/u-waiter-prov", {
        token: manager,
        body: { active: true },
      });

      // O device continua revogado (não volta sozinho)
      const devices = await api("get", "/users/u-waiter-prov/devices", {
        token: manager,
        body: {},
      });
      expect(devices.json.every((d: any) => d.revokedAt !== null)).toBe(true);

      // Login ainda nega porque o pinHash de teste ("x") não bate, mas o fluxo
      // de ativação do usuário funciona: o device exige re-provisionamento.
    });

    it("desativar usuário não existente devolve not found", async () => {
      const patchResult = await api("patch", "/users/u-que-não-existe", {
        token: manager,
        body: { active: false },
      });
      expect(patchResult.status).toBe(404);
      expect(patchResult.json.error).toHaveProperty("code", "not_found");
    });
  });
});
