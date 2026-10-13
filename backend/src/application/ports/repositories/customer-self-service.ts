/**
 * Port do self-service do cliente — carrinho server-side e endereços.
 *
 * Contrato CONGELADO: os use cases falam com estas interfaces; o adapter
 * Postgres (`src/infra/db/repositories/customer-self-service.repository.ts`)
 * traduz para Drizzle/schema.
 */
import type { Id } from "./shared.js";

/**
 * ADIÇÃO (Onda 3 — self-service): carrinho server-side do cliente
 * (`customer_cart`, baseline 0001), chaveado pelo TELEFONE. Continuação do
 * pedido sem localStorage. O TTL/expiração e o parse do JSON ficam no use case
 * (rascunho); o adapter lê/grava a linha crua (itens = string JSON, como o
 * banco guarda).
 */
export interface CustomerCartRepository {
  /** Linha crua por telefone — null quando não existe (expiração é do use case). */
  findByPhone(phone: Id): Promise<{ items: string; expiresAt: string } | null>;
  /** Upsert por telefone (last-write-wins; o rascunho não tem idempotência). */
  upsert(input: { phone: Id; items: string; updatedAt: string; expiresAt: string }): Promise<void>;
  deleteByPhone(phone: Id): Promise<void>;
}

/**
 * ADIÇÃO (Onda 3 — self-service): endereço de cliente (`customer_address`).
 * O CEP cru (8 dígitos, já normalizado pelo use case), o limite de 3 por
 * cliente e a promoção de "padrão" são regras de use case — o adapter só
 * persiste as colunas reais (sem `latitude`/`longitude`, que não são
 * serializados hoje).
 */
export interface CustomerAddressRecord {
  id: Id;
  customerId: Id;
  label: string | null;
  cep: string | null;
  street: string;
  number: string;
  complement: string | null;
  neighborhood: string;
  city: string;
  state: string | null;
  reference: string | null;
  /**
   * ADIÇÃO (Onda 3 — entrega): georreferência usada só para o marker de
   * destino no mapa do entregador/gerente. Não é serializada na API.
   */
  latitude: number | null;
  longitude: number | null;
  isDefault: boolean;
  createdAt: string;
}

export interface CustomerAddressRepository {
  findById(id: Id): Promise<CustomerAddressRecord | null>;
  /** Todos os endereços do cliente (mesma consulta sem ordenação do `findMany` original). */
  listByCustomer(customerId: Id): Promise<CustomerAddressRecord[]>;
  /**
   * ADIÇÃO (Onda 3 — entrega): endereços de vários clientes em uma query — o
   * marker de destino do mapa resolve o endereço padrão por cliente (sem N+1).
   */
  listByCustomers(customerIds: Id[]): Promise<CustomerAddressRecord[]>;
  /** Mais antigo do cliente (`createdAt ASC`, LIMIT 1) — reassume o padrão na exclusão. */
  findOldestByCustomer(customerId: Id): Promise<CustomerAddressRecord | null>;
  create(input: {
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
  }): Promise<CustomerAddressRecord>;
  /** Zera `is_default` de todos os endereços do cliente (um padrão por cliente). */
  clearDefaults(customerId: Id): Promise<void>;
  setDefault(id: Id): Promise<void>;
  delete(id: Id): Promise<void>;
}
