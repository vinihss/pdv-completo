/**
 * Adapter do port `OrderPrinter` (application/ports/effects.ts) — ONDA 2.
 *
 * O port recebe só `orderId` (a application não conhece o layout do cupom nem
 * o formato do DaemonPrintRequest). Este adapter delega ao use case de
 * impressão de integração, que monta o cupom (mapper) e chama o client —
 * mesma semântica fire-and-forget de sempre (o client nunca lança; o daemon
 * tem retry próprio).
 */
import type { Id } from "../../application/ports/repositories.js";
import type { OrderPrinter } from "../../application/ports/effects.js";
import { printCourierOrder, printKitchenOrder } from "./printer.usecases.js";

export class OrderPrinterAdapter implements OrderPrinter {
  async printKitchenOrder(orderId: Id): Promise<void> {
    await printKitchenOrder(orderId);
  }

  async printCourierOrder(orderId: Id): Promise<void> {
    await printCourierOrder(orderId);
  }
}
