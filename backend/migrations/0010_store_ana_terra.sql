-- ============================================================
-- 0010_store_ana_terra — primeira store tenant de produção.
-- Resolve `ana-terra.labolabe.tech` → store slug `ana-terra`
-- (tenant.middleware cruza o subdomínio com stores.slug).
-- Idempotente.
-- ============================================================

INSERT INTO stores (id, name, slug, status)
VALUES ('00000000-0000-0000-0000-000000000002', 'Ana Terra', 'ana-terra', 'active')
ON CONFLICT (slug) DO NOTHING;
