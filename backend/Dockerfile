# ============================================================
# Backend PDV — imagem de produção (PostgreSQL)
# ============================================================
FROM node:22-slim AS build
WORKDIR /app

RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---------- imagem final, sem ferramentas de build ----------
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
# `--omit=optional` não é poda: o drizzle-orm (dependência de produção)
# declara `better-sqlite3` como peer opcional, então o npm marca o pacote
# como devOptional e o instala mesmo com `--omit=dev` — disparando um
# node-gyp que falha nesta imagem (sem toolchain de build). O SQLite foi
# removido do produto; o único uso do pacote é o script avulso
# `db:migrate:sqlite`, que roda fora do container. Sem isto, o build da
# imagem de produção quebra sempre que o prebuild do better-sqlite3 não
# consegue baixar o binário pronto.
RUN npm ci --omit=dev --omit=optional

COPY --from=build /app/dist ./dist
COPY migrations ./migrations
COPY seed-data ./seed-data

# O banco é o Postgres (variável DATABASE_URL) — não há volume de dados local.
# Só os uploads de produto são persistidos aqui.
VOLUME ["/app/uploads"]

EXPOSE 3000
CMD ["node", "dist/http/server.js"]
