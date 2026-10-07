// Tela de desbloqueio do aparelho provisionado (docs/21 §5.3): mostra o
// usuário VINCULADO (sem grade), envia login com deviceId via AuthProvider e
// trata revogação/erro de PIN. AuthProvider e navegação são mock.
import React from "react";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react-native";

const mockLogin = jest.fn();
const mockUnlock = jest.fn();
const mockSetBiometric = jest.fn();
const mockAuthValue = {
  login: mockLogin,
  deviceCredential: null,
  biometricEnabled: false,
  biometricAvailable: false,
  unlockWithBiometrics: mockUnlock,
  setBiometricEnabled: mockSetBiometric,
};

jest.mock("@react-navigation/native", () => ({ useFocusEffect: jest.fn() }));
jest.mock("@/app/providers/auth", () => ({ useAuth: () => mockAuthValue }));
jest.mock("@/app/providers/appConfig", () => ({ useAppConfig: () => ({ configured: true }) }));
jest.mock("@/entities/session", () => ({ listLoginUsers: jest.fn(async () => []) }));
jest.mock("@/entities/store", () => ({ getStoreInfo: jest.fn(async () => ({})) }));
jest.mock("@expo/vector-icons", () => {
  const React = require("react");
  const { Text } = require("react-native");
  const Icon = (props) => React.createElement(Text, null, props.name ?? "icon");
  return { Ionicons: Icon, __esModule: true };
});

const LoginPage = require("../LoginPage").default;

const CRED = {
  deviceId: "dev-1",
  deviceToken: "tok-1",
  user: { id: "u1", name: "Ana Ribeiro", role: "waiter", photoPath: null },
};

const navigation = { navigate: jest.fn() };

async function renderPage() {
  return render(<LoginPage navigation={navigation} />);
}

async function typePin(digits, utils) {
  for (const d of digits) await fireEvent.press(utils.getByText(d));
  await fireEvent.press(utils.getByText("Entrar"));
}

describe("LoginPage — aparelho provisionado", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAuthValue.deviceCredential = null;
    mockAuthValue.biometricEnabled = false;
    mockAuthValue.biometricAvailable = false;
    mockLogin.mockResolvedValue({ token: "jwt", user: CRED.user });
  });

  afterEach(async () => {
    await cleanup();
  });

  it("sem credencial mantém o fluxo legado (grade)", async () => {
    const { getByText, queryByText } = await renderPage();
    expect(getByText("Selecione seu nome para continuar")).toBeTruthy();
    expect(queryByText("Desbloqueie o aparelho com seu PIN")).toBeNull();
  });

  it("com credencial mostra o usuário vinculado e não a grade", async () => {
    mockAuthValue.deviceCredential = CRED;
    const { getByText, queryByText } = await renderPage();
    expect(getByText("Ana Ribeiro")).toBeTruthy();
    expect(getByText("Desbloqueie o aparelho com seu PIN")).toBeTruthy();
    expect(queryByText("Selecione seu nome para continuar")).toBeNull();
  });

  it("envia login do usuário vinculado (deviceId vai pelo AuthProvider)", async () => {
    mockAuthValue.deviceCredential = CRED;
    const utils = await renderPage();
    await typePin(["1", "2", "3", "4"], utils);
    await waitFor(() => expect(mockLogin).toHaveBeenCalledWith("u1", "1234"));
  });

  it("PIN incorreto usa a mensagem PT-BR", async () => {
    mockAuthValue.deviceCredential = CRED;
    mockLogin.mockRejectedValue({ code: "invalid_credentials" });
    const utils = await renderPage();
    await typePin(["9", "9", "9", "9"], utils);
    await waitFor(() => expect(utils.getByText("PIN incorreto. Tente novamente.")).toBeTruthy());
  });

  it("aparelho revogado avisa que precisa provisionar de novo", async () => {
    mockAuthValue.deviceCredential = CRED;
    mockLogin.mockRejectedValue({ code: "device_revoked" });
    const utils = await renderPage();
    await typePin(["1", "2", "3", "4"], utils);
    await waitFor(() =>
      expect(
        utils.getByText("Este aparelho não está mais autorizado. Provisione novamente."),
      ).toBeTruthy(),
    );
  });

  it("botão de biometria desbloqueia quando ligada e disponível", async () => {
    mockAuthValue.deviceCredential = CRED;
    mockAuthValue.biometricEnabled = true;
    mockAuthValue.biometricAvailable = true;
    const utils = await renderPage();
    await fireEvent.press(utils.getByTestId("biometric-unlock"));
    await waitFor(() => expect(mockUnlock).toHaveBeenCalledTimes(1));
  });

  it("oferece ligar a biometria e persiste após login por PIN", async () => {
    mockAuthValue.deviceCredential = CRED;
    mockAuthValue.biometricAvailable = true;
    mockAuthValue.biometricEnabled = false;
    const utils = await renderPage();
    await fireEvent.press(utils.getByTestId("biometric-toggle"));
    await typePin(["1", "2", "3", "4"], utils);
    await waitFor(() => expect(mockSetBiometric).toHaveBeenCalledWith(true));
  });
});
