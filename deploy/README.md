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
| `umamisushiarte.com.br` | IP do VPS | redirect para a vitrine (`app./pedido`) |
| `www.umamisushiarte.com.br` | IP do VPS | redirect para a vitrine (`app./pedido`) |
| `app.umamisushiarte.com.br` | IP do VPS | **a aplicação (PDV)** |

O domínio raiz **não** serve o app — ele redireciona (302, temporário) para a
vitrine pública em **`app./pedido`**. Quem for usar o PDV (garçons, cozinha,
gerente) entra por **`app.`**; o cliente final chega no domínio raiz e cai
direto na página de pedidos. O path é `/pedido` no **singular** (é o que o
React Router declara em `frontend/src/app/router.jsx`); `/pedidos` cai no
catch-all e mostra a tela de login. O redirect é **temporário** (302) de
propósito: o 308 (`permanent`) fica cacheado no navegador e mascara a
mudança — valide com `curl -sI` e só volte pra `permanent` quando o destino
estiver definitivo.

Depois de criar/alterar, é só recarregar o Caddy — ele pega os certificados
sozinho, sem reiniciar containers:

```bash
docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
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
redirecionam para a vitrine, então não precisam (e não devem) estar na
lista:

```
CORS_ORIGIN=https://app.umamisushiarte.com.br
```

Depois de mudar, o container precisa ser recriado (variável de ambiente não é
reconhecida em hot reload):

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
- job **Windows** (`build-desktop`): gera o instalador do app desktop
  assinado, monta o manifesto do auto-update e publica os artefatos — ver
  [Auto-update do app desktop](#auto-update-do-app-desktop);
- deploy remoto por SSH com backup prévio e health check;
- deploy **sem downtime** com `deploy/switch.sh` (instância nova ao lado da
  atual, healthcheck como portão, troca de upstream por `caddy reload` — sem
  `down -v`, sem recriar o proxy, preservando o volume do Postgres e dos
  uploads). Ver [Deploy sem downtime](#deploy-sem-downtime-switch-azulverde).

O `deploy` só roda depois de `build-desktop`: o manifesto do update nunca
chega ao servidor antes do backend no ar. Se a tag não bater com a
`version` do `frontend/src-tauri/tauri.conf.json`, o job Windows falha de
propósito — um descasamento ali publicaria um manifesto que nenhum app
reconhece, e o update pareceria só não existir.

### Como usar

1. Crie uma tag semântica: `git tag v1.0.0 && git push origin v1.0.0`
2. O workflow roda automaticamente: testes → backup → deploy → health check
3. Acompanhe na aba **Actions** do repositório

### Secrets necessários no GitHub Actions

Configure em **Settings → Secrets and variables → Actions**:

- `HOSTINGER_HOST` (IP ou domínio do VPS)
- `HOSTINGER_PORT` (opcional; se ausente/vazio usa `22`)
- `HOSTINGER_USER` (usuário SSH)
- `HOSTINGER_SSH_KEY` (chave privada OpenSSH/PEM)
- `HOSTINGER_APP_PATH` (caminho absoluto do clone no VPS, ex.: `/opt/pdv-completo`)
- `HOSTINGER_KNOWN_HOSTS` (opcional, recomendado)
- `TAURI_SIGNING_PRIVATE_KEY` (chave Ed25519 do auto-update — ver abaixo)
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (senha dessa chave)
- `UPDATE_BASE_URL` (opcional; padrão `https://app.umamisushiarte.com.br`)

### Auto-update do app desktop

O app Windows (Tauri) pergunta por update no boot. Duas rotas no Caddy:

| Rota | O que serve |
|---|---|
| `/updates/desktop/<target>/<arch>/<versão-atual>` | sempre o mesmo `latest.json` (manifesto da versão mais recente) |
| `/updates/files/windows-x86_64/...` | o instalador `.exe`, o `.exe.zip` e o `.sig` |

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

### Chave SSH e known_hosts (sem expor segredo)

No seu computador local:

```bash
ssh-keygen -t ed25519 -C "github-actions-deploy" -f ~/.ssh/pdv_hostinger_deploy
```

1. Adicione `~/.ssh/pdv_hostinger_deploy.pub` em `~/.ssh/authorized_keys` do
   usuário do VPS (`HOSTINGER_USER`).
2. Copie o conteúdo de `~/.ssh/pdv_hostinger_deploy` para o secret
   `HOSTINGER_SSH_KEY`.
3. **Nunca** comite chave privada no repositório.

Para o `known_hosts`:

```bash
ssh-keyscan -p 22 -H SEU_HOST_OU_IP
```

Copie a saída para o secret `HOSTINGER_KNOWN_HOSTS`. Se ele não for informado,
o workflow gera `known_hosts` com `ssh-keyscan` durante a execução.

### Setup inicial do VPS para uso da pipeline

```bash
sudo apt-get update
sudo apt-get install -y git
curl -fsSL https://get.docker.com | sh

sudo mkdir -p /opt/pdv-completo
sudo chown -R "$USER":"$USER" /opt/pdv-completo
git clone https://github.com/vinihss/pdv-completo.git /opt/pdv-completo
cd /opt/pdv-completo

# Diretório de artefatos do app Windows (instalador + latest.json). Precisa
# existir COM O DONO CERTO antes do primeiro `docker compose up`: o compose
# monta ./updates no Caddy, e bind mount de diretório inexistente faz o
# Docker criá-lo como root — aí o scp do job build-desktop (que roda com o
# usuário do CI, não com root) falha com "permission denied" e o instalador
# nunca chega ao servidor. O switch.sh e o install.sh já criam e checam isso;
# o comando abaixo é para um clone manual.
mkdir -p deploy/updates/files/windows-x86_64
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
