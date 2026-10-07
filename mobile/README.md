# mobile — apps React Native (Expo SDK 57)

Um único codebase Expo/React Native que gera **dois apps** conforme a variante
de build `APP_VARIANT`:

| `APP_VARIANT` | App | slug | bundle/package |
|---|---|---|---|
| `garcon` (padrão) | PDV Garçom | `pdv-garcon` | `com.pdvapp.garcon` |
| `entregador` | PDV Entregador | `pdv-entregador` | `com.pdvapp.entregador` |

A identidade nativa (nome, slug, bundle id, permissões) muda em
`app.config.js`; o lado JS lê a variante em `src/shared/lib/variant.js`.

> Contexto, decisões de arquitetura e mapeamento web → RN estão em
> [`docs/22-mobile-react-native.md`](../docs/22-mobile-react-native.md). Este
> README cobre só **rodar, configurar e buildar** o `mobile/`.

## Pré-requisitos

- Node.js 20+ e `npm install` nesta pasta.
- **Conta Expo/EAS** (dono da conta): o `projectId` **não está versionado**.
  Rode uma vez, autenticado, para gravá-lo no `app.config.js`/`app.json`:

  ```bash
  npx eas init               # cria/associa o projeto EAS e grava o projectId
  npx eas build:configure    # gera o eas.json (já versionado) e confere o projeto
  ```

  Sem o `projectId`, `eas build`/`eas submit` falham. O `eas.json` já está no
  repo; `eas init` só precisa **preencher** o id no config da conta.
- **Conta Apple Developer** para build/entrega iOS (certificados e perfis via
  EAS credentials).
- **Google Maps API Key** para o app Entregador no **Android em release** —
  restrinja a chave ao pacote `com.pdvapp.entregador` (Android apps) no Google
  Cloud Console.

## Rodando em desenvolvimento

```bash
npm run start:garcon       # APP_VARIANT=garcon
npm run start:entregador   # APP_VARIANT=entregador
```

(O `npm run start` sem variante equivale a `garcon`.)

## Variáveis de ambiente

Copie `.env.example` para `.env` (o `.env` é ignorado pelo git). O Expo injeta
as variáveis em tempo de build via `babel.config.js`.

| Variável | Obrigatória? | Descrição |
|---|---|---|
| `APP_VARIANT` | Não (padrão `garcon`) | `garcon` ou `entregador`. Define identidade, permissões e telas. |
| `GOOGLE_MAPS_API_KEY` | **Só** para Android + Entregador em release (APK/AAB) | Chave do Google Maps SDK. Sem ela o mapa (`react-native-maps`) fica cinza no Android em release. iOS usa Apple Maps e não precisa. Vazio em dev/preview é aceitável. |

A chave é lida em `app.config.js` (`android.config.googleMaps.apiKey`) para não
commitar segredo.

## Validando a configuração nativa

Confere o resultado do `app.config.js` sem gerar as pastas nativas:

```bash
APP_VARIANT=garcon     npx expo config --type prebuild
APP_VARIANT=entregador npx expo config --type prebuild
```

Atalhos (tipo `public`):

```bash
npm run config:garcon
npm run config:entregador
```

## Build com EAS

Perfis definidos em [`eas.json`](./eas.json):

| Perfil | Distribuição | Android | iOS | Uso |
|---|---|---|---|---|
| `development` | internal | development client | — | Dev client com módulos nativos. |
| `preview` | internal | `.apk` | — | APK para testar em aparelho. |
| `production` | store | `.aab` (app-bundle) | build de loja | `autoIncrement: true` (incrementa `versionCode`/`buildNumber`). |

Exemplos:

```bash
# APK de preview do Entregador
APP_VARIANT=entregador npx eas build --profile preview --platform android

# Produção (app-bundle) do Garçom
APP_VARIANT=garcon npx eas build --profile production --platform android

# Dev client
npx eas build --profile development --platform android
```

O `APP_VARIANT` é lido no build; passe-o no ambiente para escolher o app.

### CI (opcional)

Para builds automáticos sem login interativo, use um token de conta Expo:
`EXPO_TOKEN` (secret do CI). Nenhum workflow é fornecido aqui — é só a
variável que o `eas build` consome.

## Assets e ícones

Os ícones/splash atuais em `assets/` são **os do template Expo — placeholders**.
As fontes de marca ficam em:

- `standalone-garcon/icons/`
- `standalone-entregador/icons/`

Ao definir a identidade final de cada variante, substitua os assets de
`mobile/assets/` pelos ícones correspondentes.
