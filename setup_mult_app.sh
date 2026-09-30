#!/usr/bin/env bash

echo "🚀 Iniciando transição para arquitetura Multi-App Standalone..."

# 1. Criar a nova árvore de diretórios
mkdir -p standalone-pdv/src
mkdir -p standalone-pdv/binaries
mkdir -p standalone-kds/src

# 2. Criar o tauri.conf.json da Frente de Caixa (Com Impressora)
echo "📝 Gerando configuração: standalone-pdv..."
cat << 'EOF' > standalone-pdv/tauri.conf.json
{
  "productName": "PDV - Frente de Caixa",
  "version": "1.0.0",
  "identifier": "com.restaurante.pdv",
  "build": {
    "beforeDevCommand": "pnpm --filter frontend dev",
    "beforeBuildCommand": "cd ../frontend && pnpm build:pdv",
    "frontendDist": "../frontend/dist/pdv"
  },
  "app": {
    "windows": [
      {
        "title": "Frente de Caixa",
        "width": 1024,
        "height": 768,
        "resizable": true,
        "fullscreen": false
      }
    ]
  },
  "bundle": {
    "active": true,
    "targets": "all",
    "externalBin": [
      "binaries/pdv-printer-daemon"
    ]
  }
}
EOF

# 3. Criar o tauri.conf.json da Cozinha (Sem Impressora)
echo "📝 Gerando configuração: standalone-kds..."
cat << 'EOF' > standalone-kds/tauri.conf.json
{
  "productName": "KDS - Monitor de Cozinha",
  "version": "1.0.0",
  "identifier": "com.restaurante.kds",
  "build": {
    "beforeDevCommand": "pnpm --filter frontend dev",
    "beforeBuildCommand": "cd ../frontend && pnpm build:kds",
    "frontendDist": "../frontend/dist/kds"
  },
  "app": {
    "windows": [
      {
        "title": "Monitor de Cozinha (KDS)",
        "width": 1280,
        "height": 800,
        "resizable": true,
        "fullscreen": true
      }
    ]
  },
  "bundle": {
    "active": true,
    "targets": "all",
    "externalBin": []
  }
}
EOF

# 4. Criar esqueletos mínimos de código Rust para os apps compilarem
cat << 'EOF' > standalone-pdv/src/main.rs
fn main() {
    // Ciclo de vida padrão do Tauri para o PDV com injeção de comandos de caixa
    println!("Iniciando ambiente nativo: Frente de Caixa");
}
EOF

cat << 'EOF' > standalone-kds/src/main.rs
fn main() {
    // Ciclo de vida padrão do Tauri para o KDS simplificado
    println!("Iniciando ambiente nativo: Monitor de Cozinha");
}
EOF

# 5. Atualizar ou criar o manifesto opencode.json com os novos agentes fragmentados
echo "🛡️ Sincronizando permissões e escopos em opencode.json..."
cat << 'EOF' > ./opencode.json
{
  "$schema": "https://opencode.dev",
  "meta": {
    "project_context": "pdv-restaurante-pub-multi-app",
    "global_timeout_seconds": 180
  },
  "agents": {
    "pdv-orchestrator": {
      "agent_id": "pdv-orchestrator",
      "name": "Orquestrador do Restaurante",
      "model": "free-default-orchestrator",
      "temperature": 0.1,
      "system_instructions": "Você é o coordenador central. Analise as demandas do usuário baseando-se estritamente no CLAUDE.md e distribua as tarefas para os subagentes usando a tag @ correspondente ao escopo afetado.",
      "subagents": ["backend-dev", "frontend-core", "tauri-pdv-expert", "tauri-kds-expert", "devops-bot"]
    },
    "backend-dev": {
      "agent_id": "backend-dev",
      "name": "Especialista Backend Node.js",
      "model": "free-code-model",
      "temperature": 0.0,
      "system_instructions": "Você atua estritamente na pasta ./backend. Respeite as regras de ESM, transações db.transaction e ledger contidas em docs/agent-backend.md.",
      "permissions": { "fs": { "read": ["backend/*", "docs/agent-backend*.md"], "write": ["backend/*"] } }
    },
    "frontend-core": {
      "agent_id": "frontend-core",
      "name": "Especialista Interface React",
      "model": "free-code-model",
      "temperature": 0.0,
      "system_instructions": "Você atua estritamente na pasta ./frontend. Siga as regras do Feature-Sliced Design (FSD) contidas em docs/agent-frontend.md. Não mexe em arquivos de Rust.",
      "permissions": { "fs": { "read": ["frontend/*", "docs/agent-frontend*.md"], "write": ["frontend/*"] } }
    },
    "tauri-pdv-expert": {
      "agent_id": "tauri-pdv-expert",
      "name": "Especialista Desktop Caixa",
      "model": "free-code-model",
      "temperature": 0.0,
      "system_instructions": "Você atua estritamente na pasta ./standalone-pdv/. Cuida do ciclo de vida nativo do caixa e validação do sidecar binaries/pdv-printer-daemon.",
      "permissions": { "fs": { "read": ["standalone-pdv/*"], "write": ["standalone-pdv/*"] } }
    },
    "tauri-kds-expert": {
      "agent_id": "tauri-kds-expert",
      "name": "Especialista Monitor Cozinha",
      "model": "free-code-model",
      "temperature": 0.0,
      "system_instructions": "Você atua estritamente na pasta ./standalone-kds/. Cuida da aplicação nativa de tela cheia que roda na cozinha do estabelecimento.",
      "permissions": { "fs": { "read": ["standalone-kds/*"], "write": ["standalone-kds/*"] } }
    },
    "devops-bot": {
      "agent_id": "devops-bot",
      "name": "Gênio DevOps & Containers",
      "model": "free-code-model",
      "temperature": 0.0,
      "system_instructions": "Você gerencia os arquivos em ./deploy/ e workflows do GitHub. Controla os ciclos locais do Postgres e Caddy.",
      "permissions": {
        "fs": { "read": ["deploy/*", ".github/*"], "write": ["deploy/*"] },
        "bash": { "allow": ["docker ps"], "ask": ["./deploy/probe-availability.sh", "docker-compose -f deploy/docker-compose.dev.yml up -d"] }
      }
    }
  }
}
EOF

echo "✅ Transição concluída! Arquitetura criada e agentes blindados."

