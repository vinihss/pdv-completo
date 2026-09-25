# Notas de implementação

Este código implementa o License Platform seguindo as decisões arquiteturais
(Clean Architecture / Hexagonal) definidas para o projeto. Todas as camadas
foram implementadas e testadas:

| Camada | Pacote | Testes |
|---|---|---|
| Domínio | `internal/license` | 13 testes unitários (fakes das portas) |
| Criptografia | `internal/crypto` | 4 testes (geração de chave, assinatura, verificação) |
| Persistência | `internal/repository` | 4 testes de integração com SQLite real em memória |
| API HTTP | `internal/api` | 7 testes com `httptest` |
| Composição | `cmd/license-server` | testado manualmente ponta a ponta com `curl` |
| SDK cliente | `sdk/licensego` | 12 testes (incluindo `httptest.Server` simulando o servidor, fallback offline, `grace_period`) |

Todos os testes passam com `go test ./... -race`. `go vet ./...` está limpo.

## Como rodar

```bash
go mod tidy   # baixa gorm.io/gorm e gorm.io/driver/sqlite
go build ./...
go test ./... -race
go run ./cmd/license-server
```

Em outro terminal:

```bash
curl http://localhost:8080/health

curl -X POST http://localhost:8080/v1/licenses/issue \
  -H 'Content-Type: application/json' \
  -d '{
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

## O que foi adicionado além do README original

O domínio já previa os campos `lease` e `offline_until` na licença, mas o
endpoint de emissão ainda não os preenchia. Foram adicionados dois campos
opcionais ao payload de `/v1/licenses/issue`:

- `lease_hours` (float, opcional): horas a partir de `issued_at` até
  `lease_until`. Se omitido, o lease coincide com `expires_at` — ou seja, o
  documento é considerado "fresco" (estado `active` no SDK) por toda a
  validade nominal da licença.
- `offline_hours` (float, opcional): horas a partir de `expires_at` até
  `offline_until` (janela de tolerância offline). Padrão: 168h (7 dias).

Esses campos alimentam diretamente a lógica de estado do SDK
(`active` / `grace_period` / `offline` / `expired` / `invalid`), implementada
em `sdk/licensego/state.go` como função pura e testada isoladamente.

## Limitação conhecida do ambiente de desenvolvimento usado aqui

Este código foi escrito e testado em um sandbox cujo acesso de rede não
inclui `proxy.golang.org` (o proxy padrão de módulos Go), apenas `github.com`
diretamente. Para conseguir rodar `go test`/`go build` durante o
desenvolvimento, foram usadas temporariamente diretivas `replace` no
`go.mod` apontando `gorm.io/gorm` e `gorm.io/driver/sqlite` para seus
respectivos repositórios no GitHub. **Essas diretivas foram removidas do
`go.mod` final** — em um ambiente com acesso normal à internet, `go mod tidy`
resolve as dependências pelos caminhos oficiais (`gorm.io/...`) sem
necessidade de replace.

Todo o código foi de fato compilado, testado (`go test ./... -race`) e o
servidor rodou de verdade com requisições HTTP reais via `curl` durante o
desenvolvimento, usando esse workaround apenas para o download de pacotes.
