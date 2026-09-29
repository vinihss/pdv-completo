# Manutenção de Banco de Dados — Agente

Guia para o agente realizar operações de manutenção no banco de produção do cliente Umami diretamente via Docker/PSQL.

## Acesso

```bash
# 1. Conectar na VPS
ssh <vps-host>

# 2. Encontrar o container do PostgreSQL
docker ps --format '{{.Names}}' | grep -i postgres

# 3. Executar psql dentro do container
docker exec -it <container-name> psql -U pdv -d pdv
```

Para operações em lote, o agente pode usar `docker exec` com `psql -c "SQL"` ou criar um arquivo SQL temporário e executá-lo com `docker exec -i <container> psql -U pdv -d pdv < script.sql`.

## Schema Resumido

O banco do Umami é uma instância deste mesmo PDV. Schema completo em `backend/migrations/0001_init.sql`.

### Tabelas Principais

| Tabela | Descrição | Coluna de soft-delete |
|---|---|---|
| `category` | Categorias de produtos | `active` (boolean) |
| `product` | Produtos do cardápio | `active` (boolean) |
| `kitchen_group` | Grupos de cozinha | `active` (boolean) |
| `customer` | Clientes | `active` (boolean) |
| `user` | Usuários da equipe | `active` (boolean) |
| `supplier` | Fornecedores | `active` (boolean) |
| `order` | Comandas | `status` (enum: open/closed/cancelled) |
| `order_item` | Itens de comanda | `status` (enum: ordered/ready/delivered/cancelled) |
| `restaurant_table` | Mesas físicas | `status` (enum: free/occupied/closing) |

### Relacionamentos Críticos

```
category 1───* product *───1 kitchen_group
                    │
                    * (ON DELETE RESTRICT)
                    │
              order_item *───1 order *───1 restaurant_table
                    │              │
                    │              *───1 customer
                    │
stock_movement (ledger) *───1 product
```

### Convenções Importantes

| Convenção | Detalhe |
|---|---|
| **Soft-delete** | Nunca usar `DELETE` em entidades de domínio. Usar `UPDATE ... SET active = false` |
| **Timestamps** | TEXT em ISO-8601 UTC (`YYYY-MM-DDTHH:MM:SS.mmmZ`) |
| **IDs** | TEXT, gerados via `crypto.randomUUID()` na aplicação |
| **JSON** | Armazenado como TEXT (string JSON) |
| **Money/Quantity** | REAL (double precision) |
| **Enums** | Enums nativos do PostgreSQL |
| **Estoque** | Ledger: saldo = SUM(`quantity_delta`) de `stock_movement` |

## Regras de Manutenção

### Operações Permitidas

| Operação | Permissão | Confirmação |
|---|---|---|
| `SELECT` | Livre | Não precisa |
| `UPDATE` | Permitida | Em lote |
| `INSERT` | Permitida | Em lote |
| `DELETE` | **Apenas com justificativa** | Em lote + justificativa |

### Regras de Ouro

1. **Sempre usar transações** para operações de escrita: `BEGIN; ... COMMIT;`
2. **Nunca hard-delete** entidades de domínio (category, product, customer, user, supplier). Usar soft-delete (`active = false`)
3. **Sempre verificar antes**: rodar `SELECT` para confirmar o que será afetado
4. **Confirmar em lote**: mostrar todas as operações planejadas e pedir uma única confirmação
5. **Backup antes de operações destrutivas**: se possível, criar snapshot antes de DELETEs
6. **Respeitar FKs**: verificar referências antes de alterar/deletar registros

## Fluxo de Trabalho

### 1. Consulta (SELECT)

```bash
# Listar produtos de uma categoria
docker exec <container> psql -U pdv -d pdv -c "
  SELECT p.id, p.name, p.price, p.active
  FROM product p
  JOIN category c ON p.category_id = c.id
  WHERE c.name = 'Nome da Categoria'
  ORDER BY p.name;
"
```

### 2. Operação de Escrita (UPDATE/INSERT/DELETE)

**Passo 1 — Planejar**: escrever todas as operações SQL em um arquivo temporário.

**Passo 2 — Mostrar plano**: apresentar ao usuário o que será afetado (SELECTs de verificação + operações planejadas).

**Passo 3 — Confirmar**: pedir confirmação única para o lote.

**Passo 4 — Executar**: rodar o arquivo SQL dentro de transação.

**Passo 5 — Verificar**: rodar SELECTs de confirmação.

## Exemplos Práticos

### Exemplo 1: Listar produtos da categoria "Porções"

```sql
SELECT p.id, p.name, p.price, p.active, p.track_stock
FROM product p
JOIN category c ON p.category_id = c.id
WHERE c.name = 'Porções'
ORDER BY p.display_order, p.name;
```

### Exemplo 2: Renomear categoria

```sql
-- Verificar
SELECT id, name FROM category WHERE name = 'Nome Antigo';

-- Renomear
BEGIN;
UPDATE category SET name = 'Nome Novo' WHERE name = 'Nome Antigo';
COMMIT;

-- Confirmar
SELECT id, name FROM category WHERE name = 'Nome Novo';
```

### Exemplo 3: Mover produtos para outra categoria

```sql
-- Verificar produtos atuais
SELECT p.id, p.name, c.name AS categoria_atual
FROM product p
JOIN category c ON p.category_id = c.id
WHERE p.name IN ('Produto X', 'Produto Y', 'Produto Z');

-- Verificar categoria de destino
SELECT id, name FROM category WHERE name = 'Categoria B';

-- Mover
BEGIN;
UPDATE product p
SET category_id = (SELECT id FROM category WHERE name = 'Categoria B')
WHERE p.name IN ('Produto X', 'Produto Y', 'Produto Z');
COMMIT;

-- Confirmar
SELECT p.id, p.name, c.name AS categoria
FROM product p
JOIN category c ON p.category_id = c.id
WHERE p.name IN ('Produto X', 'Produto Y', 'Produto Z');
```

### Exemplo 4: Desativar produto (soft-delete)

```sql
-- Verificar
SELECT id, name, active FROM product WHERE name = 'Produto Z';

-- Desativar
BEGIN;
UPDATE product SET active = false WHERE name = 'Produto Z';
COMMIT;
```

### Exemplo 5: Atualizar preço de produtos

```sql
-- Verificar preços atuais
SELECT p.id, p.name, p.price
FROM product p
WHERE p.name IN ('Produto X', 'Produto Y');

-- Atualizar
BEGIN;
UPDATE product SET price = 25.90 WHERE name = 'Produto X';
UPDATE product SET price = 18.50 WHERE name = 'Produto Y';
COMMIT;
```

## Comandos PSQL Úteis

```bash
# Listar tabelas
\dt

# Descrever tabela
\d product

# Listar categorias
SELECT id, name, display_order, active FROM category ORDER BY display_order;

# Listar produtos com categoria
SELECT p.name, p.price, c.name AS categoria, p.active
FROM product p
LEFT JOIN category c ON p.category_id = c.id
ORDER BY c.name, p.name;

# Buscar produto por nome (parcial)
SELECT id, name, price FROM product WHERE name ILIKE '%frango%';

# Verificar estoque de um produto
SELECT p.name, COALESCE(SUM(sm.quantity_delta), 0) AS saldo
FROM product p
LEFT JOIN stock_movement sm ON sm.product_id = p.id
WHERE p.name = 'Produto X'
GROUP BY p.name;

# Sair do psql
\q
```

## Avisos e Cuidados

| Cuidado | Por quê |
|---|---|
| Nunca `DELETE FROM product` | Quebra FK de `order_item` e `stock_movement` |
| Nunca `DELETE FROM category` | FK de `product` usa `ON DELETE SET NULL` (produtos ficam sem categoria) |
| Nunca `DELETE FROM customer` | Tem histórico de pedidos |
| Nunca `DELETE FROM user` | Tem histórico de ações (audit_log, orders, etc.) |
| Cuidado com `UPDATE sem WHERE` | Afeta todas as linhas da tabela |
| Verificar `updated_at` | Algumas tabelas têm essa coluna; atualizar manualmente se necessário |
| `order_item.version` | Lock otimista; não alterar manualmente |
| `stock_movement.seq` | Ordem de inserção para custo médio; não alterar |

## Checklist Antes de Executar

1. [ ] Rodei SELECTs de verificação para confirmar o que será afetado?
2. [ ] Todas as operações estão em uma transação (`BEGIN/COMMIT`)?
3. [ ] Não estou fazendo hard-delete em entidade de domínio?
4. [ ] Mostrei o plano completo ao usuário?
5. [ ] Recebi confirmação do usuário?
6. [ ] Rodei SELECTs de confirmação após executar?
