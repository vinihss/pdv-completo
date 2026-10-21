import { eq, inArray } from "drizzle-orm";
import type { Tx } from "../client.js";
import { customerAddresses, customerCarts } from "../schema.js";
import { Errors } from "../../../domain/errors.js";
import type {
  CustomerAddressRecord,
  CustomerAddressRepository,
  CustomerCartRepository,
  Id,
} from "../../../application/ports/repositories.js";

// =====================================================================
// Self-service — carrinho e endereços (Onda 3)
// =====================================================================

/**
 * Carrinho server-side do cliente (`customer_cart`). Traduz 1:1 o acesso
 * Drizzle do antigo `cart.usecases` — o parse defensivo do JSON e a decisão de
 * expiração/purga ficam no use case (o adapter devolve a linha crua).
 */
export class PostgresCustomerCartRepository implements CustomerCartRepository {
  constructor(private readonly tx: Tx) {}

  async findByPhone(phone: Id): Promise<{ items: string; expiresAt: string } | null> {
    const row = await this.tx.query.customerCarts.findFirst({ where: eq(customerCarts.phone, phone) });
    return row ? { items: row.items, expiresAt: row.expiresAt } : null;
  }

  /** Upsert por telefone — mesmo `onConflictDoUpdate` de `saveCustomerCartUsecase`. */
  async upsert(input: { phone: Id; items: string; updatedAt: string; expiresAt: string }): Promise<void> {
    await this.tx
      .insert(customerCarts)
      .values({
        phone: input.phone,
        items: input.items,
        updatedAt: input.updatedAt,
        expiresAt: input.expiresAt,
      })
      .onConflictDoUpdate({
        target: [customerCarts.tenantId, customerCarts.phone],
        set: { items: input.items, updatedAt: input.updatedAt, expiresAt: input.expiresAt },
      });
  }

  async deleteByPhone(phone: Id): Promise<void> {
    await this.tx.delete(customerCarts).where(eq(customerCarts.phone, phone));
  }
}

function toCustomerAddressRecord(a: typeof customerAddresses.$inferSelect): CustomerAddressRecord {
  return {
    id: a.id,
    customerId: a.customerId,
    label: a.label,
    cep: a.cep,
    street: a.street,
    number: a.number,
    complement: a.complement,
    neighborhood: a.neighborhood,
    city: a.city,
    state: a.state,
    reference: a.reference,
    latitude: a.latitude,
    longitude: a.longitude,
    isDefault: a.isDefault,
    createdAt: a.createdAt,
  };
}

/**
 * Endereços de cliente (`customer_address`). Mesma semântica de
 * `customer-address.usecases`, SEM as regras de domínio (limite de 3, um
 * padrão por cliente, promoção do mais antigo) — essas moram no use case.
 */
export class PostgresCustomerAddressRepository implements CustomerAddressRepository {
  constructor(private readonly tx: Tx) {}

  async findById(id: Id): Promise<CustomerAddressRecord | null> {
    const row = await this.tx.query.customerAddresses.findFirst({ where: eq(customerAddresses.id, id) });
    return row ? toCustomerAddressRecord(row) : null;
  }

  async listByCustomer(customerId: Id): Promise<CustomerAddressRecord[]> {
    const rows = await this.tx.query.customerAddresses.findMany({
      where: eq(customerAddresses.customerId, customerId),
    });
    return rows.map(toCustomerAddressRecord);
  }

  /** ADIÇÃO (Onda 3 — entrega): endereços de vários clientes em uma query (marker de destino). */
  async listByCustomers(customerIds: Id[]): Promise<CustomerAddressRecord[]> {
    if (customerIds.length === 0) return [];
    const rows = await this.tx.query.customerAddresses.findMany({
      where: inArray(customerAddresses.customerId, customerIds),
    });
    return rows.map(toCustomerAddressRecord);
  }

  async findOldestByCustomer(customerId: Id): Promise<CustomerAddressRecord | null> {
    const rows = await this.tx.query.customerAddresses.findMany({
      where: eq(customerAddresses.customerId, customerId),
      orderBy: (a, { asc: asc_ }) => asc_(a.createdAt),
      limit: 1,
    });
    return rows[0] ? toCustomerAddressRecord(rows[0]) : null;
  }

  async create(input: {
    customerId: Id;
    label?: string | null;
    cep?: string | null;
    street: string;
    number: string;
    complement?: string | null;
    neighborhood: string;
    city: string;
    state?: string | null;
    reference?: string | null;
    isDefault: boolean;
  }): Promise<CustomerAddressRecord> {
    const [row] = await this.tx
      .insert(customerAddresses)
      .values({
        customerId: input.customerId,
        label: input.label ?? null,
        cep: input.cep ?? null,
        street: input.street,
        number: input.number,
        complement: input.complement ?? null,
        neighborhood: input.neighborhood,
        city: input.city,
        state: input.state ?? null,
        reference: input.reference ?? null,
        isDefault: input.isDefault,
      })
      .returning();
    if (!row) throw Errors.validationFailed({ field: "street" });
    return toCustomerAddressRecord(row);
  }

  async clearDefaults(customerId: Id): Promise<void> {
    await this.tx
      .update(customerAddresses)
      .set({ isDefault: false })
      .where(eq(customerAddresses.customerId, customerId));
  }

  async setDefault(id: Id): Promise<void> {
    await this.tx.update(customerAddresses).set({ isDefault: true }).where(eq(customerAddresses.id, id));
  }

  async delete(id: Id): Promise<void> {
    await this.tx.delete(customerAddresses).where(eq(customerAddresses.id, id));
  }
}

// ---------------------------------------------------------------------------
