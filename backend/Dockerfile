# ============================================================
# Backend PDV — imagem de produção (PostgreSQL)
# ============================================================
FROM node:22-slim AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---------- imagem final, sem ferramentas de build ----------
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist
COPY migrations ./migrations
COPY seed-data ./seed-data

# O banco é o Postgres (variável DATABASE_URL) — não há volume de dados local.
# Só os uploads de produto são persistidos aqui.
VOLUME ["/app/uploads"]

EXPOSE 3000
CMD ["node", "dist/http/server.js"]
