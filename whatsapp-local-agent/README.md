# Protótipo local WhatsApp Web para Linux

**Uso experimental e somente para testes.** Este projeto automatiza a interface do WhatsApp Web; não é uma integração oficial da Meta e pode parar de funcionar ou levar a restrições da conta. Não use em produção nem com mensagens/dados sensíveis. Os seletores da interface não são um contrato estável.

O agente é um programa independente do PWA/Tauri e do backend. Mantém um servidor local em `127.0.0.1:8765` com painel de conexão, QR e histórico. O checkout e as consultas são feitos nos endpoints públicos do PDV.

## Requisitos e execução

- Node.js 20+
- `secret-tool` e keyring Secret Service ativo (GNOME Keyring, KDE Wallet ou equivalente)
- Chromium e dependências do Playwright
- URL absoluta da API e URL pública do cardápio online da loja

Debian/Ubuntu:

```bash
sudo apt-get update
sudo apt-get install -y libsecret-tools
cd whatsapp-local-agent
npm install
npx playwright install --with-deps chromium
npm test
```

Arch Linux:

```bash
sudo pacman -S --needed libsecret gnome-keyring
command -v secret-tool
```

O pacote `libsecret` fornece o executável `secret-tool`; ele também precisa falar com um serviço Secret Service ativo na sessão gráfica. Em uma sessão GNOME, o `gnome-keyring` normalmente é iniciado pelo login. Confira se o D-Bus do usuário anuncia o serviço:

```bash
busctl --user list | grep org.freedesktop.secrets
```

Se o executável existir, mas o serviço não aparecer, tente iniciá-lo dentro da sessão do usuário (não use `sudo`):

```bash
gnome-keyring-daemon --start --components=secrets
```

Para diagnóstico, teste o keyring diretamente. O segundo comando deve imprimir `teste`; depois remova a entrada temporária:

```bash
printf 'teste\n' | secret-tool store --label='PDV keyring test' service pdv-test account local
secret-tool lookup service pdv-test account local
secret-tool clear service pdv-test account local
```

Se `command -v secret-tool` não imprimir caminho, o processo do agente pode estar com outro `PATH`; no Arch o executável costuma estar em `/usr/bin/secret-tool`. Se `secret-tool` existe mas `lookup` falha, verifique o serviço D-Bus/keyring ou se o cofre está desbloqueado. Não execute o agente com `sudo`, porque isso muda a sessão D-Bus e o keyring do usuário.

Configure as URLs usadas pela instalação da loja. A URL da API deve ser a mesma base `/api` que o PWA usa, incluindo o host da loja/tenant; a URL pública deve apontar para a página `/pedido` dessa loja:

```bash
export PDV_API_BASE_URL="https://api.sua-loja.exemplo/api"
export PDV_PUBLIC_ORDER_URL="https://sua-loja.exemplo/pedido"
npm start
```

Em desenvolvimento local, use por exemplo `http://127.0.0.1:3000/api` e `http://127.0.0.1:5173/pedido`. Para execução por systemd, defina as mesmas variáveis na unidade/arquivo de ambiente, sem gravar tokens ou cookies em texto claro.

Acesse `http://127.0.0.1:8765`, clique **Conectar / atualizar QR** e leia o QR com o WhatsApp no celular. Depois da conexão, o processo varre periodicamente a lista lateral do WhatsApp Web para encontrar chats individuais não lidos.

Para configurar um chat individual exclusivo de teste, defina `PDV_WA_TEST_PHONE` com o telefone completo incluindo DDI, apenas dígitos, antes de iniciar o agente. Exemplo no terminal (substitua pelo número de teste desejado):

```bash
export PDV_WA_TEST_PHONE=SEU_NUMERO_COM_DDI
npm start
```

Esse chat é conferido a cada 10 segundos mesmo quando a última mensagem já foi lida ou a atividade tem mais de 24 horas; o agente considera somente a última mensagem recebida e valida que o JID corresponda exatamente ao número configurado. O restante dos chats continua sujeito à regra de 24 horas. Como essa exceção pode processar mensagens antigas do contato de teste, use apenas uma conta controlada para testes. O telefone não está embutido no código nem no `.env.example`.

## Logs em tempo real

Os eventos são escritos em JSON no `stdout`, sem telefone, nome ou texto das mensagens. Para ver e salvar a saída ao iniciar manualmente:

```bash
cd whatsapp-local-agent
mkdir -p ~/.local/state
npm start 2>&1 | tee -a ~/.local/state/pdv-whatsapp-agent.log
```

Em outro terminal, acompanhe o arquivo ao vivo e filtre os eventos de varredura/atendimento:

```bash
tail -F ~/.local/state/pdv-whatsapp-agent.log | grep --line-buffered -E '"event":"(scanner[.]|message[.])'
```

Para uma unidade `systemd` de usuário, use `journalctl --user -u NOME.service -f -o cat`; para uma unidade de sistema, use `sudo journalctl -u NOME.service -f -o cat`. Os eventos principais são `scanner.idle` (registrado a cada 30 s sem chats não lidos), `scanner.unread_detected`, `scanner.skipped_unverified_chat`, `scanner.skipped_outside_24h`, `scanner.test_chat_latest_verified`, `scanner.opening_direct_chat`, `scanner.message_id_verified`, `message.classified`, `message.ignored`, `reply.sent` e `scanner.failed`.

## Fluxo de atendimento

1. **Filtro e classificação local:** grupos e IDs não reconhecidos são rejeitados. Um classificador Naive Bayes multinomial, pequeno e executado em Node.js, compara o texto com exemplos locais de três classes: `novo pedido`, `acompanhar pedido` e `fora de escopo`. Não usa rede, API paga nem envia o texto a terceiros. Mensagens fora de escopo só são avaliadas em memória e descartadas.
2. **Linguagem flexível:** aceita formulações como “manda o cardápio”, “quero pedir de novo”, “onde está meu pedido?” e “já saiu?”. Acentos e pontuação são normalizados. Respostas `1`/`2` continuam compatíveis.
3. **Ambiguidade:** se houver sinal de pedido mas a confiança/margem forem insuficientes, o bot pergunta se a pessoa quer iniciar um novo pedido ou acompanhar um existente. Não registra mensagens fora do escopo de pedido.
4. **Consulta de pedido:** para mensagem classificada como pedido, o agente consulta `POST /public/orders/active` usando o telefone e obtém a fase em `GET /public/orders/:id/status`.
5. **Pedido em andamento:** informa a etapa atual, explica a situação e pergunta se a pessoa deseja fazer outro pedido ou acompanhar o atual. Sem pedido ativo, oferece abrir o cardápio.
6. **Novo pedido e acompanhamento:** envia o link `/pedido` com `via=whatsapp` e `phone=<telefone>`. Se a pessoa optar por acompanhar o pedido atual, inclui também `order=<id>`. Depois do checkout, o agente detecta o novo pedido e envia confirmação e link de status.

O telefone enviado pelo link é uma referência de associação, não uma prova de identidade. A consulta pública por telefone já existe no contrato do PDV e tem rate limit. A marcação de canal é metadado de origem, não autenticação. O agente limita as consultas periódicas para respeitar o rate limit público.

## Histórico e proteção

- O painel local lista contatos e mensagens de pedidos.
- O SQLite fica em memória durante a execução. Em disco, apenas o snapshot cifrado `history.sqlite.enc` é persistido com AES-256-GCM; a sessão do navegador também é cifrada.
- A chave AES-256 é criada e guardada no keyring Linux por `secret-tool`. Sem Secret Service, o programa falha fechado e não grava a chave em arquivo.
- Os arquivos ficam em `~/.local/share/pdv-whatsapp-test/` (ou `$XDG_DATA_HOME/pdv-whatsapp-test/`), com diretório `0700` e arquivos `0600`. O histórico, incluindo telefones e links enviados, permanece até ser apagado manualmente; ainda não há expiração automática nem botão de exclusão no painel.
- A cifragem em repouso não protege contra malware ou contra uma pessoa com acesso à sessão desktop enquanto o programa está em execução.

## Limitações conhecidas

- **Varredura cautelosa de não lidas.** O agente só abre um item se a lista lateral expuser um JID individual `@c.us` e uma data/hora precisa que confirme atividade nas últimas 24 horas; sem timestamp confiável, o chat é ignorado. Depois confirma que o `data-id` da mensagem pertence ao mesmo JID antes de ler seu texto. Itens antigos, grupos e IDs desconhecidos (por exemplo, `@lid`) não são abertos/processados; uma mudança no DOM do WhatsApp Web pode fazer o agente ignorar conversas até os seletores serem atualizados.
- O agente verifica até 100 itens da lista lateral por ciclo e processa somente as mensagens não lidas que o contador do WhatsApp expõe. Conversas arquivadas/fora da lista carregada ou mensagens que o WhatsApp não marque como não lidas podem não ser detectadas.
- O classificador de `src/classifier.mjs` é um Naive Bayes lexical treinado com exemplos curtos embutidos no código: é local e rápido, mas não entende contexto profundo, gírias novas ou erros de digitação com a robustez de um modelo grande. Atualize os exemplos e rode os testes antes de alterar o limiar de confiança.
- A mensagem pós-checkout é detectada por polling do pedido ativo, não por webhook; pode chegar com atraso. A automação de envio para um número em outra aba também depende da interface atual do WhatsApp Web.
- O checkout continua sendo concluído pelo cliente na página `/pedido`; o agente não cria pedido nem altera preço, estoque, pagamento ou entrega diretamente.
- O painel local é limitado a loopback, mas não substitui autenticação do sistema para integração com outros aplicativos locais.
- Automação não oficial e experimental: não é recomendada para produção.

## Verificação

```bash
npm run check
npm test
```
