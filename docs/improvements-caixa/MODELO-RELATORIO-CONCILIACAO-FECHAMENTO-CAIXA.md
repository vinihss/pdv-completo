# Modelo gerencial — Conciliação de pagamentos e fechamento de caixa

> **Objetivo:** permitir que gerente e responsável pelo caixa respondam, sem misturar conceitos: (1) o dinheiro físico confere? (2) pagamentos eletrônicos foram recebidos/liquidados? (3) há diferenças ou pendências que exigem ação?
>
> **Regra principal:** o dinheiro esperado na gaveta não é o faturamento total. Pix, cartão e marketplace devem ser conciliados em blocos próprios.

## 1. Cabeçalho da sessão

| Campo | Preenchimento |
|---|---|
| Loja / unidade | `[nome da loja]` |
| Data operacional | `[AAAA-MM-DD]` |
| Fuso horário da loja | `[ex.: America/Sao_Paulo]` |
| Caixa / terminal | `[identificador físico ou lógico]` |
| Turno | `[abertura–fechamento; ex.: noite]` |
| Sessão / ID do caixa | `[ID]` |
| Aberto em / por | `[data e hora] · [usuário]` |
| Fechado em / por | `[data e hora] · [usuário]` |
| Conferido por | `[usuário, se diferente]` |
| Gerente aprovador | `[nome/PIN ou não aplicável]` |
| Situação | `☐ conciliado  ☐ conciliado com ressalva  ☐ pendente  ☐ divergente` |

**Data operacional** é a data atribuída à jornada da loja. Ela não deve ser inferida somente pela data civil do servidor quando a sessão atravessa a meia-noite.

## 2. Resumo executivo

| Indicador | Valor | Leitura |
|---|---:|---|
| Vendas brutas registradas no período | R$ `[ ]` | Itens vendidos + entrega, antes de cancelamentos/estornos exibidos separadamente |
| Cancelamentos / estornos | R$ `[ ]` | Valores revertidos, com referência ao pagamento original |
| Vendas líquidas registradas | R$ `[ ]` | Brutas − cancelamentos/estornos; não significa dinheiro já liquidado |
| Dinheiro esperado na gaveta | R$ `[ ]` | Valor físico calculado para a sessão |
| Dinheiro contado | R$ `[ ]` | Contagem física, não preencher copiando o esperado |
| Diferença de caixa | R$ `[ ]` | Contado − esperado; sobra positiva, falta negativa |
| Pagamentos eletrônicos conciliados | R$ `[ ]` | Valor liquidado/confirmado segundo fonte de cada método |
| Repasse de canal ainda pendente | R$ `[ ]` | Valor previsto não recebido até a data/hora de corte |
| Exceções em aberto | `[ ]` | Quantidade de itens que exigem ação |

### Estado do fechamento

- [ ] Diferença de caixa dentro da tolerância configurada.
- [ ] Diferença explicada e registrada.
- [ ] Meios eletrônicos conciliados com extrato/portal do provedor.
- [ ] Repasses de canal conciliados ou identificados como pendentes.
- [ ] Comprovantes e observações anexados/referenciados.
- [ ] Revisão do gerente concluída, quando exigida.

## 3. Fechamento do dinheiro físico

### 3.1 Composição do valor esperado

```text
Esperado na gaveta
  = fundo inicial
  + recebimentos em dinheiro confirmados durante a sessão
  + suprimentos (dinheiro colocado na gaveta)
  − sangrias (dinheiro retirado da gaveta)
```

> Estorno em dinheiro deve aparecer como saída física **uma única vez**. Se o sistema já lança o estorno como sangria, não subtrair novamente numa linha separada de “reembolso”. O relatório pode identificar a parcela das sangrias que corresponde a estornos.

| Composição | Valor |
|---|---:|
| Fundo inicial | R$ `[ ]` |
| Vendas em dinheiro confirmadas | R$ `[ ]` |
| Suprimentos | + R$ `[ ]` |
| Sangrias operacionais | − R$ `[ ]` |
| Estornos em dinheiro incluídos nas sangrias | − R$ `[ ]` *(informativo; não subtrair novamente)* |
| **Esperado na gaveta** | **R$ `[ ]`** |

### 3.2 Contagem física por denominação

Preencher quantidade de notas/moedas; o sistema calcula os subtotais e o total. Denominações devem ser configuráveis conforme a moeda em uso.

| Denominação | Quantidade | Subtotal |
|---:|---:|---:|
| R$ 200,00 | `[ ]` | R$ `[ ]` |
| R$ 100,00 | `[ ]` | R$ `[ ]` |
| R$ 50,00 | `[ ]` | R$ `[ ]` |
| R$ 20,00 | `[ ]` | R$ `[ ]` |
| R$ 10,00 | `[ ]` | R$ `[ ]` |
| R$ 5,00 | `[ ]` | R$ `[ ]` |
| R$ 2,00 | `[ ]` | R$ `[ ]` |
| R$ 1,00 e moedas | `[ ]` | R$ `[ ]` |
| **Total contado** |  | **R$ `[ ]`** |

| Resultado da conferência | Valor |
|---|---:|
| Esperado | R$ `[ ]` |
| Contado | R$ `[ ]` |
| **Diferença (contado − esperado)** | **R$ `[ ]`** |
| Tolerância configurada | R$ `[ ]` |
| Justificativa obrigatória? | `[sim/não]` |
| Justificativa | `[texto; obrigatória acima da tolerância]` |
| Aprovador | `[nome/identificação; se necessário]` |

## 4. Conciliação dos meios de pagamento

A conciliação deve comparar **venda registrada**, **valor esperado do provedor** e **valor efetivamente liquidado**. Use o período e a data de corte do extrato, e preserve o identificador da transação sem armazenar dados sensíveis.

| Meio / provedor | Vendas confirmadas | Taxas/ajustes | Líquido esperado | Liquidado até o corte | Pendente | Diferença não explicada |
|---|---:|---:|---:|---:|---:|---:|
| Pix / provedor `[ ]` | R$ `[ ]` | R$ `[ ]` | R$ `[ ]` | R$ `[ ]` | R$ `[ ]` | R$ `[ ]` |
| Cartão débito / adquirente `[ ]` | R$ `[ ]` | R$ `[ ]` | R$ `[ ]` | R$ `[ ]` | R$ `[ ]` | R$ `[ ]` |
| Cartão crédito / adquirente `[ ]` | R$ `[ ]` | R$ `[ ]` | R$ `[ ]` | R$ `[ ]` | R$ `[ ]` | R$ `[ ]` |
| Outros `[ ]` | R$ `[ ]` | R$ `[ ]` | R$ `[ ]` | R$ `[ ]` | R$ `[ ]` | R$ `[ ]` |

```text
Líquido esperado = venda confirmada − taxas − ajustes/descontos do provedor
Pendente = líquido esperado − valor liquidado até a data/hora de corte
Diferença não explicada = valor do extrato − valor esperado, após considerar taxas,
                          cancelamentos, estornos e diferenças de calendário
```

**Parcelamento:** no crédito, discriminar parcelas e datas previstas de recebimento quando disponíveis. **Troco:** não contabilizar troco entregue como nova receita; registrar valor recebido e valor da venda conforme a regra do sistema, e usar o troco apenas para conciliar a saída física.

## 5. Conciliação por canal de venda

Canal é uma dimensão diferente do meio de pagamento. Uma venda de marketplace pode ter sido paga com cartão ou Pix no canal; por isso, não some o total do canal novamente ao consolidado por método de pagamento.

| Canal | Bruto dos pedidos concluídos | Cancelamentos/estornos | Comissão/taxas | Repasse líquido previsto | Repasse recebido | Pendente | Divergência |
|---|---:|---:|---:|---:|---:|---:|---:|
| Salão / balcão | R$ `[ ]` | R$ `[ ]` | R$ `[ ]` | R$ `[ ]` | R$ `[ ]` | R$ `[ ]` | R$ `[ ]` |
| Delivery próprio | R$ `[ ]` | R$ `[ ]` | R$ `[ ]` | R$ `[ ]` | R$ `[ ]` | R$ `[ ]` | R$ `[ ]` |
| iFood | R$ `[ ]` | R$ `[ ]` | R$ `[ ]` | R$ `[ ]` | R$ `[ ]` | R$ `[ ]` | R$ `[ ]` |
| Outro marketplace | R$ `[ ]` | R$ `[ ]` | R$ `[ ]` | R$ `[ ]` | R$ `[ ]` | R$ `[ ]` | R$ `[ ]` |

```text
Repasse líquido previsto = bruto − comissão − taxas − ajustes do canal
Pendente = repasse líquido previsto − repasse recebido até o corte
```

Se ainda não houver settlement/importação de extrato, marcar comissão/repasse como **“não conciliado”**. Não estimar “líquido recebido” usando apenas o bruto do pedido.

## 6. Movimentações e trilha de auditoria

| Hora | Tipo | Categoria | Valor | Operador | Destino/recebedor | Referência | Observação/comprovante |
|---|---|---|---:|---|---|---|---|
| `[hh:mm]` | `sangria/suprimento` | `[cofre/troco/despesa/estorno/outro]` | R$ `[ ]` | `[ ]` | `[ ]` | `[ID/recibo/pedido]` | `[ ]` |

Cada ajuste deve ser rastreável. Não apagar movimento confirmado; registrar estorno/correção com referência ao lançamento original, usuário, horário e motivo.

## 7. Exceções e plano de ação

| Prioridade | Exceção | Valor/impacto | Responsável | Ação necessária | Prazo | Situação/evidência |
|---|---|---:|---|---|---|---|
| `[alta/média/baixa]` | `[ex.: diferença de caixa]` | R$ `[ ]` | `[ ]` | `[ ]` | `[ ]` | `[aberta/resolvida]` |
|  |  |  |  |  |  |  |

Exemplos de exceção: falta/sobra acima da tolerância; pagamento confirmado no PDV sem liquidação no provedor; taxa diferente da contratada; pedido cancelado sem reembolso confirmado; repasse de marketplace atrasado; sangria sem categoria ou referência; contagem feita por pessoa diferente sem revisão.

## 8. Aprovação e encerramento

| Papel | Nome/identificação | Data/hora | Aprovação/observação |
|---|---|---|---|
| Responsável pela contagem | `[ ]` | `[ ]` | `[ ]` |
| Operador que encerra | `[ ]` | `[ ]` | `[ ]` |
| Gerente/revisor | `[ ]` | `[ ]` | `[ ]` |

**Decisão:** `☐ aprovado  ☐ aprovado com ressalva  ☐ reabrir apuração`  
**Observação final:** `[texto]`

## 9. Exemplo preenchido (valores ilustrativos)

> Exemplo didático, não representa dados reais do repositório nem de uma loja.

### 9.1 Caixa físico

| Composição | Valor |
|---|---:|
| Fundo inicial | R$ 200,00 |
| Recebimentos em dinheiro confirmados | R$ 1.248,50 |
| Suprimento de troco | + R$ 50,00 |
| Sangrias: depósito no cofre | − R$ 250,00 |
| Sangrias: pagamento de despesa | − R$ 30,00 |
| Sangrias: estornos em dinheiro | − R$ 40,00 |
| **Esperado na gaveta** | **R$ 1.178,50** |
| Contado fisicamente | R$ 1.173,50 |
| **Diferença** | **− R$ 5,00 (falta)** |
| Justificativa | `[registrar explicação; exigir se excede tolerância]` |

Cálculo: `200,00 + 1.248,50 + 50,00 − 250,00 − 30,00 − 40,00 = 1.178,50`.

### 9.2 Eletrônicos / canal

| Grupo | Bruto confirmado | Taxas/ajustes | Líquido previsto | Recebido | Pendente |
|---|---:|---:|---:|---:|---:|
| Pix | R$ 835,00 | R$ 0,00 | R$ 835,00 | R$ 835,00 | R$ 0,00 |
| Cartão débito | R$ 620,00 | R$ 12,40 | R$ 607,60 | R$ 607,60 | R$ 0,00 |
| Cartão crédito | R$ 480,00 | R$ 14,40 | R$ 465,60 | R$ 400,00 | R$ 65,60 |
| iFood — visão por canal | R$ 930,00 | R$ 142,30 | R$ 787,70 | R$ 600,00 | R$ 187,70 |

> O total do iFood é mostrado na visão de canal para conferir repasse. Não deve ser somado novamente ao mix de métodos de pagamento se os mesmos pedidos já estiverem classificados por Pix/cartão.

## 10. Regras de implementação sugeridas para o PDV

### Campos que o relatório deve obter do sistema

- **Já existentes no fluxo de caixa:** valor de abertura, esperado, vendas em dinheiro confirmadas, movimentos de sangria/suprimento, horário e responsável pela abertura/fechamento, contado, diferença e observação.
- **Melhorias necessárias:** contagem por denominação; motivo/categoria da movimentação; quem recebeu/destino; data operacional; nome/identificador do terminal; início/fim de turno explícitos.
- **Para conciliação eletrônica:** débito/crédito, adquirente, referência não sensível da transação, valor bruto, taxas, parcelas e estado/data do repasse; importação ou registro de extrato.
- **Para conciliação de canal:** bruto do pedido, comissão, taxas, ajustes, reembolso, repasse previsto e efetivamente recebido, com referência externa.
- **Para reembolsos:** entidade/registro próprio ligado ao pagamento original e estado do reembolso. Reembolso em dinheiro deve gerar a saída física correspondente uma única vez; Pix/cartão precisam de acompanhamento separado da gaveta.

### Regras para números confiáveis

1. Recalcular esperado a partir das fontes de verdade no backend; o navegador não decide o saldo final.
2. Persistir valores monetários em centavos ou aplicar arredondamento consistente no limite de cada operação.
3. Usar idempotência para fechamento, sangria, suprimento, pagamento e importação de extrato.
4. Serializar movimento/fechamento da mesma sessão para evitar concorrência e saldo negativo.
5. Não misturar sessões abertas com totais de sessões encerradas em diferença consolidada.
6. Toda métrica deve mostrar período, fuso/data operacional, status de confirmação e origem dos dados.
7. Exportações devem incluir filtros aplicados, data de geração e identificador da sessão; preservar auditoria e permissões.

## Observação sobre a versão atual analisada

No repositório analisado, o relatório de fluxo de caixa já resume sessões, fundo, vendas em dinheiro, esperado, contado e diferença. Entretanto, não identifiquei no modelo atual a discriminação de contagem por denominação, uma entidade completa de liquidação por adquirente/canal nem `business_date` explícito para o turno. Portanto, as seções de cartão detalhado, marketplace líquido e data operacional deste modelo devem ser tratadas como **alvo de evolução**, não como dados já garantidos pela implementação atual.
