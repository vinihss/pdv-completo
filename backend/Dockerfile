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
# `npm ci --omit=dev` NÃO pode rodar aqui: o drizzle-orm declara better-sqlite3
# como peer dependency OPCIONAL, então o npm o instala mesmo com --omit=dev (marcado
# `devOptional` no lockfile). Como ele tem install script, o node-gyp roda e
# estoura sem toolchain. E o `--omit=dev` no estágio final só funcionava por
# cache de layer — um build --no-cache quebrava. Aqui a toolchain existe, então
# prunes as dev deps DEPOIS de compilar o que precisa compilar.
RUN npm prune --omit=dev

# ---------- imagem final, sem ferramentas de build ----------
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production

# node_modules vem já compilado do estágio de build (argon2 e o próprio
# better-sqlite3), então a imagem final não precisa de python3/make/g++ nem
# de um segundo `npm ci` — e não depende de cache de layer para buildar.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package*.json ./
COPY migrations ./migrations
COPY seed-data ./seed-data

# O banco é o Postgres (variável DATABASE_URL) — não há volume de dados local.
# Só os uploads de produto são persistidos aqui.
VOLUME ["/app/uploads"]

EXPOSE 3000
CMD ["node", "dist/http/server.js"]
