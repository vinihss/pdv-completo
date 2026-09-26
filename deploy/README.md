# Deploy em nuvem — passo a passo

Este runbook sobe o sistema completo (backend + frontend + HTTPS automático)
num único servidor Docker. Qualquer VPS com Docker serve — os passos abaixo
usam Ubuntu 22.04 genérico, funcionam igual na Hetzner, DigitalOcean,
Contabo, etc.

## Por que essa abordagem

O backend já está pronto e testado no modo `local` (SQLite) da spec. Rodar
esse mesmo container num servidor na nuvem, em vez de num mini-PC dentro do
estabelecimento, já resolve o pedido — "os garçons acessam de qualquer
lugar" — sem precisar reescrever nada pra Postgres. Um único servidor pequeno
aguenta tranquilamente o volume de um restaurante/pub (ver §15 do backend
spec: "dezenas de comandas simultâneas, não milhares").

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

## Deploy contínuo com GitHub Actions (Hostinger VPS)

O repositório possui o workflow **`.github/workflows/deploy-hostinger.yml`** com:

- gatilho em `push` para `main`;
- gatilho manual (`workflow_dispatch`);
- validações antes do deploy:
  - backend: `npm ci`, `npm run build`, `npm run test`;
  - frontend: `npm ci`, `npm run lint`, `npm run build`, `npm run test`;
- deploy remoto por SSH com `set -Eeuo pipefail`;
- sincronização limpa do código no VPS com `git fetch --prune`, `git checkout -f main` e `git reset --hard origin/main`;
- deploy com `docker compose -f deploy/docker-compose.yml up -d --build --remove-orphans`;
- checagem de status/saúde dos serviços após subir.

O workflow **não** roda `docker compose down -v` e não remove volumes
persistentes, preservando dados do SQLite e uploads.

### Secrets necessários no GitHub Actions

Configure em **Settings → Secrets and variables → Actions**:

- `HOSTINGER_HOST` (IP ou domínio do VPS)
- `HOSTINGER_PORT` (opcional; se ausente/vazio usa `22`)
- `HOSTINGER_USER` (usuário SSH)
- `HOSTINGER_SSH_KEY` (chave privada OpenSSH/PEM)
- `HOSTINGER_APP_PATH` (caminho absoluto do clone no VPS, ex.: `/opt/pdv-completo`)
- `HOSTINGER_KNOWN_HOSTS` (opcional, recomendado)
- `DEPLOY_JWT_SECRET` (**secret obrigatório**) — valor forte para `JWT_SECRET` do backend
- `DEPLOY_DOMAIN` (**variable recomendado**; pode ser secret) — domínio da aplicação, ex.: `app.seudominio.com.br`

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

# 4. Suba tudo
docker compose up -d --build

# 5. Rode o seed de primeiro deploy (uma única vez — cria o cadastro do
#    estabelecimento e o usuário gerente inicial; nada de dados fictícios)
docker compose exec backend node dist/infra/db/seed-prod.js
#   Pode passar variáveis pra personalizar (opcional, senão usa placeholders):
#   docker compose exec -e MERCHANT_NAME="Bar do Zé" -e MERCHANT_CITY="Sao Paulo" \
#     -e MANAGER_NAME="Roberto Alves" backend node dist/infra/db/seed-prod.js
```

O comando acima imprime o **PIN do gerente uma única vez** — anote na hora.
Depois disso, entre com esse PIN e cadastre o resto (categorias, produtos,
garçons, cozinha) pela própria tela de Configurações/Equipe — não precisa
mexer no servidor de novo pra isso.

Depois desse passo, `https://app.seudominio.com.br` já serve o app com certificado
válido, e a API responde em `https://app.seudominio.com.br/api/...`.

## Seed de demonstração vs. seed de produção

- **`seed.ts`** (`npm run seed`) — só pra desenvolvimento local. Cria 4
  usuários fictícios (Ana, Carlos, Roberto, Estação Cozinha) com PINs
  conhecidos e um cardápio de exemplo. **Nunca rode isso num deploy real**
  — os PINs de teste ficam documentados no código-fonte.
- **`seed-prod.ts`** (`npm run seed:prod`, ou `node dist/infra/db/seed-prod.js`
  já compilado) — o que o passo 5 acima usa. Cria só `store_settings` com os
  dados reais do estabelecimento e um usuário gerente com PIN aleatório,
  sem nenhum dado fictício. É o script que a imagem de produção do backend
  já inclui (compilado junto com o resto do `dist/`), sem precisar instalar
  `tsx` na imagem final.

## Backup (não pule esta parte)

O SQLite mora no volume Docker `pdv_backend_data` (nome explícito, independente
da pasta do compose). Sem backup, perder o volume = perder todas as comandas e o
cadastro do estabelecimento.

Use o script **`deploy/backup.sh`** — ele roda o comando `.backup` do sqlite3,
que gera um snapshot online **consistente mesmo em WAL mode** (copiar só o
`data.db` pode perder transações que ainda estão no `data.db-wal`):

```bash
# um backup agora, salvo em /opt/backups/
./backup.sh /opt/backups
```

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

## Atualizando o app depois do primeiro deploy

Via CI/CD (recomendado), basta fazer push/merge na `main` ou executar manualmente
o workflow **Deploy Hostinger VPS** na aba Actions.

Fallback manual:

```bash
cd /opt/pdv-completo
git pull   # ou reenvie os arquivos atualizados
docker compose -f deploy/docker-compose.yml up -d --build --remove-orphans
```

As migrations rodam automaticamente no boot do backend (ver
`src/infra/db/migrate.ts`) — não precisa rodar nada manual pra aplicar
mudanças de schema, desde que você adicione o novo arquivo `.sql` em
`backend/migrations/` antes de subir.

## Rollback simples

Se precisar voltar para um commit anterior:

```bash
cd /opt/pdv-completo
git fetch --prune origin
git reset --hard <commit-ou-tag-estavel>
docker compose -f deploy/docker-compose.yml up -d --build --remove-orphans
```

Depois ajuste a `main` no GitHub para evitar redeploy do commit ruim.

### Cuidados com backup do SQLite

- Faça backup antes de rollback e antes de mudanças críticas.
- Preserve o volume `pdv_backend_data` (dados) e `pdv_backend_uploads` (uploads).
- Nunca use `docker compose down -v` em produção sem plano de restauração.

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
  jeito que está, com HTTPS automático e um volume persistente pro SQLite
  (verifique se o plano escolhido tem *disco persistente*, não só
  filesystem efêmero — sem isso, os dados somem a cada deploy)
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
