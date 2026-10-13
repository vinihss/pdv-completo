/**
 * Port do caixa — gaveta (`cash_drawer`) e movimentos.
 *
 * Contrato CONGELADO: os use cases falam com esta interface; o adapter Postgres
 * (`src/infra/db/repositories/cash-flow.repository.ts`) traduz para
 * Drizzle/schema.
 */
import type { CashMovementKind, Id, PageQuery } from "./shared.js";

// ---------- ADIÇÃO (Onda cash-flow): records de gaveta e movimento ----------

/** Linha completa de `cash_drawer` (todas as colunas do schema). */
export interface CashDrawerRecord {
  id: Id;
  status: "open" | "closed";
  openedAt: string;
  openedBy: Id;
  openingAmount: number;
  note: string | null;
  closedAt: string | null;
  closedBy: Id | null;
  closingExpected: number | null;
  closingCounted: number | null;
  closingDifference: number | null;
  closingNote: string | null;
  /** JSON string (mesmo formato do banco) — o parse é do use case. */
  closingDenominations: string | null;
  closingJustification: string | null;
  closingApprovedBy: Id | null;
}

/** Linha de `cash_drawer_movement`. */
export interface CashMovementRecord {
  id: Id;
  drawerId: Id;
  type: CashMovementKind;
  amount: number;
  note: string | null;
  refOrderId: Id | null;
  createdBy: Id;
  createdAt: string;
  category: string;
}

/**
 * ADIÇÃO (Onda cash-flow): pagamento em dinheiro confirmado na janela da
 * sessão — a fonte das ENTRADAS do caixa (`order_payment` é a fonte da
 * verdade). Mesma query de `cashPaymentsBetween`: method='cash' AND confirmed
 * AND `confirmed_at` BETWEEN [from, to], sem JOIN (o resumo só soma/contagem).
 */
export interface CashPaymentRecord {
  orderId: Id;
  amount: number;
  received: number | null;
  change: number | null;
  confirmedAt: string | null;
}

/**
 * ADIÇÃO (Onda cash-flow): linha do detalhe de vendas em dinheiro
 * (`GET /cash-drawer/:id`) — mesmo JOIN de `order_payment` × `order` ×
 * `restaurant_table` da query original; o rótulo "Mesa N"/tabLabel é montado
 * pelo use case.
 */
export interface CashSaleRecord {
  orderId: Id;
  tabLabel: string | null;
  tableNumber: string | null;
  amount: number;
  received: number | null;
  change: number | null;
  confirmedAt: string | null;
}

/**
 * ADIÇÃO (Onda cash-flow): persistência da gaveta — a ONDA 2 tinha só o
 * mínimo para `order`/`refund` (findOpenForUpdate/open/recordMovement); a
 * migração de `cash-flow.usecases` completou as leituras (current/detalhe/
 * listagem/resumo) e o fechamento.
 */
export interface CashFlowRepository {
  /** Gaveta aberta SEM lock (`GET /cash-drawer/current`). */
  findOpen(): Promise<CashDrawerRecord | null>;
  /**
   * SELECT ... FOR UPDATE da gaveta aberta (mesma trava de linha de
   * `findOpenDrawerTxForUpdate`): sangria/suprimento/fechamento e o pagamento
   * em dinheiro confirmado validam o saldo sob o lock de linha.
   */
  findOpenForUpdate(): Promise<CashDrawerRecord | null>;
  /**
   * Abre a gaveta. A checagem "já existe aberta" + o índice único parcial
   * `uq_cash_drawer_single_open` replicam `openCashDrawerUsecase` (a corrida em
   * duas requisições vira o mesmo 409, não uma segunda gaveta). O `openedAt`
   * chega ISO 8601 UTC explícito (comparação lexicográfica com
   * `order_payment.confirmed_at`); audit/outbox são do use case.
   */
  open(input: {
    actorId: Id;
    openingAmount: number;
    note?: string | null;
    openedAt: string;
  }): Promise<CashDrawerRecord>;
  /**
   * Sangria/suprimento. ADIÇÃO (Onda 2): `refOrderId` (coluna real
   * `ref_order_id` — estorno de comanda cancelada rastreia a origem) e o
   * retorno com id/amount (o audit/outbox do cancelamento publicam
   * `movementId`/`amount` gravados). ADIÇÃO (Onda cash-flow): `category`
   * (default "outros" do schema quando ausente) e o retorno vira a linha
   * completa (o use case serializa `note`/`category`/`createdAt`).
   */
  recordMovement(input: {
    drawerId: Id;
    actorId: Id;
    type: CashMovementKind;
    amount: number;
    note?: string;
    refOrderId?: Id | null;
    category?: string;
  }): Promise<CashMovementRecord>;
  /**
   * Fechamento: grava status + os campos de conferência JÁ calculados pelo use
   * case (`closing_expected`/`counted`/`difference`/denominações/justificativa/
   * aprovador) e devolve a linha atualizada.
   */
  close(input: {
    drawerId: Id;
    closedBy: Id;
    closedAt: string;
    closingExpected: number;
    closingCounted: number;
    closingDifference: number;
    closingNote: string | null;
    closingDenominations: string | null;
    closingJustification: string | null;
    closingApprovedBy: Id | null;
  }): Promise<CashDrawerRecord>;
  /** Gaveta por id (`GET /cash-drawer/:id`). */
  findById(id: Id): Promise<CashDrawerRecord | null>;
  /** Listagem paginada `openedAt DESC` (`GET /cash-drawer`). */
  list(query: PageQuery): Promise<CashDrawerRecord[]>;
  /**
   * Sessões que INTERSECTAM `[from, to]`: não fecharam antes de `from`
   * (`closed_at` NULL conta) nem abriram depois de `to`, `openedAt DESC`
   * (`GET /cash-drawer/summary`).
   */
  listIntersecting(from: string, to: string): Promise<CashDrawerRecord[]>;
  /** Movimentos da gaveta, mais recentes primeiro (`createdAt DESC`). */
  listMovements(drawerId: Id): Promise<CashMovementRecord[]>;
  /** Pagamentos em dinheiro confirmados na janela (resumo de saldo). */
  listCashPaymentsBetween(from: string, to: string): Promise<CashPaymentRecord[]>;
  /** Vendas em dinheiro confirmadas na janela, com mesa resolvida (detalhe). */
  listCashSalesBetween(from: string, to: string): Promise<CashSaleRecord[]>;
}
