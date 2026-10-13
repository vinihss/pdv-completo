/**
 * Port do catálogo — produtos, categorias, grupos de produção e mesas.
 *
 * Contrato CONGELADO: os use cases falam com esta interface; o adapter Postgres
 * (`src/infra/db/repositories/catalog.repository.ts`) traduz para Drizzle/schema.
 */
import type { Id, Page, PageQuery } from "./shared.js";

/** ADIÇÃO (Onda 3A — catálogo): categoria do produto. */
export interface CategoryRecord {
  id: Id;
  name: string;
  displayOrder: number;
  active: boolean;
  createdAt: string;
}

/** ADIÇÃO (Onda 3A — catálogo): grupo de produção (estação da cozinha). */
export interface KitchenGroupRecord {
  id: Id;
  name: string;
  displayOrder: number;
  active: boolean;
  createdAt: string;
}

export interface ProductRecord {
  id: Id;
  categoryId: Id | null;
  kitchenGroupId: Id | null;
  name: string;
  description: string;
  price: number;
  /** JSON string — o parse para `VariationGroup[]` é do use case (domínio). */
  variations: string;
  /** Curadoria da vitrine pública (§04): produto marcado aparece na seção "Destaques". */
  featured: boolean;
  /** Configuração de estoque (baseline 0001): custo unitário (margem). */
  costPrice: number;
  /** Configuração de estoque: saldo mínimo antes de alertar. */
  lowStockThreshold: number;
  /** Configuração de estoque: se o saldo é rastreado no ledger. */
  trackStock: boolean;
  /** Unidade de medida (baseline 0001), ex.: "un", "kg". */
  unit: string;
  active: boolean;
  imagePath: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * ADIÇÃO (Onda 2): mesa do salão (`restaurant_table`), usada pelo hub de
 * pedidos (claim atômico na abertura, "Mesa 3" no alerta, GET /tables).
 */
export interface TableRecord {
  id: Id;
  number: string;
  status: "free" | "occupied" | "closing";
  createdAt: string;
}

/**
 * ADIÇÃO (Onda 2): produto do ponto de vista do LANÇAMENTO de item — o
 * `ProductRecord` do catálogo não traz snapshot de custo, rastreamento de
 * estoque nem threshold, que `addItemsUsecase`/`registerStockMovementUsecase`
 * precisam. Campo a campo, é o que `addItems` lê de `products`.
 */
export interface OrderingProductRecord {
  id: Id;
  name: string;
  price: number;
  costPrice: number;
  active: boolean;
  imagePath: string | null;
  kitchenGroupId: Id | null;
  trackStock: boolean;
  lowStockThreshold: number;
}

export interface CatalogRepository {
  listProducts(
    query: PageQuery & { categoryId?: Id; active?: boolean; search?: string; sort?: string },
  ): Promise<Page<ProductRecord>>;
  findProduct(id: Id): Promise<ProductRecord | null>;
  /**
   * `input.id` presente = update; ausente = create. Create exige
   * `name`/`price` (validados em runtime — o update é parcial,
   * então ambos são opcionais no tipo). Defaults de criação =
   * mesmos de `createProductUsecase`.
   */
  saveProduct(input: Partial<ProductRecord> & { id?: Id }): Promise<ProductRecord>;
  /** Categorias em ordem de exibição (linha inteira — a listagem expõe `createdAt`). */
  listCategories(): Promise<CategoryRecord[]>;
  /** Grupos de produção em ordem de exibição (linha inteira). */
  listKitchenGroups(): Promise<KitchenGroupRecord[]>;

  // ---------- ADIÇÕES (Onda 2 — hub de pedidos) ----------
  /** Mesa (restaurant_table) por id — abertura de comanda e alerta "Mesa N". */
  findTable(id: Id): Promise<TableRecord | null>;
  /** Mesas em ordem de número (GET /tables). */
  listTables(): Promise<TableRecord[]>;
  /** Lote de mesas por ids (hidratação da listagem de comandas). */
  listTablesByIds(ids: Id[]): Promise<TableRecord[]>;
  /**
   * Claim atômico da mesa para abrir comanda: UPDATE condicional
   * `status = 'free'` → `occupied`. Devolve `false` quando nenhuma linha foi
   * alterada (mesa inexistente OU já ocupada) — a distinção 404/409 é do use
   * case (`findTable` em seguida), para não reintroduzir a corrida.
   */
  tryClaimTable(tableId: Id): Promise<boolean>;
  /** Libera a mesa (fechamento/cancelamento da comanda): volta para `free`. */
  releaseTable(tableId: Id): Promise<void>;
  /**
   * Produto com os campos que o LANÇAMENTO de item e o movimento manual de
   * estoque precisam (snapshot de preço/custo + rastreamento + estação).
   * `findProduct` não traz `trackStock`/`costPrice`/`lowStockThreshold`.
   */
  findProductForOrdering(id: Id): Promise<OrderingProductRecord | null>;

  // ---------- ADIÇÕES (Onda 3A — catálogo) ----------
  /** Categoria por id (validação antes de update/delete de produto). */
  findCategoryById(id: Id): Promise<CategoryRecord | null>;
  /** INSERT de categoria (`name`, `displayOrder`). */
  createCategory(input: { name: string; displayOrder?: number }): Promise<CategoryRecord>;
  /** UPDATE parcial de categoria (`name`, `displayOrder`, `active`). */
  updateCategory(id: Id, input: { name?: string; displayOrder?: number; active?: boolean }): Promise<CategoryRecord>;
  /** Exclusão real da categoria; produtos vinculados ficam com `category_id = null`. */
  deleteCategory(id: Id): Promise<void>;
  /** Grupo de produção por id. */
  findKitchenGroupById(id: Id): Promise<KitchenGroupRecord | null>;
  /** INSERT de grupo de produção. */
  createKitchenGroup(input: { name: string; displayOrder?: number }): Promise<KitchenGroupRecord>;
  /** UPDATE parcial de grupo de produção. */
  updateKitchenGroup(id: Id, input: { name?: string; displayOrder?: number; active?: boolean }): Promise<KitchenGroupRecord>;
  /** Exclusão real do grupo; produtos vinculados ficam com `kitchen_group_id = null`. */
  deleteKitchenGroup(id: Id): Promise<void>;
  /** Set de `active` do produto (`product_activated`/`product_deactivated`). */
  setProductActive(id: Id, active: boolean): Promise<ProductRecord>;
  /** UPDATE de `image_path` (foto do produto). */
  saveProductImage(id: Id, filename: string): Promise<ProductRecord>;
  /** Limpa `image_path` (foto removida). */
  clearProductImage(id: Id): Promise<ProductRecord>;
  /** Produtos ativos (menu público) — `active = true`, ordem alfabética. */
  listActiveProducts(): Promise<ProductRecord[]>;
  /** Categorias ativas (menu público) — ordem de exibição. */
  listActiveCategories(): Promise<Array<{ id: Id; name: string }>>;

  // ---------- ADIÇÕES (Onda 3 — self-service) ----------
  /**
   * Lote de produtos por ids (validação de variações do checkout): o
   * `checkout` confere cada linha contra `variations`/`name` do produto —
   * inexistente fica de fora e `addItems` responde 404 depois.
   */
  findProductsByIds(ids: Id[]): Promise<ProductRecord[]>;

  // ---------- ADIÇÃO (Onda financeiro — compras) ----------
  /**
   * Espelha o custo médio móvel vigente em `product.cost_price` (display).
   * O ledger continua a fonte da verdade; a coluna é leitura conveniente —
   * mesma disciplina do `payment_method` denormalizado.
   */
  setCostPrice(productId: Id, costPrice: number): Promise<void>;
}
