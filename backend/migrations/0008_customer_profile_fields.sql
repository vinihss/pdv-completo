-- Detalhe de cliente: foto, CPF e observações livres.
--
-- A tela de cliente já existia (migration 0003_profile_fields.sql, que criou
-- `customer.email` e o soft-delete `active`), mas o cadastro era o mínimo do
-- balcão: nome, telefone, email. Estas três colunas fecham o perfil que a
-- tela de detalhe precisa mostrar — quem é o cliente, como falar com ele, o que
-- ele pede e o que ele consome.
--
-- 1. photo_path — mesma régua de `user.photo_path` (0003) e de
--    `product.image_path`: o banco guarda SÓ o basename (`<id>.<ext>`), com o
--    nome gerado pelo app a partir do id, e o caminho público
--    `/uploads/<id>.<ext>` é montado na borda (`photoUrl` em
--    user.usecases.ts). O nome enviado pelo cliente nunca vira caminho em
--    disco: é o que impede path traversal e a colisão entre dois uploads do
--    mesmo registro.
--
-- 2. cpf — 11 dígitos CRUDOS, sem máscara. A máscara (`000.000.000-00`) é
--    apresentação e muda de contexto (cadastro, comprovante, mensagem), então
--    guardar formatado quebraria tanto a busca quanto o índice. A entrada
--    aceita com ou sem máscara; a normalização para dígitos fica no usecase.
--    É único entre clientes (índice parcial abaixo) e opcional — cliente sem
--    documento continua válido.
--
-- 3. notes — observação livre do gerente/caixa sobre o cliente ("pede sem
--    cebola", "paga sempre no Pix", "é o dono do bar da esquina"). Não é
--    endereço estruturado: é texto que ninguém consulta em SQL, e por isso
--    TEXT sem validação além de "não vazio".
--
-- UNIQUE parcial em `cpf` (WHERE cpf IS NOT NULL), no mesmo formato do
-- `uq_customer_email` que já existe: NULLs não colidem, então o índice não
-- impede o cadastro de quem não tem CPF. A mensagem de campo vem do usecase
-- (`assertCpfAvailable`, mesmo padrão do email); o índice aqui é a garantia
-- contra a corrida entre duas requisições simultâneas.
--
-- IF NOT EXISTS em tudo: reexecutar a migration é seguro (mesma régua de
-- 0005_customer_address_cep.sql e 0007).

ALTER TABLE customer ADD COLUMN IF NOT EXISTS photo_path TEXT;
ALTER TABLE customer ADD COLUMN IF NOT EXISTS cpf TEXT;
ALTER TABLE customer ADD COLUMN IF NOT EXISTS notes TEXT;

-- CPF único quando informado (parcial: NULL não colide com nada).
CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_cpf ON customer(cpf) WHERE cpf IS NOT NULL;