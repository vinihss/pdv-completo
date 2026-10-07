// Credencial do aparelho: SecureStore mockado em memória (é assíncrono só na
// API) e a preferência de biometria no MMKV (shim de storage). `docs/21
// §3` decisão 4 / §5.2.
import { storage } from "@/shared/lib/storage";
import {
  clearDeviceCredential,
  isBiometricEnabled,
  loadDeviceCredential,
  saveDeviceCredential,
  setBiometricPreference,
} from "./credential.js";

jest.mock("expo-secure-store", () => {
  const store = new Map();
  return {
    getItemAsync: jest.fn(async (k) => (store.has(k) ? store.get(k) : null)),
    setItemAsync: jest.fn(async (k, v) => {
      store.set(k, v);
    }),
    deleteItemAsync: jest.fn(async (k) => {
      store.delete(k);
    }),
    __store: store,
  };
});

// Acesso ao Map interno do mock via requireMock: acessar `__store` pelo
// namespace tipado do import dispara `import/namespace` no oxlint.
const secureStore = jest.requireMock("expo-secure-store");

const CRED = {
  deviceId: "dev-1",
  deviceToken: "tok-1",
  user: { id: "u1", name: "Ana", role: "waiter", photoPath: null },
};

describe("deviceCredential", () => {
  beforeEach(() => {
    secureStore.__store.clear();
    storage.clear();
    jest.clearAllMocks();
  });

  it("devolve null quando não há credencial", async () => {
    await expect(loadDeviceCredential()).resolves.toBeNull();
  });

  it("grava e lê a credencial no SecureStore", async () => {
    await saveDeviceCredential(CRED);
    await expect(loadDeviceCredential()).resolves.toEqual(CRED);
    // Persistiu como JSON na chave física do SecureStore (sem `:`, que a API recusa).
    expect(secureStore.setItemAsync).toHaveBeenCalledWith("pdv.device", JSON.stringify(CRED));
  });

  it("clear apaga a credencial", async () => {
    await saveDeviceCredential(CRED);
    await clearDeviceCredential();
    await expect(loadDeviceCredential()).resolves.toBeNull();
  });

  it("crédito corrompido/incompleto devolve null em vez de estourar", async () => {
    secureStore.__store.set("pdv.device", "{not-json");
    await expect(loadDeviceCredential()).resolves.toBeNull();

    secureStore.__store.set("pdv.device", JSON.stringify({ deviceId: "x" }));
    await expect(loadDeviceCredential()).resolves.toBeNull();
  });
});

describe("biometric preference", () => {
  beforeEach(() => {
    storage.clear();
  });

  it("default desligado e liga/desliga no MMKV", () => {
    expect(isBiometricEnabled()).toBe(false);
    setBiometricPreference(true);
    expect(isBiometricEnabled()).toBe(true);
    expect(storage.getItem("pdv:device:biometric")).toBe("1");
    setBiometricPreference(false);
    expect(isBiometricEnabled()).toBe(false);
  });
});
