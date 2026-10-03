// Id do usuário técnico seedado em migrations/0002_delivery_self_service.sql
// (role "system", active: false, nunca autentica). Serve só como alvo de FK
// para orders.waiter_id e audit_log.user_id em pedidos self-service, que não
// têm garçom nem gerente responsável — ver 04-delivery-self-service-integration.md
// "Decisões de arquitetura".
export const SYSTEM_USER_ID = "system";

// Store "default" — mesma criada na migration 0008_stores_and_store_id e usada
// como fallback do tenant middleware quando o Host não traz subdomínio.
// Só serve de fallback nos fluxos SEM contexto de requisição (worker do iFood,
// bot do WhatsApp), onde não há `req.storeId` para repassar: o caminho normal
// é a rota passar o storeId resolvido pelo middleware.
export const DEFAULT_STORE_ID = "00000000-0000-0000-0000-000000000001";
