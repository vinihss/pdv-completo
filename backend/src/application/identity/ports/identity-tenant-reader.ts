/**
 * Port de LEITURA por-tenant da identidade (docs/26 §4).
 *
 * O `account` é global, mas o vínculo é uma linha em `user` DENTRO do schema de
 * cada loja, e `companies` precisa da marca (`store_settings`) de cada uma. Quem
 * sabe entrar no escopo de cada schema (ALS + pool por tenant) é a infra — a
 * application só pergunta "quais empresas esta conta acessa?" e "qual é o
 * usuário desta conta nesta loja?".
 *
 * `findLinkedUser` devolve `null` para: slug desconhecido/suspenso, roteamento
 * multi-tenant desligado e slug não-default, schema não provisionado ou conta
 * sem linha `user` ATIVA ali. O use case traduz esse `null` para
 * `403 tenant_not_linked` — a distinção entre os motivos não pode vazar (§4).
 */
import type { Id } from "../../ports/repositories/shared.js";
import type { UserRole } from "../../ports/repositories/shared.js";

/** Empresa em que a conta tem vínculo — o que `POST /auth/session` devolve. */
export interface CompanySummary {
  slug: string;
  name: string;
  logoUrl: string | null;
  /** Nunca `null`: `store_settings.brand_color` tem default — o port espelha. */
  primaryColor: string | null;
}

export interface LinkedUserRecord {
  userId: Id;
  name: string;
  role: UserRole;
  photoPath: string | null;
}

export interface IdentityTenantReader {
  /**
   * Empresas ATIVAS em que a conta tem `user` ativo, com a marca de cada loja.
   * Inclui o tenant DEFAULT (a instalação de loja única não tem registry) além
   * dos ativos do registry — ver nota de implementação no adapter.
   */
  listCompaniesForAccount(accountId: Id): Promise<CompanySummary[]>;
  /** Usuário ativo da conta no tenant `slug` (para reconstruir os claims do JWT). */
  findLinkedUser(slug: string, accountId: Id): Promise<LinkedUserRecord | null>;
}
