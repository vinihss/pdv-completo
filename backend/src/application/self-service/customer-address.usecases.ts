import { eq } from "drizzle-orm";
import { db } from "../../infra/db/client.js";
import { customers, customerAddresses } from "../../infra/db/schema.js";
import { Errors } from "../../domain/errors.js";

const MAX_ADDRESSES_PER_CUSTOMER = 3;

function serializeAddress(a: typeof customerAddresses.$inferSelect) {
  return {
    id: a.id,
    customerId: a.customerId,
    label: a.label,
    street: a.street,
    number: a.number,
    complement: a.complement,
    neighborhood: a.neighborhood,
    city: a.city,
    reference: a.reference,
    isDefault: a.isDefault,
    createdAt: a.createdAt,
  };
}

/**
 * Texto único formatado pra exibição/impressão — usado como snapshot em
 * delivery.address. Nunca persistido de volta nos campos estruturados.
 */
export function formatAddress(a: {
  street: string;
  number: string;
  complement?: string | null;
  neighborhood: string;
  city: string;
  reference?: string | null;
}): string {
  const line1 = `${a.street}, ${a.number}${a.complement ? ` - ${a.complement}` : ""}`;
  const line2 = `${a.neighborhood}, ${a.city}`;
  const line3 = a.reference ? ` (${a.reference})` : "";
  return `${line1} - ${line2}${line3}`;
}

// ---------- POST /public/customers/lookup ----------
export async function lookupCustomerByPhoneUsecase(phone: string) {
  const customer = await db.query.customers.findFirst({ where: eq(customers.phone, phone) });
  if (!customer) return null;
  const addresses = await db.query.customerAddresses.findMany({
    where: eq(customerAddresses.customerId, customer.id),
  });
  return {
    customerId: customer.id,
    name: customer.name,
    addresses: addresses.map(serializeAddress),
  };
}

// ---------- POST /public/customers ----------
// Nome deliberadamente diferente de customer.usecases.ts#createCustomerUsecase
// (cadastro manual do balcão, sem checar duplicidade de telefone) — aqui o
// telefone É a chave de identificação do fluxo self-service, então precisa
// ser único.
export async function createSelfServiceCustomerUsecase(input: { name: string; phone: string }) {
  // Unicidade aplicada em usecase — customer.phone tem índice, mas não
  // constraint UNIQUE no schema atual (§04, mesmo padrão de address_limit).
  const existing = await db.query.customers.findFirst({ where: eq(customers.phone, input.phone) });
  if (existing) throw Errors.duplicatePhone();

  const [created] = await db.insert(customers).values({ name: input.name, phone: input.phone }).returning();
  return { customerId: created.id };
}

// ---------- POST /public/customers/:id/addresses ----------
export async function addCustomerAddressUsecase(input: {
  customerId: string;
  label?: string;
  street: string;
  number: string;
  complement?: string;
  neighborhood: string;
  city: string;
  reference?: string;
  isDefault?: boolean;
}) {
  const customer = await db.query.customers.findFirst({ where: eq(customers.id, input.customerId) });
  if (!customer) throw Errors.notFound("Cliente");

  const existing = await db.query.customerAddresses.findMany({
    where: eq(customerAddresses.customerId, input.customerId),
  });
  if (existing.length >= MAX_ADDRESSES_PER_CUSTOMER) throw Errors.addressLimitReached();

  // Primeiro endereço do cliente vira padrão automaticamente, mesmo sem pedir.
  const isDefault = input.isDefault ?? existing.length === 0;

  const created = await db.transaction(async (tx) => {
    if (isDefault) {
      await tx
        .update(customerAddresses)
        .set({ isDefault: false })
        .where(eq(customerAddresses.customerId, input.customerId));
    }
    const [row] = await tx
      .insert(customerAddresses)
      .values({
        customerId: input.customerId,
        label: input.label ?? null,
        street: input.street,
        number: input.number,
        complement: input.complement ?? null,
        neighborhood: input.neighborhood,
        city: input.city,
        reference: input.reference ?? null,
        isDefault,
      })
      .returning();
    return row;
  });

  return serializeAddress(created);
}

export async function listCustomerAddressesUsecase(customerId: string) {
  const addresses = await db.query.customerAddresses.findMany({
    where: eq(customerAddresses.customerId, customerId),
  });
  return addresses.map(serializeAddress);
}
