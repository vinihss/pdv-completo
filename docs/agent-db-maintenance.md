# Manutenção de banco de dados — guia seguro

Este guia cobre consultas e alterações de dados do PDV. **Não concede autorização para acessar ou modificar produção.** O ambiente precisa ser identificado e autorizado pelo responsável antes de qualquer conexão ou escrita.

## Limites obrigatórios

- **Padrão: trabalhar em banco local/de teste.** Não acessar VPS, produção ou dados de clientes por iniciativa própria.
- Operação em produção exige pedido explícito do responsável autorizado, identificação inequívoca do ambiente/tenant e confirmação do plano final. A confirmação deve ocorrer antes da escrita e incluir o conjunto de registros, campos, valores e impacto.
- Uma solicitação genérica para “corrigir” ou “atualizar” dados não autoriza acesso a produção, exportação de dados pessoais ou alteração de registros.
- Nunca imprimir, copiar ou incluir credenciais, tokens, dados pessoais desnecessários ou conteúdo de `.env` em respostas, arquivos ou logs.
- Se ambiente, tenant, alvo, impacto ou autorização forem incertos: **parar e pedir esclarecimento**. Não inferir pelo nome do container, host ou banco.
- Preferir a API/administração do produto quando disponível. SQL direto só quando necessário e autorizado.

## Fluxo de leitura

1. Identifique se a solicitação é apenas consulta e qual o escopo mínimo necessário.
2. Confirme que a conexão aponta para o ambiente autorizado; não confie apenas no nome do container.
3. Use `SELECT` somente, limite resultados, selecione apenas campos necessários e evite dados pessoais irrelevantes.
4. Apresente o resultado com contexto e indique o ambiente consultado sem revelar segredos.

Exemplo para ambiente **local de desenvolvimento** (ajuste banco/credenciais segundo a configuração local; não copie para produção sem autorização):

```bash
docker compose -f deploy/docker-compose.dev.yml ps
# Após confirmar visualmente que é o stack local de desenvolvimento:
docker compose -f deploy/docker-compose.dev.yml exec -T postgres \
  psql -U pdv -d pdv -c \
  "SELECT id, name, price, active FROM product ORDER BY name LIMIT 100;"
```

Os nomes de serviço e variáveis podem variar; confirme no compose e no `.env.example` sem exibir valores secretos.

## Fluxo de escrita autorizado

1. **Identificar ambiente e autorização.** Confirmar explicitamente o ambiente e, para produção, a autorização do responsável.
2. **Inspecionar schema e regra de domínio.** Conferir migration/schema atuais, restrições, triggers, soft-delete, auditoria e ledger relacionados.
3. **Planejar sem escrever.** Preparar `SELECT` que conte e mostre exatamente os registros alvo, além do SQL pretendido. Garantir predicado seletivo; nunca executar `UPDATE`/`DELETE` sem `WHERE`.
4. **Apresentar o plano final.** Informar ambiente, tenant, contagem, registros/campos atingidos, valores antes/depois, riscos, backup/recuperação e validações. Pedir confirmação explícita para esse plano exato.
5. **Backup verificável.** Para alterações de alto impacto/destrutivas em produção, assegurar backup recente, íntegro e com recuperação testada conforme runbook da operação. Se isso não for possível, interromper e escalar; não substituir por um backup improvisado.
6. **Executar atomicamente.** Usar transação, bloquear ou validar o conjunto alvo, verificar quantidade afetada (`RETURNING` quando aplicável) e fazer `ROLLBACK` se o resultado divergir do plano. Não fazer commit parcial.
7. **Verificar.** Consultar estado final, confirmar invariantes/auditoria e reportar o resultado. Não afirmar sucesso sem evidência.

A confirmação cobre apenas o plano apresentado. Se o alvo ou o SQL mudar, apresentar o plano atualizado e pedir nova confirmação.

## Regras de domínio

- Não fazer hard-delete de entidades de domínio (`product`, `category`, `customer`, `user`, `supplier`) salvo procedimento formal autorizado e comprovadamente necessário. Prefira soft-delete conforme o schema e as regras da aplicação.
- Estoque é ledger: saldo deriva de `SUM(quantity_delta)` em `stock_movement`. Não “corrigir saldo” editando/deletando movimentos antigos; use o fluxo de ajuste documentado.
- Não alterar manualmente `order_item.version`, `stock_movement.seq` ou dados de auditoria/outbox para contornar regras.
- Não presumir tipos, enums, colunas de timestamp, esquema/tenant ou relacionamentos deste resumo. Confirme migrations e código atuais. Este banco é PostgreSQL; consulte schema vigente em `backend/migrations/`.
- Mudança que represente regra de negócio deve preferir endpoint/use case, para preservar validação, auditoria, outbox e idempotência.

## Consultas de exemplo (somente local/teste autorizado)

```sql
-- Produtos de uma categoria; limite os resultados
SELECT p.id, p.name, p.price, p.active
FROM product p
JOIN category c ON c.id = p.category_id
WHERE c.name = 'Porções'
ORDER BY p.name
LIMIT 100;

-- Saldo derivado do ledger para um produto
SELECT p.id, p.name, COALESCE(SUM(sm.quantity_delta), 0) AS saldo
FROM product p
LEFT JOIN stock_movement sm ON sm.product_id = p.id
WHERE p.id = '<id-confirmado>'
GROUP BY p.id, p.name;
```

## Checklist antes de parar

- [ ] Ambiente e tenant identificados e autorizados.
- [ ] Consulta limitada ao mínimo necessário, ou escrita coberta por plano exato confirmado.
- [ ] Schema e regras atuais conferidos.
- [ ] Backup/recuperação verificados quando exigidos.
- [ ] Predicados seletivos e transação utilizados; quantidade afetada conferida.
- [ ] Estado final verificado e resultado reportado sem segredos.

## Referências

- Schema e migrations: `backend/migrations/`.
- Regras de negócio e padrões do backend: `agent-backend.md`.
- Segurança e procedimentos de produção: `agent-deploy.md` e `../deploy/README.md`.
