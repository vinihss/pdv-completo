# Stage 1: Build
FROM node:20-alpine AS builder

WORKDIR /app

# Copiar arquivos necessários pra instalar deps com workspaces
COPY package.json package-lock.json ./
COPY frontend/package.json ./frontend/
COPY apps/pedido-public/package.json ./apps/pedido-public/

# Instalar dependências
RUN npm ci

# Copiar todo o código necessário pro build
COPY frontend ./frontend
COPY apps/pedido-public ./apps/pedido-public

# Buildar o app standalone do pedido
RUN npm run build:pedido

# Stage 2: Serve com nginx
FROM nginx:1.27-alpine AS runner

# Copiar build
COPY --from=builder /app/apps/pedido-public/dist /usr/share/nginx/html

# Copiar config nginx
COPY apps/pedido-public/nginx.conf /etc/nginx/conf.d/default.conf

# Remover config default do nginx
RUN rm -f /etc/nginx/conf.d/default.conf.bak 2>/dev/null || true

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
