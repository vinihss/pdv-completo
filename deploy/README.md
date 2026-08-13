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
#   DOMAIN=pdv.seudominio.com.br
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

Depois desse passo, `https://pdv.seudominio.com.br` já serve o app com certificado
válido, e a API responde em `https://pdv.seudominio.com.br/api/...`.

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

```bash
cd /opt/pdv
git pull   # ou reenvie os arquivos atualizados
cd deploy
docker compose up -d --build
```

As migrations rodam automaticamente no boot do backend (ver
`src/infra/db/migrate.ts`) — não precisa rodar nada manual pra aplicar
mudanças de schema, desde que você adicione o novo arquivo `.sql` em
`backend/migrations/` antes de subir.

## Deixando o app disponível pros garçons (PWA)

Não precisa publicar em loja de app nenhuma. No celular do garçom:

1. Abra `https://pdv.seudominio.com.br` no Chrome (Android) ou Safari (iOS)
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
