/**
 * Adapter do port `CustomerNotifier` (application/ports/effects.ts) — ONDA 2.
 *
 * Notificação WhatsApp de status AO CLIENTE (ex.: `notifyReady` quando a
 * cozinha termina o último item de um pedido self-service). O port recebe
 * `orderId`; este adapter delega ao notifier de integração, que resolve o
 * telefone do cliente e envia — fire-and-forget (o caller decide se espera
 * ou não; em geral é pós-commit, fora da transação de domínio).
 */
import type { Id } from "../../application/ports/repositories.js";
import type { CustomerNotifier } from "../../application/ports/effects.js";
import { notifyReady } from "./whatsapp.notifier.js";

export class CustomerNotifierAdapter implements CustomerNotifier {
  async notifyReady(orderId: Id): Promise<void> {
    await notifyReady(orderId);
  }
}
