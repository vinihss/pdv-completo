-- ============================================================
-- Migration 0021 — cardápio do restaurante Unami (japonês)
--
-- Carga de catálogo gerada a partir de `full_atualizado.md` (raiz do
-- repo): 11 categorias e 63 produtos com nome, descrição e preço.
-- Este arquivo é DADO, não schema — não há nenhum ALTER TABLE, só
-- INSERTs, e nada é apagado.
--
-- Idempotente e re-executável: os IDs são determinísticos
-- (`kg-unami-*` / `cat-unami-*` / `p-unami-NNN`) e o ON CONFLICT só
-- reescreve os campos de catálogo (name, description, price,
-- category_id, kitchen_group_id). Ele NÃO toca em active, featured,
-- cost_price, track_stock, unit, variations, ifood_enabled nem
-- image_path — ou seja, reaplicar a migration não sobrescreve o que o
-- gerente cadastrou depois no app.
--
-- Decisões tomadas na leitura do markdown:
--   - Categoria entra sem emoji (o emoji é decoração do markdown; o
--     nome aparece na UI do garçom, do gerente e do /pedido).
--   - `Tira de Peixe Branco` aparece 2x no markdown, sem preço nas
--     duas ocorrências. Como product.price é NOT NULL, entra 1x com
--     price = 0 e active = 0: fica invisível até o gerente cadastrar
--     o preço no cadastro de produtos.
--   - `Kids Inca de Alcatra` e `Kids Inca de Alcatra (variação)`
--     viram 1 produto com grupo de variações obrigatório de
--     acompanhamento (as duas linhas do markdown são o mesmo prato).
--   - `Combinação sem lactose (24 peças)` (R$ 79,00, em Combos) e
--     `S/Lactose 24` (R$ 99,90, em Combinados) entraram como 2
--     produtos, fiéis ao arquivo — unificar cardápio com dois preços
--     é decisão do gerente, não da carga inicial.
--   - Preços estavam em real com vírgula decimal (R$ 33,90) e foram
--     convertidos para REAL pontuado; os 25 valores sem centavos
--     entraram como inteiros. Nenhum produto tem custo/estoque porque
--     o markdown não traz custo — vale preencher depois de ligar o
--     módulo de compras (migration 0017).
--   - O grupo de cozinha 'Bar' é criado mesmo sem itens no markdown,
--     para ficar disponível quando o cardápio ganhar bebidas.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Grupos de cozinha — filtro da tela da Cozinha
-- ------------------------------------------------------------
INSERT INTO kitchen_group (id, name, display_order, active) VALUES
    ('kg-unami-sushi',   'Sushi',   1, true),
    ('kg-unami-cozinha', 'Cozinha', 2, true),
    ('kg-unami-bar',     'Bar',     3, true)
ON CONFLICT (id) DO UPDATE SET
    name          = excluded.name,
    display_order = excluded.display_order;

-- ------------------------------------------------------------
-- 2. Categorias — display_order segue a ordem do markdown
-- ------------------------------------------------------------
INSERT INTO category (id, name, display_order, active) VALUES
    ('cat-unami-combos', 'Combos', 1, true),
    ('cat-unami-hot-rolls-kids', 'Hot Rolls e Kids', 2, true),
    ('cat-unami-nigiri-sashimi', 'Nigiri e Sashimi', 3, true),
    ('cat-unami-gunkan-joe', 'Gunkan e Joe', 4, true),
    ('cat-unami-uramaki-hossomaki', 'Uramaki e Hossomaki', 5, true),
    ('cat-unami-pratos-quentes', 'Pratos Quentes', 6, true),
    ('cat-unami-poke-yakisoba', 'Poke e Yakisoba', 7, true),
    ('cat-unami-hot-doce-primavera', 'Hot Doce e Rolinho Primavera', 8, true),
    ('cat-unami-combinados', 'Combinados', 9, true),
    ('cat-unami-entradas-especiais', 'Entradas e Especiais', 10, true),
    ('cat-unami-especiarias', 'Especiarias 2 Peças', 11, true)
ON CONFLICT (id) DO UPDATE SET
    name          = excluded.name,
    display_order = excluded.display_order;

-- ------------------------------------------------------------
-- 3. Produtos — 63 itens
--    variations: '[]' por padrão; o Kids Inca de Alcatra traz o grupo
--    obrigatório de acompanhamento (única variação do cardápio).
-- ------------------------------------------------------------
INSERT INTO product (id, category_id, kitchen_group_id, name, description, price, variations, active) VALUES
    ('p-unami-001', 'cat-unami-combos', 'kg-unami-sushi', 'Combo Gunkan (10 peças)', '2 Gunkan Salmão, 2 Gunkan Atum, 2 Gunkan Peixe Branco, 2 Gunkan Salmão Brie, 2 Gunkan Salmão Mel Picante', 42, '[]', true),
    ('p-unami-002', 'cat-unami-combos', 'kg-unami-sushi', 'Moria Wase (24 lâminas)', '4 Salmão, 4 Atum, 4 Peixe Branco, 4 Polvo, 4 Salmão Hara, 4 Haddock', 89, '[]', true),
    ('p-unami-003', 'cat-unami-combos', 'kg-unami-sushi', 'Especiarias (9 peças)', 'Salmão Hara, Atum Shimeji Tamago, Vieira, Saboroso, Haddock, Polvo, Karubina, Enguia, Salmão Tostado', 56, '[]', true),
    ('p-unami-004', 'cat-unami-combos', 'kg-unami-sushi', 'Combo Umami (45 peças)', '10 Uramaki Philadelphia, 4 Joe Ebi, 4 Joe Shimeji, 4 Joe Crispy Alho-Poró, 4 Joe Tostado, 4 Nigiri Salmão Hara, 10 Sashimi Salmão, 5 Sashimi Atum', 120, '[]', true),
    ('p-unami-005', 'cat-unami-combos', 'kg-unami-sushi', 'Combo 39 peças', '10 Ura Philadelphia, 10 Ura Skin, 5 Hossomaki Salmão, 2 Nigiri Salmão, 2 Nigiri Skin, 4 Gunkan Salmão, 6 Sashimi Salmão', 99, '[]', true),
    ('p-unami-006', 'cat-unami-combos', 'kg-unami-sushi', 'Combo 49 peças', '10 Ura Philadelphia, 10 Ura Skin, 10 Hossomaki Salmão, 3 Nigiri Salmão, 3 Nigiri Skin, 4 Gunkan Salmão, 9 Sashimi Salmão', 129, '[]', true),
    ('p-unami-007', 'cat-unami-combos', 'kg-unami-sushi', 'Combo 59 peças', '10 Ura Philadelphia, 10 Ura Camarão Crocante, 10 Ura Skin, 10 Hossomaki Salmão, 3 Nigiri Salmão, 3 Nigiri Skin, 4 Gunkan Salmão, 9 Sashimi Salmão', 149, '[]', true),
    ('p-unami-008', 'cat-unami-combos', 'kg-unami-sushi', 'Combo Nigiri (12 peças)', '2 Nigiri Salmão, 2 Nigiri Atum, 2 Nigiri Camarão, 2 Nigiri Polvo, 2 Nigiri Peixe Branco, 2 Nigiri Skin', 62, '[]', true),
    ('p-unami-009', 'cat-unami-combos', 'kg-unami-sushi', 'Kit (12 peças + Temaki)', '5 Ura Philadelphia, 5 Sashimi Salmão, 2 Gunkan Salmão, 1 Temaki', 55, '[]', true),
    ('p-unami-010', 'cat-unami-combos', 'kg-unami-sushi', 'Popu (54 peças)', '10 Ura Philadelphia, 10 Ura Skin, 10 Hossomaki Salmão, 10 Hossomaki Pepino, 10 Hot Philadelphia, 2 Nigiri Salmão, 2 Nigiri Skin', 139, '[]', true),
    ('p-unami-011', 'cat-unami-combos', 'kg-unami-sushi', 'Combo 19 peças', '5 Ura Philadelphia, 5 Hossomaki Salmão, 2 Nigiri Salmão, 2 Gunkan Salmão, 5 Sashimi Salmão', 69, '[]', true),
    ('p-unami-012', 'cat-unami-combos', 'kg-unami-sushi', 'Combo 29 peças', '10 Ura Philadelphia, 5 Hossomaki Salmão, 2 Nigiri Salmão, 2 Nigiri Skin, 3 Gunkan Salmão, 7 Sashimi Salmão', 89, '[]', true),
    ('p-unami-013', 'cat-unami-combos', 'kg-unami-sushi', 'Combinação sem lactose (24 peças)', '10 Ura Salmão, 5 Hossomaki Salmão, 2 Gunkan Salmão, 2 Nigiri Salmão, 5 Sashimi Salmão', 79, '[]', true),
    ('p-unami-014', 'cat-unami-hot-rolls-kids', 'kg-unami-sushi', 'Hot Philadelphia (10 peças)', 'Salmão, cream cheese, arroz, alga, tarê, gergelim', 29.9, '[]', true),
    ('p-unami-015', 'cat-unami-hot-rolls-kids', 'kg-unami-sushi', 'Hot Camarão (10 peças)', 'Camarão, cream cheese, arroz, alga, tarê, cebollete', 39.9, '[]', true),
    ('p-unami-016', 'cat-unami-hot-rolls-kids', 'kg-unami-sushi', 'Hot Enjoy Cítrico (10 peças)', 'Salmão, arroz, cream cheese, tarê, alga, crocante cítrico', 39.9, '[]', true),
    ('p-unami-017', 'cat-unami-hot-rolls-kids', 'kg-unami-cozinha', 'Kids Inca de Alcatra', 'Alcatra, macarrão na manteiga', 24.9, '[{"name":"Acompanhamento","options":["Arroz, alcatra, batata frita","Macarrão na manteiga"],"required":true,"allowMultiple":false}]', true),
    ('p-unami-018', 'cat-unami-nigiri-sashimi', 'kg-unami-sushi', 'Sashimi Salmão (5 peças)', 'Sashimi Salmão', 33.9, '[]', true),
    ('p-unami-019', 'cat-unami-nigiri-sashimi', 'kg-unami-sushi', 'Sashimi Atum (5 peças)', 'Sashimi Atum', 18.9, '[]', true),
    ('p-unami-020', 'cat-unami-nigiri-sashimi', 'kg-unami-sushi', 'Sashimi Peixe Branco (5 peças)', 'Sashimi Peixe Branco', 39.9, '[]', true),
    ('p-unami-021', 'cat-unami-nigiri-sashimi', 'kg-unami-sushi', 'Sashimi Polvo (5 peças)', 'Sashimi Polvo', 39.9, '[]', true),
    ('p-unami-022', 'cat-unami-nigiri-sashimi', 'kg-unami-sushi', 'Sashimi Haddock (5 peças)', 'Sashimi Haddock', 36.9, '[]', true),
    ('p-unami-023', 'cat-unami-nigiri-sashimi', 'kg-unami-sushi', 'Sashimi Hara (5 peças)', 'Sashimi Hara', 39.9, '[]', true),
    ('p-unami-024', 'cat-unami-nigiri-sashimi', 'kg-unami-sushi', 'Nigiri Salmão (2 peças)', 'Salmão e arroz', 9.9, '[]', true),
    ('p-unami-025', 'cat-unami-nigiri-sashimi', 'kg-unami-sushi', 'Nigiri Atum (2 peças)', 'Atum e arroz', 8.9, '[]', true),
    ('p-unami-026', 'cat-unami-nigiri-sashimi', 'kg-unami-sushi', 'Nigiri Peixe Branco (2 peças)', 'Peixe branco, arroz e limão', 8.9, '[]', true),
    ('p-unami-027', 'cat-unami-nigiri-sashimi', 'kg-unami-sushi', 'Nigiri Salmão Tamago (2 peças)', 'Salmão, arroz e creme tamago', 12.9, '[]', true),
    ('p-unami-028', 'cat-unami-nigiri-sashimi', 'kg-unami-sushi', 'Nigiri Salmão Brie (2 peças)', 'Salmão, arroz e queijo brie', 13.9, '[]', true),
    ('p-unami-029', 'cat-unami-gunkan-joe', 'kg-unami-sushi', 'Gunkan Salmão (2 peças)', 'Salmão, arroz, cream cheese, cebollete', 22, '[]', true),
    ('p-unami-030', 'cat-unami-gunkan-joe', 'kg-unami-sushi', 'Gunkan Atum (2 peças)', 'Atum, arroz, gergelim, kimuchi, cebollete', 24, '[]', true),
    ('p-unami-031', 'cat-unami-gunkan-joe', 'kg-unami-sushi', 'Gunkan Peixe Branco (2 peças)', 'Peixe branco, arroz, crispy de alho, cebollete', 23, '[]', true),
    ('p-unami-032', 'cat-unami-gunkan-joe', 'kg-unami-sushi', 'Joe Shimeji (4 peças)', 'Shimeji, salmão, cream cheese, manteiga com mel, tarê, gergelim, cebollete', 12.9, '[]', true),
    ('p-unami-033', 'cat-unami-gunkan-joe', 'kg-unami-sushi', 'Joe Ebi (4 peças)', 'Camarão, cream cheese, salmão, tarê, gergelim, cebollete', 38, '[]', true),
    ('p-unami-034', 'cat-unami-gunkan-joe', 'kg-unami-sushi', 'Joe Ebi Crispy de Couve (4 peças)', 'Camarão, salmão, cream cheese, sweet chili, crispy de couve', 40, '[]', true),
    ('p-unami-035', 'cat-unami-gunkan-joe', 'kg-unami-sushi', 'Joe Ebi Alho-Poró (4 peças)', 'Camarão, salmão, cream cheese, tarê, crispy de alho-poró', 40, '[]', true),
    ('p-unami-036', 'cat-unami-gunkan-joe', 'kg-unami-sushi', 'Salmão Mel Picante (2 peças)', 'Salmão, arroz, cream cheese, sriracha, mel', 22, '[]', true),
    ('p-unami-037', 'cat-unami-gunkan-joe', 'kg-unami-sushi', 'Salmão Brie (2 peças)', 'Salmão, arroz, queijo brie, mel', 24, '[]', true),
    ('p-unami-038', 'cat-unami-gunkan-joe', 'kg-unami-sushi', 'Salmão Tostado (2 peças)', 'Salmão, cream cheese, aspargo, creme tamago, layu', 26, '[]', true),
    ('p-unami-039', 'cat-unami-uramaki-hossomaki', 'kg-unami-sushi', 'Uramaki Philadelphia (10 peças)', 'Salmão, cream cheese, arroz, alga, gergelim', 34.9, '[]', true),
    ('p-unami-040', 'cat-unami-uramaki-hossomaki', 'kg-unami-sushi', 'Uramaki Skin Especial (10 peças)', 'Skin grelhado, cream cheese, arroz, alga, gergelim, lâmina de salmão, tarê, crispy de couve', 38.9, '[]', true),
    ('p-unami-041', 'cat-unami-uramaki-hossomaki', 'kg-unami-sushi', 'Uramaki Tuna (10 peças)', 'Tartar de atum, cebolete, molho kimuchi, arroz, alga, gergelim', 31.9, '[]', true),
    ('p-unami-042', 'cat-unami-uramaki-hossomaki', 'kg-unami-sushi', 'Uramaki Philadelphia Crocante Cítrico (10 peças)', 'Salmão, cream cheese, arroz, alga, gergelim, farofa cítrica', 37.9, '[]', true),
    ('p-unami-043', 'cat-unami-uramaki-hossomaki', 'kg-unami-sushi', 'Uramaki Camarão Crocante (10 peças)', 'Camarão crocante, cream cheese, arroz, alga, gergelim, lâmina de salmão, tarê, crispy de alho-poró', 39.9, '[]', true),
    ('p-unami-044', 'cat-unami-uramaki-hossomaki', 'kg-unami-sushi', 'Hossomaki Salmão (10 peças)', 'Salmão e arroz envoltos em alga', 24.9, '[]', true),
    ('p-unami-045', 'cat-unami-uramaki-hossomaki', 'kg-unami-sushi', 'Hossomaki Atum (10 peças)', 'Atum e arroz envoltos em alga', 20.9, '[]', true),
    ('p-unami-046', 'cat-unami-uramaki-hossomaki', 'kg-unami-sushi', 'Hossomaki Pepino (10 peças)', 'Pepino e arroz envoltos em alga', 18.9, '[]', true),
    ('p-unami-047', 'cat-unami-pratos-quentes', 'kg-unami-cozinha', 'Salmão grelhado ao ponto de Endro', 'Salmão, arroz tempura, aspargos, tomate confit, cebola, molho de maracujá', 49.9, '[]', true),
    ('p-unami-048', 'cat-unami-pratos-quentes', 'kg-unami-cozinha', 'Polvo ao Açaí Picante', 'Polvo, arroz tempura, aspargos, tomate confit, cebola, molho de açaí', 59.9, '[]', true),
    ('p-unami-049', 'cat-unami-poke-yakisoba', 'kg-unami-cozinha', 'Poke Tradicional', 'Salmão, atum, peixe branco, avocado, cebola roxa, sunomono, alga, edamame, cebollete, gergelim, chips de batata, polvo, aspargo', 49.9, '[]', true),
    ('p-unami-050', 'cat-unami-poke-yakisoba', 'kg-unami-cozinha', 'Poke Salmão Trufado', 'Salmão, avocado, sunomono, alga, edamame, azeite trufado, flor de sal, limão siciliano, chips de batata', 54.9, '[]', true),
    ('p-unami-051', 'cat-unami-poke-yakisoba', 'kg-unami-cozinha', 'Yakisoba Frango', 'Frango, cenoura, acelga, pimentão, aspargo, macarrão, brócolis', 49, '[]', true),
    ('p-unami-052', 'cat-unami-poke-yakisoba', 'kg-unami-cozinha', 'Yakisoba Alcatra', 'Alcatra, acelga, cenoura, pimentão, aspargo, macarrão, brócolis', 52, '[]', true),
    ('p-unami-053', 'cat-unami-poke-yakisoba', 'kg-unami-cozinha', 'Yakisoba Salmão', 'Salmão, acelga, cenoura, pimentão, aspargo, macarrão, brócolis', 37.9, '[]', true),
    ('p-unami-054', 'cat-unami-poke-yakisoba', 'kg-unami-cozinha', 'Yakisoba Camarão', 'Camarão, acelga, cenoura, pimentão, aspargo, macarrão, brócolis', 44.9, '[]', true),
    ('p-unami-055', 'cat-unami-poke-yakisoba', 'kg-unami-cozinha', 'Yakisoba Vegano', 'Acelga, cenoura, pimentão, aspargo, macarrão, brócolis', 24.9, '[]', true),
    ('p-unami-056', 'cat-unami-hot-doce-primavera', 'kg-unami-cozinha', 'Chocolate', 'Massa Haromaki, ganache, amendoim', 19.9, '[]', true),
    ('p-unami-057', 'cat-unami-hot-doce-primavera', 'kg-unami-cozinha', 'Doce de leite', 'Massa Haromaki, doce de leite, banana', 19.9, '[]', true),
    ('p-unami-058', 'cat-unami-hot-doce-primavera', 'kg-unami-cozinha', 'Romeu e Julieta (Rolinho Primavera)', 'Massa Haromaki, goiabada, queijo mussarela', 11.9, '[]', true),
    ('p-unami-059', 'cat-unami-combinados', 'kg-unami-sushi', 'S/Lactose 24', '10 Ura Salmão, 5 Hossomaki Salmão, 2 Gunkan Salmão, 2 Nigiri Salmão, 5 Sashimi Salmão', 99.9, '[]', true),
    ('p-unami-060', 'cat-unami-entradas-especiais', 'kg-unami-cozinha', 'Ceviche', 'Salmão, atum, peixe branco, molho verde, cebola roxa, leite de tigre, pimenta dedo-de-moça', 39, '[]', true),
    ('p-unami-061', 'cat-unami-entradas-especiais', 'kg-unami-cozinha', 'Tira de Peixe Branco', 'Lâminas de peixe branco, molho de maracujá, azeite, cebolete, raspas de limão siciliano', 0, '[]', false),
    ('p-unami-062', 'cat-unami-especiarias', 'kg-unami-sushi', 'Salmão Hara', 'Azeite Trufado, flor de sol, ovos, Limão siciliano e cebolete', 19.9, '[]', true),
    ('p-unami-063', 'cat-unami-especiarias', 'kg-unami-sushi', 'Atum Shimeji Tamago', 'Atum, Shimeji, Tamago e layu', 18.9, '[]', true)
ON CONFLICT (id) DO UPDATE SET
    category_id      = excluded.category_id,
    kitchen_group_id = excluded.kitchen_group_id,
    name             = excluded.name,
    description      = excluded.description,
    price            = excluded.price,
    updated_at       = (current_timestamp);

