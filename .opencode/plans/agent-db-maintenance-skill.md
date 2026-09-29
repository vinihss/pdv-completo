# Plano: Documentação de Skill — Manutenção de Banco de Dados (Agente)

## Objetivo

Criar `docs/agent-db-maintenance.md` — guia completo para o agente realizar operações de manutenção no banco de produção do cliente Umami diretamente via Docker/PSQL, com confirmação em lote.

## Contexto

- **Acesso**: VPS via SSH com chave + `docker exec` para rodar psql
- **Banco**: Mesmo schema deste projeto (pdv-completo), instância separada na VPS
- **Confirmação**: Em lote (mostrar plano → pedir confirmação única → executar → verificar)

## Arquivo a criar

`docs/agent-db-maintenance.md`

## Estrutura do Documento

1. **Acesso** — comandos SSH + Docker + psql
2. **Schema Resumido** — tabelas principais, relacionamentos, convenções
3. **Regras de Manutenção** — operações permitidas, regras de ouro
4. **Fluxo de Trabalho** — SELECT livre, escrita em lote com confirmação
5. **Exemplos Práticos** — 5 exemplos cobrindo os casos do usuário:
   - Listar produtos da categoria X
   - Renomear categoria
   - Mover produtos entre categorias
   - Desativar produto (soft-delete)
   - Atualizar preços
6. **Comandos PSQL Úteis** — referência rápida
7. **Avisos e Cuidados** — o que nunca fazer
8. **Checklist** — verificação antes de executar

## Conteúdo Detalhado

### 1. Acesso

```bash
ssh <vps-host>
docker ps --format '{{.Names}}' | grep -i postgres
docker exec -it <container-name> psql -U pdv -d pdv
```

Para lote: `docker exec -i <container> psql -U pdv -d pdv < script.sql`

### 2. Schema Resumido

Tabelas principais com coluna de soft-delete:
- `category`, `product`, `kitchen_group`, `customer`, `user`, `supplier` → `active` (boolean)
- `order` → `status` (enum)
- `order_item` → `status` (enum)
- `restaurant_table` → `status` (enum)

Relacionamentos críticos:
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

Convenções:
- Soft-delete: nunca DELETE em domínio, usar `active = false`
- Timestamps: TEXT ISO-8601 UTC
- IDs: TEXT (crypto.randomUUID())
- JSON: TEXT
- Money/Quantity: REAL
- Enums: nativos PG
- Estoque: ledger (saldo = SUM quantity_delta)

### 3. Regras de Manutenção

| Operação | Permissão | Confirmação |
|---|---|---|
| SELECT | Livre | Não precisa |
| UPDATE | Permitida | Em lote |
| INSERT | Permitida | Em lote |
| DELETE | Apenas com justificativa | Em lote + justificativa |

Regras de ouro:
1. Sempre transações para escrita
2. Nunca hard-delete domínio
3. Sempre verificar antes (SELECT)
4. Confirmar em lote
5. Backup antes de destrutivas
6. Respeitar FKs

### 4. Fluxo de Trabalho

**SELECT**: livre, sem confirmação

**Escrita (UPDATE/INSERT/DELETE)**:
1. Planejar SQL
2. Mostrar plano (SELECTs verificação + operações)
3. Pedir confirmação única
4. Executar em transação
5. Verificar resultado

### 5. Exemplos Práticos

#### 5.1 Listar produtos da categoria "Porções"
```sql
SELECT p.id, p.name, p.price, p.active, p.track_stock
FROM product p
JOIN category c ON p.category_id = c.id
WHERE c.name = 'Porções'
ORDER BY p.display_order, p.name;
```

#### 5.2 Renomear categoria
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

#### 5.3 Mover produtos para outra categoria
```sql
-- Verificar produtos atuais
SELECT p.id, p.name, c.name AS categoria_atual
FROM product p JOIN category c ON p.category_id = c.id
WHERE p.name IN ('Produto X', 'Produto Y', 'Produto Z');
-- Verificar destino
SELECT id, name FROM category WHERE name = 'Categoria B';
-- Mover
BEGIN;
UPDATE product p SET category_id = (SELECT id FROM category WHERE name = 'Categoria B')
WHERE p.name IN ('Produto X', 'Produto Y', 'Produto Z');
COMMIT;
-- Confirmar
SELECT p.id, p.name, c.name AS categoria
FROM product p JOIN category c ON p.category_id = c.id
WHERE p.name IN ('Produto X', 'Produto Y', 'Produto Z');
```

#### 5.4 Desativar produto (soft-delete)
```sql
SELECT id, name, active FROM product WHERE name = 'Produto Z';
BEGIN;
UPDATE product SET active = false WHERE name = 'Produto Z';
COMMIT;
```

#### 5.5 Atualizar preços
```sql
SELECT p.id, p.name, p.price FROM product p WHERE p.name IN ('Produto X', 'Produto Y');
BEGIN;
UPDATE product SET price = 25.90 WHERE name = 'Produto X';
UPDATE product SET price = 18.50 WHERE name = 'Produto Y';
COMMIT;
```

### 6. Comandos PSQL Úteis

```bash
\dt                          # listar tabelas
\d product                   # descrever tabela
SELECT * FROM category ORDER BY display_order;
SELECT p.name, p.price, c.name FROM product p LEFT JOIN category c ON p.category_id = c.id;
SELECT * FROM product WHERE name ILIKE '%frango%';
SELECT p.name, COALESCE(SUM(sm.quantity_delta), 0) AS saldo
FROM product p LEFT JOIN stock_movement sm ON sm.product_id = p.id
WHERE p.name = 'X' GROUP BY p.name;
\q                           # sair
```

### 7. Avisos e Cuidados

| Cuidado | Por quê |
|---|---|
| Nunca DELETE FROM product | Quebra FK de order_item e stock_movement |
| Nunca DELETE FROM category | Produtos ficam sem categoria (SET NULL) |
| Nunca DELETE FROM customer | Tem histórico de pedidos |
| Nunca DELETE FROM user | Tem histórico de ações |
| Cuidado UPDATE sem WHERE | Afeta todas as linhas |
| Verificar updated_at | Algumas tabelas têm essa coluna |
| order_item.version | Lock otimista, não alterar |
| stock_movement.seq | Ordem para custo médio, não alterar |

### 8. Checklist

1. [ ] Rodei SELECTs de verificação?
2. [ ] Tudo em transação (BEGIN/COMMIT)?
3. [ ] Sem hard-delete em domínio?
4. [ ] Mostrei plano ao usuário?
5. [ ] Recebi confirmação?
6. [ ] Rodei SELECTs de confirmação após executar?

## Verificação

- [ ] Documento cobre todos os exemplos do usuário (listar, renomear, mover)
- [ ] Acesso via Docker está claro
- [ ] Regras de confirmação em lote estão definidas
- [ ] Convenções do schema estão documentadas
- [ ] Avisos de segurança estão presentes
