package server

import (
	"context"
	"fmt"
	"sync"
	"time"
)

// HealthProbe pergunta ao banco em background e guarda o último resultado. O
// handler do /health só lê esse estado, e por isso nunca bloqueia.
//
// ## Por que existe
//
// Um `PingContext` no caminho da request herda o pior defeito do `lib/pq`: ele
// respeita o contexto só no caminho de cancelamento, e o cancelamento é entregue
// numa conexão TCP nova (`pq.(*conn).cancel`), que contra um servidor congelado
// trava tanto quanto a query original. O `http.Server` também não tem
// `ReadTimeout`/`WriteTimeout` como rede de segurança aqui — não há hijack como
// no gateway WS, mas um `WriteTimeout` global cortaria a resposta de um webhook
// lento, e o que interessa a este handler é o `/health`.
//
// Com o probe de fundo, quem responde é o tempo: um "ok" mais velho que
// `staleAfter` deixa de valer, e o `/health` responde 503 sem esperar por mais
// nada. Medido contra um Postgres de verdade com `docker pause`: banco travado →
// 503 em ~1-3ms, destravado → 200 sozinho, sem restart.
//
// ## Requisito do probe
//
// O `switch.sh` chama o healthcheck com `curl -fsS -m 2` e o healthcheck do Docker
// usa `timeout: 5s`, então o prazo de resposta é contrato de deploy. Ler um mutex
// custa microssegundos — sobra uma folga de duas ordens de grandeza.
type HealthProbe struct {
	db dbPinger

	// poll, timeout, staleAfter e maxInFlight carregam os valores das constantes
	// abaixo; o construtor os preenche e os testes os encolhem.
	poll        time.Duration
	timeout     time.Duration
	staleAfter  time.Duration
	maxInFlight int

	mu       sync.Mutex
	st       probeState
	inFlight []time.Time // início de cada tentativa em andamento, em ordem
}

// dbPinger é o único pedaço de `*sql.DB` que o probe de saúde usa.
//
// A troca por interface existe por causa de um teste: para provar que o /health
// responde com o banco travado é preciso um pinger que trava de propósito e que
// ignora o prazo do contexto (é o que o lib/pq faz), e não dá para montar isso
// com um `*sql.DB` sem subir um Postgres de verdade. `*sql.DB` satisfaz a
// interface, então a produção continua usando o pool de verdade.
type dbPinger interface {
	PingContext(ctx context.Context) error
}

// Prazos do probe. São constantes aqui e campos em HealthProbe (o construtor copia
// estes valores) porque os testes encolhem tudo para milissegundos em vez de
// dormir segundos por caso.
const (
	// healthPollInterval é de quanto em quanto o fundo pergunta ao banco.
	//
	// Antes cada requisição de /health perguntava — a carga no banco seguia a
	// frequência de quem sonda (Docker a cada 3s, switch.sh a cada 0.5s durante um
	// deploy). Fixar a cadência desacopla os dois: o banco leva 1 pergunta por
	// segundo por instância, não importa quantos clientes estén apertando o
	// endpoint.
	healthPollInterval = 1 * time.Second

	// healthProbeTimeout é o orçamento passado ao driver em cada pergunta.
	//
	// Ele NÃO é o que garante o prazo do /health, e é importante não confundir os
	// dois: o lib/pq respeita o contexto só no caminho de cancelamento (ver a nota
	// do tipo). O orçamento serve para o driver marcar a conexão do pool como ruim
	// e o pool não ficar reciclando uma conexão morta. O prazo que decide o
	// /health é healthStaleAfter, porque esse não depende do driver obedecer.
	healthProbeTimeout = 1 * time.Second

	// healthStaleAfter é a idade máxima de um "ok" ainda considerado verdade.
	//
	// Congelar o banco não muda nenhum campo do estado: só faz o tempo passar. E é
	// o tempo que decide — passados 3s sem um ping novo, o último "ok" é história e
	// o /health responde 503 sem esperar por mais nada. Esse é o caminho que
	// transforma "banco travado" em "503 dentro do prazo" em vez de "nunca
	// responde". Três segundos é menor que um ciclo do healthcheck do Docker
	// (interval 3s + timeout 5s no compose), então uma travada aparece no /health
	// antes do Docker desistir.
	healthStaleAfter = 3 * time.Second

	// healthMaxInFlight é quantas perguntas podem estar em andamento ao mesmo
	// tempo.
	//
	// Uma pergunta que travou não volta nunca. Sem teto, cada sondagem deixaria uma
	// goroutine e uma conexão do pool presas para sempre, e o pool deste processo
	// tem 10 conexões: em ~75s de banco travado o /health esgotaria o pool e
	// levaria junto o drain da inbox, que é justamente o que este endpoint existe
	// para proteger. Com o teto o pior caso é 2 goroutines e 2 conexões presas, para
	// sempre, e o drain continua com as 8 que sobram.
	healthMaxInFlight = 2
)

// probeState é o resultado do último probe CONCLUÍDO. Só a mudança de `ok` vem de
// um ping que voltou — congelar o banco não mexe em nenhum campo daqui.
type probeState struct {
	ok      bool      // o último probe concluído deu certo
	lastOK  time.Time // quando o último ping bom terminou; zero se nunca houve
	lastErr error     // erro do último probe que falhou; nil se nunca falhou
}

// NewHealthProbe cria o probe a partir de um pool que já respondeu um ping
// (`db.Connect` pinga antes de devolver o pool). `connectedAt` é o horário desse
// ping: semeá-lo como último "ok" evita o 503 sem sentido logo depois do boot, e
// continua sendo verdade — o banco respondeu, há um instante.
func NewHealthProbe(db dbPinger, connectedAt time.Time) *HealthProbe {
	return &HealthProbe{
		db:          db,
		poll:        healthPollInterval,
		timeout:     healthProbeTimeout,
		staleAfter:  healthStaleAfter,
		maxInFlight: healthMaxInFlight,
		st:          probeState{ok: true, lastOK: connectedAt},
	}
}

// Conectado diz se existe probe — ou seja, se o processo tem banco.
//
// Usado pelo `/health` para o `webhookEnabled` e por `Server` para decidir entre
// "sem pool" e "banco travado", que são degradações diferentes com causas
// diferentes.
func (p *HealthProbe) Conectado() bool { return p != nil && p.db != nil }

// HealthVerdict é a leitura do estado já com o prazo aplicado: o handler não decide
// nada, ele só traduz.
type HealthVerdict struct {
	ok         bool          // pode responder 200
	dbErr      error         // erro do último probe que falhou; nil se nunca houve
	lastOK     time.Time     // zero se o banco nunca respondeu
	lastOKAge  time.Duration // idade do último "ok"; sem sentido se lastOK é zero
	probingFor time.Duration // há quanto tempo começou a tentativa em andamento
	inFlight   int           // tentativas em andamento
}

// Check devolve o estado corrente. É só leitura de mutex — nunca toca no banco, e
// por isso tem prazo de microssegundos em vez de "sem prazo".
func (p *HealthProbe) Check() HealthVerdict {
	p.mu.Lock()
	defer p.mu.Unlock()

	v := HealthVerdict{dbErr: p.st.lastErr, inFlight: len(p.inFlight)}
	if !p.st.lastOK.IsZero() {
		v.lastOK = p.st.lastOK
		v.lastOKAge = time.Since(p.st.lastOK)
	}
	// O mais antigo da fila é o que interessa: é há quanto tempo o fundo está sem
	// resposta nenhuma.
	if n := len(p.inFlight); n > 0 {
		v.probingFor = time.Since(p.inFlight[0])
	}
	// Um "ok" só vale enquanto for fresco. Congelar o banco não muda nenhum campo
	// do estado, só o tempo passa — então é o tempo que tem de decidir, e não o
	// driver. É esta linha, e só ela, que garante que o /health nunca responda 200
	// mentindo.
	v.ok = p.st.ok && v.lastOKAge <= p.staleAfter
	return v
}

// dbErrorText explica o 503.
//
// Errar e calar são estados diferentes e a providência é diferente, então o texto
// separa: erro do driver significa banco recusando ou derrubado (o que o pool
// resolve sozinho); silêncio significa banco travado ou rede engolida, em que o
// driver simplesmente nunca volta.
func (v HealthVerdict) dbErrorText() string {
	if v.dbErr != nil {
		return v.dbErr.Error()
	}
	if !v.lastOK.IsZero() {
		return fmt.Sprintf("banco sem responder: último ping bom foi há %.1fs, %d tentativa(s) em andamento há %.1fs",
			v.lastOKAge.Seconds(), v.inFlight, v.probingFor.Seconds())
	}
	return fmt.Sprintf("banco sem responder: %d tentativa(s) em andamento, nenhum ping voltou", v.inFlight)
}

// Run é o laço de fundo. Sai junto com o ctx do processo.
func (p *HealthProbe) Run(ctx context.Context) {
	p.probe(ctx) // sem esperar o primeiro tick: senão o primeiro /health depois do
	// boot encontraria o estado "nunca respondeu" e responderia 503
	t := time.NewTicker(p.poll)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			p.probe(ctx)
		}
	}
}

// probe é uma ida ao banco.
func (p *HealthProbe) probe(ctx context.Context) {
	p.mu.Lock()
	if len(p.inFlight) >= p.maxInFlight {
		// Já há perguntas presas demais. Não empilha: o teto existe para o /health
		// não virar o que derruba o pool.
		//
		// Isso NÃO trava a recuperação. Medido contra um Postgres de verdade com
		// `docker pause`: a pergunta presa voltou sozinha ~1,2s depois do unpause
		// (o socket tem dado recebido pelo kernel é lido assim que o servidor
		// volta), e voltando ela libera o lugar. O pior caso de um banco que engole
		// pacote sem nunca devolver RST é ficar em 503 para sempre — e isso é
		// honesto, porque esse banco está realmente fora de alcance.
		p.mu.Unlock()
		return
	}
	p.inFlight = append(p.inFlight, time.Now())
	p.mu.Unlock()

	// O ping roda FORA do mutex: trancar durante a consulta devolveria o mesmo
	// defeito que o handler tinha, só que agora no lugar errado.
	pingCtx, cancel := context.WithTimeout(ctx, p.timeout)
	defer cancel()
	err := p.db.PingContext(pingCtx)

	p.mu.Lock()
	defer p.mu.Unlock()
	p.releaseLocked()
	if ctx.Err() != nil {
		// Shutdown no meio da pergunta: o cancelamento é da morte do processo, não
		// do banco. Registrar isso derrubaria o /health na janela de saída.
		return
	}
	if err != nil {
		p.st.ok = false
		p.st.lastErr = err
		return
	}
	p.st.ok = true
	p.st.lastErr = nil
	p.st.lastOK = time.Now()
}

// releaseLocked devolve o lugar da tentativa. Com o mutex já tomado.
//
// Remove a mais antiga em vez da última: a ordem em que as perguntas voltam não é
// a ordem em que foram feitas (a primeira, com o pool vazio, espera um dial; a
// seguinte pode usar uma conexão ociosa e responder antes), e é a mais antiga que
// define "há quanto tempo estou preso".
func (p *HealthProbe) releaseLocked() {
	if len(p.inFlight) > 0 {
		p.inFlight = p.inFlight[1:]
	}
}
