/**
 * Port de clientes — cadastro e as comandas do cliente (detalhe/histórico).
 *
 * Contrato CONGELADO: os use cases falam com esta interface; o adapter Postgres
 * (`src/infra/db/repositories/customer.repository.ts`) traduz para
 * Drizzle/schema.
 */
import type { Id, OrderStatus, Page, PageQuery } from "../../ports/repositories/shared.js";

export interface CustomerRecord {
  id: Id;
  name: string;
  phone: string | null;
  email: string | null;
  /** CPF crudo (11 dígitos, sem máscara) — normalização é do use case. */
  cpf: string | null;
  notes: string | null;
  /** Só o basename (`<id>.<ext>`); o caminho público é do serializador. */
  photoPath: string | null;
  /** Soft-delete: manutenção desativa, não apaga (histórico de pedidos). */
  active: boolean;
  createdAt: string;
}

export interface CustomerRepository {
  findById(id: Id): Promise<CustomerRecord | null>;
  findByPhone(phone: string): Promise<CustomerRecord | null>;
  list(query: PageQuery & { search?: string; active?: boolean }): Promise<Page<CustomerRecord>>;
  /** `input.id` presente = update; ausente = create. Normalização (phone/email/cpf) fica no use case. */
  save(input: Partial<CustomerRecord> & Pick<CustomerRecord, "name">): Promise<CustomerRecord>;
  /** Soft-delete (seta `active=false`) — cliente tem histórico, nunca é apagado. */
  delete(id: Id): Promise<void>;
  /** ADIÇÃO (Onda 2): lote por ids (hidratação da listagem de comandas — sem N+1). */
  findByIds(ids: Id[]): Promise<CustomerRecord[]>;

  // ---------- ADIÇÕES (Onda 3C — customer.usecases) ----------
  /** Cliente por email exato (unicidade `uq_customer_email` — 400 no use case). */
  findByEmail(email: string): Promise<CustomerRecord | null>;
  /** Cliente por CPF exato (unicidade `uq_customer_cpf` — 400 no use case). */
  findByCpf(cpf: string): Promise<CustomerRecord | null>;
  /**
   * Busca leve do balcão (abrir comanda com cliente): só ATIVOS, ordem
   * alfabética, LIMIT 20, sem email — a manutenção completa é a `list`.
   */
  searchLight(search?: string): Promise<Array<Pick<CustomerRecord, "id" | "name" | "phone">>>;
  /**
   * Contagem de endereços por cliente em uma query agrupada. `customerIds`
   * vazio devolve mapa vazio; o mapa pode não ter a chave de um cliente sem
   * endereços (o use case trata como 0).
   */
  countAddressesByCustomer(customerIds: Id[]): Promise<Map<Id, number>>;
}

/**
 * ADIÇÃO (Onda 3C — customer.usecases): comanda em aberto do cliente no bloco
 * de detalhe — `tableNumber` resolvida por LEFT JOIN com `restaurant_table`.
 */
export interface CustomerOpenOrderRecord {
  id: Id;
  status: OrderStatus;
  openedAt: string;
  tabLabel: string | null;
  deliveryFee: number | null;
  tableNumber: string | null;
}

/**
 * ADIÇÃO (Onda 3C — customer.usecases): linha do histórico paginado do cliente
 * (`GET /customers/:id/orders`) — `tableNumber` resolvida por LEFT JOIN.
 */
export interface CustomerOrderHistoryRecord {
  id: Id;
  status: OrderStatus;
  openedAt: string;
  closedAt: string | null;
  tabLabel: string | null;
  paymentMethod: string | null;
  deliveryFee: number | null;
  tableNumber: string | null;
}
