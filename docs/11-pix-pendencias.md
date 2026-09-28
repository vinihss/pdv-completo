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

## 2. `analyzePixKey` — tipo deduzido, checksum só avisa

O tipo da chave Pix é dedutível do próprio formato, então a geração do payload
**não depende** de `store_settings.pixKeyType`. Chave salva com máscara
(`519.914.324-85`, `+55 (51) 99143-2485`, `11.222.333/0001-81`) é
canonicalizada na hora de montar o BR Code.

Duas decisões deliberadas:

- **11 dígitos é ambíguo** — CPF e celular no formato nacional têm exatamente o
  mesmo formato. O padrão é tratar como **CPF**; quem quiser telefone digita o
  `+55` e cai no ramo de E.164.
- **Dígito verificador errado é aviso, nunca reclassificação.** A tentação é
  "CPF válido → cpf, senão → telefone", e isso é perigoso: um CPF digitado
  errado viraria uma chave de telefone *válida*, e o cliente pagaria para o
  número de outra pessoa. Falha muito pior do que o app do banco recusar o QR.
  O aviso aparece no modal do `PixQrScreen`, que não trava a geração.

## 3. Pendências

### 3.1 Normalizar a chave também no `PATCH /store-settings`

Hoje a sanitização acontece **só na hora de gerar o QR**
(`store-settings.usecases.ts:80` valida `merchantName`/`merchantCity` mas
salva `pixKey` cru). Funciona, mas o banco guarda lixo e qualquer consumidor
futuro do `pix_key` vai ler a chave com máscara. Normalizar no save deixa o
banco canônico; a sanitização na geração continua como rede de segurança.

### 3.2 `pixKeyType` virou campo morto

Depois de §2, o `pixKeyType` é **gravado e nunca lido** em lugar nenhum. Por
decisão explícita ficou como está (não quebrar o banco de quem já salvou uma
instalação), mas as opções são: remover o `select` de `SettingsTab.jsx:286` e
a coluna, ou passar a exibi-lo como **derivado** do valor, mostrando ao gerente
o que o sistema deduziu. Se remover a coluna, precisa de migration `0004_*`
com `DROP COLUMN IF EXISTS`.

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
