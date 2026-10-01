import { eq } from "drizzle-orm";
import { db } from "../../infra/db/client.js";
import { customers, customerAddresses } from "../../infra/db/schema.js";
import { Errors } from "../../domain/errors.js";

const MAX_ADDRESSES_PER_CUSTOMER = 3;

/**
 * CEP para os 8 dígitos crus, ou null quando não informado.
 *
 * Aceita com ou sem máscara ("01310-100" e "01310100" viram o mesmo valor):
 * a tela mascara, o banco não. Vazio é null e não erro — o campo é
 * conveniência de preenchimento, e quem digita o endereço à mão nunca
 * preenche o CEP (ver a migration 0005).
 *
 * Só valida formato. Não consulta ViaCEP: o backend não pode depender de um
 * terceiro em rede dentro de uma escrita, e o CEP não bloqueia nada. A busca
 * fica no frontend (shared/api/cep.js), que trata CEP inexistente na UX.
 */
export function normalizeCep(cep: string | null | undefined): string | null {
  const digits = (cep ?? "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length !== 8) throw Errors.validationFailed({ field: "cep" });
  return digits;
}

function serializeAddress(a: typeof customerAddresses.$inferSelect) {
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
    reference: a.reference,
    isDefault: a.isDefault,
    createdAt: a.createdAt,
  };
}

/**
 * Texto único formatado pra exibição/impressão — usado como snapshot em
 * delivery.address. Nunca persistido de volta nos campos estruturados.
 *
 * O `cep` entra no tipo mas NÃO no texto: este snapshot é o que o entregador
 * lê (frontend/src/pages/courier/CourierApp.jsx) e o que a bobina imprime em
 * largura fixa (printer/daemon/main.go, seção "delivery"). Empilhar "CEP:
 * 01310100" no fim da linha quebraria a bobina e poluiria a tela sem pedido
 * de ninguém — o CEP fica estruturado na API para quem precisar dele.
 */
export function formatAddress(a: {
  street: string;
  number: string;
  complement?: string | null;
  neighborhood: string;
  city: string;
  reference?: string | null;
  cep?: string | null;
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
  label?: string | null;
  cep?: string | null;
  street: string;
  number: string;
  complement?: string | null;
  neighborhood: string;
  city: string;
  reference?: string | null;
  isDefault?: boolean;
}) {
  const customer = await db.query.customers.findFirst({ where: eq(customers.id, input.customerId) });
  if (!customer) throw Errors.notFound("Cliente");

  const existing = await db.query.customerAddresses.findMany({
    where: eq(customerAddresses.customerId, input.customerId),
  });
  if (existing.length >= MAX_ADDRESSES_PER_CUSTOMER) throw Errors.addressLimitReached();

  // Valida antes da transação: CEP inválido não pode consumir um dos 3 slots
  // nem deixar o cliente com "endereço salvo" que não é.
  const cep = normalizeCep(input.cep);

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
        cep,
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

// ---------- Manutenção de endereço (gerente/caixa) ----------

export async function setDefaultCustomerAddressUsecase(customerId: string, addressId: string) {
  const customer = await db.query.customers.findFirst({ where: eq(customers.id, customerId) });
  if (!customer) throw Errors.notFound("Cliente");
  const address = await db.query.customerAddresses.findFirst({ where: eq(customerAddresses.id, addressId) });
  if (!address || address.customerId !== customerId) throw Errors.notFound("Endereço");

  // Um padrão por cliente: limpa os outros antes de marcar o escolhido.
  await db.transaction(async (tx) => {
    await tx.update(customerAddresses).set({ isDefault: false }).where(eq(customerAddresses.customerId, customerId));
    await tx.update(customerAddresses).set({ isDefault: true }).where(eq(customerAddresses.id, addressId));
  });
}

export async function deleteCustomerAddressUsecase(customerId: string, addressId: string) {
  const customer = await db.query.customers.findFirst({ where: eq(customers.id, customerId) });
  if (!customer) throw Errors.notFound("Cliente");
  const address = await db.query.customerAddresses.findFirst({ where: eq(customerAddresses.id, addressId) });
  if (!address || address.customerId !== customerId) throw Errors.notFound("Endereço");

  await db.delete(customerAddresses).where(eq(customerAddresses.id, addressId));

  // Se o removido era o padrão e sobraram endereços, o mais antigo vira padrão.
  if (address.isDefault) {
    const remaining = await db.query.customerAddresses.findMany({
      where: eq(customerAddresses.customerId, customerId),
      orderBy: (a, { asc }) => asc(a.createdAt),
      limit: 1,
    });
    if (remaining[0]) {
      await db.update(customerAddresses).set({ isDefault: true }).where(eq(customerAddresses.id, remaining[0].id));
    }
  }
}
