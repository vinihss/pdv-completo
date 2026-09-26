import React from "react";
import { OrderBoard } from "@/widgets/order-board";

// Tela do garçom. O bloco de comandas é o mesmo que o gerente vê na aba
// "Comandas" — por isso vive em widgets/order-board e não aqui.
export default function PdvPage() {
  return <OrderBoard />;
}
