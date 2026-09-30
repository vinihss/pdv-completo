# PDV Entregador — pendências mobile

Este README documenta o que **ainda não existe** no crate porque depende do
`tauri android init` (que não roda neste ambiente — sem Android SDK/NDK). Não
chute: cada item abaixo é ou gerado pelo init ou precisa ser escrito à mão
depois dele.

## O que falta

### 1. `gen/android/` — projeto Gradle

Gerado por:

```bash
cd standalone-entregador
cargo tauri android init
```

Isso cria:

```
gen/android/
├── app/
│   ├── build.gradle.kts
│   └── src/main/
│       ├── AndroidManifest.xml    ← permissões de sistema ficam aqui
│       ├── res/
│       └── java/com/pdvapp/entregador/
├── build.gradle.kts
├── gradle.properties
├── gradlew
├── settings.gradle.kts
└── tauri-build.gradle.kts
```

**Não crie `gen/android/` à mão.** O init gera o projeto Gradle com as
dependências e plugins corretos; um arquivo feito na mão será sobrescrito e o
conflito vai ser confuso.

### 2. `AndroidManifest.xml` — permissões de sistema

O arquivo `gen/android/app/src/main/AndroidManifest.xml` é onde as permissões
de sistema do Android são declaradas. O `tauri android init` gera um
`AndroidManifest.xml` mínimo; as permissões abaixo precisam ser adicionadas
à mão depois do init.

#### Localização: `ACCESS_FINE_LOCATION` (foreground)

```xml
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
```

**Justificativa — por que foreground e não background:**

O entregador precisa de localização **enquanto está em rota** para:

- Mostrar a posição no mapa durante a entrega
- Calcular distância restante e ETA
- Registrar o trajeto para o backend

Isso é **foreground**: o app está aberto na tela do entregador, ele está
ativamente usando o GPS. A permissão `ACCESS_FINE_LOCATION` (ou
`ACCESS_COARSE_LOCATION` se precisão de ~100m bastar) cobre esse caso.

**Por que NÃO pedir `ACCESS_BACKGROUND_LOCATION`:**

- O entregador não precisa de localização com o app fechado ou em segundo
  plano. Ele está sempre com o app aberto durante a rota.
- O Android 10+ restringe fortemente `ACCESS_BACKGROUND_LOCATION`: precisa de
  justificativa na Play Store, e o app pode ser rejeitado se a justificativa
  não for sólida.
- Se no futuro o app precisar de localização em background (ex.: rastreio
  automático mesmo com app minimizado), aí sim `ACCESS_BACKGROUND_LOCATION`
  entra — mas é uma decisão de produto, não de implementação.

#### Notificação: `POST_NOTIFICATIONS` (Android 13+)

```xml
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
```

**Justificativa:**

O entregador precisa ser notificado quando:

- Um novo pedido é atribuído a ele
- O status de uma entrega muda (ex.: cliente cancelou)

No Android 13+ (API 33+), `POST_NOTIFICATIONS` é uma permissão runtime que o
usuário precisa conceder explicitamente. Sem ela, o app não mostra
nenhuma notificação.

#### Acordar do segundo plano: `WAKE_LOCK` + `FOREGROUND_SERVICE`

```xml
<uses-permission android:name="android.permission.WAKE_LOCK" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_LOCATION" />
```

**Justificativa:**

O Android 8+ (API 26+) limita o que um app em segundo plano pode fazer. Para
manter o GPS ativo durante uma entrega (que pode durar 30+ minutos), o app
precisa de um **foreground service** com o tipo `location`:

- `FOREGROUND_SERVICE` — permite que o app rode um serviço em foreground
- `FOREGROUND_SERVICE_LOCATION` — tipo específico para serviços que usam
  localização (Android 14+ / API 34+)
- `WAKE_LOCK` — impede que a CPU durma enquanto o serviço está ativo

Sem isso, o Android pode matar o serviço de localização depois de alguns
minutos em segundo plano, e o entregador perde o rastreio no meio da rota.

#### Internet: `INTERNET`

```xml
<uses-permission android:name="android.permission.INTERNET" />
```

O `tauri android init` já adiciona essa permissão por padrão. Listada aqui
por completude.

### 3. `mobile-schema.json` — schema de capabilities mobile

O `$schema` de `capabilities/default.json` aponta para
`../gen/schemas/desktop-schema.json`, que é gerado pelo `build.rs` no host.
O schema mobile (`../gen/schemas/mobile-schema.json`) só existe depois do
`tauri android init`.

Até lá, o `$schema` aponta para um arquivo que não existe. Isso é **esperado**
e não afeta o build no host. Depois do init, o `$schema` pode ser atualizado
para apontar para o schema mobile, mas não é obrigatório — o Tauri funciona
sem ele.

## Endpoints do backend que o app consome

O app Entregador consome os seguintes endpoints do backend (todos em
`backend/src/http/routes/courier.routes.ts`):

| Método | Rota | Descrição |
|--------|------|-----------|
| `GET` | `/courier/deliveries` | Lista entregas do entregador logado (status: `awaiting_courier`, `out_for_delivery`) |
| `PATCH` | `/courier/deliveries/:id/dispatch` | Marca saída para entrega |
| `PATCH` | `/courier/deliveries/:id/deliver` | Confirma entrega |
| `PATCH` | `/courier/deliveries/:id/fail` | Registra falha na entrega (com motivo) |

**Não há endpoint de localização no backend.** O backend não expõe uma API
para o entregador enviar sua posição em tempo real. Se no futuro isso for
necessário (ex.: rastreio ao vivo para o cliente), o endpoint precisa ser
criado no backend — não aqui.

O backend **tem** um serviço de roteamento (`backend/src/integrations/maps/routing.service.ts`)
que calcula rotas entre dois pontos usando OSRM, mas ele é usado pelo backend
para calcular distância e duração da entrega no momento do dispatch — não é
um endpoint que o app consome diretamente.

## Como buildar

### Desktop (host)

```bash
cd standalone-entregador
cargo check
```

**Nota:** o crate ainda não está em `members` do `/Cargo.toml` raiz. O
`cargo check` vai falhar com `current package believes it's in a workspace
when it's not` — isso é **esperado**. O crate será adicionado ao workspace
pelo mantenedor.

### Mobile (Android)

```bash
cd standalone-entregador
cargo tauri android init   # gera gen/android/
# ... editar AndroidManifest.xml para adicionar as permissões acima ...
cargo tauri android build
```

**Requisitos:** Android SDK, NDK, Java 17+. Não roda neste ambiente.

## Estrutura do crate

```
standalone-entregador/
├── Cargo.toml              # package + [lib] crate-type = ["staticlib", "cdylib", "rlib"]
├── build.rs                # tauri_build::build()
├── tauri.conf.json        # config do Tauri (productName, identifier, frontendDist, ...)
├── capabilities/
│   └── default.json       # permissões do ACL (core:default, http:default)
├── icons/                  # ícones do app (copiados de frontend/src-tauri/icons/)
├── src/
│   ├── lib.rs              # run() + #[cfg_attr(mobile, tauri::mobile_entry_point)]
│   └── main.rs             # binário desktop (chama run())
├── .gitignore
└── README.md               # este arquivo
```

## Decisões

| Decisão | Valor | Justificativa |
|---------|-------|---------------|
| `productName` | `PDV Entregador` | Nome de exibição na loja e no sistema |
| `identifier` | `com.pdvapp.entregador` | Domínio reverso único; diferente do app v1 (`com.pdvapp.desktop`) |
| `version` | `0.1.0` | Primeira versão; igual no `Cargo.toml` e no `tauri.conf.json` |
| `frontendDist` | `../frontend/dist/entregador` | Profile `entregador` do Vite |
| `beforeBuildCommand` | `cd ../frontend && npm run build:entregador` | Funciona com cwd no crate ou no `frontend/` |
| `updater` | `false` | Distribuição por loja/APK; sem `latest.json` |
| `process` | `false` | Sem updater, não há quem chame `app.restart()` |
| `log` | `false` | Em mobile, log em arquivo é ruído e consumo de armazenamento |
| `app.windows` | 412x892, `resizable: false` | Tamanho de celular coerente; no mobile o Tauri usa a tela do sistema |
| `bundle.android.debugApplicationIdSuffix` | `.debug` | Sufixo para build de debug (mesmo do app v1) |
