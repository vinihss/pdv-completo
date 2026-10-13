// Package tenancy é o contexto EXPLÍCITO de tenant do gateway.
//
// O backend Node fala com um schema PostgreSQL por loja (docs/15-multi-tenant-
// schema.md): o pool de cada request está fixado no schema do tenant resolvido
// pelo Host, e o JWT carrega o slug do tenant no claim `tenant`
// (login.usecase.ts assina `{ sub, role, tenant }`; auth.middleware.ts compara
// com o escopo do request). Este pacote é o MESMO contrato do lado Go:
//
//   - `Tenant` nomeia o escopo: `Slug` é o claim do JWT / a 1ª label do Host,
//     `Schema` é o schema Postgres do qual o serviço lê e escreve;
//   - `Statements`/`Apply` gravam o contexto na TRANSAÇÃO (`SET LOCAL
//     app.tenant_id` + `SET LOCAL search_path`) — o equivalente do
//     `options=-c search_path=…` do pool dedicado do Node. A diferença é que
//     aqui não há pool por tenant: o contexto morre no COMMIT/ROLLBACK, que é
//     justamente o que impede ele de vazar para a próxima requisição que
//     pegar a mesma conexão ociosa do pool (§4.2 do doc 15);
//   - `Source` é de onde vêm os tenants que o dispatcher varre, e como um
//     `Host` vira tenant no caminho público (`/realtime/public`, sem JWT).
//
// `app.tenant_id` é ADITIVO (forward-compat): RLS hoje seria inerte enquanto a
// role do DSN for superuser (docs/15 §2 mediu `pdv | rolsuper=t`), mas gravar
// o contexto em cada transação é o degrau que torna RLS possível amanhã sem
// mexer em query nenhuma.
//
// Compatibilidade com o esquema atual (schema-por-tenant; `public` ainda é o
// schema do tenant `default` até o cutover): sem `WS_TENANTS` e com o registry
// indisponível, o serviço varre SÓ o tenant `default` com o search_path do
// ambiente (`DEFAULT_TENANT_SCHEMA`, default `public`) — que é onde
// `outbox_event` do tenant default mora, ou seja, o comportamento de antes.
package tenancy

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"regexp"
	"strings"
)

// Tenant é o escopo com que uma transação roda.
//
// Os dois campos podem ser vazios, e o vazio é SEM escopo — o modo legado de
// uma-loja só, em que nada muda em relação ao `search_path` default da conexão.
type Tenant struct {
	// Slug é o claim `tenant` do JWT (e a 1ª label do Host no caminho público).
	// É a CHAVE de partição das conexões: um broadcast do tenant A só alcança
	// conexões cujo `Tenant.Slug` é A (ver connmanager.BroadcastToRoom).
	Slug string
	// Schema é o schema Postgres do tenant. Vazio = não mexer no search_path
	// (a tabela continua sendo resolvida pelo search_path da conexão).
	Schema string
}

// DefaultSlug é o slug do tenant default, o MESMO `DEFAULT_TENANT_SLUG` do
// backend Node (`application/tenant/resolve-tenant.usecase.ts`). O default NÃO
// é uma linha do registry até o cutover (docs/15 §6.2), então ele precisa
// deste nome próprio para casar com o claim do JWT emitido pelo Node para a
// loja default.
const DefaultSlug = "default"

// Chave devolve a chave de partição do tenant: é o valor que entra no filtro de
// broadcast e que a conexão carrega vindo do JWT.
func (t Tenant) Chave() string { return t.Slug }

func (t Tenant) String() string {
	if t.Schema == "" {
		return t.Slug
	}
	return t.Slug + "(" + t.Schema + ")"
}

// Os três RE, repetidos do backend (domain/tenant.ts) de propósito: as duas
// barreiras precisam casar. O `CHECK` do banco é a primeira; estas são a
// segunda, para o dia em que o constraint cair ou em que uma env mal digitada
// tente virar `search_path`.
var (
	// slugRE é o CHECK do slug em `public.tenant` (`^ [a-z0-9][a-z0-9-]* $`).
	slugRE = regexp.MustCompile(`^[a-z0-9][a-z0-9-]*$`)
	// schemaRE é o CHECK do `schema_name` (`^ tenant_[a-z0-9_]+ $`).
	schemaRE = regexp.MustCompile(`^tenant_[a-z0-9_]+$`)
	// safeSchemaRE é o formato de schema vindo do AMBIENTE
	// (`DEFAULT_TENANT_SCHEMA`), mais frouxo que o do registry de propósito:
	// o schema default é `public` até o cutover, e `public` não casa
	// `^tenant_…`. Ainda assim só `[a-z_][a-z0-9_]*`: sem ponto, sem aspas,
	// nada que quebre um `SET search_path`.
	safeSchemaRE = regexp.MustCompile(`^[a-z_][a-z0-9_]*$`)
)

// ValidSlug diz se o valor é um slug de tenant plausível (o CHECK do registry).
func ValidSlug(v string) bool { return slugRE.MatchString(v) }

// ValidSchema diz se o valor é um schema de tenant do registry.
func ValidSchema(v string) bool { return schemaRE.MatchString(v) }

// Default devolve o tenant default do processo.
//
// O schema vem de `DEFAULT_TENANT_SCHEMA` — a MESMA env que o Node lê em
// `resolveTenant` (`defaultSchemaName()`), com o mesmo fallback `public`. Isso
// não é conveniência: se o Node gravar o outbox do default em `tenant_main`
// (env presente lá e ausente aqui) e o gateway ler `public`, o evento é
// silenciosamente mudo — o pior defeito possível num realtime.
func Default() Tenant {
	schema := strings.TrimSpace(os.Getenv("DEFAULT_TENANT_SCHEMA"))
	if !safeSchemaRE.MatchString(schema) {
		// Ausente ou inseguro ⇒ `public`, o mesmo fallback do Node.
		schema = "public"
	}
	return Tenant{Slug: DefaultSlug, Schema: schema}
}

// -----------------------------------------------------------------------------
// contexto de transação
// -----------------------------------------------------------------------------

// Statement é um `set_config(..., is_local ⇒ true)` a rodar no início da
// transação.
type Statement struct {
	Query string
	Args  []any
}

const setConfigStmt = `SELECT set_config($1, $2, true)`

// Statements devolve os `SET LOCAL` que põem a transação no escopo do tenant.
//
// Devolve ERRO quando o escopo não é confiável (slug fora do CHECK do registry
// ou schema que não é identificador seguro) — fail-closed de propósito: um
// nome mal configurado nunca pode virar `search_path`, e "cair no schema da
// conexão" seria exatamente o vazamento que este pacote existe para impedir.
//
// `app.tenant_id` é aditivo: nada no banco lê ele hoje (RLS pendente), e gravá-lo
// é o que faz o contexto existir para quem vier depois. `search_path` é a
// barreira que vale hoje: `outbox_event` sem qualificação passa a resolver
// dentro do schema do tenant.
func Statements(t Tenant) ([]Statement, error) {
	var out []Statement
	if t.Slug != "" {
		if !ValidSlug(t.Slug) {
			return nil, fmt.Errorf("tenancy: slug de tenant inválido %q", t.Slug)
		}
		out = append(out, Statement{Query: setConfigStmt, Args: []any{"app.tenant_id", t.Slug}})
	}
	if t.Schema != "" {
		if !safeSchemaRE.MatchString(t.Schema) {
			return nil, fmt.Errorf("tenancy: schema de tenant inseguro %q", t.Schema)
		}
		out = append(out, Statement{Query: setConfigStmt, Args: []any{"search_path", SearchPath(t.Schema)}})
	}
	return out, nil
}

// SearchPath monta o valor do `search_path` do tenant, no mesmo formato do
// pool dedicado do Node (`-c search_path=<schema>,public,pg_temp`).
func SearchPath(schema string) string {
	if schema == "public" {
		return "public"
	}
	return schema + ", public"
}

// Querier é o pedaço de `*sql.Tx` que `Apply` usa — declarado como interface
// para o teste poder exercitar o caminho sem Postgres.
type Querier interface {
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// Apply grava o contexto de tenant na transação JÁ ABERTA. Chamar logo depois
// de `BeginTx` e antes de qualquer query de domínio: `SET LOCAL` só vale até o
// fim da transação, então um `Apply` depois do SELECT seria tarde demais.
func Apply(ctx context.Context, q Querier, t Tenant) error {
	stmts, err := Statements(t)
	if err != nil {
		return err
	}
	for _, st := range stmts {
		var conferido string
		if err := q.QueryRowContext(ctx, st.Query, st.Args...).Scan(&conferido); err != nil {
			return err
		}
	}
	return nil
}

// -----------------------------------------------------------------------------
// fonte de tenants
// -----------------------------------------------------------------------------

// Source é a lista de tenants que o serviço varre e a resolução de Host do
// caminho público.
//
// Duas pontas porque o gateway tem dois caminhos: o autenticado recebe o tenant
// no JWT (o gateway só valida e particiona), e o público (`/realtime/public`,
// a vitrine de pedidos) não tem token — é o Host que diz de qual loja é o
// `order:<uuid>` que o client está acompanhando.
type Source interface {
	// Tenants devolve os tenants a varrer. Erro = "não consegui saber", e o
	// chamador NÃO deve cair no default em silêncio (ver Dispatcher.PollOnce).
	Tenants(ctx context.Context) ([]Tenant, error)
	// Resolve devolve o tenant de um Host. Host que não é de tenant nenhum
	// (localhost, apex, rótulo reservado) resolve no default, como no Node.
	Resolve(ctx context.Context, host string) (Tenant, error)
}

// EnvTenants é a env que torna a lista de tenants EXPLÍCITA sem depender do
// banco: `WS_TENANTS="default=public,umami=tenant_umami"` (CSV de
// `slug=schema`). O tenant default continua implícito e é acrescentado quando
// não aparecer na lista.
const EnvTenants = "WS_TENANTS"

// Static é uma fonte fixa — a que vem do ambiente (`WS_TENANTS`) ou a que o
// serviço usa quando não há o que consultar (sem banco). Também é o dublê dos
// testes que precisam de dois tenants sem subir Postgres.
type Static struct {
	tenants []Tenant
}

// NewStatic monta uma fonte fixa. O tenant default é acrescentado quando a
// lista não o traz, porque ele existe mesmo sem registry (docs/15 §6.2) e é o
// slug que o JWT do Node traz para a loja default.
func NewStatic(tenants []Tenant) *Static {
	out := append([]Tenant(nil), tenants...)
	temDefault := false
	for _, t := range out {
		if t.Slug == DefaultSlug {
			temDefault = true
			break
		}
	}
	if !temDefault {
		out = append([]Tenant{Default()}, out...)
	}
	return &Static{tenants: out}
}

// Tenants devolve a lista fixa.
func (s *Static) Tenants(context.Context) ([]Tenant, error) {
	return append([]Tenant(nil), s.tenants...), nil
}

// Resolve casa o Host com o slug de uma da lista; o resto cai no default.
func (s *Static) Resolve(_ context.Context, host string) (Tenant, error) {
	return resolveHost(host, func(slug string) (Tenant, bool) {
		for _, t := range s.tenants {
			if t.Slug == slug {
				return t, true
			}
		}
		return Tenant{}, false
	}, func(string) (Tenant, bool) { return Tenant{}, false }), nil
}

// FromEnv lê `WS_TENANTS`. O segundo retorno diz se a env estava DEFINIDA —
// ausente não é lista vazia: é "sem fonte explícita", e o chamador decide se
// cai no registry (produção) ou só no default (dev sem banco).
func FromEnv() (*Static, bool, error) {
	raw := strings.TrimSpace(os.Getenv(EnvTenants))
	if raw == "" {
		return nil, false, nil
	}
	var tenants []Tenant
	for _, item := range strings.Split(raw, ",") {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		slug, schema, ok := strings.Cut(item, "=")
		slug, schema = strings.TrimSpace(slug), strings.TrimSpace(schema)
		if !ok || !ValidSlug(slug) || !safeSchemaRE.MatchString(schema) {
			return nil, true, fmt.Errorf("tenancy: %s=%q fora do formato slug=schema (slug minúsculo sem pontuação, schema [a-z_][a-z0-9_]*)",
				EnvTenants, item)
		}
		tenants = append(tenants, Tenant{Slug: slug, Schema: schema})
	}
	if len(tenants) == 0 {
		return nil, true, fmt.Errorf("tenancy: %s definida mas vazia", EnvTenants)
	}
	return NewStatic(tenants), true, nil
}

// -----------------------------------------------------------------------------
// resolução de Host (parte pura, compartilhada por Static e Registry)
// -----------------------------------------------------------------------------

// reservedSubdomains são rótulos da PLATAFORMA, nunca loja — a mesma lista de
// `domain/tenant.ts`. Se um deles resolvesse para um tenant, qualquer um
// registraria `app` no registry e tomaria a origem do app interno.
var reservedSubdomains = map[string]bool{"www": true, "app": true, "api": true}

// NormalizeHost devolve o Host em forma de comparação: minúsculas, sem porta,
// sem ponto final. `false` = não parece host nenhum (o chamador usa o default,
// como no Node, que trata host malformado como "não é loja").
func NormalizeHost(raw string) (string, bool) {
	host := strings.ToLower(strings.TrimSpace(raw))
	if strings.HasPrefix(host, "[") {
		// Literal IPv6 ([::1]:8080): recorta entre os colchetes e valida como
		// ENDEREÇO, não como nome — os `:` de dentro não passariam pela checagem
		// de rótulos abaixo, e o host de loopback cairia em "não é host nenhum"
		// (que também resolve no default, mas sem a distinção de por quê).
		end := strings.Index(host, "]")
		if end == -1 {
			return "", false
		}
		resto := host[end+1:]
		if resto != "" && !strings.HasPrefix(resto, ":") {
			return "", false // tem lixo depois do colchete que não é porta
		}
		ip := host[1:end]
		if !ipv6Literal(ip) {
			return "", false
		}
		return ip, true
	} else if i := strings.Index(host, ":"); i >= 0 {
		host = host[:i]
	}
	host = strings.TrimSuffix(host, ".")
	if len(host) == 0 || len(host) > 253 {
		return "", false
	}
	for _, r := range host {
		if !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '.' || r == '-') {
			return "", false
		}
	}
	for _, label := range strings.Split(host, ".") {
		if label == "" {
			return "", false
		}
	}
	return host, true
}

// ipv6Literal diz se o valor entre colchetes parece literal IPv6: dígitos hex e
// `:`, com pelo menos um `:`. Não é um validador de gramática IPv6 completo — o
// que ele precisa garantir é que só um ENDEREÇO chegue aqui, nunca um nome com
// caractere estranho passando por IPv6.
func ipv6Literal(h string) bool {
	if !strings.Contains(h, ":") {
		return false
	}
	for _, r := range h {
		if !(r >= '0' && r <= '9' || r >= 'a' && r <= 'f' || r == ':') {
			return false
		}
	}
	return true
}

// resolveHost aplica as regras de Host do Node (§3.1 do doc 15) na forma que o
// gateway precisa:
//
//	localhost / 1 rótulo / rótulo reservado → default;
//	1ª rótulo casa um slug conhecido        → aquele tenant;
//	o resto                                 → default.
//
// Aqui NÃO há o 404 do Node para subdomínio desconhecido: o caminho público do
// gateway é o acompanhamento de `order:<uuid>` (a "senha" é o UUID), e derrubar
// a conexão de um host não cadastrado não protege dado nenhum — enquanto o
// default errado derrubaria a vitrine de qualquer instalação de loja só. O
// `custom_domain` do registry é resolvido pelo `Registry.Resolve`, que é quem
// tem as linhas.
func resolveHost(host string, porSlug func(string) (Tenant, bool), porCustomDomain func(string) (Tenant, bool)) Tenant {
	defaultTenant := Default()
	h, ok := NormalizeHost(host)
	if !ok {
		return defaultTenant
	}
	if t, achou := porCustomDomain(h); achou {
		return t
	}
	labels := strings.Split(h, ".")
	if len(labels) == 1 || strings.HasSuffix(h, ".localhost") {
		return defaultTenant
	}
	if len(labels) > 2 && reservedSubdomains[labels[0]] {
		return defaultTenant
	}
	if t, achou := porSlug(labels[0]); achou {
		return t
	}
	return defaultTenant
}
