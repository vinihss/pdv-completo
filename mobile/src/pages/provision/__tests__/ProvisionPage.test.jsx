// Tela de provisionamento (docs/21 §5.2): QR + digitação, estados de
// permissão da câmera e mapeamento de erro. Câmera e AuthProvider são mock —
// o que importa é o contrato da tela.
import React from "react";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react-native";

const mockProvision = jest.fn();
const mockRequestPermission = jest.fn();
let mockPermission = { granted: false, canAskAgain: true };

jest.mock("expo-camera", () => {
  const React = require("react");
  const { View } = require("react-native");
  return {
    CameraView: (props) => React.createElement(View, props),
    useCameraPermissions: () => [mockPermission, mockRequestPermission],
  };
});

jest.mock("@/app/providers/auth", () => ({
  useAuth: () => ({ provision: mockProvision }),
}));

jest.mock("@/shared/lib/server", () => ({ currentServerLabel: () => "http://10.0.2.2:3000" }));

jest.mock("@expo/vector-icons", () => {
  const React = require("react");
  const { Text } = require("react-native");
  const Icon = (props) => React.createElement(Text, null, props.name ?? "icon");
  return { Ionicons: Icon, __esModule: true };
});

const ProvisionPage = require("../ProvisionPage").default;

describe("ProvisionPage", () => {
  const navigation = { navigate: jest.fn() };

  beforeEach(() => {
    jest.clearAllMocks();
    mockPermission = { granted: false, canAskAgain: true };
    mockProvision.mockResolvedValue({
      deviceId: "d1",
      deviceToken: "t1",
      user: { id: "u1", name: "Ana" },
    });
  });

  afterEach(async () => {
    await cleanup();
  });

  it("pede permissão de câmera quando abre no modo scan", async () => {
    await render(<ProvisionPage navigation={navigation} />);
    await waitFor(() => expect(mockRequestPermission).toHaveBeenCalledTimes(1));
  });

  it("sem permissão e sem poder pedir, cai no fallback de digitação", async () => {
    mockPermission = { granted: false, canAskAgain: false };
    const { getByText, getByPlaceholderText, queryByTestId } = await render(
      <ProvisionPage navigation={navigation} />,
    );
    expect(getByText("Sem permissão para usar a câmera.")).toBeTruthy();
    expect(queryByTestId("provision-camera")).toBeNull();
    expect(mockRequestPermission).not.toHaveBeenCalled();

    await fireEvent.press(getByText("Digitar o código"));
    await fireEvent.changeText(getByPlaceholderText("XXXX-XXXX-XXXX-XXXX"), "abcdefghijklmnop");
    await fireEvent.press(getByText("Conectar"));

    await waitFor(() => expect(mockProvision).toHaveBeenCalledWith("PDVABCDEFGHIJKLMNOP"));
  });

  it("mapeia erro do exchange para mensagem PT-BR", async () => {
    mockPermission = { granted: false, canAskAgain: false };
    mockProvision.mockRejectedValue({ code: "provisioning_key_revoked" });
    const { getByText, getByPlaceholderText } = await render(
      <ProvisionPage navigation={navigation} />,
    );
    await fireEvent.press(getByText("Digitar o código"));
    await fireEvent.changeText(getByPlaceholderText("XXXX-XXXX-XXXX-XXXX"), "ABCDEFGHIJKLMNOP");
    await fireEvent.press(getByText("Conectar"));

    await waitFor(() =>
      expect(getByText("Esta chave foi revogada. Peça uma nova ao gerente.")).toBeTruthy(),
    );
  });

  it("lê o QR (removendo o envelope PDVPROV1:) e provisiona", async () => {
    mockPermission = { granted: true, canAskAgain: true };
    const { getByTestId } = await render(<ProvisionPage navigation={navigation} />);
    await fireEvent(getByTestId("provision-camera"), "barcodeScanned", {
      data: "PDVPROV1:PDV-ABCD-EFGH-IJKL-MNOP",
    });
    await waitFor(() => expect(mockProvision).toHaveBeenCalledWith("PDVABCDEFGHIJKLMNOP"));
  });

  it("QR estranho não chama o exchange e mostra aviso", async () => {
    mockPermission = { granted: true, canAskAgain: true };
    const { getByTestId, getByText } = await render(<ProvisionPage navigation={navigation} />);
    await fireEvent(getByTestId("provision-camera"), "barcodeScanned", {
      data: "https://exemplo.com",
    });
    expect(getByText("Este QR Code não é uma chave de provisionamento do PDV.")).toBeTruthy();
    expect(mockProvision).not.toHaveBeenCalled();
  });

  it("escape de desenvolvimento navega para o login antigo", async () => {
    const { getByText } = await render(<ProvisionPage navigation={navigation} />);
    await fireEvent.press(getByText("Entrar sem provisionar (dev)"));
    expect(navigation.navigate).toHaveBeenCalledWith("Login");
  });
});
