#!/usr/bin/env bash
# ============================================================
# install.sh — instala a CLI `pdv` (Rust, cmd/pdv) a partir da fonte.
#
# O que faz, nesta ordem:
#   1. compila cmd/pdv em release (cargo build --release)
#   2. remove versões anteriores da CLI (PATH + prefixos comuns)
#   3. instala o binário novo (local ou global)
#   4. atualiza a cópia local ./pdv na raiz do repo (comandos ./pdv …)
#
# Uso:
#   ./install.sh              # local:  ~/.local/bin/pdv
#   ./install.sh --global     # global: /usr/local/bin/pdv (pede sudo se preciso)
#   ./install.sh --prefix DIR # DIR/bin/pdv
#   ./install.sh --uninstall  # remove a CLI do sistema
#   ./install.sh --help
#
# `PREFIX` no ambiente equivale a `--prefix` (compatibilidade com o
# instalador antigo, scripts/dev/install-pdv-cli.sh, já removido).
# ============================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI_SRC="$ROOT/cmd/pdv"
BIN_NAME="pdv"
PREFIX="${PREFIX:-$HOME/.local}"

# --- saída amigável: cores só em terminal, NO_COLOR respeitado ---
if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  C_RESET=$'\033[0m'
  C_BOLD=$'\033[1m'
  C_GREEN=$'\033[32m'
  C_RED=$'\033[31m'
  C_YELLOW=$'\033[33m'
  C_CYAN=$'\033[36m'
else
  C_RESET=''; C_BOLD=''; C_GREEN=''; C_RED=''; C_YELLOW=''; C_CYAN=''
fi

ok()   { printf '%s✔%s %s\n' "$C_GREEN"  "$C_RESET" "$*"; }
err()  { printf '%s✖%s %s\n' "$C_RED"    "$C_RESET" "$*" >&2; }
warn() { printf '%s!%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
info() { printf '%s›%s %s\n' "$C_CYAN"   "$C_RESET" "$*"; }
step() { printf '\n%s%s%s\n' "$C_BOLD" "$*" "$C_RESET"; }
die()  { err "$*"; exit 1; }

usage() {
  cat <<EOF
Instalador da CLI pdv (Rust — cmd/pdv)

Uso: ./install.sh [opção]

Opções:
  --local           Instala em ~/.local/bin (padrão)
  --global          Instala em /usr/local/bin (pode pedir sudo)
  --prefix DIR      Instala em DIR/bin
  --uninstall       Remove a CLI pdv do sistema
  -h, --help        Mostra esta ajuda

O instalador compila cmd/pdv (cargo build --release), remove versões
anteriores da CLI encontradas no PATH e nos prefixos comuns, instala o
binário novo e atualiza a cópia local ./pdv na raiz do repo (usada pelos
comandos ./pdv … da documentação).
EOF
}

# ---------- argumentos ----------
MODE="install"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --local)   PREFIX="$HOME/.local"; shift ;;
    --global)  PREFIX="/usr/local";   shift ;;
    --prefix)
      [[ $# -ge 2 ]] || die "--prefix exige um diretório (ex.: --prefix /opt/pdv)"
      PREFIX="$2"; shift 2 ;;
    --uninstall) MODE="uninstall"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "opção desconhecida: $1" ;;
  esac
done

BIN_DIR="$PREFIX/bin"
BIN="$BIN_DIR/$BIN_NAME"

# ---------- descoberta das versões instaladas ----------
# Imprime (uma por linha) os binários `pdv` existentes no sistema: os de
# qualquer diretório do PATH + prefixos conhecidos + a cópia local
# ./pdv na raiz do repo. O artefato de build em cmd/pdv/target é
# ignorado — ele não é "instalação".
find_installed() {
  local d f
  local -a dirs=()
  while IFS= read -r d; do
    if [[ -n "$d" ]]; then dirs+=("$d"); fi
  done < <(printf '%s' "$PATH" | tr ':' '\n')
  for d in \
    "$HOME/.local/bin" \
    "$HOME/bin" \
    "$HOME/go/bin" \
    /usr/local/bin \
    /usr/bin \
    /opt/pdv/bin \
    "$ROOT"
  do
    dirs+=("$d")
  done
  for d in "${dirs[@]}"; do
    f="$d/$BIN_NAME"
    case "$f" in
      "$CLI_SRC"/target/*) continue ;; # artefato de build, não instalação
    esac
    if [[ -f "$f" && -x "$f" ]]; then
      printf '%s\n' "$f"
    fi
  done | sort -u
}

# remove_file <caminho>: remove com permissão local ou via sudo.
# Retorna 0 se removeu; 1 caso contrário (aviso já impresso).
remove_file() {
  local f="$1" dir
  dir="$(dirname "$f")"
  if [[ -w "$dir" ]]; then
    if rm -f "$f"; then ok "removido: $f"; return 0; fi
    warn "falha ao remover $f"
    return 1
  fi
  if command -v sudo >/dev/null 2>&1; then
    info "removendo $f (a senha de administrador pode ser pedida)"
    if sudo rm -f "$f"; then ok "removido: $f"; return 0; fi
    warn "não foi possível remover $f — rode: sudo rm $f"
    return 1
  fi
  warn "sem permissão para remover $f — rode: sudo rm $f"
  return 1
}

# install_file <origem> <destino>: copia com permissão local ou via sudo.
install_file() {
  local src="$1" dst="$2" dir
  dir="$(dirname "$dst")"
  if [[ ! -d "$dir" ]]; then
    if ! mkdir -p "$dir" 2>/dev/null; then
      command -v sudo >/dev/null 2>&1 \
        || die "sem permissão para criar $dir e sudo indisponível — use --local ou --prefix DIR"
      info "criando $dir (a senha de administrador pode ser pedida)"
      sudo mkdir -p "$dir" || die "falha ao criar $dir"
    fi
  fi
  if [[ -w "$dir" ]]; then
    if ! cp "$src" "$dst" || ! chmod 0755 "$dst"; then
      die "falha ao copiar para $dst"
    fi
  else
    command -v sudo >/dev/null 2>&1 \
      || die "sem permissão de escrita em $dir — use --local ou --prefix DIR"
    info "instalando em $dst (a senha de administrador pode ser pedida)"
    if ! sudo cp "$src" "$dst" || ! sudo chmod 0755 "$dst"; then
      die "falha ao instalar $dst"
    fi
  fi
}

# ---------- desinstalar ----------
if [[ "$MODE" == "uninstall" ]]; then
  step "Removendo a CLI pdv do sistema"
  FOUND="$(find_installed)"
  if [[ -z "$FOUND" ]]; then
    warn "nenhuma instalação da CLI pdv encontrada"
    exit 0
  fi
  REMOVED=0
  FAILED=0
  while IFS= read -r f; do
    if [[ -z "$f" ]]; then continue; fi
    if remove_file "$f"; then REMOVED=$((REMOVED + 1)); else FAILED=$((FAILED + 1)); fi
  done <<< "$FOUND"
  echo
  ok "remoção concluída: $REMOVED removida(s), $FAILED falha(s)"
  [[ "$FAILED" -eq 0 ]] || exit 1
  exit 0
fi

# ---------- instalar ----------
step "Compilando a CLI pdv (release)"

if ! command -v cargo >/dev/null 2>&1; then
  # rustup costuma deixar o cargo em ~/.cargo/bin
  if [[ -f "$HOME/.cargo/env" ]]; then
    # shellcheck source=/dev/null
    . "$HOME/.cargo/env"
  fi
fi
command -v cargo >/dev/null 2>&1 \
  || die "cargo não encontrado. Instale o Rust: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
[[ -f "$CLI_SRC/Cargo.toml" ]] \
  || die "crate da CLI não encontrado em $CLI_SRC — rode a partir da raiz do repo"

info "cargo build --release em cmd/pdv (pode demorar no primeiro build)"
(cd "$CLI_SRC" && cargo build --release) || die "compilação falhou — veja os erros acima"

BUILT="$CLI_SRC/target/release/$BIN_NAME"
[[ -x "$BUILT" ]] || die "build terminou mas $BUILT não existe"
ok "build pronto: $BUILT"

step "Removendo versões anteriores"
FOUND="$(find_installed)"
if [[ -z "$FOUND" ]]; then
  ok "nenhuma versão anterior encontrada"
else
  REMOVED=0
  FAILED=0
  while IFS= read -r f; do
    if [[ -z "$f" ]]; then continue; fi
    # o destino desta instalação será sobrescrito — não conta como remoção
    if [[ "$f" == "$BIN" ]]; then continue; fi
    if remove_file "$f"; then REMOVED=$((REMOVED + 1)); else FAILED=$((FAILED + 1)); fi
  done <<< "$FOUND"
  ok "versões anteriores: $REMOVED removida(s), $FAILED falha(s)"
fi

step "Instalando em $BIN"
install_file "$BUILT" "$BIN"
INSTALLED_VERSION="$("$BIN" --version 2>/dev/null || echo "versão desconhecida")"
ok "instalado: $BIN ($INSTALLED_VERSION)"

# cópia local na raiz: os docs (scripts/README.md, AGENTS.md) mandam rodar
# `./pdv …`; falhar aqui não é fatal (ex.: checkout só de leitura).
if cp "$BUILT" "$ROOT/pdv" 2>/dev/null && chmod 0755 "$ROOT/pdv" 2>/dev/null; then
  ok "cópia local atualizada: ./pdv (comandos ./pdv … da documentação)"
else
  warn "não consegui criar ./pdv na raiz do repo — use o binário instalado acima"
fi

# avisos amigáveis: sobra de versão antiga e PATH
if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
  info "para usar o pdv de qualquer lugar, adicione ao seu shell:  export PATH=\"$BIN_DIR:\$PATH\""
fi
RESOLVED="$(command -v "$BIN_NAME" 2>/dev/null || true)"
if [[ -n "$RESOLVED" && "$RESOLVED" != "$BIN" && "$RESOLVED" != "$ROOT/pdv" ]]; then
  warn "outra cópia do pdv aparece antes do destino no PATH: $RESOLVED"
  warn "se for uma versão antiga, remova-a:  sudo rm $RESOLVED"
fi

step "Pronto! Como usar"
cat <<EOF
  pdv --help          ajuda completa e lista de comandos
  pdv status          diagnóstico do ambiente (git, worktrees, ferramentas)
  pdv setup           sobe o ambiente de dev em containers (docker compose)
  pdv tui             interface interativa no terminal

Mais comandos: docs/27-cli-pdv-rust.md
Desinstalar:  ./install.sh --uninstall
EOF
