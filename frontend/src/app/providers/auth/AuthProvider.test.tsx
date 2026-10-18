import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth } from "./AuthProvider.jsx";

// Falso JWT: o AuthProvider só lê o `exp` localmente (base64url do meio),
// sem validar assinatura — isso é papel do backend.
function makeToken(expInMs) {
  const payload = btoa(JSON.stringify({ sub: "acc-1", typ: "account", exp: Math.floor((Date.now() + expInMs) / 1000) }));
  return `header.${payload}.assinatura`;
}

const mocks = vi.hoisted(() => ({
  sessionStart: vi.fn(),
  changePassword: vi.fn(),
  selectTenant: vi.fn(),
  refreshSession: vi.fn(),
  logoutSession: vi.fn(),
  login: vi.fn(),
  updateMe: vi.fn(),
  setDeviceTenantSlug: vi.fn(),
  getStoreSettings: vi.fn(),
  authTokens: [],
  unauthorizedHandler: null,
}));

vi.mock("@/entities/session", async (orig) => ({
  ...(await orig()), // decodeTokenExp/getDeviceTenantSlug ficam REAIS
  sessionStart: (...a) => mocks.sessionStart(...a),
  changePassword: (...a) => mocks.changePassword(...a),
  selectTenant: (...a) => mocks.selectTenant(...a),
  refreshSession: (...a) => mocks.refreshSession(...a),
  logoutSession: (...a) => mocks.logoutSession(...a),
  login: (...a) => mocks.login(...a),
  updateMe: (...a) => mocks.updateMe(...a),
  setDeviceTenantSlug: (...a) => mocks.setDeviceTenantSlug(...a),
}));
vi.mock("@/entities/store", () => ({
  getStoreSettings: (...a) => mocks.getStoreSettings(...a),
}));
vi.mock("@/shared/api/http", () => ({
  setAuthToken: (t) => mocks.authTokens.push(t),
  setUnauthorizedHandler: (fn) => {
    mocks.unauthorizedHandler = fn;
  },
}));

// Sonda: o resto do app lê session={token,user} — é esse o contrato interno
// que estes testes protegem junto com a persistência em dois estágios.
let auth;
function Probe() {
  auth = useAuth();
  return (
    <p>
      {auth.booting ? "bootando" : auth.session ? `logado:${auth.session.user.name}` : "sem-sessao"}
    </p>
  );
}

async function renderAuth() {
  render(
    <AuthProvider>
      <Probe />
    </AuthProvider>
  );
  await waitFor(() => expect(screen.queryByText("bootando")).toBeNull());
}

const SESSION_VIVA = {
  token: makeToken(6 * 60 * 60 * 1000), // 6h de vida: o boot não precisa girar nada
  refreshToken: "refresh-1",
  user: { id: "u1", name: "Ana Ribeiro", role: "waiter" },
};

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  mocks.authTokens.length = 0;
  mocks.unauthorizedHandler = null;
  for (const fn of [
    mocks.sessionStart,
    mocks.changePassword,
    mocks.selectTenant,
    mocks.refreshSession,
    mocks.logoutSession,
    mocks.login,
    mocks.updateMe,
    mocks.setDeviceTenantSlug,
  ]) {
    fn.mockReset();
  }
  mocks.getStoreSettings.mockReset().mockResolvedValue({ merchantName: "Bar do Zé" });
  mocks.logoutSession.mockResolvedValue({ ok: true }); // fire-and-forget do logout precisa de promise
});
afterEach(cleanup);

describe("AuthProvider — boot", () => {
  it("sessão lembrada (localStorage) restaura sem bater refresh", async () => {
    localStorage.setItem("pdv:session", JSON.stringify(SESSION_VIVA));
    await renderAuth();
    expect(screen.getByText("logado:Ana Ribeiro")).toBeTruthy();
    expect(mocks.refreshSession).not.toHaveBeenCalled();
  });

  it("sessão só da aba (sessionStorage) também restaura", async () => {
    sessionStorage.setItem("pdv:session", JSON.stringify(SESSION_VIVA));
    await renderAuth();
    expect(screen.getByText("logado:Ana Ribeiro")).toBeTruthy();
    expect(mocks.refreshSession).not.toHaveBeenCalled();
  });

  it("token com < 5min de vida gira o refresh ANTES do app começar", async () => {
    localStorage.setItem(
      "pdv:session",
      JSON.stringify({ ...SESSION_VIVA, token: makeToken(2 * 60 * 1000) })
    );
    const girado = { token: makeToken(6 * 60 * 60 * 1000), refreshToken: "refresh-2" };
    mocks.refreshSession.mockResolvedValue(girado);
    await renderAuth();
    expect(screen.getByText("logado:Ana Ribeiro")).toBeTruthy();
    expect(mocks.refreshSession).toHaveBeenCalledWith("refresh-1");
    // A rotação é persistida: o próximo boot já usa o token novo.
    const gravada = JSON.parse(localStorage.getItem("pdv:session"));
    expect(gravada.token).toBe(girado.token);
    expect(gravada.refreshToken).toBe("refresh-2");
  });

  it("refresh que falhou no boot → logout limpo (cai no login)", async () => {
    localStorage.setItem(
      "pdv:session",
      JSON.stringify({ ...SESSION_VIVA, token: makeToken(60 * 1000) })
    );
    mocks.refreshSession.mockRejectedValue({ status: 401 });
    await renderAuth();
    expect(screen.getByText("sem-sessao")).toBeTruthy();
    expect(localStorage.getItem("pdv:session")).toBeNull();
    expect(sessionStorage.getItem("pdv:session")).toBeNull();
  });

  it("sessão por PIN (sem refreshToken) perto do fim da vida morre no boot", async () => {
    sessionStorage.setItem(
      "pdv:session",
      JSON.stringify({ ...SESSION_VIVA, refreshToken: null, token: makeToken(60 * 1000) })
    );
    await renderAuth();
    expect(screen.getByText("sem-sessao")).toBeTruthy();
    expect(mocks.refreshSession).not.toHaveBeenCalled();
  });

  it("storage corrompido é descartado sem derrubar o boot", async () => {
    localStorage.setItem("pdv:session", "{nao-e-json");
    await renderAuth();
    expect(screen.getByText("sem-sessao")).toBeTruthy();
    expect(localStorage.getItem("pdv:session")).toBeNull();
  });
});

describe("AuthProvider — identidade centralizada", () => {
  it("loginNovo abre a etapa de conta EM MEMÓRIA (não persiste accountToken)", async () => {
    await renderAuth();
    mocks.sessionStart.mockResolvedValue({
      accountToken: "acc-token",
      mustChangePassword: true,
      companies: [{ slug: "bar-do-ze", name: "Bar do Zé" }],
    });
    await act(async () => {
      await auth.loginNovo("ana@pdv.local", "senha", true);
    });
    expect(screen.getByText("sem-sessao")).toBeTruthy(); // ainda não é sessão
    expect(auth.account.mustChangePassword).toBe(true);
    expect(auth.account.remember).toBe(true);
    expect(localStorage.getItem("pdv:session")).toBeNull();
    expect(sessionStorage.getItem("pdv:session")).toBeNull();
  });

  it("'lembrar' grava a sessão final em localStorage; sem lembrar, só na aba", async () => {
    await renderAuth();
    mocks.sessionStart.mockResolvedValue({ accountToken: "acc", mustChangePassword: false, companies: [] });
    mocks.selectTenant.mockResolvedValue({
      token: "tok-tenant",
      refreshToken: "refresh-tenant",
      user: { id: "u1", name: "Ana Ribeiro", role: "waiter" },
    });

    await act(async () => {
      await auth.loginNovo("ana@pdv.local", "senha", true);
    });
    await act(async () => {
      await auth.completeTenantSelection("bar-do-ze");
    });
    expect(screen.getByText("logado:Ana Ribeiro")).toBeTruthy();
    expect(JSON.parse(localStorage.getItem("pdv:session")).token).toBe("tok-tenant");
    expect(sessionStorage.getItem("pdv:session")).toBeNull();
    // Preferência do dispositivo gravada só após o select-tenant dar certo.
    expect(mocks.setDeviceTenantSlug).toHaveBeenCalledWith("bar-do-ze");

    await act(async () => {
      auth.logout();
    });
    mocks.selectTenant.mockClear();
    mocks.sessionStart.mockResolvedValue({ accountToken: "acc2", mustChangePassword: false, companies: [] });
    mocks.selectTenant.mockResolvedValue({
      token: "tok-2",
      refreshToken: "refresh-2",
      user: { id: "u1", name: "Ana Ribeiro", role: "waiter" },
    });
    await act(async () => {
      await auth.loginNovo("ana@pdv.local", "senha", false);
    });
    await act(async () => {
      await auth.completeTenantSelection("bar-do-ze");
    });
    expect(sessionStorage.getItem("pdv:session")).not.toBeNull();
    expect(localStorage.getItem("pdv:session")).toBeNull();
  });

  it("troca de senha usa o accountToken da etapa de conta", async () => {
    await renderAuth();
    mocks.sessionStart.mockResolvedValue({ accountToken: "acc", mustChangePassword: true, companies: [] });
    mocks.changePassword.mockResolvedValue({ ok: true });
    await act(async () => {
      await auth.loginNovo("ana@pdv.local", "temporaria", false);
    });
    await act(async () => {
      await auth.changeAccountPassword("senha-definitiva");
    });
    expect(mocks.changePassword).toHaveBeenCalledWith("acc", "senha-definitiva");
    expect(auth.account.mustChangePassword).toBe(false);
  });

  it("select-tenant sem etapa de conta não dispara chamada nenhuma", async () => {
    await renderAuth();
    await expect(auth.completeTenantSelection("bar-do-ze")).rejects.toThrow(/Sessão expirada/);
    expect(mocks.selectTenant).not.toHaveBeenCalled();
  });
});

describe("AuthProvider — 401 e logout", () => {
  it("401 com sessão viva tenta UM refresh (rotação) antes de deslogar", async () => {
    localStorage.setItem("pdv:session", JSON.stringify(SESSION_VIVA));
    await renderAuth();
    const girado = { token: makeToken(6 * 60 * 60 * 1000), refreshToken: "refresh-2" };
    mocks.refreshSession.mockResolvedValue(girado);

    // Dois 401 em cascata (ex.: duas telas atualizando juntas) → uma rotação só.
    await act(async () => {
      await Promise.all([mocks.unauthorizedHandler(), mocks.unauthorizedHandler()]);
    });
    expect(mocks.refreshSession).toHaveBeenCalledTimes(1);
    expect(screen.getByText("logado:Ana Ribeiro")).toBeTruthy();
    expect(JSON.parse(localStorage.getItem("pdv:session")).refreshToken).toBe("refresh-2");
  });

  it("refresh recusado no meio do turno → logout limpo", async () => {
    localStorage.setItem("pdv:session", JSON.stringify(SESSION_VIVA));
    await renderAuth();
    mocks.refreshSession.mockRejectedValue({ status: 401 });
    await act(async () => {
      await mocks.unauthorizedHandler();
    });
    expect(screen.getByText("sem-sessao")).toBeTruthy();
    expect(localStorage.getItem("pdv:session")).toBeNull();
  });

  it("logout revoga a sessão no servidor (fire-and-forget) e limpa o device", async () => {
    localStorage.setItem("pdv:session", JSON.stringify(SESSION_VIVA));
    await renderAuth();
    mocks.logoutSession.mockResolvedValue({ ok: true });
    await act(async () => {
      auth.logout();
    });
    expect(mocks.logoutSession).toHaveBeenCalledWith("refresh-1");
    expect(screen.getByText("sem-sessao")).toBeTruthy();
    expect(localStorage.getItem("pdv:session")).toBeNull();
  });

  it("logout sem refreshToken (PIN) só limpa o local", async () => {
    sessionStorage.setItem("pdv:session", JSON.stringify({ ...SESSION_VIVA, refreshToken: null }));
    await renderAuth();
    await act(async () => {
      auth.logout();
    });
    expect(mocks.logoutSession).not.toHaveBeenCalled();
    expect(screen.getByText("sem-sessao")).toBeTruthy();
  });
});
