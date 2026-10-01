#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PREFIX="${PREFIX:-/opt/pdv-printer}"
CONFIG_DIR="${CONFIG_DIR:-/etc/pdv-printer}"
SERVICE_USER="${SERVICE_USER:-pdv-printer}"

if [[ "${EUID}" -ne 0 ]]; then echo "Execute como root: sudo $0" >&2; exit 1; fi
command -v go >/dev/null || { echo "Go 1.22+ é necessário para compilar o daemon." >&2; exit 1; }

install -d -m 0755 "$PREFIX" "$CONFIG_DIR"
id "$SERVICE_USER" >/dev/null 2>&1 || useradd --system --home "$PREFIX" --shell /usr/sbin/nologin "$SERVICE_USER"

go build -trimpath -ldflags='-s -w' -o "$PREFIX/pdv-printer-daemon" "$ROOT/daemon"
cp -R "$ROOT/daemon/templates" "$PREFIX/"
# Não copia o config.example.json: ele traz IPs fictícios e uma impressora
# windows_spooler. Sem config, o próprio daemon cria um padrão na primeira
# execução, com impressoras sem endereço (ready=false até configurar) e um
# api_token aleatório.
chown -R "$SERVICE_USER:$SERVICE_USER" "$PREFIX" "$CONFIG_DIR"
chmod 0755 "$PREFIX/pdv-printer-daemon"
chmod 0750 "$CONFIG_DIR"

cat > /etc/systemd/system/pdv-printer.service <<EOF
[Unit]
Description=PDV Printer ESC/POS Daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$PREFIX
Environment=PDV_PRINTER_CONFIG=$CONFIG_DIR/config.json
ExecStart=$PREFIX/pdv-printer-daemon
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now pdv-printer.service
systemctl --no-pager --full status pdv-printer.service || true
echo "Instalado. O daemon cria $CONFIG_DIR/config.json na primeira execução (com api_token)."
echo "Edite as impressoras e reinicie: sudo nano $CONFIG_DIR/config.json && systemctl restart pdv-printer"
echo "O PDV precisa enviar  Authorization: Bearer <api_token>  (campo api_token do config)."
