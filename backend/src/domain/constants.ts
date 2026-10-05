// Id do usuário técnico seedado em migrations/0001_init.sql
// (role "system", active: false, nunca autentica). Serve só como alvo de FK
// para orders.waiter_id e audit_log.user_id em pedidos self-service, que não
// têm garçom nem gerente responsável — ver 04-delivery-self-service-integration.md
// "Decisões de arquitetura".
export const SYSTEM_USER_ID = "system";

