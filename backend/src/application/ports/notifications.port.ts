import type { EntityId, JsonValue } from "./persistence.js";

export interface NotificationMessage {
  recipient: string;
  template: string;
  data: JsonValue;
  correlationId?: EntityId;
}
export interface OrderNotifier {
  send(message: NotificationMessage): Promise<void>;
}
export interface PrinterPort {
  printOrder(input: { orderId: EntityId; copy?: "customer" | "kitchen" }): Promise<void>;
}
export interface MailerPort {
  send(input: { to: string; subject: string; text: string; html?: string }): Promise<void>;
}
