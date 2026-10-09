---
name: sync-sidecar
description: Revisar a integração de impressão desktop e seus artefatos de build.
---
# Impressão desktop e sidecars

1. Leia `docs/agente-hardware-printing.md` e os guias/código dos crates envolvidos.
2. Confira os manifests Tauri e workflows presentes no checkout antes de afirmar se há sidecar; não dependa de caminhos antigos como `printer/` ou `printer/scripts/`.
3. Preserve os contratos de impressão e os testes golden existentes. Descubra os testes pelo módulo/fonte atual; não presuma que um daemon Go existe neste checkout.
4. Atualize o guia e os links de entrada se mudarem os caminhos, o empacotamento ou o estado da integração. Relate validações não executadas.
