# docs/22-mobile-react-native.md — Migração dos apps mobile para React Native/Expo

**Status:** Em migração (cascas Tauri mobile ainda existem, mas codebase RN já funcional em branch).  
**Número:** 22 (próximo livre após 21-device-provisioning.md).

## 1) Contexto e decisão

O projeto tinha duas cascas Tauri específicas para os perfis mobile: `standalone-garcon/` (Tauri) e `standalone-entregador/` (Tauri), com `com.pdvapp.garcon` e `com.pdvapp.entregador`. Em 2026, nesta branch (`feat/mobile-rn`), foi criado `mobile/` — um único codebase Expo SDK 57 (JavaScript, React Native) que, conforme `APP_VARIANT`, gera os **dois apps diferentes**.

### Por que trocar as cascas Tauri mobile por Expo/RN

- **Experiência/hardware nativo:** câmera (QR), biometria/local auth, SecureStore, localização (GPS), manter app ativo, áudio — hoje cobertos por módulos nativos com melhor suporte no RN/Expo.
- **iOS + Android com menor complexidade:** Expo unifica configuração (app.config.js), build (EAS) e permissões (Info.plist/manifest) em um lugar, evitando duplicação entre as duas cascas.
- **Paridade com padrões web/mobile atuais:** evita manter duas frentes de configuração nativa distintas (Tauri mobile crates) enquanto o web já segue FSD; o RN permite reutilizar conceitos (contratos, realtime, armazenamento) com adaptações mínimas.
- **Manutenção única:** um codebase → dois apps (garçom/entregador) via variant, reduz drift entre os dois perfis mobile.
- **Sem publicação nas lojas até validação:** nada foi publicado, nenhum APK instalado em aparelho — janela segura para migração.

**Decisão:** manter um único repositório, codebase RN com `APP_VARIANT`, gerando os dois apps com os mesmos package IDs dos crates Tauri (`com.pdvapp.garcon` / `com.pdvapp.entregador`).

## 2) Arquitetura geral

- **Base:** Expo SDK 57, React 19.2.3, React Native 0.86.3 (JavaScript puro).
- **Dois apps, um código:** `APP_VARIANT=garcon|entregador` define identidade (name/slug/bundle/package), permissões, telas e comportamento. `shared/lib/variant.js` expõe `APP_VARIANT`, `isGarcon`, `isEntregador`.
- **FSD:** `mobile/src/{app,pages,widgets,features,entities,shared}` — mesmo estilo de organização usado no frontend (ver `docs/09-frontend-fsd.md`).
- **Sem lib de estado global extra:** server-authoritative. Fetch via `server.apiUrl` + `fetch` nativo, realtime via `useRealtime` (WebSocket com token em subprotocol), reload por GET após mutações.
- **Navegação:** `@react-navigation/native` + `native-stack`.
- **Testes:** Jest + jest-expo + @testing-library/react-native (227 testes / 26 suítes verdes). Lint: `expo lint` (0 erros).

### Estrutura selecionada (espelho da realidade)

```text
mobile/
├── app.config.js        # identidade, plugins, permissões por VARIANT
├── babel.config.js      # inline env (APP_VARIANT, EXPO_PUBLIC_*)
├── jest.setup.js
├── src/
│   ├── app/             # providers, rotas, bootstrap
│   ├── entities/        # modelos/dominios (ex.: provisioning)
│   ├── features/        # fluxos de UI reutilizáveis
│   ├── pages/           # telas por perfil/fluxo
│   ├── shared/
│   │   ├── hooks/       # useRealtime, useOnlineStatus, useAppStateActive
│   │   └── lib/         # server, storage (MMKV), variant, appConfig, etc.
│   └── widgets/
└── scripts/             # utilitários
```

## 3) Mapeamento web → RN

Adaptações feitas para "tirar" as dependências do navegador e dos plugins Tauri, mantendo contratos.

| Web (frontend) | RN (mobile) | Observação |
|---|---|---|
| `fetch` com mesmas origens (Vite proxy) | `fetch` nativo via `server.apiUrl()` (sempre base persistida) | Sem CORS no plano LAN: backend atende direto. |
| `window.location` / origem da página | sem "origem" — `currentServerLabel()` devolve `""` se não configurado; `wsUrl()` deriva ws(s) da base salva | Tela de setup impede chamadas sem configuração válida. |
| `localStorage` | `react-native-mmkv` via shim `storage` (`shared/lib/storage.js`) — API síncrona (getItem/setItem/removeItem/clear) | Permite portar módulos com leitura síncrona no boot. |
| `sessionStorage` | MMKV (mesmo store) | Decisão pragmática (sandbox do app). |
| `navigator.onLine` | `@react-native-community/netinfo` (`useOnlineStatus`) | Mockado em testes. |
| `document.visibilitychange` / foco | `AppState` (`useAppStateActive`) | Usado quando relevante ao realtime/conexão. |
| WebSocket (`WebSocket` browser) | WebSocket nativo (`new WebSocket(url, [token])`) — token em subprotocol | Mesmo contrato: servidor fecha 4001 se token inválido. |
| `react-leaflet` (mapa web) | `react-native-maps` | Entregador: mapa, marcadores/rota conforme necessário ao fluxo. |
| Web Audio API | `expo-audio` | Sons/feedback conforme fluxo. |
| Wake Lock (`navigator.wakeLock`/Tauri) | `expo-keep-awake` | Manter tela ativa em fluxos críticos (ex.: lista/entrega). |
| Configurações nativas Tauri | `app.config.js` + config plugins Expo | Camera, LocalAuthentication, SecureStore, build properties, permissões. |
| Config/estado persistente geral | MMKV (`pdv-storage`) | Sessão/token e preferências não-sensitivas. |
| Credencial revogável (device token) | `expo-secure-store` (`pdv.device`) | Protegido (keychain/keystore). Ver §4. |
| Scanner QR | `expo-camera` (barcodeScannerEnabled) | Leitura de QR de provisionamento (e usos futuros se houver). |
| Biometria/desbloqueio | `expo-local-authentication` | Usado no fluxo de device provisioning. |

## 4) Device provisioning no RN

Baseado em `docs/21-device-provisioning.md` (fonte da verdade; **não editado**). A migração para RN herda os contratos REST, mas **altera a implementação nativa**.

### Diferenças práticas (RN vs Tauri) em relação ao doc 21

| Aspecto (doc 21) | RN (mobile/src) | Observação |
|---|---|---|
| Scanner: `tauri-plugin-barcode-scanner` | `expo-camera` (`barcodeScannerEnabled: true`) | Mesmo caso de uso (QR). Permissões: `NSCameraUsageDescription` + `android.permissions` (plugin). |
| Biometria: `tauri-plugin-biometric` | `expo-local-authentication` | Verifica disponibilidade, autenticação biométrica. Mensagens iOS/Android via plugin/config. |
| Device config armazenada em `standalone-shared` (Rust/Tauri) | `expo-secure-store` para credencial; `MMKV` para preferência biométrica (`pdv:device:biometric`) | Credencial: `{ deviceId, deviceToken, user }` salva em `pdv.device` (SecureStore). Preferência não-sensitiva no MMKV. |
| Manifest/gen/android (Tauri) | `app.config.js` + config plugins (`expo-camera`, `expo-local-authentication`, `expo-secure-store`, `expo-build-properties`) | Tudo centralizado em `app.config.js`. |
| Configuração do aparelho (persistência) | Entidade `entities/provisioning` (model/api): `credential.js`, `code.js`, `errors.js` + testes | Implementação JS/AsyncStorage-like via SecureStore; contratos idênticos conceitualmente ao fluxo descrito no doc 21. |
| Refresh da credencial | `POST /auth/device/refresh` usado conforme fluxo (com `deviceToken`) | Mantido. |

### Fluxo implementado (alta leitura)

1. Sem servidor configurado → tela de setup (base HTTP/HTTPS do backend). Com base → prossegue.
2. Verifica credencial no SecureStore (`loadDeviceCredential`). Se não existe → **tela de provisionamento** (QR via camera / código digitado).
3. Após provisionamento válido, salva credencial (`saveDeviceCredential`) e prossegue ao login normal (PIN do usuário vinculado). Biometrics opcional: `isBiometricEnabled` / `setBiometricPreference`.
4. Sessão JWT mantém-se no MMKV (descartável, ~12h) conforme padrão; device token é a credencial persistente (revogável).

**Ponto a registrar:** o doc 21 assume **plugins Tauri** e detalhes de `standalone-shared/device_config`/manifest. No RN isso é substituído por **expo-camera / expo-local-authentication / expo-secure-store**. As decisões de §3 e §9 do doc 21 **ficam superadas pela migração RN** (implementação diferente, mesmo objetivo e contratos backend preservados).

## 5) Fluxos por variante

### Garçom (`APP_VARIANT=garcon`)

Coberto no RN:
- Login (grade + PIN). **Legado (grade+PIN legado) só aparece em `__DEV__`** (conforme código).
- Provisionamento de aparelho (quando necessário).
- Board de comandas, nova comanda, lançar itens, edição de itens, pagamento (Pix/QR), impressão **condicional ao daemon LAN** (`isDaemonConfigured`), sino/alertas, etc.
- Integração com realtime (`waiter:{id}`, salas relevantes), keep-awake/online status quando aplicável.

### Entregador (`APP_VARIANT=entregador`)

Coberto no RN:
- Lista/cards de entregas, dispatch/entregar/falha.
- Mapa: `react-native-maps`.
- GPS: `expo-location` (foreground), com ping ~60s (conforme implementação), permissões `ACCESS_FINE_LOCATION`/`ACCESS_COARSE_LOCATION`.
- `expo-keep-awake`, `expo-audio` para feedback.
- Realtime para `deliveries` + alerts.

**Impressão:** apenas via **daemon em LAN**. Não existe daemon no celular — o app decide exibição do botão "Imprimir" a partir da configuração do daemon (`getDaemonBase`/`isDaemonConfigured` em `server.js`). Sem daemon configurado, botão fica escondido.

## 6) Como rodar e buildar

Não existe `mobile/README.md` neste repo. Os scripts e fluxo são os abaixo.

### Pré-requisitos

- Node.js 20+
- Expo CLI/runtime via `npx expo` (Expo SDK 57)
- Dispositivo físico ou emulador/simulador para testar câmera/GPS/biometria

### Rodar em dev

```bash
cd mobile
npm install
npm run start:garcon      # APP_VARIANT=garcon
# ou
npm run start:entregador  # APP_VARIANT=entregador
```

Outros scripts (package.json):
- `npm start` (default garcon via lógica do app.config/variant)
- `android`, `ios` (via expo)
- `test` (Jest)
- `lint` (expo lint)
- `config:garcon`, `config:entregador` (`expo config --type public`)

### Configuração do servidor/backend

- Definir base do backend: tela de setup no app (HTTP/HTTPS, porta LAN, ex.: `http://192.168.0.10:3000`). Persistido em MMKV (`pdv:server`).
- Build pode embutir `EXPO_PUBLIC_DEFAULT_SERVER` (vide `server.js`) para evitar digitação em aparelho interno.
- Daemon de impressão (se usado): configurado no app (LAN) — endereço persistido em `pdv:daemon`; sem ele impressão não aparece.

### Build (Android/iOS)

Expo/EAS recomendado. Identidades já definidas:
- Garçom: `com.pdvapp.garcon`
- Entregador: `com.pdvapp.entregador`

**Dependências externas (a registrar explicitamente):**
- **Google Maps API key (Android release):** necessária para `react-native-maps` em build release Android (e opcional em dev). Deve ser configurada no app.config/EAS (não versionar chave).
- **Expo/EAS Account + Project:** para builds remotos (`eas build`) e (se publicar) distribuição interna/lojas. Conta/projeto Expo não existem no repo.
- **Apple Developer Account / Certificates (iOS):** se for buildar/distribuir iOS. Fora do escopo atual.
- **Keystore Android:** gerado por EAS ou local (`eas credentials`). Nunca commitar.

**Sem sidecar printer no mobile.** Impressão é sempre via daemon HTTP na LAN (mesmo padrão do web quando configurado).

## 7) Pendências explícitas

1. **Chaves externas**
- [ ] Google Maps API key para Android release (`react-native-maps`). Configurar em `app.config.js` (android.config.googleMaps.apiKey) ou via EAS secrets. **Não versionar**.
- [ ] Definir/validar contas: Expo account, EAS project, Apple Developer (se iOS). Sem owner definido ainda.

2. **Validação em aparelho (smoke nunca feito)**
- [ ] Smoke completo garçom em aparelho físico: login/provisionamento → nova comanda → lançar itens → pagamento Pix/QR → impressão via daemon LAN → sino.
- [ ] Smoke completo entregador em aparelho físico: lista → dispatch/entregar/falha → mapa + GPS (foreground, ping 60s) → keep-awake/áudio.
- [ ] Testar provisionamento por QR + código digitado, biometria e rotação de token (`/auth/device/refresh`).
- [ ] Validar `usesCleartextTraffic: true` em LAN real (Android) e sem quebrar HTTPS.

3. **Paridade fina com web (front)**
- [ ] **Rótulo "Cliente" vs "Rótulo" quando `uses_tables=false`** — conferir exibição em telas do garçom (paridade com `frontend/src`).
- [ ] **Stepper no carrinho** — validar comportamento (incremento/decremento) igual ao web.
- [ ] **Tela de log do garçom** — garantir presença/funcionamento conforme esperado.
- [ ] **Imagem de produto** — `assetUrl` já trata `/uploads/...` + absolutos; conferir carregamento offline/timeout.

4. **Infra/escopo**
- [ ] **Notificações push** — fora do escopo (mencionado em comentários mas não implementado). Decisão: não tratar agora.
- [ ] **Impressão só via daemon LAN** — confirmado (sem renderizador nativo no app). Documentar esse contrato para operadores.
- [ ] **Revisar `__DEV__` legacy login** — grade+PIN legado só em dev; não deve ir para release.

5. **Destino das cascas Tauri mobile (`standalone-garcon/`, `standalone-entregador/`)**
- [ ] **Recomendação: manter até o smoke em aparelho estar concluído e validado.** Os apps nunca foram publicados/instalados; manter por enquanto evita regressão caso precise comparar comportamento nativo (camera/biometria/GPS) durante validação.
- [ ] **Remover em PR próprio, depois da validação.** Mesmo padrão de transição adotado para o app v1 (desktop Tauri desacoplado) — não apagar junto desta doc. Criar tarefa/PR dedicado com checklist de remoção + verificação.
- [ ] **Não editar `standalone-*/README` nem docs relacionados agora** (conforme regra). Só registrar nesta doc.

## 8) Tabela de verificação (o que foi rodado)

Executado nesta branch (verificado):

```bash
cd /root/pdv/feat/mobile-rn/mobile
npm test   # 227 tests / 26 suites — PASS
npm run lint  # 0 errors
```

Não executado (necessário em aparelho):
- `npx expo start --android` / `--ios` em dispositivo físico
- Builds EAS (debug/release) por variante
- Smoke ponta-a-ponta com backend real na LAN

## 9) Divergências encontradas vs "contexto factual" fornecido

Nenhuma divergência substancial. O que foi verificado bate com o descrito:
- `mobile/` existe, Expo SDK 57, FSD, dois apps via `APP_VARIANT`.
- Provisionamento implementado (`entities/provisioning`) com SecureStore + MMKV.
- Shared: `server.js` (fetch/WS/asset/daemon), `storage.js` (MMKV), `useRealtime.js` com token em subprotocol e reconexão com backoff+jitter, `variant.js`.
- Testes verdes (227/26). Lint limpo.
- `mobile/README.md` **não existe** — por isso a seção 6 aponta para scripts/package.json.

Pequenos acertos na documentação necessária: deixar explícito que **docs/21** assume plugins Tauri (superado pela implementação RN) e registrar pendências de chaves externas + destino das cascas Tauri.

## 10) Referências

- `docs/21-device-provisioning.md` — spec de provisionamento (fonte; não editado)
- `mobile/app.config.js` — identidade, plugins, permissões por variante
- `mobile/src/shared/lib/server.js` — base API/WS/daemon/asset
- `mobile/src/shared/lib/storage.js` — MMKV shim
- `mobile/src/shared/hooks/useRealtime.js` — WS com token em subprotocol
- `mobile/src/entities/provisioning/*` — modelo/api/erros + testes
- `mobile/src/shared/lib/variant.js` — APP_VARIANT
- `standalone-garcon/`, `standalone-entregador/` — cascas Tauri atuais (a manter até smoke)
