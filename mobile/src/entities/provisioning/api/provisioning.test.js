// Contrato HTTP do provisionamento. O exchange é PÚBLICO (sem Bearer) e o
// refresh recebe {deviceId, deviceToken} — `docs/21-device-provisioning.md` §6
// e `backend/src/http/routes/provisioning.routes.ts`.
import { setAppConfig } from "@/shared/lib";
import { setAuthToken } from "@/shared/api/http";
import {
  currentDeviceLabel,
  exchangeProvisioningCode,
  refreshDeviceSession,
} from "./provisioning.js";

jest.mock("expo-device", () => ({ modelName: "Galaxy A54", deviceName: "samsung" }));

function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => "application/json" },
    json: async () => payload,
  };
}

describe("provisioning api", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    setAppConfig({ apiBase: "http://10.0.2.2:3000", daemonUrl: "" });
    setAuthToken(null);
    global.fetch = jest.fn(async () => jsonResponse(201, {}));
  });

  afterEach(() => {
    setAppConfig(null);
    global.fetch = originalFetch;
  });

  it("currentDeviceLabel cai para o modelo do aparelho", () => {
    expect(currentDeviceLabel()).toBe("Galaxy A54");
  });

  it("exchange manda o payload do contrato em /public/provisioning/exchange", async () => {
    await exchangeProvisioningCode({
      code: "PDVABCDEFGHIJKLMNOP",
      platform: "android",
      appProfile: "garcon",
      deviceLabel: "Galaxy A54",
    });
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe("http://10.0.2.2:3000/api/public/provisioning/exchange");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBeUndefined(); // público
    expect(JSON.parse(init.body)).toEqual({
      code: "PDVABCDEFGHIJKLMNOP",
      platform: "android",
      appProfile: "garcon",
      deviceLabel: "Galaxy A54",
    });
  });

  it("exchange normaliza deviceLabel ausente para null", async () => {
    await exchangeProvisioningCode({ code: "PDVX", platform: "ios", appProfile: "entregador" });
    const [, init] = global.fetch.mock.calls[0];
    expect(JSON.parse(init.body).deviceLabel).toBeNull();
  });

  it("refresh manda deviceId/deviceToken em /auth/device/refresh", async () => {
    global.fetch.mockResolvedValue(
      jsonResponse(200, { token: "jwt", deviceToken: "tok-2", user: { id: "u1" } }),
    );
    const result = await refreshDeviceSession({ deviceId: "dev-1", deviceToken: "tok-1" });
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe("http://10.0.2.2:3000/api/auth/device/refresh");
    expect(JSON.parse(init.body)).toEqual({ deviceId: "dev-1", deviceToken: "tok-1" });
    expect(result.deviceToken).toBe("tok-2");
  });
});
