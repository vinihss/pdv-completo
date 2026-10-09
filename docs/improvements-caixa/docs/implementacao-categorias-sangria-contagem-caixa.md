# Implementação — categorias de sangria e contagem por denominação

## Objetivo e estado

Implementar classificação auditável de sangrias e preparar fechamento de caixa com contagem física por denominação. Este documento divide o trabalho em **já implementado neste clone** e **por fazer**, para coordenação entre agentes. A migration foi aplicada em Postgres local descartável e validada na suíte; isso **não** significa que esteja implantada em produção, cujo rollout ainda depende de autorização e runbook próprios.

### Entregue no clone nesta rodada

- [x] Migration incremental `0005_cash_drawer_categories_and_count.sql`.
- [x] Tabela de categorias pré-cadastradas, estado ativo e flag de observação obrigatória.
- [x] Backfill histórico para `legacy_uncategorized`, sem inventar razões antigas.
- [x] Importador SQLite→Postgres atribui o mesmo código legado a sangrias antigas e deixa suprimentos sem categoria.
- [x] Coluna de categoria em sangrias e constraint relacional para exigir categoria em novos/antigos movimentos.
- [x] Tabela de linhas de contagem no fechamento, com denominação em centavos inteiros e quantidade inteira.
- [x] Endpoint de leitura para opções de categoria, validação/persistência das categorias pelo backend e integração da UI de sangria.
- [x] Contrato opcional no fechamento que aceita as linhas de denominação, valida duplicidade/faixa/quantidade/soma e persiste os detalhes; clientes atuais podem continuar enviando somente o total durante a transição.
- [x] Categoria específica para sangria automática de reembolso em dinheiro.

> Atualizar esta lista se os testes/build identificarem arquivo necessário que não entrou na implementação.

## Checklist restante por agentes

### A. Migração e banco — agente Backend/DB

- [ ] Revisar a migration na ordem lexicográfica da cadeia e confirmar que os dois arquivos `0004_*` anteriores são aplicados antes dela.
- [x] Aplicar a migration em Postgres de teste limpo e em schemas tenant criados pela suíte; a cópia representativa com sangrias históricas continua pendente.
- [ ] Confirmar que todas as sangrias históricas viram `legacy_uncategorized`, não são perdidas e mantêm valor, nota, vínculo com pedido e auditoria.
- [ ] Verificar FK, check `sangria_category_required`, `CHECK` de denominação, chave primária composta e cascata ao excluir sessão de teste.
- [x] Verificar que a migration roda no provisionamento multi-tenant e que a lista de migrations do teste está atualizada.
- [ ] Testar reexecução explícita/idempotência do runner em schema que já recebeu a migration.
- [ ] Confirmar que a migration não consulta nem altera dados de produção; operação de produção exige runbook/backup/autorização próprios.

### B. Regras de categorias — agente Backend

- [x] `GET /cash-drawer/categories` retorna somente categorias ativas e exige papel caixa/gerente (teste de integração).
- [x] A API rejeita categoria ausente, inativa ou desconhecida; sangria é categorizada e suprimento rejeita `categoryCode` (testes de integração).
- [x] A observação das categorias configuradas como obrigatórias é validada também no use case/backend (teste de integração).
- [x] Estorno automático usa `cash_refund`, preserva `refOrderId` e nota e é gravado na transação do cancelamento (teste de integração).
- [x] Demo atribui categoria explícita à sangria de exemplo; importação histórica conserva o legado sem inventar motivo.
- [x] Categoria é incluída em auditoria e payload de realtime, sem dados pessoais adicionais.
- [x] `categoryCode` e `categoryLabel` são serializados e exibidos na sessão atual e no detalhe histórico.
- [ ] Avaliar se o gerente precisará futuramente de CRUD para ativar/desativar/ordenar categorias; não criar CRUD sem requisito de autorização, trilha de auditoria e UX.

### C. Validação de contagem — agente Backend

- [x] Payload antigo (`countedAmount`) continua aceito durante a transição.
- [x] Payload novo com `denominationCounts` e sem total manual é aceito; servidor deriva o total em centavos.
- [x] Total manual divergente é rejeitado.
- [x] Denominação não permitida/duplicada e quantidade fracionária, negativa ou acima do teto são rejeitadas.
- [ ] Confirmar que uma sessão com dinheiro contado zero envia ao menos uma linha de denominação com quantidade zero; array vazio não é uma contagem detalhada válida.
- [x] Contagem e fechamento são persistidos na mesma transação; fechamento inválido mantém sessão aberta.
- [x] Linhas são retornadas no detalhe e o total contado é verificado contra as denominações.
- [x] Dinheiro é convertido/validado em centavos seguros; fração de centavo e overflow numérico do campo “Contado” são rejeitados.
- [x] Testes de API cobrem os principais casos inválidos e a persistência/total do fechamento.
- [ ] Acrescentar teste específico de replay/idempotência do fechamento com discriminação, além da cobertura genérica de `correlationId`.

### D. Frontend — agente Caixa/UX

- [ ] Atualizar `CloseCashDrawerModal.jsx` para renderizar uma linha por denominação aceita e permitir informar quantidades de cédulas/moedas.
- [ ] O campo/quantidade começa vazia ou em zero, nunca copiando `expected` como valor contado.
- [ ] Calcular e exibir total contado, esperado e diferença em reais; usar centavos internamente ou cálculo decimal seguro.
- [ ] Exigir confirmação explícita de contagem física antes do botão “Fechar caixa” ficar habilitado.
- [ ] Enviar `denominationCounts` e deixar o backend derivar o total. Durante compatibilidade, não enviar um `countedAmount` independente, ou assegurar que o backend valide igualdade.
- [ ] Tratar erro do backend preservando contagem, nota e foco do operador; não apagar o formulário em falha de rede.
- [x] Categoria da sangria está visível na lista da sessão e no detalhe histórico; permanece pendente exibir **contagens por denominação** em `CashDrawerDetailModal.jsx`, `PrintReceipt.jsx` e relatório gerencial.
- [ ] Testar teclado numérico, leitor/toque em tablet, layout mobile e acessibilidade dos rótulos.
- [ ] Implementar testes de UI: total recalcula, total zero permitido, alterar quantidade exige reconfirmar, envio correto, servidor rejeita e formulário permanece.

### E. Histórico, relatórios e auditoria — agentes Backend/Relatórios

- [x] Exibir categoria e motivo nos movimentos da sessão atual e detalhe histórico.
- [ ] Acrescentar filtros por categoria, operador, período e tipo ao relatório de fluxo de caixa.
- [ ] Separar “reembolso em dinheiro” dentro de sangrias sem subtrair duas vezes do esperado.
- [ ] Criar indicadores de incidência/valor de sangria por categoria; não converter anomalia em acusação de fraude.
- [ ] Disponibilizar exportação CSV com sessão, horário, categoria, operador, valor, nota e referência.
- [ ] Garantir que a categoria legado não aparece como opção de nova operação e fica identificada como dado histórico sem classificação.

### F. Qualidade, testes e release — coordenador

- [x] `cd backend && npm run build`.
- [x] `cd backend && npm test -- test/cash-flow.test.ts` em Postgres local descartável: 19 testes passaram.
- [x] Suíte completa do backend: 26 arquivos e 393 testes passaram; o fluxo de caixa foi reexecutado após os últimos ajustes.
- [ ] `cd frontend && npm run test` — executado: 47 arquivos/532 testes passaram; 7 falharam em 2 suítes existentes de profiles Vite e base de servidor (incluindo `public/sw.js` ausente/configuração). Investigar essas falhas de ambiente/código antes de release.
- [x] `cd frontend && npm run lint` e `npm run build` (lint sem erros; avisos preexistentes).
- [x] Revisar `git diff --check`, `git status` e escritas diretas em `cash_drawer_movement`.
- [x] Teste multi-tenant/provisionamento executado; migrations `0001`–`0005` aplicadas nas duas sessões tenant de teste.
- [ ] Documentar rollout: primeiro backend/migration, depois frontend; o backend aceita temporariamente payload legado, e eventual remoção exige confirmar que todos os clientes estão atualizados.
- [ ] Não executar migration em produção nem publicar/deploy sem instruções e autorização específicas.

## Contratos esperados

### Criar sangria

```http
POST /cash-drawer/sangria
```

```json
{
  "correlationId": "idempotency-key",
  "amount": 25.5,
  "categoryCode": "safe_deposit",
  "note": "Depósito do turno da noite"
}
```

`categoryCode` é obrigatório; `note` é obrigatória para categorias configuradas com `requiresNote=true`.

### Listar categorias disponíveis

```http
GET /cash-drawer/categories
```

Resposta: lista ordenada de `{ code, label, requiresNote }`, apenas categorias ativas.

### Fechar caixa com discriminação

```http
POST /cash-drawer/close
```

```json
{
  "correlationId": "idempotency-key",
  "denominationCounts": [
    { "denominationCents": 10000, "quantity": 2 },
    { "denominationCents": 5000, "quantity": 1 },
    { "denominationCents": 100, "quantity": 3 }
  ],
  "note": "Conferido pelo gerente"
}
```

O backend calcula o contado como `Σ(denominationCents × quantity) / 100`. O campo legado `countedAmount` é aceito no período de transição; se ambos forem enviados, precisam coincidir ao centavo.

## Critérios de conclusão

A entrega só fica completa quando: categorias são persistidas e visíveis no fluxo de sangria; estornos automáticos e lançamentos demo não quebram a regra; contagens detalhadas são validadas e gravadas transacionalmente; o frontend de fechamento envia as denominações; as linhas aparecem no detalhe/comprovante; as migrations rodam em Postgres limpo e com histórico; e os testes de backend/frontend/build passam.
