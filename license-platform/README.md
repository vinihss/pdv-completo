# License Platform

License Platform é um serviço central em Go para emissão e validação de licenças de produtos SaaS e sistemas instalados. O servidor assina as licenças com **Ed25519**. O SDK cliente verifica a assinatura localmente e mantém um cache para permitir operação offline durante o período configurado.

O projeto utiliza arquitetura exagonal. O domínio depende de portas, enquanto HTTP, GORM e SQLite são adaptadores substituíveis. A persistência atual usa SQLite por meio do GORM, com caminho preparado para futura migração para PostgreSQL.

> **Estado atual:** este repositório é um MVP técnico. A geração de chaves ainda é adequada apenas para desenvolvimento. Antes de produção, use um secret manager, autenticação administrativa, migrações versionadas e observabilidade.

## Funcionalidades

O servidor oferece emissão e validação de licenças. Cada licença pode conter cliente, produto, instalação, features, limites, validade, lease e janela de tolerância offline.

O SDK Go consulta o servidor quando necessário, verifica a assinatura Ed25519, salva o documento assinado em cache com gravação atômica e permite que a aplicação consulte features e limites sem conhecer a implementação do transporte.

A persistência é feita por um adaptador GORM. O banco SQLite é criado automaticamente e a tabela é atualizada com `AutoMigrate` na inicialização.

## Requisitos

Instale os seguintes componentes antes de executar o projeto:

- Go 1.22 ou superior;
- Git, caso o projeto seja obtido de um repositório;
- um ambiente compatível com CGO, necessário para o driver SQLite `go-sqlite3`.

Confirme a instalação do Go:

```bash
go version
```

## Instalação

Entre no diretório do projeto e baixe as dependências:

```bash
cd license-platform
go mod download
go mod tidy
```

## Testes

Execute todos os testes antes de iniciar o servidor:

```bash
go test ./...
```

Para executar com saída detalhada:

```bash
go test -v ./...
```

O comando de teste também compila todos os pacotes do servidor e do SDK.

## Executar o servidor

Inicie o servidor com a configuração padrão:

```bash
go run ./cmd/license-server
```

O servidor escuta em `:8080` e cria o banco em `./data/license-platform.db`. O diretório do banco é criado automaticamente com permissão restrita ao usuário do processo.

A saída inicial informa o identificador da chave e a chave pública em Base64. Essa chave é gerada novamente a cada inicialização do MVP, portanto não use esse comportamento em produção.

### Variáveis de ambiente

| Variável | Padrão | Finalidade |
|---|---|---|
| `HTTP_ADDR` | `:8080` | Endereço e porta HTTP do servidor. |
| `DATABASE_PATH` | `./data/license-platform.db` | Caminho do arquivo SQLite. |
| `LICENSE_ISSUER` | `license-server.local` | Emissor incluído nas claims da licença. |
| `LICENSE_KEY_ID` | `dev-license-key` | Identificador da chave usada na assinatura. |

Exemplo de execução em uma porta e diretório alternativos:

```bash
HTTP_ADDR=127.0.0.1:9090 \
DATABASE_PATH=/var/lib/license-platform/license.db \
LICENSE_ISSUER=licenses.example.com \
LICENSE_KEY_ID=license-key-2026-01 \
go run ./cmd/license-server
```

## Verificar o serviço

Depois de iniciar o servidor, consulte o health check:

```bash
curl -i http://localhost:8080/health
```

Resposta esperada:

```json
{"status":"ok"}
```

## API HTTP

### Emitir uma licença

O endpoint de emissão cria ou atualiza uma licença no repositório e retorna um documento assinado. No MVP, ele não possui autenticação administrativa; use-o apenas em ambiente de desenvolvimento controlado.

```bash
curl -X POST http://localhost:8080/v1/licenses/issue \
  -H 'Content-Type: application/json' \
  -d '{
    "version": 1,
    "issuer": "license-server.local",
    "aud": "my-erp",
    "license_id": "lic-1",
    "customer_id": "customer-1",
    "product_id": "erp",
    "installation_id": "inst-1",
    "status": "active",
    "features": ["financial", "reports_advanced"],
    "limits": {"max_users": 10},
    "expires_at": "2027-09-18T00:00:00Z"
  }'
```

O retorno contém `key_id`, `payload` e `signature`. O payload e a assinatura são representados como bytes serializados em JSON.

### Validar uma licença

```bash
curl -X POST http://localhost:8080/v1/licenses/validate \
  -H 'Content-Type: application/json' \
  -d '{
    "license_id": "lic-1",
    "product_id": "erp",
    "installation_id": "inst-1"
  }'
```

A validação verifica a existência da licença, o produto, a instalação, o status e a janela de validade. Em caso de sucesso, o servidor retorna uma nova licença assinada para o cliente armazenar ou avaliar.

### Health check em outra porta

Se o servidor foi iniciado com `HTTP_ADDR=127.0.0.1:9090`, use:

```bash
curl http://127.0.0.1:9090/health
```

## Usar o SDK Go

O SDK está no pacote `sdk/licensego`. Um cliente precisa receber a URL do servidor, os identificadores da licença e da instalação, as chaves públicas confiáveis e um armazenamento de cache.

Exemplo conceitual:

```go
package main

import (
    "context"
    "crypto/ed25519"
    "encoding/base64"
    "log"
    "time"

    "github.com/example/license-platform/sdk/licensego"
    "github.com/example/license-platform/sdk/licensego/cache"
)

func main() {
    publicKeyBytes, err := base64.StdEncoding.DecodeString("CHAVE_PUBLICA_BASE64")
    if err != nil {
        log.Fatal(err)
    }

    client := &licensego.Client{
        BaseURL:        "http://localhost:8080",
        LicenseID:      "lic-1",
        ProductID:      "erp",
        InstallationID: "inst-1",
        PublicKeys: map[string]ed25519.PublicKey{
            "dev-license-key": ed25519.PublicKey(publicKeyBytes),
        },
        Cache: cache.FileStore{Path: "./data/license-cache.json"},
        Grace:  7 * 24 * time.Hour,
        Now:    time.Now,
    }

    state, err := client.Check(context.Background())
    if err != nil || !state.Valid {
        log.Fatal("licença inválida")
    }

    if !state.Features["reports_advanced"] {
        log.Fatal("recurso não contratado")
    }

    maxUsers, exists, err := client.Limit(context.Background(), "max_users")
    if err != nil || !exists {
        log.Fatal("limite não configurado")
    }
    log.Printf("limite de usuários: %d", maxUsers)
}
```

### Estados do SDK

O resultado de `Client.Check` contém o estado operacional da licença:

| Estado | Significado |
|---|---|
| `active` | Licença válida e lease atual vigente. |
| `grace_period` | Lease expirado, mas a janela offline ainda está válida. |
| `offline` | Estado válido obtido a partir do cache local. |
| `expired` | Licença fora da validade. |
| `invalid` | Não foi possível validar a licença. |

A aplicação contratada deve escolher uma política para cada estado. Por exemplo, pode bloquear apenas o recurso premium, impedir novas operações ou permitir somente leitura. A política deve ser explícita e não deve ficar escondida dentro do SDK.

### Forçar uma renovação

Use `Refresh` quando a aplicação quiser renovar o documento assinado antes de executar uma operação importante:

```go
if err := client.Refresh(ctx); err != nil {
    // Aplicar a política definida para indisponibilidade ou licença inválida.
}
```

`Check` tenta usar um cache ainda válido. Se necessário, consulta o endpoint de validação. Se o servidor estiver indisponível, o SDK tenta avaliar o documento salvo localmente dentro da janela offline.

## Persistência com SQLite e GORM

A aplicação abre o banco SQLite no executável principal e injeta o adaptador GORM no serviço:

```go
db, err := gorm.Open(sqlite.Open(databasePath), &gorm.Config{})
if err != nil {
    log.Fatal(err)
}

repo := repository.NewGorm(db)
if err := repo.AutoMigrate(); err != nil {
    log.Fatal(err)
}
```

O domínio não conhece `gorm.DB`. Essa separação permite trocar o driver sem alterar as regras de emissão e validação.

### Migrar para PostgreSQL

A migração futura deverá substituir o driver SQLite pelo driver PostgreSQL e alterar a configuração da conexão:

```go
db, err := gorm.Open(postgres.Open(databaseURL), &gorm.Config{})
if err != nil {
    log.Fatal(err)
}

repo := repository.NewGorm(db)
```

Antes da migração, adicione migrações versionadas, pool de conexões, índices revisados, backup, métricas e uma estratégia para concorrência. Não use `AutoMigrate` como substituto de migrações controladas em produção.

## Estrutura do projeto

```text
license-platform/
├── cmd/license-server/       # composição e inicialização do servidor
├── internal/api/             # rotas e handlers HTTP
├── internal/crypto/          # assinatura e verificação no servidor
├── internal/license/         # domínio, claims, serviço e portas
├── internal/repository/      # adaptadores de persistência
├── sdk/licensego/            # SDK para aplicações clientes
│   ├── cache/                # cache local com gravação atômica
│   ├── crypto/               # verificação da licença no cliente
│   └── model/                # modelos públicos do SDK
├── data/                     # banco local criado em runtime
├── go.mod
└── README.md
```

## Segurança e limitações do MVP

A chave privada é gerada em memória durante o startup e nunca é persistida. Isso simplifica o desenvolvimento, mas invalida a confiança operacional após cada reinicialização. Em produção, a chave deve ser carregada de um secret manager ou de um HSM, com rotação e versionamento de chaves públicas.

O endpoint de emissão também deve ser protegido antes de qualquer uso externo. Implemente autenticação administrativa, autorização por tenant, validação de payload, idempotência e auditoria. Adicione rate limiting aos endpoints públicos e não exponha detalhes internos nos erros HTTP.

A assinatura garante integridade e autenticidade do documento, mas não substitui autenticação de usuário, autorização de negócio ou proteção contra engenharia reversa do produto cliente. A política de bloqueio deve ser definida pelo sistema contratado.

## Diagnóstico rápido

Se a porta estiver ocupada, altere `HTTP_ADDR`:

```bash
HTTP_ADDR=:8081 go run ./cmd/license-server
```

Se o banco não puder ser criado, verifique se o diretório pai existe e se o usuário do processo possui permissão de escrita:

```bash
mkdir -p ./data
DATABASE_PATH=./data/license-platform.db go run ./cmd/license-server
```

Se o SDK informar que não existe uma licença válida quando o servidor estiver indisponível, confirme se o cache foi salvo, se a chave pública corresponde ao `key_id` recebido e se `offline_until` ainda não expirou.

## Próximos passos recomendados

A evolução imediata deve priorizar autenticação administrativa, persistência de chaves, validação de instalação, webhooks idempotentes de cobrança, auditoria e testes de integração. Depois, implemente migrações versionadas para PostgreSQL e uma camada de observabilidade com métricas de validação, falhas de assinatura, uso offline e expiração de leases.

## Referências

[1]: https://go.dev/doc/ "Documentação oficial da linguagem Go"
[2]: https://gorm.io/docs/ "Documentação oficial do GORM"
[3]: https://pkg.go.dev/crypto/ed25519 "Pacote ed25519 da biblioteca padrão Go"
