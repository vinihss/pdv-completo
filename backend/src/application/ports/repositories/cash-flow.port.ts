import type { EntityId } from "../persistence.js";
export interface CashDrawer { id: EntityId; status: "open" | "closed"; openedAt: string }
export interface CashFlowRepository {
  findOpenDrawerForUpdate(): Promise<CashDrawer | null>;
  openDrawer(input: { openedBy: EntityId; openingAmountMinor: number }): Promise<CashDrawer>;
  recordMovement(input: { drawerId: EntityId; actorId: EntityId; type: string; amountMinor: number; note?: string }): Promise<void>;
  closeDrawer(input: { drawerId: EntityId; closedBy: EntityId; countedAmountMinor: number }): Promise<void>;
}
