import React from "react";
import { StyleSheet } from "react-native";
import { cleanup, render, within } from "@testing-library/react-native";
import DeliveryCard from "../DeliveryCard";

// Ícones quebram renders repetidos sob o renderer assíncrono do RNTL v14
// (glyph de fonte); mock vira `<Text name>` e o foco fica no comportamento.
jest.mock("@expo/vector-icons", () => {
  const React = require("react");
  const { Text } = require("react-native");
  const Icon = (props) => React.createElement(Text, null, props.name ?? "icon");
  return { Ionicons: Icon, __esModule: true };
});

// A altura da ação primária é regra de produto (polegar, uma mão, na rua).
const PRIMARY_MIN_HEIGHT = 56;

const queueDelivery = {
  id: "d1",
  orderId: "12345678-aaaa-bbbb",
  status: "awaiting_courier",
  customerName: "João",
  customerPhone: "11987654321",
  createdAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
  estimatedMinutes: 25,
  items: [{ quantity: 1, productName: "Pizza", notes: "sem cebola" }],
  address: "Rua Teste, 10 - Centro",
  addressLatitude: -23.5,
  addressLongitude: -46.6,
};

const activeDelivery = {
  id: "d2",
  orderId: "87654321-bbbb-cccc",
  status: "out_for_delivery",
  customerName: "Maria",
  dispatchedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
  address: "Av Teste, 20",
  addressLatitude: -23.6,
  addressLongitude: -46.7,
};

function actionRow(getByTestId) {
  // `within(row)` é o ponto do teste: o botão de problema mora FORA desta
  // linha (faixa própria) e por isso não pode aparecer nesta contagem — era
  // exatamente o `slice(0, 2)` da linha antiga que o cortava.
  return within(getByTestId("delivery-actions")).getAllByTestId(/^delivery-action-/);
}

describe("DeliveryCard", () => {
  afterEach(async () => {
    await cleanup();
  });

  test("fila: mostra dados, endereço e estimativa do contrato", async () => {
    const { getByText } = await render(<DeliveryCard delivery={queueDelivery} now={Date.now()} />);
    expect(getByText("João")).toBeTruthy();
    expect(getByText("Pedido #12345678")).toBeTruthy();
    expect(getByText("≈ 25 min")).toBeTruthy();
    expect(getByText("Rua Teste, 10 - Centro")).toBeTruthy();
    expect(getByText(/Pizza — sem cebola/)).toBeTruthy();
    expect(getByText("Saí para entrega")).toBeTruthy();
  });

  test("fila: no máximo 2 ações e sem faixa de problema (fail só em rota)", async () => {
    const { getByTestId, queryByText } = await render(
      <DeliveryCard delivery={queueDelivery} now={Date.now()} />
    );
    const buttons = actionRow(getByTestId);
    expect(buttons.length).toBeLessThanOrEqual(2);
    expect(buttons.length).toBe(2); // Saí para entrega + Rota
    expect(queryByText("Problema na entrega")).toBeNull();
  });

  test("rota: Entreguei é primária de 56px e a ação de problema NÃO é cortada", async () => {
    const { getByTestId, getByText } = await render(
      <DeliveryCard delivery={activeDelivery} now={Date.now()} variant="hero" />
    );
    const buttons = actionRow(getByTestId);
    expect(buttons.length).toBeLessThanOrEqual(2);
    expect(getByText("Entreguei")).toBeTruthy();

    const primary = StyleSheet.flatten(getByTestId("delivery-action-deliver").props.style);
    expect(primary.minHeight).toBe(PRIMARY_MIN_HEIGHT);

    // O bug original: com endereço, a linha era [Entreguei, Rota, Problema] e o
    // `slice(0, 2)` sumia com "Problema na entrega".
    expect(getByTestId("delivery-action-fail")).toBeTruthy();
  });

  test("rota: linha de ação fica com 2 botões e o problema fica fora dela", async () => {
    const { getByTestId } = await render(
      <DeliveryCard delivery={activeDelivery} now={Date.now()} />
    );
    const row = getByTestId("delivery-actions");
    expect(actionRow(getByTestId)).toHaveLength(2); // Entreguei + Rota
    expect(within(row).queryByTestId("delivery-action-fail")).toBeNull();
  });

  test("telefone é link de dado, não botão de ação", async () => {
    const { getByTestId, getByText } = await render(
      <DeliveryCard delivery={queueDelivery} now={Date.now()} />
    );
    expect(getByText("(11) 98765-4321")).toBeTruthy();
    expect(getByTestId("delivery-call")).toBeTruthy();
  });
});
