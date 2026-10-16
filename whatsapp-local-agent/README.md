# Protótipo local WhatsApp Web para Linux

**Uso experimental e somente para testes.** Este projeto automatiza a interface do WhatsApp Web, não é integração oficial da Meta e pode parar de funcionar ou levar a restrições da conta. Não use em produção nem com mensagens/dados sensíveis. Os seletores da interface não são contrato estável.

O protótipo é independente do backend do PDV e não reativa a integração antiga removida. Executa um servidor local em `127.0.0.1:8765` com um painel de conexão e histórico.

## Requisitos e execução

- Node.js 20+
- `secret-tool` e keyring Secret Service ativo (GNOME Keyring, KDE Wallet ou equivalente)
- Chromium e dependências do Playwright

Debian/Ubuntu:

```bash
sudo apt-get update
sudo apt-get install -y libsecret-tools
cd whatsapp-local-agent
npm install
npx playwright install --with-deps chromium
npm test
npm start
```

Acesse `http://127.0.0.1:8765`, clique **Conectar / atualizar QR** e leia o QR com o WhatsApp no celular. Para que mensagens sejam detectadas, o processo deve permanecer aberto e o chat individual precisa estar aberto no WhatsApp Web.

## Fluxo de atendimento

1. **Grupo:** o identificador de grupo (`@g.us`) é rejeitado antes de ler o texto da mensagem. Não cria contato, não guarda conteúdo e não responde.
2. **Mensagem individual sem sinal de pedido:** o texto é avaliado transitoriamente em memória por uma lista inicial de palavras-chave (pedido, cardápio, entrega, acompanhar etc.). Se não corresponder, não é guardado nem respondido. Para classificar, o conteúdo precisa ser examinado em memória; não é gravado em log nem no histórico.
3. **Pedido detectado:** grava o contato e a mensagem individual no histórico cifrado e pergunta: `1 - Fazer um pedido` ou `2 - Acompanhar um pedido`.
4. **Escolha 1:** pede itens e quantidades, guarda a resposta e informa que o protótipo apenas registra a conversa. **Não cria nem confirma pedido no PDV.**
5. **Escolha 2:** solicita o número do pedido. Ao recebê-lo, registra a conversa e avisa que a consulta automática ainda não existe; a equipe precisa conferir antes de responder.
6. **Novo pedido:** quando um atendimento anterior foi concluído, um contato pode iniciar outro ao enviar uma mensagem que corresponda às palavras-chave.

Respostas numéricas ou texto fora das etapas esperadas são ignorados e não armazenados. Não há envio de mensagens para grupos. As palavras-chave em `src/filters.mjs` são intencionalmente simples e precisam ser ajustadas após testes reais.

## Histórico e proteção

- A tela local lista conversas de pedido por contato e mostra mensagens recebidas/enviadas.
- O banco é SQLite em memória durante a execução. Em disco, apenas o snapshot cifrado `history.sqlite.enc` é persistido com AES-256-GCM; a sessão do navegador também é cifrada.
- A chave AES-256 é criada e guardada no keyring do Linux por `secret-tool`. Se o keyring não estiver disponível, o programa falha fechado, sem gravar a chave em arquivo.
- Arquivos ficam em `~/.local/share/pdv-whatsapp-test/` (ou `$XDG_DATA_HOME/pdv-whatsapp-test/`), com diretório `0700` e arquivos `0600`. O histórico permanece até ser apagado manualmente; ainda não existe expiração automática nem botão para apagar no painel.
- A cifragem em repouso não protege contra malware ou usuário com acesso à sessão desktop enquanto o programa está em execução.

## Limitações conhecidas

- **Não sincroniza todas as conversas.** Observa somente o chat aberto; mensagens podem ser perdidas se outras chegarem entre ciclos de observação.
- Para segurança, só aceita identificadores individuais no formato `@c.us`; grupos e IDs desconhecidos (por exemplo, `@lid`) são ignorados. Se uma versão do WhatsApp Web deixar de expor esse identificador, o contato não será salvo.
- A resposta de boas-vindas usa palavras-chave, não entendimento semântico. Pode deixar passar pedidos escritos de outra forma ou classificar incorretamente termos ambíguos.
- O fluxo não consulta pedidos, não cria pedidos, não confirma estoque/preço e não encaminha para atendimento humano.
- Não integrado ao PWA, Tauri ou backend do PDV. O endpoint HTTP fica limitado a loopback, mas não substitui autenticação do sistema para uso com outras aplicações locais.
- Automação não oficial e experimental: não é recomendada para produção.

## Verificação

```bash
npm run check
npm test
```
