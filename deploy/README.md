# Deploy em nuvem — passo a passo

Este runbook sobe o sistema completo (backend + frontend + HTTPS automático)
num único servidor Docker. Qualquer VPS com Docker serve — os passos abaixo
usam Ubuntu 22.04 genérico, funcionam igual na Hetzner, DigitalOcean,
Contabo, etc.

## Por que essa abordagem

O backend já está pronto e testado com PostgreSQL (o único banco suportado).
Rodar esse mesmo stack num servidor na nuvem, em vez de num mini-PC dentro do
estabelecimento, já resolve o pedido — "os garçons acessam de qualquer
lugar" — sem precisar trocar nada no código. Um único servidor pequeno
(com o container `postgres` do compose ao lado) aguenta tranquilamente o volume
de um restaurante/pub (ver §15 do backend spec: "dezenas de comandas
simultâneas, não milhares").

Se um dia isso precisar atender **múltiplos estabelecimentos** ou escalar
horizontalmente, aí sim vale migrar pro modo `cloud` (Postgres) da spec —
mas isso é trabalho adicional não incluído aqui.

## Pré-requisitos

1. Um servidor com **Docker** e **Docker Compose** instalados (`curl -fsSL https://get.docker.com | sh`)
2. Um **domínio** (ou subdomínio) com o DNS já apontando (registro `A`) pro
   IP do servidor — o Caddy precisa disso resolvendo *antes* de subir, pra
   conseguir emitir o certificado TLS automaticamente
3. Portas **80** e **443** liberadas no firewall do servidor
4. Repositório clonado em um diretório fixo no VPS (ex.: `/opt/pdv-completo`)

> ⚠️ A pipeline abaixo é para **Hostinger VPS** (ou servidor Linux equivalente
> com Docker + SSH). **Não use em hospedagem compartilhada/hPanel sem Docker e
> sem acesso SSH adequado**.

## DNS obrigatório (por que o HTTPS não sobe)

O Caddy emite o certificado do Let's Encrypt por desafio **HTTP-01**: a
autoridade certificadora resolve o domínio e tenta abrir a porta 80 do
servidor. Se o nome **não apontar para o IP do servidor**, o desafio falha e
**nenhum certificado é emitido** — o Caddy fica respondendo só em HTTP, sem
nenhum erro fatal no log.

Checagem rápida do sintoma: no log do Caddy, a linha

```
"enabling automatic TLS certificate management","domains":["app.umamisushiarte.com.br"]
```

lista **só** os nomes que consequenceiram certificado. Os que faltarem dessa
lista (e seus erros `failed to obtain certificate` no log) são os que o DNS
ainda não resolve para o servidor.

Para o domínio do exemplo, crie estes registros **A** no registrador, todos
apontando para o IP público do VPS:

| Registro | Aponta para | Serve |
|---|---|---|
| `umamisushiarte.com.br` | IP do VPS | redirect para o WhatsApp (`wa.me`) |
| `www.umamisushiarte.com.br` | IP do VPS | redirect para o WhatsApp (`wa.me`) |
| `app.umamisushiarte.com.br` | IP do VPS | **a aplicação (PDV)** |

O domínio raiz **não** serve o app — ele redireciona (302, temporário) para o
**WhatsApp** da casa (`wa.me`, link com o número em texto). Quem for usar o PDV
(garçons, cozinha, gerente) entra por **`app.`**; quem digitar o domínio sem
`app.` cai no WhatsApp, que é o canal de contato/vendas. Como o `redir` é do
site inteiro no Caddy, qualquer caminho no domínio raiz (inclusive
`/cardapio/do-acao`) cai no mesmo link — o path da requisição não vaza para o
`Location`. O redirect é **temporário** (302) de propósito: o 308
(`permanent`) fica cacheado no navegador e mascara a mudança — quem já tinha
visitado o domínio continuaria indo para o destino antigo até limpar o cache.
Por isso, se o número do WhatsApp mudar depois, basta editar o `redir` e
recarregar. Valide sempre com `curl -sI` e só considere `permanent` quando o
destino estiver definitivo:

```bash
curl -sI https://umamisushiarte.com.br | grep -i location
```

Depois de criar/alterar, é só recarregar o Caddy — ele pega os certificados
sozinho, sem reiniciar containers:

```bash
# Pelo caddy-assemble.sh, e NÃO um `caddy reload` direto: quem resolve os
# upstreams (o ponteiro e a flag WS_BACKEND) é o script, e um reload
# cru pula essa resolução — o /realtime* voltaria sozinho para o backend
# Node, sem erro em lugar nenhum. (O caminho `/etc/caddy/Caddyfile` do
# comando antigo também não existe neste stack: a config é montada em
# /srv/pdv-deploy/Caddyfile.)
docker compose exec caddy sh /srv/pdv-deploy/caddy-assemble.sh reload
```

> ⚠️ **O `umamisushiarte.com.br` e o `www` compartilham um único certificado**
> (estão no mesmo bloco do `Caddyfile`). Se o registro do domínio raiz não
> existir, a emissão do par inteiro falha e o `www` fica sem TLS também.
> Crie **os dois**, mesmo que hoje só o `app.` seja usado.

Verifique o resultado:

```bash
echo | openssl s_client -connect SEU_IP:443 -servername app.seudominio.com.br 2>/dev/null \
  | openssl x509 -noout -subject -ext subjectAltName
```

### `CORS_ORIGIN` tem que incluir o endereço real do app

O backend bloqueia, via CORS, qualquer origem que não esteja em
`CORS_ORIGIN`. **Todo endereço que serve o app precisa estar na lista** —
esquecer o `www.` (ou o subdomínio `app.`) faz o app carregar mas **toda
chamada de API ser bloqueada pelo navegador**, sem erro visível no servidor.

O `docker-compose.yml` usa `CORS_ORIGIN=${CORS_ORIGIN:-https://${DOMAIN}}`,
então a lista completa vai no `.env`, separada por vírgula e **sem espaços**.
Aqui só entram os endereços que **servem o app** — o domínio raiz e o `www.`
redirecionam para o WhatsApp (não servem o app), então não precisam (e não
devem) estar na lista:

```
CORS_ORIGIN=https://app.umamisushiarte.com.br
```

**App desktop (Tauri) entra na lista também.** O app roda na origem
`tauri://localhost` (Linux) e `http://tauri.localhost` (Windows), que não é o
domínio de ninguém — sem as duas entradas o app abre mas **toda chamada de API
é bloqueada** (mesmo sintoma: tela carrega, lista de usuários não vem):

```
CORS_ORIGIN=https://app.umamisushiarte.com.br,tauri://localhost,http://tauri.localhost
```

Conferir se entrou, sem abrir o app:

```bash
curl -s -D- -o /dev/null -X OPTIONS \
  -H 'Origin: tauri://localhost' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: authorization,content-type' \
  https://app.seudominio.com.br/api/auth/login | grep -i access-control-allow-origin
# esperado: access-control-allow-origin: tauri://localhost
```

Depois de mudar, o container precisa ser recriado (variável de ambiente não é
reconhecida em hot reload — `docker compose restart backend` **não** basta,
ele reinicia com o env antigo):

```bash
docker compose up -d --force-recreate backend
```

Teste com um `Origin` de verdade — `curl` sem header não exercita o CORS:

```bash
curl -s -o /dev/null -D - -H "Origin: https://app.seudominio.com.br" \
  https://app.seudominio.com.br/api/auth/users | grep -i access-control-allow-origin
```

### `Caddyfile` não atualiza sozinho (bind mount de arquivo)

> **Resolvido.** O Caddy agora recebe o **diretório** `deploy/` montado
> (`./:/srv/pdv-deploy:ro`) e a config é aplicada por `caddy reload` dentro do
> container (`deploy/caddy-assemble.sh`). A armadilha do inode não existe mais
> porque o inode trocado é o de um arquivo *dentro* de um diretório montado.
> O texto abaixo fica como registro do sintoma e do porquê — ele é a razão de
> o compose montar diretório em vez de arquivo.

Sintoma (na configuração antiga): você edita o `deploy/Caddyfile`, roda
`docker compose up -d`, e **nada muda**. Sem erro no log, health check
passando, certificado emitido — só a config antiga continua valendo.

Por quê: o compose montava o Caddyfile como **arquivo único**
(`./Caddyfile:/etc/caddy/Caddyfile:ro`). O Compose calcula o hash do container a
partir do *spec* do mount (caminho, alvo, modo) e **nunca do conteúdo do
arquivo**. Logo, editar o Caddyfile não muda o hash e o container não é
recriado. Pior: `git pull`/`git checkout` substitui o arquivo por um **inode
novo**, e o container continua preso ao inode antigo — que segue aberto e
sendo servido normalmente.

O sintoma é silencioso justamente porque nada falha. Para conferir se o
container está com a versão certa:

```bash
# tem que dar o MESMO hash dos dois lados
md5sum deploy/Caddyfile
docker exec deploy-caddy-1 md5sum /srv/pdv-deploy/Caddyfile
```

Formas de resolver na configuração antiga (as duas continuam válidas se
alguém montar arquivo em vez de diretório):

```bash
# 1) recriar o container (o que a CI fazia, ~2s de proxy fora do ar)
docker compose -f deploy/docker-compose.yml up -d --force-recreate caddy

# 2) sobrescrever o arquivo SEM trocar o inode, e dar reload (zero downtime)
cat /caminho/do/Caddyfile.novo > deploy/Caddyfile
docker exec deploy-caddy-1 sh /srv/pdv-deploy/caddy-assemble.sh reload
```

O que **troca** o inode (e portanto quebra o bind mount de arquivo) e o que
**não** troca, medido em Linux:

| Comando | Inode | O container passa a ver a config nova? |
|---|---|---|
| `cat novo > Caddyfile` | preservado | sim, na hora (e o `reload` é opcional) |
| `cp novo Caddyfile` (destino existe) | preservado | sim, na hora |
| `cp --remove-destination` | **novo** | só depois de restart/recreate |
| `mv novo Caddyfile` | **novo** | só depois de restart/recreate |
| `git pull` / `git checkout` | **novo** | só depois de restart/recreate |

O ponto central: `docker compose up -d` **não** faz nada nesse caso, porque
para ele nada mudou (o hash do container não depende do conteúdo do arquivo).
Esse é o bug — o `up` não reclama e não loga nada. Já `docker compose restart
caddy` **resolve**, porque o Docker reaplica o bind mount no start do
container; `--force-recreate` também resolve. Medido no VPS de produção:

```
host 80ee0b41…  container 3fddb7cd…   <- divergentes (bug)
após restart            80ee0b41…   <- restart já resolve
após --force-recreate   80ee0b41…   <- idem
```

**Hoje:** confira com o `md5sum` dos dois lados depois de mexer no Caddyfile,
mas o `switch.sh` já aplica a config nova por `reload` como parte do deploy.


## Deploy automático por tag (GitHub Actions → Hostinger VPS)

O repositório possui o workflow **`.github/workflows/deploy-on-tag.yml`** com:

- gatilho em **push de tags** no formato `v*.*.*` (ex.: `v1.2.0`);
- validações antes do deploy:
  - backend: `npm ci`, `npm run build`, `npm run test`;
  - frontend: `npm ci`, `npm run lint`, `npm run build`, `npm run test`;
- job **Windows** (`build-desktop`): gera os instaladores da família
  standalone (PDV Caixa + KDS Cozinha) assinados, monta o manifesto do
  auto-update de cada app e publica os artefatos — ver
  [Auto-update do app desktop](#auto-update-do-app-desktop);
- deploy remoto por SSH com backup prévio e health check;
- deploy **sem downtime** com `deploy/switch.sh` (instância nova ao lado da
  atual, healthcheck como portão, troca de upstream por `caddy reload` — sem
  `down -v`, sem recriar o proxy, preservando o volume do Postgres e dos
  uploads). Ver [Deploy sem downtime](#deploy-sem-downtime-switch-azulverde).

O `deploy` só roda depois de `build-desktop`: o manifesto do update nunca
chega ao servidor antes do backend no ar. A versão publicada é a do
`tauri.conf.json` de **cada crate** da família (conferida contra o
`Cargo.toml` do crate), não a tag — a tag é do app v1/backend, e cada
app da família tem sua própria versão.

### O instalador é o `build-desktop.yml` (também dá para rodar sozinho)

O job Windows acima **não tem steps próprios**: ele chama
**`.github/workflows/build-desktop.yml`**, que é a definição única dos
instaladores da família standalone. O workflow builda os dois apps
desktop (PDV Caixa + KDS Cozinha) em uma matriz; os mobile (Garçom,
Entregador) não buildam no runner Windows — o alvo deles é Android/iOS,
e o build de mobile exige toolchain que não está no runner.

O mesmo arquivo tem `workflow_dispatch`, então dá para gerar só o
instalador quando quiser, sem tag e sem deploy do backend:

1. aba **Actions** → **Instalador Windows (Tauri)** → **Run workflow**;
2. escolha a branch/commit (o `.exe` sempre sai daquele código);
3. `publicar_no_servidor`:
   - **marcado** — assina, cria/atualiza a release e publica o
     `latest.json` + instalador de cada app em `deploy/updates/<app>/`.
     É o que faz o auto-update funcionar; use como padrão;
   - **desmarcado** — gera e anexa na release do GitHub, mas **não serve
     o manifesto**: o app instalado não vai encontrar essa versão. Serve
     para conferir que o build do runner Windows continua funcionando sem
     mexer no que está no ar.
4. `nota` é opcional e aparece como observação do update no app.

Dois avisos sobre essa porta:

- A release é nomeada pela **tag** (entrada por tag) ou pela **versão do
  PDV** (disparo manual). O run avisa quando veio de branch, e a release
  aponta para o commit exato que assinou o artefato (`--target`).
- Rodar duas vezes a mesma versão no modo padrão **sobrescreve** o
  manifesto servido. Só faça isso de novo quando quiser que o app instalado
  passe a ver aquela versão.

O `.github/workflows/desktop-windows.yml` é **legado**: gera `.msi`/`.exe`
em release rascunho, sem assinatura e sem publicar o manifesto. Não é o
caminho de publicação.

O app v1 (`frontend/src-tauri`, em produção) tem o seu próprio script de
build: **`frontend/src-tauri/build-app.sh`**. Ele confere a versão do
`tauri.conf.json` contra o `package.json`, resolve a assinatura (chave de
entrega vs chave local descartável) e gera o instalador.

### Como usar

1. Crie uma tag semântica: `git tag v1.0.0 && git push origin v1.0.0`
2. O workflow roda automaticamente: testes → backup → deploy → health check
3. Acompanhe na aba **Actions** do repositório

### Quem cria a tag: o `release.yml` (e por que ele precisa de PAT)

Hoje a tag **não precisa ser criada à mão**: o merge na `main` dispara
**`.github/workflows/release.yml`**, que roda o Semantic Release e publica
tag, release e changelog. O passo 1 acima é o caminho manual, que continua
valendo (e é o escape quando o versionamento automático não roda).

Só que o push da tag do Semantic Release **precisa de um PAT** para acordar
o `deploy-on-tag.yml`: o GitHub não dispara workflows a partir de eventos
criados com o `GITHUB_TOKEN` do próprio Actions (trava anti-recursão), e o
release usava só ele. O sintoma era silencioso — run verde, tag e release
publicadas, produção parada: entre `v1.18.0` e `v1.21.0` nenhuma tag
disparou deploy, e a `v1.21.0` só entrou em produção quando a tag foi
apagada e re-pushada à mão. O `release.yml` agora usa
`SEMANTIC_RELEASE_TOKEN` com fallback para `GITHUB_TOKEN`: **sem o secret o
release continua publicando** (o versionamento automático nunca para) e só
o deploy não dispara — por isso o fallback é deliberado e não deve ser
removido. O bloco `permissions:` do `release.yml` não resolve o problema
(a trava vale em qualquer escopo) e não deve ser mexido por causa disso.

### Secrets necessários no GitHub Actions

Configure em **Settings → Secrets and variables → Actions**:

- `HOSTINGER_HOST` (IP ou domínio do VPS)
- `HOSTINGER_PORT` (opcional; se ausente/vazio usa `22`)
- `HOSTINGER_USER` (usuário SSH)
- `HOSTINGER_SSH_KEY` (chave privada OpenSSH/PEM)
- `HOSTINGER_APP_PATH` (caminho absoluto do clone no VPS, ex.: `/opt/pdv-completo`)
- `HOSTINGER_SSH_FINGERPRINT` (opcional, recomendado; `SHA256:...` do host — ver abaixo)
- `TAURI_SIGNING_PRIVATE_KEY` (chave Ed25519 do auto-update — ver abaixo)
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (senha dessa chave)
- `UPDATE_BASE_URL` (opcional; padrão `https://app.umamisushiarte.com.br`)
- `SEMANTIC_RELEASE_TOKEN` (PAT com escopo `contents: write`, só para o
  `release.yml`; sem ele a tag é publicada mas o deploy **não** dispara —
  ver a seção acima)

```bash
gh secret set SEMANTIC_RELEASE_TOKEN --repo <owner>/<repo>
```

### Auto-update do app desktop

Os apps Windows (Tauri) perguntam por update no boot. Rotas no Caddy:

| Rota | O que serve |
|---|---|
| `/updates/desktop/<target>/<arch>/<versão-atual>` | app v1 (produção): sempre o mesmo `latest.json` |
| `/updates/caixa/<target>/<arch>/<versão-atual>` | PDV Caixa: sempre o mesmo `latest.json` |
| `/updates/kds/<target>/<arch>/<versão-atual>` | KDS Cozinha: idem (quando tiver updater) |
| `/updates/files/<app>/windows-x86_64/...` | os artefatos (installer `.exe`, `.exe.zip`, `.sig`) de cada app |

Cada app tem seu manifesto e seus artefatos em um diretório separado — se
PDV e KDS publicassem no mesmo `latest.json`, um consumiria o update do
outro (o updater do PDV baixaria o instalador do KDS).

> ⚠️ **Não mude o prefixo `/updates/desktop/`** — é o endpoint que o app v1
> (`frontend/src-tauri`, em produção) tem hardcoded no
> `plugins.updater.endpoints`. Mudar quebra o auto-update de tudo que está
> instalado.

Os arquivos vivem em `deploy/updates/` no servidor (bind mount somente-leitura
em `/srv/pdv-updates`) e são publicados pelo job `build-desktop` via SSH. O
diretório está no `.gitignore` e **precisa existir no servidor com o dono do
usuário de deploy** — `switch.sh` (`ensure_updates_dir`) e `install.sh` já
criam e checam isso, porque o bind mount do Caddy criaria o diretório como
root e o `scp` do CI falharia com *permission denied*.

O **mesmo `.exe` é o que o cliente baixa**: `/updates/files/…` não é
exclusivo do updater — é o canal de download do instalador, público, sem
conta. O `latest.json` é o que o app consulta sozinho; o `.exe` é o que a
pessoa baixa com o mouse.

A chave de assinatura é a parte que importa: **sem o secret
`TAURI_SIGNING_PRIVATE_KEY` o job Windows falha**, e é o que impede qualquer
terceiro de assinar um update falso para o app. A senha é obrigatória junto:
sem ela no ambiente, o CLI tenta perguntar por prompt e o build quebra no
runner, que não tem terminal. A chave pública correspondente já está no
`frontend/src-tauri/tauri.conf.json` (`plugins.updater.pubkey`).

```bash
# gerar um par novo (o público vai no conf, o privado no secret)
cd frontend
npx tauri signer generate -w /caminho/seguro/pdv.key -p 'senha-forte'
gh secret set TAURI_SIGNING_PRIVATE_KEY --repo <owner>/<repo> < /caminho/seguro/pdv.key
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --repo <owner>/<repo> <<< 'senha-forte'
```

Guarde a chave e a senha **fora do repositório e fora do runner**: quem perde
não consegue mais assinar versão nenhuma, e o app fica preso na versão em
disco. Detalhes e o caminho completo em `docs/11-desktop-instalador.md` §6.

### Chave SSH do deploy (sem expor segredo)

No seu computador local:

```bash
ssh-keygen -t ed25519 -C "github-actions-deploy" -f ~/.ssh/pdv_hostinger_deploy
```

1. Adicione `~/.ssh/pdv_hostinger_deploy.pub` em `~/.ssh/authorized_keys` do
   usuário do VPS (`HOSTINGER_USER`).
2. Copie o conteúdo de `~/.ssh/pdv_hostinger_deploy` para o secret
   `HOSTINGER_SSH_KEY`.
3. **Nunca** comite chave privada no repositório.

### Verificação da host key do SSH (fingerprint)

No seu computador local:

```bash
ssh-keyscan -p 22 SEU_HOST_OU_IP | ssh-keygen -lf -
```

Cada linha é um tipo de chave. O `ssh-action` confere a chave que o cliente
SSH dele realmente negocia, cuja preferência é `ecdsa-sha2-nistp256` >
`rsa-sha2-256/512` > `ssh-rsa` > `ssh-ed25519` — **não** use a linha
`ed25519`. Copie o `SHA256:...` da linha `ecdsa-sha2-nistp256` para o secret
`HOSTINGER_SSH_FINGERPRINT`.

Sem esse secret o deploy funciona igual, mas **não confere a host key**: quem
estiver no meio da rede e se fizer passar pelo servidor recebe a chave privada
de produção. Com ele, um valor errado derruba o job no handshake (antes de
qualquer comando rodar) com `ssh: host key fingerprint mismatch`.

O mesmo secret vale para a **publicação do instalador**
(`.github/workflows/build-desktop.yml`): lá a verificação cobre os três steps
de appleboy do job `publish` (o `mkdir`, o `scp` e o ajuste de layout), e não
só o `deploy` — sem o secret, nenhuma das duas rotas confere a host key.

> ⚠️ `HOSTINGER_KNOWN_HOSTS` **não verifica nada**: `known_hosts` não é um
> input do `appleboy/ssh-action@v1`, então a action o ignora — avisando
> "Unexpected input(s) 'known_hosts'" no log — e o deploy segue. O secret
> pode ser removido do repositório; ele não substitui o fingerprint.

### Setup inicial do VPS para uso da pipeline

```bash
sudo apt-get update
sudo apt-get install -y git
curl -fsSL https://get.docker.com | sh

sudo mkdir -p /opt/pdv-completo
sudo chown -R "$USER":"$USER" /opt/pdv-completo
git clone https://github.com/vinihss/pdv-completo.git /opt/pdv-completo
cd /opt/pdv-completo

# Diretório de artefatos dos apps Windows (instalador + latest.json). Precisa
# existir COM O DONO CERTO antes do primeiro `docker compose up`: o compose
# monta ./updates no Caddy, e bind mount de diretório inexistente faz o
# Docker criá-lo como root — aí o scp do job build-desktop (que roda com o
# usuário do CI, não com root) falha com "permission denied" e o instalador
# nunca chega ao servidor. O switch.sh e o install.sh já criam e checam isso;
# o comando abaixo é para um clone manual.
#
# Um diretório por app: o Caddy espera latest.json em deploy/updates/<app>/ e
# os artefatos em deploy/updates/files/<app>/windows-x86_64/ (ver Caddyfile).
# O app v1 (produção) continua no layout antigo: latest.json na raiz e
# artefatos em files/windows-x86_64/.
mkdir -p deploy/updates/files/windows-x86_64   # app v1 (produção)
mkdir -p deploy/updates/caixa                  # PDV Caixa
mkdir -p deploy/updates/files/caixa/windows-x86_64
mkdir -p deploy/updates/kds                    # KDS Cozinha
mkdir -p deploy/updates/files/kds/windows-x86_64
chown -R "$USER":"$USER" deploy/updates
```

Verificação rápida depois do primeiro deploy do app Windows:

```bash
curl -sI https://SEU_DOMINIO/updates/desktop/windows-x86_64/x86_64/1.0.2 | head -1
# 200 + o latest.json; se der 404, o diretório está vazio ou com o dono errado.
```

Crie o arquivo de produção **somente no VPS** (opcional para bootstrap local):

```bash
cp deploy/.env.example deploy/.env
nano deploy/.env
```

No deploy via GitHub Actions, o workflow agora **gera/atualiza automaticamente**
`deploy/.env` no VPS com `DEPLOY_DOMAIN` e `DEPLOY_JWT_SECRET` antes do
`docker compose up`, preservando outras variáveis já existentes no arquivo.

## Passo a passo

### Instalação do zero (recomendado)

```bash
# 1. Envie o projeto pro servidor (scp, git clone, rsync — o que preferir)
scp -r pdv/ usuario@seu-servidor:/opt/pdv

# 2. No servidor
ssh usuario@seu-servidor
cd /opt/pdv/deploy

# 3. Configure as variáveis
cp .env.example .env
nano .env
#   DOMAIN=app.seudominio.com.br
#   JWT_SECRET=<gere com: openssl rand -hex 32>
#   MERCHANT_NAME="Bar do Zé"        (opcional)
#   MERCHANT_CITY="Sao Paulo"        (opcional)
#   MANAGER_NAME="Roberto Alves"     (opcional)

# 4. Instala tudo do zero (containers + gerente + cardápio Unami)
./install.sh
```

O `install.sh` sobe os containers, aguarda o health check, cria **somente** o
usuário gerente (via `seed-prod`) e aplica o cardápio Unami (via `load-menu`).
O PIN do gerente é exibido **uma única vez** no log — anote na hora.

Depois disso, entre com esse PIN e cadastre o resto (garçons, cozinha, mesas)
pela própria tela de Configurações/Equipe — não precisa mexer no servidor de novo.

A partir daí, **toda atualização é pelo `switch.sh`** (deploy sem downtime):

```bash
cd /root/pdv-completo && git pull && cd deploy && ./switch.sh
```

### Reset total (começar do zero)

Se precisar apagar **todos** os dados e recomeçar:

```bash
./deploy/reset.sh          # pede confirmação
./deploy/reset.sh --force  # pula confirmação
./deploy/install.sh        # instala do zero
```

**Atenção:** o `reset.sh` remove containers, imagens e volumes. Todos os dados
(comandas, cadastros, cardápio) são perdidos de forma irreversível.

### Passo a passo manual (alternativo)

```bash
# Subir containers
docker compose up -d --build

# Criar somente o gerente (uma única vez)
docker compose exec backend node dist/infra/db/seed-prod.js

# Aplicar cardápio Unami (explícito, não automático)
docker compose exec backend node dist/infra/db/load-menu.js
```

Depois desses passos, `https://app.seudominio.com.br` já serve o app com certificado
válido, e a API responde em `https://app.seudominio.com.br/api/...`.

## Seed de demonstração vs. seed de produção

- **`seed.ts`** (`npm run seed`) — só pra desenvolvimento local. Cria usuários
  fictícios (Ana, Carlos, Roberto, Estação Cozinha) com PINs conhecidos e um
  cardápio de exemplo. **Nunca rode isso num deploy real** — os PINs de teste
  ficam documentados no código-fonte.
- **`seed-prod.ts`** (`npm run seed:prod`, ou `node dist/infra/db/seed-prod.js`
  já compilado) — cria só `store_settings` com os dados reais do estabelecimento
  e um usuário gerente com PIN aleatório, sem nenhum dado fictício. É o script
  que a imagem de produção do backend já inclui (compilado junto com o resto do
  `dist/`), sem precisar instalar `tsx` na imagem final.
- **`load-menu.ts`** (`node dist/infra/db/load-menu.js`) — aplica o cardápio
  Unami (`seed-data/menu-unami.sql`) de forma **explícita**, sob demanda. Não
  roda automaticamente no boot. O `install.sh` chama esse script após o
  seed-prod.

## WhatsApp (opcional)

A aba **WhatsApp** do gerente usa o [Embedded Signup da Meta](../docs/10-whatsapp-embedded-signup.md).
Nada de obrigatório: sem estas variáveis a aba mostra "não configurado" e o
resto do sistema funciona igual.

No `.env` do deploy (`deploy/.env`), acrescentar:

```
META_APP_ID=<id do app da Meta>
META_APP_SECRET=<segredo do app>
WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID=<config_id do Embedded Signup v4>
WHATSAPP_VERIFY_TOKEN=<valor aleatorio seu>
```

A URL de callback cadastrada no painel da Meta é
`https://<DOMAIN>/webhooks/whatsapp` — **sem o `/api`**. Os três Caddyfiles
já têm a rota `/webhooks/*` apontando para o backend; se você customizar o
seu, ela é obrigatória, senão a Meta não consegue validar o callback e o
PDV não recebe resposta nem status de entrega.

O que é do app (as variáveis acima) vale para qualquer loja que se conectar
nele. O token do WhatsApp em si é **por loja** e fica no banco
(`whatsapp_connection`), criado pelo próprio popup de conexão.

Pré-requisitos do lado da Meta (App Review, permissões, número novo) estão no
doc do módulo.

## Backup (não pule esta parte)

O banco mora no volume Docker `pdv_postgres_data` (nome explícito,
independente da pasta do compose). Sem backup, perder o volume = perder todas
as comandas e o cadastro do estabelecimento.

Use o script **`deploy/backup.sh`** — ele roda `pg_dump -Fc` no container do
Postgres, que gera um snapshot transacional **consistente sem derrubar o banco**,
e um `.tar.gz` das fotos de produto:

```bash
# um backup agora, salvo em /opt/backups/
./backup.sh /opt/backups
# → /opt/backups/pdv-AAAAMMDD-HHMMSS.dump
#   /opt/backups/pdv-AAAAMMDD-HHMMSS-uploads.tar.gz
```

O script acha o container do Postgres pelo nome padrão
(`pdv-compose-postgres-1`); se o projeto do compose tem outro nome (ou se há
mais de um Postgres no host), informe explicitamente:

```bash
PDV_PG_CONTAINER=meu-projeto-postgres-1 ./backup.sh /opt/backups
```

**Restaurar** (o `.dump` é formato custom do `pg_dump -Fc`):

```bash
docker compose stop backend
docker cp /opt/backups/pdv-AAAAMMDD-HHMMSS.dump <container-postgres>:/tmp/r.dump
docker exec -i <container-postgres> pg_restore -U pdv -d pdv --clean /tmp/r.dump
docker compose start backend
```

Baixar de um servidor remoto: `PDV_SSH_PASS=... ./backup-fetch.sh user@host`.

Cron diário sugerido:

```bash
0 3 * * * /opt/pdv/deploy/backup.sh /opt/backups
```

E **mande as cópias pra fora do servidor** (S3, Backblaze, etc.) — um cron que
só copia pro mesmo disco não protege contra o servidor inteiro sumir. Exemplo
simples de copiar pro destino externo:

```bash
0 4 * * * rclone copy /opt/backups meus3:pdv-backups/
```

## Migrando dados de uma instalação antiga (SQLite → Postgres)

Instalações feitas antes da migração para Postgres usavam um arquivo SQLite
(`data.db`) no volume `pdv_backend_data`. O app atual é **Postgres-only** —
não existe mais caminho de leitura do SQLite. Para migrar os dados de produção
(comandas, cadastros, cardápio, caixa, estoque) sem perdê-los:

```bash
# 1. Suba a stack nova com Postgres (sem derrubar a antiga ainda)
cd /opt/pdv-completo/deploy
cp .env.example .env
nano .env
#   DATABASE_URL=postgres://pdv:pdv_password@postgres:5432/pdv
#   JWT_SECRET=<gere com: openssl rand -hex 32>

# 2. Copie o data.db do volume antigo para um caminho acessível
docker run --rm -v <projeto>_backend_data:/data -v /tmp/pdv-mig:/out \
  alpine sh -c "cp /data/data.db /out/data.db && chmod 644 /out/data.db"
#   (o nome do volume tem o prefixo do projeto — `docker volume ls` mostra)

# 3. Dry-run primeiro: lê o SQLite e reporta contagens, sem escrever
docker compose exec backend \
  npx tsx src/infra/db/migrate-sqlite-to-pg.ts --db=/tmp/data.db --dry-run
#   (ou, fora do Docker: DATABASE_URL=... npm run db:migrate:sqlite -- --db=... --dry-run)

# 4. Migração de fato (uma transação, all-or-nothing)
docker compose exec backend \
  npx tsx src/infra/db/migrate-sqlite-to-pg.ts --db=/tmp/data.db
```

O script (`backend/src/infra/db/migrate-sqlite-to-pg.ts`):

- preserva **ids** (inclusive não-UUID: `system`, `singleton`, telefone,
  `cat-unami-*`), **hashes de PIN** (argon2) e a **ordem do ledger**
  (`purchase_item.seq`/`stock_movement.seq`/`outbox_event.seq` = `rowid` do
  SQLite — a média móvel de custo é um replay dessa ordem);
- converte `INTEGER 0/1` → `boolean` e normaliza timestamps
  (`YYYY-MM-DD HH:MM:SS` → ISO-8601 com `T`/`Z`/ms, formato que o app ordena
  lexicograficamente);
- pula tabelas que não existem no SQLite (ex.: iFood, se o cliente não usa)
  e **falha com mensagem clara** se houver dados que violam restrições do
  Postgres (ex.: comanda sem mesa/cliente/rótulo);
- roda em **uma única transação**: se qualquer linha falhar, nada é gravado.

**Antes de migrar:** faça backup do volume antigo (`./deploy/backup.sh` não
cobre SQLite — use `docker run --rm -v <vol>:/data -v /tmp:/out alpine cp
/data/data.db /out/data.db`). Depois de migrado e validado (login, comandas,
caixa), remova o volume `pdv_backend_data` antigo.

## Atualizando o app em produção (sem perder dados)

Dados e uploads vivem em volumes Docker **fora** dos containers — atualizar o
código não toca neles:

- **Banco**: volume `pdv_postgres_data` (container `deploy-postgres-1`)
- **Uploads**: volume `pdv_completo_deploy_backend_uploads` (ou `<projeto>_backend_uploads`)

O caminho normal é o `deploy/switch.sh` (deploy **sem downtime**, a seção
seguinte). O procedimento com `docker compose up` abaixo é o alternativo para
quando algo está quebrado no switch — ele **tem** janela de indisponibilidade.

### Procedimento seguro (alternativo, com janela de erro)

```bash
cd /root/pdv-completo

# 1. Backup rápido (segurança — não pula)
./deploy/backup.sh /opt/backups

# 2. Atualiza o código
git fetch --prune origin
git checkout -f <tag-ou-commit>

# 3. Rebuilda e recria os containers (volumes preservados)
cd deploy
docker compose up -d --build --remove-orphans

# 3b. Aplica a Caddyfile nova por reload (o `up` acima não recria o proxy,
#     porque o hash do container não depende do conteúdo do arquivo — ver
#     a seção "Caddyfile não atualiza sozinho").
docker exec "$(docker compose ps -q caddy)" sh /srv/pdv-deploy/caddy-assemble.sh reload

# 3c. Se o gateway WebSocket em Go é quem serve o /realtime (WS_BACKEND=go),
#     o `up --build` acima NÃO o reconstrói: o serviço está atrás de
#     `--profile ws-gateway` e o gateway não entra no rodízio do switch.
docker compose --profile ws-gateway build ws-gateway \
  && docker compose --profile ws-gateway up -d --no-deps ws-gateway

# 4. Valida
curl -s http://localhost:80/health
# → {"status":"ok","database":"connected"}
```

As migrations rodam automaticamente no boot do backend (ver
`src/infra/db/migrate.ts`) — não precisa rodar nada manual pra aplicar
mudanças de schema, desde que você adicione o novo arquivo `.sql` em
`backend/migrations/` antes de subir.

### Garantias

- `docker compose up -d` **sem** `-v` recria apenas os containers — volumes
  de dados e uploads intactos.
- O Postgres está com `depends_on: service_healthy` — o backend só sobe
  depois do banco pronto.
- Migrations usam advisory lock (`pg_advisory_xact_lock`) — dois boot
  simultâneos não aplicam o mesmo arquivo duas vezes.

### Via CI/CD (recomendado)

Faça push/merge na `main` ou crie uma tag semântica: o workflow
**`deploy-on-tag.yml`** faz backup prévio e chama `./deploy/switch.sh`, que é
o deploy sem downtime (o Caddy **não** é recriado; a troca de upstream é um
`caddy reload`).

### Rollback simples

Preferir o `switch.sh`, que só troca o upstream depois que a instância
anterior responde:

```bash
cd /root/pdv-completo/deploy
./switch.sh --rollback
```

Ou, para voltar o código também (imagem antiga de verdade):

```bash
cd /root/pdv-completo
git fetch --prune origin
git reset --hard <commit-ou-tag-estavel>
cd deploy
docker compose build backend frontend && docker compose up -d
```

> **Nunca** use `docker compose down -v` em produção — isso apaga os
> volumes (banco + uploads). Se precisar limpar, use `./deploy/reset.sh`
> (com confirmação) e restaure o backup.

## Deploy sem downtime (switch azul/verde)

O `switch.sh` é o caminho normal de deploy. A ideia é nunca existir um
instante em que o Caddy aponte para algo que não responde — não "quase zero de
erro", e sim **zero requisição falha** durante o deploy, inclusive com o salão em pleno
expediente.

### Como funciona

O compose tem **duas** cópias de cada serviço, com nomes diferentes e a mesma
imagem (`extends`, não cópia):

| | instância "atual" | instância "próxima" |
|---|---|---|
| backend | `backend` | `backend-next` (profile `canary`) |
| frontend | `frontend` | `frontend-next` (profile `canary`) |
| ws-gateway (Go) | `ws-gateway` | **não tem** — ver §"Gateway WebSocket em Go" |

O gateway em Go é a única exceção, e por decisão: ele é stateless (sem
migration, sem volume, sem estado em disco), então não há o que drenar
numa troca — recriar o container derrubaria as conexões abertas do mesmo
jeito que o `stream_close_delay` segura as do backend.

```
1. build da imagem nova ............ nada em produção é tocado
2. up -d backend-next frontend-next  o tráfego segue na instância atual
3. espera o healthcheck dos dois .... verde doente = ABORTA aqui, com o
                                     proxy velho no ar (nada foi trocado)
4. grava o ponteiro + caddy reload .. o proxy passa a mandar tráfego para a
                                     instância nova
5. drain (5s) e stop da antiga ...... SIGTERM drena as requisições em voo;
                                     quem estava em WebSocket reconecta em
                                     ~250ms e recarrega o estado por REST
```

O passo 3 é o portão: `/health` só responde **depois** das migrations
(`server.ts` roda `runMigrations()` antes do `app.listen`), então "healthy"
quer dizer "schema aplicado e pronto para tráfego".

### Uso

```bash
cd /root/pdv-completo/deploy

./switch.sh --status      # quem está no ar agora
./switch.sh               # switch (o que a CI chama)
./switch.sh --rollback    # volta para a instância anterior
./switch.sh --install     # primeira instalação (sobe do zero)
./switch.sh --no-build    # não rebuilida a imagem (reaproveita a tag)
```

Variáveis: `PDV_DRAIN_SECONDS` (5), `PDV_HEALTH_TIMEOUT` (120),
`PDV_PROBE_URL` (URL pública conferida logo após o reload).

O rollback é `./switch.sh --rollback`: ele **sobe** a instância que o switch
parou (`start`, não `up` — o container parado é o da imagem anterior), espera
ela ficar healthy, e só então aponta o proxy. Se ela não subir, o tráfego
continua onde estava.

### O ponteiro e a config do proxy

A Caddyfile do repo tem o upstream como variável
(`{$PDV_BACKEND_UPSTREAM:backend:3000}`). Quem decide o valor é
`deploy/state/active-upstream` — duas linhas, escrita pelo `switch.sh` e lida
pelo container do Caddy (`caddy-assemble.sh`), que monta a config efetiva
**dentro do container** e roda `caddy validate` antes de aplicar. Não existe
Caddyfile gerado no host: o do git é o que roda.

O ponteiro é versionado com o valor padrão (`backend`/`frontend`) para que o
diretório já venha com o dono certo — se ele não existisse, o Docker criaria
`deploy/state/` como root no primeiro `up` e o `switch.sh` (que roda com o
usuário do deploy) não conseguiria escrever nele. Como o switch reescreve o
arquivo a cada deploy, ele aparece como modificado no `git status` entre um
deploy e outro: isso é estado, não drift. Verificar os dois hashes ainda é
válido, o caminho é que mudou:

```bash
md5sum Caddyfile
docker exec deploy-caddy-1 md5sum /srv/pdv-deploy/Caddyfile
```

### WebSocket no reload: por que o `stream_close_delay`

O Caddy fecha **todos** os WebSockets em qualquer reload de configuração,
inclusive em rota que não mudou (limitação documentada em
[caddyserver/caddy#6420](https://github.com/caddyserver/caddy/issues/6420) e
[#7222](https://github.com/caddyserver/caddy/issues/7222)). O
`stream_close_delay 5m` no bloco `/realtime*` adia esse fechamento: quem já
estava conectado continua na instância antiga durante o drain.

Medido no stack local durante um switch: o WebSocket **não** caiu no reload
(só 3ms antes do `stop` da instância antiga, que é o comportamento esperado),
e reconectou 293ms depois. Cliente que estava na instância que **sobreviveu**
nem sente nada: a conexão nunca caiu.

### Medir antes de confiar

`probe-availability.sh` é a régua: aperta uma URL em intervalo curto durante
um deploy e reporta falhas e o maior gap.

```bash
./probe-availability.sh --url https://app.seudominio.com.br/health --seconds 120 --interval 0.2 &
./switch.sh
wait   # imprime: requisições / falhas / disponibilidade / maior gap
```

Resultado medido em 4 switches no stack local (frontend e backend, 5hz):

| run | URL | requisições | falhas | disponibilidade | maior gap |
|---|---|---|---|---|---|
| 1 | `/health` | 226 | 0 | 100,00% | 0,0s |
| 2 | `/` | 224 | 0 | 100,00% | 0,0s |
| 3 | `/health` | 219 | 0 | 100,00% | 0,0s |
| 4 | `/` | 192 | 0 | 100,00% | 0,0s |

O script sai com código 1 se houve qualquer falha — dá para usar como porteiro
de um deploy manual.

### O que ainda é uma janela pequena (e por quê)

Durante os ~5s de drain, um cliente cujo WebSocket estava na instância antiga
pode perder um evento de realtime: o `outbox_event` é reivindicado por uma
das duas instâncias (a que está no ar naquele instante) e o WS daquele cliente
está ligado à outra. O `useRealtime` do frontend chama `onReconnect` a cada
reconexão, então o estado volta por REST em ~250ms. Fechar essa janela por
completo exigiria **um só dono do outbox** entre as duas instâncias (advisory
lock do Postgres para eleger líder, ou `LISTEN/NOTIFY`) — é pendência
conhecida, deliberadamente fora do escopo agora: exigiria alterar os workers,
e a decisão foi não mexer nisso neste deploy.

### Memória

O switch mantém **duas** cópias do backend e do frontend em pé por alguns
minutos. Medido no VPS: backend ≈ 200MB, frontend ≈ 10MB, Postgres ≈ 100MB.
Com 2,8Gi disponíveis, sobra folga.

## Gateway WebSocket em Go (opt-in)

O realtime (`/realtime*`) tem **duas implementações**: o `WsGateway` +
`outbox-dispatcher` do backend Node (o que está no ar) e o gateway escrito
em Go, em `ws-gateway/`. O gateway serve as mesmas rotas, com o mesmo
handshake, as mesmas rooms e o mesmo token — quem não muda é o app.

**Hoje o realtime vivo é o do Node.** O gateway existe no compose, atrás de
`profile`, e só entra no caminho se você mandar. A troca é o que este
runbook descreve; o motivo de ser opt-in está em §"Por que ele não sobe
sozinho".

### O serviço no compose

| | |
|---|---|
| serviço | `ws-gateway` (nos três compose: produção, local e dev) |
| imagem | `${WS_GATEWAY_IMAGE:-pdv-ws-gateway:local}`, build de `../ws-gateway` |
| porta | 8080 **dentro** da rede do compose — sem `ports:`, só o Caddy fala com ele |
| quando sobe | só com `--profile ws-gateway` (é o que o mantém fora do `up` normal) |
| ambiente | `DATABASE_URL` (o mesmo do backend), `JWT_SECRET` (o mesmo), `PORT=8080`, `WS_DISPATCH` (**o gate de posse do realtime; desligado por padrão**), `WS_ALLOWED_ORIGINS` (vazio = qualquer origem), `GIT_SHA` (aparece no `/health`) |
| portão | `/health` responde **503** quando o banco deixa de responder — inclusive travado, sem erro do driver — e **200** sem `DATABASE_URL`; healthcheck do compose por `wget` |
| volume | nenhum — não tem estado em disco |

Ele **não escreve nada no banco**: só lê `outbox_event`, que o backend
continua gravando dentro da transação da escrita. Por isso não tem
migration, não tem schema próprio e não aparece em nenhum passo de migration
do deploy.

> `GIT_SHA` só aparece no `/health` (campo `version`). A pipeline ainda não
> exporta essa variável, então em produção vem `dev`; quando alguém exportar,
> dá para confirmar pelo `/health` qual build do gateway está no ar.

> `WS_DISPATCH` decide se o gateway pode publicar `outbox_event`, e ela só entra
> no container no `up`/`recreate` dele. O que ela é e quando ligar está no
> `.env.example` e no §"Como ligar" abaixo; o `./switch.sh --status` mostra o
> estado a qualquer momento, e o `/health` corrobora (ver §"O contrato do
> `/health`").

### O contrato do `/health`

O `/health` do gateway é interno do container dele — o Caddy **não** roteia
`/health` para lá (ver `Caddyfile` e §"O que o `switch.sh` faz"). Ele existe
para responder à pergunta que só o gateway consegue responder: *ele publica
evento agora?* O que devolve:

| campo | significado |
|---|---|
| `status` | `ok` ou `degraded` — e `degraded` sempre vem acompanhado de 503 |
| `outboxEnabled` | **pool de banco E gate `WS_DISPATCH` ligado no processo**. `true` = o dispatcher está despachando de verdade |
| `databaseLastOkSeconds` | há quantos segundos terminou o último ping bom ao banco. `null` se o banco nunca respondeu desde o boot |
| `databaseError` | só no 503: o erro do driver (banco recusando/derrubado) ou o texto de banco sem responder, com a idade do último ok bom e quantas tentativas estão em andamento |
| `version`, `uptimeSeconds`, `connections`, `users` | build (`GIT_SHA`), tempo de vida, conexões e usuários no hub |

**O prazo é o ponto.** O handler não fala com o banco: um `PingContext` pode
pendurar para sempre mesmo com contexto com deadline, e o `http.Server` não tem
`ReadTimeout`/`WriteTimeout` que segurem isso (depois do upgrade a conexão
WebSocket escapa do server no hijack). Quem pergunta é um probe de fundo, a 1s,
com no máximo 2 perguntas em andamento; o handler só lê o último resultado. Um
"ok" mais velho que 3s deixa de valer, e é o **tempo** — não o driver — que
degrada a resposta.

Comportamento medido com Postgres de verdade (imagem real; banco congelado com
`docker pause`, que deixa o TCP aberto sem nada responder):

| cenário | resposta |
|---|---|
| banco respondendo | 200 em ~1–9ms |
| **banco travado** | **503 em ~3ms** (tempo de resposta do handler, medido com `curl`) — antes pendurava sem responder. O que leva ~3s é o **começo** do 503, não a resposta |
| banco inalcançável (recusando conexão) | 503, com o erro do driver em `databaseError` |
| travado por até 3s | ainda 200 (o último ping bom tinha 1–2s); 503 a partir de 3s |
| destravado | volta a 200 sozinho, sem restart — o ping preso volta quando o banco volta |
| **sem `DATABASE_URL`** | **200**, e sem `databaseLastOkSeconds` nem `databaseError` |

O texto do 503 separa "banco recusando" de "banco sem responder", porque a
providência é outra: no primeiro o pool se recupera sozinho; no segundo não há
erro para repetir, e o que o texto traz é a idade do último ok bom e quantas
tentativas estão presas.

O healthcheck do compose (`wget`, `interval: 3s`, `retries: 20`) só vira
`unhealthy` depois de ~60s de 503 seguidos — medido: `unhealthy` em t+63s de
banco congelado, e `healthy` de novo sozinho depois do `unpause`. Ele não
reprova deploy nenhum: o `switch.sh` não espera o gateway (`wait_healthy` cobre
backend e frontend) e a rota `/health` pública é a do backend.

**Sem `DATABASE_URL` o 200 é decisão, não acidente.** O gateway sem banco não
tem o que depurar: ele sobe sem pool, registra um aviso no log e serve as
conexões — e o rollback do realtime é justamente voltar o Caddy para o Node
**com o gateway vivo** (falhar o boot tiraria o rollback sem derrubar o deploy).
E, com o dispatcher desligado pelo gate, "gateway de pé e mudo" é o **modo
normal** de subida lado a lado, não um estado degradado: degradar esse caso
quebraria o `docker compose --profile ws-gateway` e o caminho de rollback.
Quem tem de conferir a posse do realtime é o `./switch.sh --status`, que cruza o
gate com o upstream.

### Quem serve o `/realtime*`

O Caddy tem um upstream só para essa rota, resolvido dentro do container por
`caddy-assemble.sh`:

```
PDV_WS_UPSTREAM   →   /realtime*   (Caddyfile)
       ↑
   quem decide, nesta ordem:
   1. linha PDV_WS_UPSTREAM em state/active-upstream   (emergência)
   2. WS_BACKEND=go no ambiente do container do Caddy  (a decisão do .env)
   3. senão: o mesmo valor de PDV_BACKEND_UPSTREAM      (acompanha o switch)
```

O item 3 é o que mantém o modo `node` com o comportamento de hoje: o
realtime gira junto com o azul/verde do backend. Um literal `backend:3000`
ali quebraria o WS no primeiro switch, porque o switch para a instância
antiga no passo 5.

Para ver quem está no ar agora:

```bash
./switch.sh --status | head -1
# Caddy aponta para: backend=backend frontend=frontend realtime=ws-gateway:8080

# e o log do container do Caddy, que é onde a resolução acontece:
docker compose logs caddy | grep "upstream ativo" | tail -1
```

### Por que ele não sobe sozinho

Não é cautela por hábito: **o dispatcher do gateway disputa com o do Node o
mesmo advisory lock** (`pdv:outbox:owner`, em
`backend/src/infra/locks.ts`) e **marca o evento como publicado mesmo com
zero assinantes na room**. O lock garante que só um publica por ciclo — ele
não garante que seja o certo.

Então um gateway de pé que **não** está no caminho do `/realtime` ganha
metade dos ciclos, engole os eventos realtime de quem está conectado no Node
e marca como publicado. O sintoma é o pior possível: nenhum erro em log
nenhum, só a tela do salão que não atualiza (o bell não toca, a comanda não
aparece sozinha) — e o `useRealtime` só recompõe o estado na reconexão, ou
seja, quando alguém dá F5.

> **Medido** com a imagem real (`ws-gateway/Dockerfile`) contra um Postgres
> de teste, com o gateway de pé e **zero** clientes WS: a linha `probe-1` do
> `outbox_event` foi de `published=false` para `published=true` em menos de
> 2s (o poll do dispatcher é de 200ms), sem nenhum assinante na room. É por
> isso que o serviço não é simplesmente "mais um container parado".

Por isso o serviço está atrás de `profile`, e a flag `WS_BACKEND=go` e o
`--profile ws-gateway` andam **juntos**: subir o container sem virar o proxy
é justamente o estado perigoso.

> A parte "só despachar quando é o dono do `/realtime`" **já está feita**, e não
> pelo `profile`: é o gate `WS_DISPATCH` (`ws-gateway/internal/outbox/gate.go`),
> dentro do processo — desligado, o dispatcher do gateway nem existe, que é o
> que fecha a janela perigosa de subir o container antes do Caddy virar. O que
> o `profile` segura é o outro lado (o `up` do dia a dia não cria o container),
> e tirá-lo continua sendo decisão de corte, não de código — pendência em
> `ws-gateway/GO-GATEWAY-PLAN.md`.

### Como ligar (a ordem importa)

```bash
cd /opt/pdv-completo/deploy

# 1. o gateway PRIMEIRO, e só ele. Sem o container no ar, todo handshake
#    leva 502: o app abre normal (REST funciona) e o realtime fica mudo.
docker compose --profile ws-gateway up -d --build ws-gateway

# 2. o gate, no .env — WS_DISPATCH=1. Ele só entra no container no `up`
#    dele, então isto é um segundo `up` do gateway, e é o passo que faz o
#    `/health` seguinte dizer `outboxEnabled:true`. Sem ele o proxy pode
#    apontar para o gateway e nenhum evento chegar (ver .env.example).
docker compose --profile ws-gateway up -d ws-gateway

# 3. portão: o /health tem que responder 200 E com o dispatcher ligado.
#    `outboxEnabled:false` = gateway de pé e mudo (o estado que não pode
#    virar tráfego). As duas causas são `WS_DISPATCH` desligado no container ou
#    DATABASE_URL ausente — o `./switch.sh --status` diz qual das duas é.
docker compose exec caddy wget -qO- http://ws-gateway:8080/health
# {"status":"ok","version":"dev","uptimeSeconds":12,"connections":0,"users":0,
#  "databaseLastOkSeconds":0,"outboxEnabled":true}

# 4. a decisão que sobrevive a deploy, no .env:
#    WS_BACKEND=go

# 5. e o caminho quente: aponta o proxy sem recriar o container do Caddy
#    (recreate custa os 1-3s de queda que o switch existe para evitar).
printf 'PDV_WS_UPSTREAM=ws-gateway:8080\n' >> state/active-upstream
docker compose exec caddy sh /srv/pdv-deploy/caddy-assemble.sh reload
```

Os passos 2 e 5 são o mesmo instante lógico: o gate liga **junto** com a
virada do proxy, porque cada um dos dois errados sozinho é o defeito medido
(gate ligado com proxy no Node = o gateway engole evento de quem está conectado
lá; proxy no gateway com gate desligado = ninguém recebe nada). Por isso o
passo 3 é o portão entre os dois.

O passo 4 é o que sobrevive aos deploys; o passo 5 é o que vale na hora. A
linha `PDV_WS_UPSTREAM` do ponteiro é descartada pelo `switch.sh` no deploy
seguinte (ele reescreve o arquivo inteiro) — de propósito, para que um
override de emergência não vire configuração permanente em silêncio.

> Se o passo 3 mostrar `outboxEnabled:false` mesmo com `WS_DISPATCH=1` no `.env`,
> olhe o log do container antes de caçar outra coisa: `AVISO: sem DATABASE_URL
> acessível (pq: SSL is not enabled on the server)` é o lib/pq recusando o
> Postgres por falta de `?sslmode=disable` na DSN, e o gateway sobe sem pool
> (o `/health` segue 200, sem `databaseLastOkSeconds`). O padrão do serviço já
> traz o parâmetro; se você sobrescreveu `DATABASE_URL` no `.env`, ele é seu.

O `stream_close_delay 5m` continua valendo em `/realtime*` (é a mesma rota,
só mudou o upstream): o `reload` não derruba as telas do salão. O que muda
agora é o destino — quem reconecta nesse instante volta pelo backoff do
client e ressincroniza por REST, como já acontece no drain do switch.

### Como desligar (rollback do realtime)

O caminho de volta é **um `sed`, uma linha de ponteiro e um reload** — sem
deploy e sem recriar container:

```bash
cd /opt/pdv-completo/deploy

# 1. tira a linha de emergência do ponteiro
grep -v '^PDV_WS_UPSTREAM=' state/active-upstream > /tmp/up && cat /tmp/up > state/active-upstream

# 2. e garante que o .env não traz o gateway de volta no próximo recreate
#    do Caddy
sed -i 's/^WS_BACKEND=.*/WS_BACKEND=node/' .env

# 3. e desliga o gate. É este passo que fecha a janela, não o proxy: com
#    WS_DISPATCH=1 deixado no .env, o próximo `up --profile ws-gateway`
#    (deploy, reinstância, alguém testando) sobe o gateway publicando com o
#    proxy já no Node — o estado que engole evento de quem está conectado lá.
sed -i 's/^WS_DISPATCH=.*/# WS_DISPATCH=/' .env
docker compose --profile ws-gateway up -d --no-deps ws-gateway   # só se ele estiver de pé

docker compose exec caddy sh /srv/pdv-deploy/caddy-assemble.sh reload
docker compose logs caddy | grep "upstream ativo" | tail -1   # conferindo
./switch.sh --status                                         # o verito do gate
```

O gateway pode continuar de pé nesse meio-tempo (o rollback aqui é do proxy,
não do container), mas **desligue-o** se não for voltar atrás:

```bash
docker compose --profile ws-gateway stop ws-gateway
```

Gateway parado não derruba nada (o `/realtime*` já está no Node); gateway de
pé com o proxy apontado para ele é o estado que engole evento, como §"Por
que ele não sobe sozinho" explica.

### O que o `switch.sh` faz (e não faz) com o gateway

**Não faz**: não reconstrói a imagem dele (o build do switch é
`backend frontend`), não recria o container e não o inclui no rodízio
azul/verde. A decisão está escrita no cabeçalho do `switch.sh`.

**Faz**: mostra o gateway no `--status` (o `realtime=` na primeira linha e o
container na tabela) e, quando o gateway é quem serve o realtime, avisa no
fim do switch que aquela imagem **não** foi atualizada por aquele deploy,
com o comando para publicar:

```bash
cd /opt/pdv-completo/deploy
docker compose --profile ws-gateway build ws-gateway \
  && docker compose --profile ws-gateway up -d --no-deps ws-gateway
```

Esse restart derruba as conexões WS abertas (o `stream_close_delay` segura
as conexões no *reload*, não no *stop* do upstream) — quem reconecta leva
~250ms de backoff e ressincroniza por REST. Rode-o em janela em que isso não
atrapalhe, ou logo depois de um switch.

O `probe-availability.sh` não muda: ele aperta `${URL}/health`, que o Caddy
roteia para o backend, então o gateway nunca entra no caminho da medição. A
rota `/health` do Caddy continua apontando para `PDV_BACKEND_UPSTREAM` de
propósito — se passasse a medir o gateway, um 503 do gateway reprovaria um
deploy em que o backend está perfeitamente saudável.

### No stack local e no dev

- **local** (`docker-compose.local.yml`): idêntico ao de produção, e o Caddy
  roda o mesmo `caddy-assemble.sh` — então `WS_BACKEND=go` funciona igual. É
  o lugar de testar um switch com o gateway no ar antes do VPS.
- **dev** (`docker-compose.dev.yml`): o Caddy **não** roda o
  `caddy-assemble.sh` (a config é montada direto do `Caddyfile.dev`), então a
  flag `WS_BACKEND` não é traduzida lá. Defina `PDV_WS_UPSTREAM` direto:

  ```bash
  # deploy/.env
  PDV_WS_UPSTREAM=ws-gateway:8080
  ```

  E suba o gateway com `--profile ws-gateway`. Sem hot reload (é binário):
  `up -d --build ws-gateway` a cada mudança em `ws-gateway/`.

## Rollback simples

Se precisar voltar para um commit anterior (por exemplo, após um deploy
publicado com bug):

```bash
cd /opt/pdv-completo
git fetch --prune origin
git checkout -f <tag-estavel>
cd deploy
./switch.sh
```

O `switch` garante o mesmo portão do deploy: se a versão antiga não ficar
healthy, o proxy não é tocado e o job falha.

Depois ajuste a `main` no GitHub para evitar redeploy do commit ruim.

Esse rollback é do **código**. Se o problema for só o realtime (telas do
salão que não atualizam), o rollback é bem mais barato e **não precisa de
deploy nenhum**: uma linha no `state/active-upstream` e um `caddy reload`
(§"Gateway WebSocket em Go", em "Como desligar"). Vale tentar isso primeiro
quando o REST está normal e só o WS está estranho — é o mesmo critério que
o `switch.sh` usa para abortar um deploy ruim.

### Cuidados com backup do Postgres

- Faça backup antes de rollback e antes de mudanças críticas.
- Preserve o volume `pdv_postgres_data` (dados) e `pdv_backend_uploads` (uploads).
- Nunca use `docker compose down -v` em produção sem plano de restauração.
- Restauração: `docker exec -i <container> pg_restore -U pdv -d pdv --clean <arquivo.dump>`
  (o `.dump` é formato custom do `pg_dump -Fc`).

## Deixando o app disponível pros garçons (PWA)

Não precisa publicar em loja de app nenhuma. No celular do garçom:

1. Abra `https://app.seudominio.com.br` no Chrome (Android) ou Safari (iOS)
2. Toque no menu → **"Adicionar à tela inicial"** (Android) ou **"Adicionar
   à Tela de Início"** (iOS, no botão de compartilhar)
3. Um ícone aparece na tela inicial, abre em tela cheia como um app nativo

Isso já está configurado no frontend (`manifest.json` + `sw.js` +
`apple-touch-icon`) — não precisa de nenhum passo extra além do deploy.

## Alternativa mais simples (sem servidor próprio)

Se administrar um servidor Linux não for o objetivo, dá pra separar:
- **Backend**: Railway, Render ou Fly.io — todos rodam o `Dockerfile` do
  jeito que está, com HTTPS automático. O banco é Postgres: use o Postgres
  gerenciado da própria plataforma e aponte `DATABASE_URL` pra ele (o plano
  do backend não precisa de disco persistente, só o do banco)
- **Frontend**: Vercel, Netlify ou Cloudflare Pages — build estático direto
  do `frontend/`, sem precisar do Dockerfile dele

Nesse cenário, ajuste `CORS_ORIGIN` no backend pra apontar pro domínio do
frontend, e configure `VITE_API_BASE`/proxy equivalente no frontend pra
apontar pro domínio do backend (hoje o `vite.config.js` só faz proxy em
dev — em produção com domínios separados, os caminhos `/api` e `/realtime`
em `src/lib/api.js`/`src/lib/ws.js` precisariam virar URLs absolutas do
backend). Mais simples de operar no dia a dia, mas com mais peças soltas
pra configurar no primeiro deploy — por isso o `docker-compose` de um
servidor único é o caminho recomendado por padrão.
