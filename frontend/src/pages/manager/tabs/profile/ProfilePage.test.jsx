import React from "react";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ auth: null, getMe: null }));

vi.mock("@/app/providers/auth", () => ({ useAuth: () => mocks.auth }));
vi.mock("@/entities/session", () => ({
  getMe: (...args) => mocks.getMe(...args),
  updateMe: vi.fn(),
  login: vi.fn(),
  listLoginUsers: vi.fn(),
}));

const { default: ProfilePage } = await import("./ProfilePage.jsx");

const PERFIL_SERVIDOR = {
  id: "u1",
  name: "Ana Ribeiro",
  phone: "(11) 90000-0000",
  email: "ana@exemplo.com",
  role: "waiter",
  photoPath: null,
};

function setup({ updateProfile = vi.fn().mockResolvedValue({}), getMe = vi.fn().mockResolvedValue(PERFIL_SERVIDOR) } = {}) {
  mocks.auth = {
    session: { token: "t", user: { id: "u1", name: "Ana Ribeiro", role: "waiter", photoPath: null } },
    updateProfile,
  };
  mocks.getMe = getMe;
  const utils = render(
    <MemoryRouter>
      <ProfilePage />
    </MemoryRouter>
  );
  return { ...utils, updateProfile, getMe };
}

/** Espera o fim do carregamento (botão sai de "Carregando…"). */
async function whenReady() {
  await screen.findByRole("button", { name: /salvar alterações/i });
}

describe("ProfilePage", () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(cleanup);

  it("carrega phone/email do servidor e salva só o que o usuário mudou", async () => {
    const { updateProfile } = setup();

    // Campos travados até o GET responder — digitar durante o load seria
    // sobrescrito pelos dados do servidor.
    expect(screen.getByLabelText(/nome/i).disabled).toBe(true);
    await whenReady();

    expect(screen.getByLabelText(/telefone/i).value).toBe("(11) 90000-0000");
    expect(screen.getByLabelText(/email/i).value).toBe("ana@exemplo.com");

    fireEvent.change(screen.getByLabelText(/nome/i), { target: { value: "Ana R. Silva" } });
    fireEvent.click(screen.getByRole("button", { name: /salvar alterações/i }));

    await waitFor(() => expect(updateProfile).toHaveBeenCalledTimes(1));
    // Telefone e e-mail intocados: fora do payload (omissão = não altera no backend).
    expect(updateProfile).toHaveBeenCalledWith({ name: "Ana R. Silva" });
    // Nunca leva role/pin/active para o self-service.
    const body = updateProfile.mock.calls[0][0];
    expect(body).not.toHaveProperty("role");
    expect(body).not.toHaveProperty("pin");
    expect(body).not.toHaveProperty("active");
    expect((await screen.findByRole("status")).textContent).toMatch(/atualizado/i);
  });

  it("mudou telefone: o campo entra no payload", async () => {
    const { updateProfile } = setup();
    await whenReady();
    fireEvent.change(screen.getByLabelText(/telefone/i), { target: { value: "(11) 91111-2222" } });
    fireEvent.click(screen.getByRole("button", { name: /salvar alterações/i }));
    await waitFor(() => expect(updateProfile).toHaveBeenCalledTimes(1));
    expect(updateProfile).toHaveBeenCalledWith({
      name: "Ana Ribeiro",
      phone: "(11) 91111-2222",
    });
  });

  it("se o GET falhar, campos intocados não são enviados (nada é apagado às cegas)", async () => {
    const { updateProfile } = setup({ getMe: vi.fn().mockRejectedValue(new Error("offline")) });
    await whenReady();
    fireEvent.click(screen.getByRole("button", { name: /salvar alterações/i }));
    await waitFor(() => expect(updateProfile).toHaveBeenCalledTimes(1));
    expect(updateProfile).toHaveBeenCalledWith({ name: "Ana Ribeiro" });
  });

  it("nome vazio não chama a API e mostra erro", async () => {
    const { updateProfile } = setup();
    await whenReady();
    fireEvent.change(screen.getByLabelText(/nome/i), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: /salvar alterações/i }));
    expect(updateProfile).not.toHaveBeenCalled();
    expect((await screen.findByRole("alert")).textContent).toMatch(/informe o nome/i);
  });

  it("falha da API vira mensagem de erro, não crash", async () => {
    const updateProfile = vi.fn().mockRejectedValue(new Error("Sem conexão com o servidor"));
    setup({ updateProfile });
    await whenReady();
    fireEvent.click(screen.getByRole("button", { name: /salvar alterações/i }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/sem conexão/i);
    expect(screen.getByRole("button", { name: /salvar alterações/i }).disabled).toBe(false);
  });
});
