import React from "react";
import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import UserModal from "./UserModal.jsx";
import UsersTab from "./UsersTab.jsx";
import { createUser, listUsers, updateUser, resetPin, uploadUserPhoto } from "@/entities/user";

// ---------------------------------------------------------------------------
// O `UserModal` é o modal ÚNICO da aba Equipe (criação e edição) — montado em
// runtime por `UsersTab`. Os testes da aba cobrem o fluxo inteiro (abrir a
// partir da lista, salvar, foto no cadastro novo); os de `UserModal` cobrem o
// contrato do componente (campos, validação, upload na edição).
// ---------------------------------------------------------------------------

vi.mock("@/entities/user", () => ({
  listUsers: vi.fn(),
  createUser: vi.fn(),
  updateUser: vi.fn(),
  resetPin: vi.fn(),
  uploadUserPhoto: vi.fn(),
  removeUserPhoto: vi.fn(),
}));

const USERS = [
  { id: "u1", name: "Ana Ribeiro", role: "waiter", active: true, photoPath: "/uploads/user/u1.jpg", phone: "11999990001", email: "ana@exemplo.com" },
  { id: "u2", name: "Carlos Lima", role: "kitchen", active: false, photoPath: null, phone: null, email: null },
];

const CRIADO = { id: "u9", name: "Beatriz Souza", role: "waiter", active: true, photoPath: null, pin: "4321" };

// jsdom não implementa createObjectURL/revokeObjectURL; a prévia local do modo
// criação usa blob URL, então o stub vem antes de qualquer render que escolha
// arquivo.
beforeAll(() => {
  URL.createObjectURL = vi.fn(() => "blob:preview");
  URL.revokeObjectURL = vi.fn();
});

function renderTab(toast = () => {}) {
  return render(<UsersTab showToast={toast} />);
}

function pickFile(modalContainer, name = "foto.png") {
  const file = new File(["x"], name, { type: "image/png" });
  fireEvent.change(modalContainer.querySelector('input[type="file"]'), { target: { files: [file] } });
  return file;
}

describe("UsersTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listUsers.mockResolvedValue(USERS.slice());
    createUser.mockResolvedValue(CRIADO);
    updateUser.mockImplementation((id, body) => Promise.resolve({ ...USERS.find((u) => u.id === id), ...body }));
    resetPin.mockResolvedValue({ pin: "1111" });
    uploadUserPhoto.mockResolvedValue({ ...CRIADO, photoPath: "/uploads/user/u9.jpg" });
  });
  afterEach(cleanup);

  it("lista usuários com avatar: foto quando existe, iniciais quando não", async () => {
    renderTab();
    await screen.findByText("Ana Ribeiro");
    // Ana tem foto → <img> com o caminho público do backend
    expect(screen.getByAltText("Ana Ribeiro").getAttribute("src")).toBe("/uploads/user/u1.jpg");
    // Carlos não tem → círculo com as iniciais
    expect(screen.getByText("CL")).toBeTruthy();
    expect(screen.queryByAltText("Carlos Lima")).toBeNull();
    expect(screen.getByText("Garçom")).toBeTruthy();
    expect(screen.getByText("Cozinha")).toBeTruthy();
  });

  it("usuário inativo continua com opacity-50 na linha", async () => {
    renderTab();
    await screen.findByText("Ana Ribeiro");
    const inativo = screen.getByText("Carlos Lima").closest(".rounded-xl");
    const ativo = screen.getByText("Ana Ribeiro").closest(".rounded-xl");
    expect(inativo.className).toContain("opacity-50");
    expect(ativo.className).not.toContain("opacity-50");
  });

  it("botão de editar abre o UserModal com os dados do usuário", async () => {
    renderTab();
    await screen.findByText("Ana Ribeiro");
    fireEvent.click(screen.getByRole("button", { name: "Editar Ana Ribeiro" }));
    expect(screen.getByRole("dialog", { name: "Editar usuário" })).toBeTruthy();
    expect(screen.getByDisplayValue("Ana Ribeiro")).toBeTruthy();
    expect(screen.getByDisplayValue("(11) 99999-0001")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Enviar foto" })).toBeTruthy();
  });

  it("salvar na edição chama updateUser e recarrega a lista", async () => {
    renderTab();
    await screen.findByText("Ana Ribeiro");
    fireEvent.click(screen.getByRole("button", { name: "Editar Ana Ribeiro" }));
    fireEvent.change(screen.getByDisplayValue("Ana Ribeiro"), { target: { value: "Ana Editada" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar alterações" }));
    await waitFor(() =>
      expect(updateUser).toHaveBeenCalledWith("u1", expect.objectContaining({ name: "Ana Editada", role: "waiter" }))
    );
    expect(listUsers).toHaveBeenCalledTimes(2); // montagem + reload pós-save
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Editar usuário" })).toBeNull());
  });

  it("cadastro novo com foto: cria o usuário e só então sobe a foto", async () => {
    renderTab();
    await screen.findByText("Ana Ribeiro");
    fireEvent.click(screen.getByRole("button", { name: /Novo usuário/ }));
    const modal = screen.getByRole("dialog", { name: "Novo usuário" });
    const inputs = modal.querySelectorAll("input:not([type='file'])");
    fireEvent.change(inputs[0], { target: { value: "Beatriz Souza" } });
    const file = pickFile(modal);

    fireEvent.click(screen.getByRole("button", { name: "Criar usuário" }));

    // O POST /users/:id/photo exige o id: primeiro o createUser, depois o upload.
    await waitFor(() =>
      expect(createUser).toHaveBeenCalledWith({ name: "Beatriz Souza", role: "waiter", phone: null, email: null })
    );
    await waitFor(() => expect(uploadUserPhoto).toHaveBeenCalledWith("u9", file));

    // PIN revelado após a criação e modal fechado — comportamento mantido.
    expect(screen.getByText(/PIN gerado: 4321/)).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Novo usuário" })).toBeNull();
    expect(listUsers).toHaveBeenCalledTimes(2);
  });

<<<<<<< HEAD
  it("preserva o PIN e fecha o modal se a criação funciona, mas a recarga falha", async () => {
    listUsers.mockReset();
    listUsers.mockResolvedValueOnce(USERS.slice()).mockRejectedValueOnce(new Error("sem conexão"));
    const toast = vi.fn();
    renderTab(toast);
    await screen.findByText("Ana Ribeiro");
    fireEvent.click(screen.getByRole("button", { name: /Novo usuário/ }));
    const modal = screen.getByRole("dialog", { name: "Novo usuário" });
    fireEvent.change(modal.querySelector("input:not([type='file'])"), { target: { value: "Beatriz Souza" } });

    fireEvent.click(screen.getByRole("button", { name: "Criar usuário" }));

    await waitFor(() => expect(createUser).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/PIN gerado: 4321/)).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Novo usuário" })).toBeNull();
    expect(toast).toHaveBeenCalledWith(expect.stringContaining("não foi possível atualizar a lista"), "error");
  });

=======
>>>>>>> e7828131 (feat(courier): payload foto/entregas, alerta WhatsApp 5min, foto equipe, migrations)
  it("se o upload da foto falhar no cadastro, avisa e mantém o usuário criado", async () => {
    uploadUserPhoto.mockRejectedValue(new Error("arquivo muito grande"));
    const toast = vi.fn();
    renderTab(toast);
    await screen.findByText("Ana Ribeiro");
    fireEvent.click(screen.getByRole("button", { name: /Novo usuário/ }));
    const modal = screen.getByRole("dialog", { name: "Novo usuário" });
    const inputs = modal.querySelectorAll("input:not([type='file'])");
    fireEvent.change(inputs[0], { target: { value: "Beatriz Souza" } });
    const file = pickFile(modal);

    fireEvent.click(screen.getByRole("button", { name: "Criar usuário" }));

    await waitFor(() => expect(uploadUserPhoto).toHaveBeenCalledWith("u9", file));
    // Decisão do cadastro: upload falhou NÃO desfaz a criação — avisa e deixa
    // a foto para a edição; o PIN continua sendo revelado.
    expect(toast).toHaveBeenCalledWith(expect.stringContaining("foto não subiu"), "error");
    expect(createUser).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/PIN gerado: 4321/)).toBeTruthy();
  });

  it("cadastro novo: dá para remover a foto escolhida antes de criar", async () => {
    renderTab();
    await screen.findByText("Ana Ribeiro");
    fireEvent.click(screen.getByRole("button", { name: /Novo usuário/ }));
    const modal = screen.getByRole("dialog", { name: "Novo usuário" });
    const inputs = modal.querySelectorAll("input:not([type='file'])");
    fireEvent.change(inputs[0], { target: { value: "Beatriz Souza" } });
    pickFile(modal);
    expect(screen.getByText(/Enviada junto com a criação/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Remover seleção" }));
    expect(screen.queryByText(/Enviada junto com a criação/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Criar usuário" }));
    await waitFor(() => expect(createUser).toHaveBeenCalledTimes(1));
    expect(uploadUserPhoto).not.toHaveBeenCalled();
  });

  it("redefinir PIN continua abrindo o modal com o PIN novo", async () => {
    renderTab();
    await screen.findByText("Ana Ribeiro");
    fireEvent.click(screen.getByRole("button", { name: "Redefinir PIN de Ana Ribeiro" }));
    await waitFor(() => expect(resetPin).toHaveBeenCalledWith("u1"));
    expect(screen.getByText(/PIN gerado: 1111/)).toBeTruthy();
  });

  it("ativar/desativar chama updateUser com active invertido e recarrega", async () => {
    renderTab();
    await screen.findByText("Ana Ribeiro");
    fireEvent.click(screen.getByRole("button", { name: "Desativar" }));
    await waitFor(() => expect(updateUser).toHaveBeenCalledWith("u1", { active: false }));
    expect(listUsers).toHaveBeenCalledTimes(2);
  });
});

describe("UserModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    uploadUserPhoto.mockResolvedValue({ id: "u1", name: "Ana Ribeiro", role: "waiter", photoPath: "/uploads/user/u1.jpg" });
  });
  afterEach(cleanup);

  it("é um diálogo de tela cheia com nome, perfil e ação no rodapé", () => {
    render(<UserModal onClose={() => {}} onSaved={async () => {}} showToast={() => {}} />);
    expect(screen.getByRole("dialog", { name: "Novo usuário" })).toBeTruthy();
    expect(screen.getByText("Nome")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Criar usuário" })).toBeTruthy();
  });

  it("lista os 5 perfis e deixa trocar a seleção", () => {
    render(<UserModal onClose={() => {}} onSaved={async () => {}} showToast={() => {}} />);
    const select = screen.getByRole("combobox");
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual([
      "Garçom",
      "Cozinha",
      "Gerente",
      "Caixa",
      "Entregador",
    ]);
    fireEvent.change(select, { target: { value: "courier" } });
    expect(select.value).toBe("courier");
  });

  it("tem telefone e email, e explica que o PIN é automático na criação", () => {
    render(<UserModal onClose={() => {}} onSaved={async () => {}} showToast={() => {}} />);
    expect(screen.getByText("Telefone")).toBeTruthy();
    expect(screen.getByText("Email")).toBeTruthy();
<<<<<<< HEAD
    expect(screen.getByText(/PIN será gerado automaticamente/)).toBeTruthy();
    expect(screen.queryByPlaceholderText("4 a 6 dígitos")).toBeNull();
=======
    expect(screen.getByPlaceholderText("4 a 6 dígitos")).toBeTruthy();
>>>>>>> e7828131 (feat(courier): payload foto/entregas, alerta WhatsApp 5min, foto equipe, migrations)
  });

  it("edição mostra foto do usuário e campos preenchidos", () => {
    const user = { id: "u1", name: "Ana Ribeiro", role: "waiter", phone: "11999990001", email: "ana@exemplo.com", photoPath: null };
    render(<UserModal user={user} onClose={() => {}} onSaved={async () => {}} showToast={() => {}} />);
    expect(screen.getByRole("dialog", { name: "Editar usuário" })).toBeTruthy();
    expect(screen.getByDisplayValue("Ana Ribeiro")).toBeTruthy();
    expect(screen.getByDisplayValue("(11) 99999-0001")).toBeTruthy();
    expect(screen.getByDisplayValue("ana@exemplo.com")).toBeTruthy();
    expect(screen.getByPlaceholderText("4 a 6 dígitos")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Enviar foto" })).toBeTruthy();
<<<<<<< HEAD
  });

  it("na edição, escolher foto sobe no onChange e o avatar reflete sem reabrir", async () => {
    const onSaved = vi.fn();
    const user = { id: "u1", name: "Ana Ribeiro", role: "waiter", phone: null, email: null, photoPath: null };
    const { container } = render(<UserModal user={user} onClose={() => {}} onSaved={onSaved} showToast={() => {}} />);
    const file = pickFile(container);
    await waitFor(() => expect(uploadUserPhoto).toHaveBeenCalledWith("u1", file));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    // `user` do pai é snapshot — o modal espelha o photoPath devolvido pelo upload.
    expect(screen.getByAltText("Ana Ribeiro").getAttribute("src")).toBe("/uploads/user/u1.jpg");
  });

  it("criação sem nome não cria usuário", () => {
    render(<UserModal onClose={() => {}} onSaved={async () => {}} showToast={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Criar usuário" }));
    expect(screen.getByText("Informe o nome do usuário.")).toBeTruthy();
    expect(createUser).not.toHaveBeenCalled();
=======
>>>>>>> e7828131 (feat(courier): payload foto/entregas, alerta WhatsApp 5min, foto equipe, migrations)
  });

  it("na edição, escolher foto sobe no onChange e o avatar reflete sem reabrir", async () => {
    const onSaved = vi.fn();
    const user = { id: "u1", name: "Ana Ribeiro", role: "waiter", phone: null, email: null, photoPath: null };
    const { container } = render(<UserModal user={user} onClose={() => {}} onSaved={onSaved} showToast={() => {}} />);
    const file = pickFile(container);
    await waitFor(() => expect(uploadUserPhoto).toHaveBeenCalledWith("u1", file));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    // `user` do pai é snapshot — o modal espelha o photoPath devolvido pelo upload.
    expect(screen.getByAltText("Ana Ribeiro").getAttribute("src")).toBe("/uploads/user/u1.jpg");
  });

  it("criação sem nome não cria usuário", () => {
    render(<UserModal onClose={() => {}} onSaved={async () => {}} showToast={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Criar usuário" }));
    expect(screen.getByText("Informe o nome do usuário.")).toBeTruthy();
    expect(createUser).not.toHaveBeenCalled();
  });
});