# Pix — pendências e o que ficou para trás

Complementa a seção 12 de `01-backend-spec.md` (que descreve o BR Code estático
gerado no client). Este arquivo é o **resto** do trabalho: o que ficou para
trás depois da correção do payload em 28/09/2026, e o que ainda não foi feito.

O fluxo completo (registrar pagamento Pix como `confirmed=false`, exibir o QR,
confirmar no extrato) está em `01-backend-spec.md` §12 e **funciona**. O que
segue é dívida.

---

## 1. Correção do payload (feito em 28/09/2026)

O app do banco recusava o QR. A causa não era o CRC nem a estrutura TLV — o
CRC-16/CCITT-FALSE estava correto (check value `29B1` para `"123456789"`) e
todos os campos declaravam o tamanho certo. Eram duas violações do padrão BR
Code, ambas suficientes para o leitor recusar o payload:

| Campo | Antes | Depois |
|---|---|---|
| `26.00` (GUI) | `BR.GOV.BCB.PIX` | `br.gov.bcb.pix` |
| `62.05` (txid) | `3f2b1c4d-5e6f-4a1b-8c2d-3` | `3F2B1C4D5E6F4A1B8C2D3E4F` |

- A GUI é definida em **minúsculas** pelo BACEN; leitores detectam o Pix pelo
  prefixo `0014br.gov.bcb.pix`. (`01-backend-spec.md` §12 já documentava em
  minúsculas — a implementação divergia da spec.)
- O txid tem de ser de 1 a 25 caracteres **alfanuméricos**. A `order.id` é um
  `crypto.randomUUID()`, ou seja, 36 caracteres **com hífens**, que reprova na
  validação de padrão.

Além disso, no mesmo commit (`entities/payment/lib/pix.js`):

- **Teto de 99 bytes no TLV.** `field()` escrevia o comprimento sem ceiling: com
  chave de e-mail/EVP (36+ bytes) e descrição de 40, o campo `26` ficava com
  129 bytes e o cabeçalho de 2 dígitos virava `26129…`, corrompendo o payload
  inteiro. Agora a descrição é cortada no que sobra dos 99 bytes e a chave que
  não cabe é recusada com erro, em vez de gerar BR Code inválido.
- **`ascii()` de verdade.** Removia diacríticos mas deixava passar o resto do
  não-ASCII — o travessão do rótulo de comanda sem mesa (`orderLabel()`,
  `order.js:12`) saía cru como 3 bytes UTF-8. Agora reduz a `U+0020–U+007E`.
- **Campo `54` opcional.** Vazio significava `NaN` no payload; vazio agora
  omite o campo, que é o que o padrão quer ("qualquer valor").
- **Dígito verificador como aviso, nunca como roteador** — ver §2.
- Suíte nova `entities/payment/lib/pix.test.js` (22 testes), com parser de TLV
  no próprio teste: é a única forma de pegar o comprimento de 3 dígitos, que
  nenhuma asserção de string pegaria.

## 2. `analyzePixKey` — o tipo vem das configurações

`analyzePixKey(raw, typeHint)` usa `store_settings.pixKeyType` como
**autoritativo**: é o gerente quem diz se a chave é telefone ou CPF, e os
formatos se cruzam — CPF e celular no formato nacional têm exatamente os mesmos
11 dígitos, então deduzir "11 dígitos = CPF" transformava o telefone do gerente
num BR Code sem DDI, e o app do banco respondia **"CPF inválido"**. Era o tipo
que estava morto, não o gerente: o `select` da tela era salvo no banco e nunca
lido em lugar nenhum.

Três decisões:

- **O tipo escolhido manda quando o valor é compatível.** Só quando não cabe é
  que a dedução pelo formato assume (CPF 11 dígitos, CNPJ 14, e-mail com "@",
  telefone em E.164, EVP é UUID), e aí a divergência vira aviso. O caminho
  inverso é proibido: um tipo incompatível não pode "forçar" a chave.
- **Sem tipo, 11 dígitos continua sendo CPF** — não há como desempatar, e o
  padrão é o que não manda dinheiro para o número de outra pessoa.
- **Dígito verificador errado é aviso, nunca reclassificação.** A tentação é
  "CPF válido → cpf, senão → telefone", e isso é perigoso: um CPF digitado
  errado viraria uma chave de telefone *válida*. O aviso aparece no modal do
  `PixQrScreen`, que não trava a geração.

O telefone sai sempre em **E.164**, porque o DDI é obrigatório: 10 dígitos
(DDD + fixo) e 11 dígitos (DDD + celular) recebem o `+55`; 12+ dígitos já com o
`55` mantêm o `+`; máscara e parênteses são removidos. O 11 dígitos fora do
padrão de celular (3º dígito ≠ 9) assume `+55` **com aviso** — o gerente
escolheu "telefone", então a intenção dele manda, mas dizemos na tela que o
formato é ambíguo. A prévia do que será gerado fica em
`SettingsTab.jsx` (`PixKeyPreview`), para o erro aparecer no cadastro e não só
na hora de cobrar.

A suíte `entities/payment/lib/pix.test.js` fixa a dedução sem tipo; o caminho
com tipo é coberto pela prévia da tela de Configurações e pelo `buildPixPayload`
do `PaymentModal` (que repassa `pixKeyType` para o `PixQrScreen`).

## 3. Pendências

### 3.1 ~~Normalizar a chave também no `PATCH /store-settings`~~ — feito em 29/09/2026

`backend/src/domain/pix-key.ts` (`canonicalizePixKey`) canonicaliza a chave no
`PUT /store-settings`, e agora ela sabe o tipo: telefone sai em E.164,
documento só em dígitos, e-mail em minúsculas, EVP em minúsculas. O `pixKeyType`
é o que desempata, e o resto é o mesmo.

Duas decisões, para o `PUT` não virar porta de entrada de erro:

- **Chave incompatível com o tipo volta como veio** (`canonical ?? raw`). Recusar
  o `PUT` inteiro bloquearia o gerente de salvar as outras configurações por um
  erro de um campo, e descartar o que ele digitou seria pior. A divergência
  vira aviso na geração do QR, no lugar certo.
- **Dígito verificador não recusa save.** É aviso, igual no client — e
  reclassificar a chave seria pior do que o app do banco recusar o QR.

A regra existe em **dois lugares** de propósito: `domain/pix-key.ts` (o que
entra no banco) e `entities/payment/lib/pix.js` (o que monta o BR Code, que é
gerado no client). Instalação com chave já salva com máscara continua
funcionando pela segunda. Mudou uma, mude a outra.

Cobertura: `test/pix-key.test.ts` (6 testes, round-trip pela API + leitura da
coluna) e `entities/payment/lib/pix.test.js` (30 testes, incluindo o
caso do bug: 11 dígitos com `pixKeyType: "phone"` → `+5551991432485` no
campo `26.01`).


### 3.2 ~~`pixKeyType` virou campo morto~~ — resolvido em 29/09/2026

O campo é **lido**: `analyzePixKey` e `buildPixPayload` recebem
`store_settings.pixKeyType` e ele é autoritativo (ver §2). O `select` da tela
passou a mostrar o rótulo em PT-BR e ganhou a prévia do tipo efetivo. A coluna
`pix_key_type` segue no schema — **não** remover sem migration `0005_*` com
`DROP COLUMN IF EXISTS`, porque ainda é a fonte da verdade do que o gerente
escolheu.

### 3.3 Quiet zone do QR

`PixQrScreen.jsx` chama `QRCode.toDataURL(payload, { width: 220, margin: 1 })`.
A zona de silêncio padrão é 4 módulos; com 1 o leitor tem menos margem, o que
pode atrapalhar a câmera em tela suja ou com brilho. O elemento tem `p-2`
branco em volta, o que atenua na prática, mas o certo é `margin: 2` ou `4`.

### 3.4 "Pix copia e cola"

A tela mostra só o QR. Expor o BR Code em texto (copia e cola) é o fallback
operacional padrão quando o cliente não consegue escanear: o app do banco
aceita colar. Baixo custo, resolve uma parte relevante dos "não funcionou".

### 3.5 Especificação

`01-backend-spec.md` §12 está correto na GUI (minúsculas, linha 911) e já
remetia o txid a `order.id` "truncado/formatado conforme spec" (linha 921). As
regras que o código agora cumpre valem para o próximo que mexer no arquivo:
teto de 99 bytes por TLV, txid alfanumérico ≤ 25, `54` omitido quando vazio.

## 4. Como testar de verdade

O CPF usado durante o diagnóstico, `51991432485`, **não é um CPF válido** — os
dígitos verificadores deveriam ser `7` e `0`, e a chave tem `8` e `5`. Serve
como fixture estrutural (é o que a suíte usa), mas um app de banco real vai
recusá-la, porque o CPF não existe no registro do BCB.

Para conferir pagamento de ponta a ponta, use uma chave Pix sua em
Configurações → Pix (QR local) e feche uma comanda como Pix. O caminho feliz
esperado: QR escaneia, valor bate com o pedaço, e a confirmação manual pelo
gerente fecha a comanda.
