// Endereços de cliente (self-service) — ONDA 3 da refatoração arquitetural.
//
// Este arquivo é uma FACTORY pura (`createCustomerAddressUsecases(deps)`):
// nenhuma importação de infra/integrations/config nem Drizzle. A persistência
// passa pelo `uow.run`/`session.customerAddresses` + `session.customers`. A
// composition root que liga os adapters concretos é
// `src/infra/composition/default-usecases.ts`.
//
// `normalizeCep`/`formatAddress` continuam exportados como helpers PUROS (sem
// deps) — consumidos por `order-intake.usecase` e pela composição de snapshots
// de entrega. Não precisam de factory.
//
// APROXIMAÇÃO DE JANELA (mesma da Onda 2): o `db.transaction` que hoje envolve
// só a escrita (clearDefaults + insert) vira um único `uow.run` que também lê
// cliente/endereços. Sob READ COMMITTED o resultado é o mesmo; a validação de
// CEP continua abortando por `throw` antes de qualquer INSERT.
import type { TenantUnitOfWork } from "../ports/unit-of-work.js";
import type { TenantContext } from "../ports/tenant-context.js";
import type { CustomerAddressRecord } from "../ports/repositories.js";
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

function serializeAddress(a: CustomerAddressRecord) {
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
    state: a.state ?? null,
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
 * largura fixa (daemon de impressão, seção "delivery"). Empilhar "CEP:
 * 01310100" no fim da linha quebraria a bobina e poluiria a tela sem pedido
 * de ninguém — o CEP fica estruturado na API para quem precisar dele.
 */
export function formatAddress(a: {
  street: string;
  number: string;
  complement?: string | null;
  neighborhood: string;
  city: string;
  state?: string | null;
  reference?: string | null;
  cep?: string | null;
}): string {
  const line1 = `${a.street}, ${a.number}${a.complement ? ` - ${a.complement}` : ""}`;
  const line2 = `${a.neighborhood}, ${a.city}${a.state ? ` - ${a.state}` : ""}`;
  const line3 = a.reference ? ` (${a.reference})` : "";
  return `${line1} - ${line2}${line3}`;
}

export interface CustomerAddressUsecasesDeps {
  uow: TenantUnitOfWork;
  /** Resolvido a cada chamada (ALS/request corrente) — nunca memoizado. */
  tenant: () => TenantContext;
}

/**
 * As use cases de endereço/cliente-self-service, com as MESMAS assinaturas de
 * antes (sem o `deps`). Os nomes legados são re-exportados por
 * `infra/composition/default-usecases.ts`.
 */
export function createCustomerAddressUsecases(deps: CustomerAddressUsecasesDeps) {
  return {
    // ---------- POST /public/customers/lookup ----------
    async lookupCustomerByPhoneUsecase(phone: string) {
      return deps.uow.run(deps.tenant(), async (session) => {
        const customer = await session.customers.findByPhone(phone);
        if (!customer) return null;
        const addresses = await session.customerAddresses.listByCustomer(customer.id);
        return {
          customerId: customer.id,
          name: customer.name,
          addresses: addresses.map(serializeAddress),
        };
      });
    },

    // ---------- POST /public/customers ----------
    // Nome deliberadamente diferente de customer.usecases.ts#createCustomerUsecase
    // (cadastro manual do balcão, sem checar duplicidade de telefone) — aqui o
    // telefone É a chave de identificação do fluxo self-service, então precisa
    // ser único.
    async createSelfServiceCustomerUsecase(input: { name: string; phone: string }) {
      return deps.uow.run(deps.tenant(), async (session) => {
        // Unicidade aplicada em usecase — customer.phone tem índice, mas não
        // constraint UNIQUE no schema atual (§04, mesmo padrão de address_limit).
        const existing = await session.customers.findByPhone(input.phone);
        if (existing) throw Errors.duplicatePhone();

        const created = await session.customers.save({ name: input.name, phone: input.phone });
        return { customerId: created.id };
      });
    },

    // ---------- POST /public/customers/:id/addresses ----------
    async addCustomerAddressUsecase(input: {
      customerId: string;
      label?: string | null;
      cep?: string | null;
      street: string;
      number: string;
      complement?: string | null;
      neighborhood: string;
      city: string;
      state?: string | null;
      reference?: string | null;
      isDefault?: boolean;
    }) {
      return deps.uow.run(deps.tenant(), async (session) => {
        const customer = await session.customers.findById(input.customerId);
        if (!customer) throw Errors.notFound("Cliente");

        const existing = await session.customerAddresses.listByCustomer(input.customerId);
        if (existing.length >= MAX_ADDRESSES_PER_CUSTOMER) throw Errors.addressLimitReached();

        // Valida antes de qualquer escrita: CEP inválido não pode consumir um
        // dos 3 slots nem deixar o cliente com "endereço salvo" que não é.
        const cep = normalizeCep(input.cep);

        // Primeiro endereço do cliente vira padrão automaticamente, mesmo sem pedir.
        const isDefault = input.isDefault ?? existing.length === 0;

        if (isDefault) {
          await session.customerAddresses.clearDefaults(input.customerId);
        }
        const created = await session.customerAddresses.create({
          customerId: input.customerId,
          label: input.label ?? null,
          cep,
          street: input.street,
          number: input.number,
          complement: input.complement ?? null,
          neighborhood: input.neighborhood,
          city: input.city,
          state: input.state ?? null,
          reference: input.reference ?? null,
          isDefault,
        });
        return serializeAddress(created);
      });
    },

    async listCustomerAddressesUsecase(customerId: string) {
      return deps.uow.run(deps.tenant(), async (session) => {
        const addresses = await session.customerAddresses.listByCustomer(customerId);
        return addresses.map(serializeAddress);
      });
    },

    // ---------- Manutenção de endereço (gerente/caixa) ----------

    async setDefaultCustomerAddressUsecase(customerId: string, addressId: string) {
      await deps.uow.run(deps.tenant(), async (session) => {
        const customer = await session.customers.findById(customerId);
        if (!customer) throw Errors.notFound("Cliente");
        const address = await session.customerAddresses.findById(addressId);
        if (!address || address.customerId !== customerId) throw Errors.notFound("Endereço");

        // Um padrão por cliente: limpa os outros antes de marcar o escolhido.
        await session.customerAddresses.clearDefaults(customerId);
        await session.customerAddresses.setDefault(addressId);
      });
    },

    async deleteCustomerAddressUsecase(customerId: string, addressId: string) {
      await deps.uow.run(deps.tenant(), async (session) => {
        const customer = await session.customers.findById(customerId);
        if (!customer) throw Errors.notFound("Cliente");
        const address = await session.customerAddresses.findById(addressId);
        if (!address || address.customerId !== customerId) throw Errors.notFound("Endereço");

        await session.customerAddresses.delete(addressId);

        // Se o removido era o padrão e sobraram endereços, o mais antigo vira padrão.
        if (address.isDefault) {
          const remaining = await session.customerAddresses.findOldestByCustomer(customerId);
          if (remaining) await session.customerAddresses.setDefault(remaining.id);
        }
      });
    },
  };
}

export type CustomerAddressUsecases = ReturnType<typeof createCustomerAddressUsecases>;
