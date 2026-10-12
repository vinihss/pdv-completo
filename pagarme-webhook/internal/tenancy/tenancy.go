// Package tenancy é o contexto EXPLÍCITO de tenant deste serviço.
//
// O backend Node fala com um schema PostgreSQL por loja (docs/15-multi-tenant-
// schema.md): o `payment_event` e o `payment` de cada loja moram no schema
// daquela loja. O webhook do Pagar.me chega com o `merchant_id` da conta que
// gerou a cobrança, e é esse identificador que diz em qual schema a linha
// deve ser gravada — um webhook da loja A gravando em `public` seria o mesmo
// vazamento que o `search_path` da conexão errada.
//
// ## As duas pontas em que o tenant importa
//
//   - INGRESSÃO (`internal/server` + `internal/inbox`): o handler resolve o
//     `merchant_id` do payload para um `Tenant` e grava a inbox numa
//     transação com `tenancy.Apply` — `SET LOCAL app.tenant_id` +
//     `SET LOCAL search_path` antes do INSERT;
//   - CICLO (`internal/queue`): o drain e a reconciliação varrem cada tenant
//     da fonte, cada um na própria transação, e mandam o `tenant` (o slug)
//     ao backend Node no corpo do pedido (`nodeapi.Request.Tenant`) para que
//     ele aplique a cobrança no schema certo.
//
// `app.tenant_id` é ADITIVO (forward-compat): RLS hoje seria inerte enquanto a
// role do DSN for superuser (docs/15 §2 mediu `pdv | rolsuper=t`), mas gravar
// o contexto em cada transação é o degrau que torna RLS possível amanhã sem
// mexer em query nenhuma.
//
// ## Compatibilidade com o esquema atual
//
// Sem `PAGARME_MERCHANT_TENANTS` o serviço é uma-loja, como antes: o tenant
// default tem `Schema` VAZIO, `Apply` não mexe no `search_path`, e a tabela
// resolve pelo `search_path` da conexão (`public` em produção, o schema que o
// `DATABASE_URL` aponta). É o mesmo efeito de fixar `public` — sem quebrar a
// suíte, que isola por schema via `options=-c search_path=…`.
package tenancy

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log"
	"os"
	"regexp"
	"strings"
)

// Tenant é o escopo com que uma transação roda.
//
// Os dois campos podem ser vazios, e o vazio é SEM escopo — o modo legado de
// uma-loja só, em que nada muda em relação ao `search_path` default da conexão.
type Tenant struct {
	// Slug é o identificador estável da loja (o claim do JWT no gateway WS, e
	// aqui o valor de `PAGARME_MERCHANT_TENANTS`). É a CHAVE de partição: o
	// `nodeapi.Request.Tenant` carrega este valor para o Node saber o escopo.
	Slug string
	// Schema é o schema Postgres do tenant. Vazio = não mexer no search_path
	// (a tabela continua sendo resolvida pelo search_path da conexão).
	Schema string
}

// DefaultSlug é o slug do tenant default, o MESMO `DEFAULT_TENANT_SLUG` do
// backend Node (`application/tenant/resolve-tenant.usecase.ts`). O default NÃO
// é uma linha do registry até o cutover (docs/15 §6.2), então ele precisa
// deste nome próprio para casar com o que o Node resolve para a loja default.
const DefaultSlug = "default"

// ErrSemTenant é o erro de resolução fail-closed: o merchant do webhook não
// corresponde a nenhum tenant configurado e não há fallback explícito.
//
// O handler traduz isto em 400 `tenant_unresolved`: gravar num escopo chutado
// seria pior que não gravar (a linha ficaria no schema errado e a
// reconciliação depois trataria aquele pagamento como da loja errada). O
// Pagar.me reenvia, e enquanto a configuração não é corrigida a recusa é
// visível — é o oposto do modo de falha silencioso.
var ErrSemTenant = errors.New("tenancy: merchant não corresponde a nenhum tenant configurado")

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

// Chave devolve a chave de partição do tenant: é o valor que entra no
// `nodeapi.Request.Tenant` e que o Node usa para escopar a transação dele.
func (t Tenant) Chave() string { return t.Slug }

func (t Tenant) String() string {
	if t.Schema == "" {
		return t.Slug
	}
	return t.Slug + "(" + t.Schema + ")"
}

// Default devolve o tenant default do processo.
//
// O schema vem de `DEFAULT_TENANT_SCHEMA` — a MESMA env que o Node lê em
// `resolveTenant` (`defaultSchemaName()`). A diferença em relação ao
// `ws-gateway` é o fallback: aqui ele é VAZIO (não mexer no search_path) em
// vez de `public`, e a razão é o desenho da suíte e do pool deste serviço.
//
// O `ws-gateway` pode fixar `public` porque o pool dele já aponta para lá (o
// dispatcher do Node lê `outbox_event` de `public`). Aqui o pool pode apontar
// para QUALQUER schema — é o `DATABASE_URL` que decide, e os testes usam
// `options=-c search_path=<schema_de_teste>` para isolar. Fixar `public` em
// cima de um pool apontado para outro schema apagaria o escopo da conexão e
// apontaria a leitura para o schema errado.
//
// Em produção a conexão resolve em `public` (o schema do tenant default
// pré-cutover) quando o `DATABASE_URL` não traz `options`, então o efeito é
// o MESMO de fixar `public` — sem que a suíte, que isola por schema, quebre.
// Quem quiser fixar explicitamente liga `DEFAULT_TENANT_SCHEMA`.
func Default() Tenant {
	schema := strings.TrimSpace(os.Getenv("DEFAULT_TENANT_SCHEMA"))
	if !safeSchemaRE.MatchString(schema) {
		// Ausente ou inseguro ⇒ sem override: a conexão governa.
		return Tenant{Slug: DefaultSlug}
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
// barreira que vale hoje: `payment_event` sem qualificação passa a resolver
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
// fim da transação, então um `Apply` depois do INSERT seria tarde demais.
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
// resolução de merchant → tenant
// -----------------------------------------------------------------------------

// Resolver devolve o tenant de um `merchant_id` do webhook.
//
// Fail-closed por construção: um merchant que não corresponde a nenhum tenant
// NÃO cai num default implícito — o chamador recebe `ErrSemTenant` e responde
// 400. A única exceção é o fallback EXPLÍCITO de `PAGARME_TENANT_DEFAULT`,
// que é logado em voz alta de propósito (nunca silencioso).
type Resolver interface {
	Resolve(ctx context.Context, merchantID string) (Tenant, error)
}

// Source devolve os tenants a varrer no ciclo (drain, reconciliação, contagem
// de DLQ). É a mesma forma do `tenancy.Source` do ws-gateway, adaptada: aqui
// não há resolução de Host, porque o webhook não vem de um client conectado —
// vem do gateway do Pagar.me com o `merchant_id` no corpo.
type Source interface {
	Tenants(ctx context.Context) ([]Tenant, error)
}

// As duas envs que configuram a resolução de merchant neste serviço.
const (
	// EnvMerchants é o mapa EXPLÍCITO de merchant → slug:
	// `PAGARME_MERCHANT_TENANTS="mk_loja_a=umami,mk_loja_b=sushi"` (CSV de
	// `merchant_id=slug`). Ausente = modo uma-loja, em que todo webhook cai no
	// tenant default (comportamento de antes do multi-tenant).
	EnvMerchants = "PAGARME_MERCHANT_TENANTS"
	// EnvTenantDefault é o slug de FALLBACK para um merchant que não aparece no
	// mapa. Ele é logado em voz alta a cada uso: o fallback silencioso é o tipo
	// de defeito que gravaria pagamento da loja B no schema da loja A sem
	// ninguém perceber até a reconciliação mostrar dinheiro no lugar errado.
	EnvTenantDefault = "PAGARME_TENANT_DEFAULT"
)

// Fonte é a implementação de produção de `Resolver` e de `Source`.
//
// O mapa merchant→slug vem do ambiente (`EnvMerchants`); o schema de cada slug
// vem do registry (`public.tenant`, com cache) quando disponível. Sem registry
// (dev local, banco ainda não provisionado), o slug `default` resolve pelo
// `Default()` e qualquer outro slug é recusado — sem registry não há como
// saber o schema de um tenant arbitrário, e chutar seria o vazamento que este
// pacote existe para impedir.
type Fonte struct {
	merchants   map[string]string
	defaultSlug string
	reg         *Registry
}

// NewFonte monta a fonte a partir de um mapa já parseado. `defaultSlug` vazio
// significa "sem fallback": um merchant ausente do mapa vira `ErrSemTenant`.
func NewFonte(merchants map[string]string, defaultSlug string, reg *Registry) *Fonte {
	cp := make(map[string]string, len(merchants))
	for k, v := range merchants {
		cp[k] = v
	}
	return &Fonte{merchants: cp, defaultSlug: defaultSlug, reg: reg}
}

// FromEnv lê as duas envs. O segundo retorno diz se `EnvMerchants` estava
// DEFINIDA — ausente não é mapa vazio: é "sem multi-tenant configurado", e o
// chamador mantém o modo uma-loja (nil = default-only).
func FromEnv(reg *Registry) (*Fonte, bool, error) {
	raw := strings.TrimSpace(os.Getenv(EnvMerchants))
	if raw == "" {
		return nil, false, nil
	}
	merchants, err := parseMerchants(raw)
	if err != nil {
		return nil, true, err
	}
	defaultSlug := strings.TrimSpace(os.Getenv(EnvTenantDefault))
	if defaultSlug != "" && !ValidSlug(defaultSlug) {
		return nil, true, fmt.Errorf("tenancy: %s=%q não é um slug de tenant válido", EnvTenantDefault, defaultSlug)
	}
	return NewFonte(merchants, defaultSlug, reg), true, nil
}

// parseMerchants faz o CSV `merchant_id=slug`. Merchant id do Pagar.me é
// alfanumérico com underscore (ex.: `mk_abc123`); validamos o SLUG pelo CHECK
// do registry, que é a barreira que protege o `search_path`.
func parseMerchants(raw string) (map[string]string, error) {
	out := map[string]string{}
	for _, item := range strings.Split(raw, ",") {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		merchant, slug, ok := strings.Cut(item, "=")
		merchant, slug = strings.TrimSpace(merchant), strings.TrimSpace(slug)
		if !ok || merchant == "" || !ValidSlug(slug) {
			return nil, fmt.Errorf("tenancy: %s=%q fora do formato merchant_id=slug (slug minúsculo sem pontuação, o CHECK do registry)",
				EnvMerchants, item)
		}
		if existente, duplicado := out[merchant]; duplicado && existente != slug {
			return nil, fmt.Errorf("tenancy: %s traz o merchant %q para DOIS slugs (%q e %q) — ambíguo, e ambiguidade de escopo é vazamento",
				EnvMerchants, merchant, existente, slug)
		}
		out[merchant] = slug
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("tenancy: %s definida mas vazia", EnvMerchants)
	}
	return out, nil
}

// Resolve devolve o tenant do `merchant_id` do webhook.
//
//  1. merchant no mapa → slug, e o schema vem do `tenantPorSlug`;
//  2. merchant fora do mapa e `PAGARME_TENANT_DEFAULT` definido → o slug de
//     fallback, com log em voz alta (nunca silencioso);
//  3. merchant fora do mapa e sem fallback → `ErrSemTenant` (fail-closed).
//
// Um `merchantID` VAZIO (payload sem o campo) segue o mesmo caminho: sem
// mapa ele cai no default; com mapa, só resolve se houver fallback explícito
// — um webhook sem merchant em modo multi-tenant não tem escopo nenhum, e
// gravar no default seria chutar.
func (f *Fonte) Resolve(ctx context.Context, merchantID string) (Tenant, error) {
	merchantID = strings.TrimSpace(merchantID)
	if slug, ok := f.merchants[merchantID]; ok {
		return f.tenantPorSlug(ctx, slug)
	}
	if f.defaultSlug == "" {
		return Tenant{}, fmt.Errorf("%w (merchant=%q)", ErrSemTenant, merchantID)
	}
	// Fallback explícito: log em voz alta. O operador precisa ver isto no log
	// para saber que a configuração está incompleta — e o `merchantID` vazio é
	// o caso mais comum de chegar aqui.
	logFallback(merchantID, f.defaultSlug)
	return f.tenantPorSlug(ctx, f.defaultSlug)
}

// tenantPorSlug resolve o schema de um slug.
func (f *Fonte) tenantPorSlug(ctx context.Context, slug string) (Tenant, error) {
	if slug == DefaultSlug {
		return Default(), nil
	}
	if f.reg == nil {
		// Sem registry não há como saber o schema de um tenant que não é o
		// default. Recusar é o lado seguro: gravar num schema chutado seria
		// o vazamento que este pacote existe para impedir.
		return Tenant{}, fmt.Errorf("tenancy: slug %q não é o default e não há registry (public.tenant) para resolver o schema — "+
			"configure %s só com o tenant default ou provisione o registry", slug, EnvMerchants)
	}
	return f.reg.PorSlug(ctx, slug)
}

// Tenants devolve os tenants do ciclo: os do registry (ativos + default), ou
// só o default quando não há registry (modo uma-loja, comportamento de antes
// do multi-tenant).
func (f *Fonte) Tenants(ctx context.Context) ([]Tenant, error) {
	if f.reg == nil {
		return []Tenant{Default()}, nil
	}
	tenants, err := f.reg.Tenants(ctx)
	if err != nil {
		return nil, err
	}
	if len(tenants) == 0 {
		return []Tenant{Default()}, nil
	}
	return tenants, nil
}

// SemFallback diz se a fonte recusa merchant desconhecido (sem
// `EnvTenantDefault`). Existe para o `main` logar no boot o modo de operação —
// e para o teste confirmar que `FromEnv` respeitou a env.
func (f *Fonte) SemFallback() bool { return f.defaultSlug == "" }

// logFallback registra o uso do fallback de `EnvTenantDefault`.
//
// A mensagem é em VOZ ALTA (prefixo ALERTA) de propósito: o fallback silencioso
// é o tipo de defeito que gravaria pagamento da loja B no schema da loja A sem
// ninguém perceber até a reconciliação mostrar dinheiro no lugar errado. O
// operador precisa ver no log que a configuração está incompleta.
func logFallback(merchantID, slug string) {
	log.Printf("[tenancy] ALERTA: merchant %q não está em %s — usando o fallback %s=%q. "+
		"Enquanto isto acontecer, o pagamento daquela conta cai no tenant %q; "+
		"adicione o merchant ao mapa para tornar a resolução explícita.",
		merchantID, EnvMerchants, EnvTenantDefault, slug, slug)
}
