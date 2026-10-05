package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"
)

// Este arquivo é a fila: o que entra, como uma impressora é reservada, quando o
// envio é repetido e o que o operador tem de confirmar à mão.
//
// Duas decisões organizem o resto do código.
//
// A primeira é o claim condicional (ADR-03). Um job não é "tirado da fila" por
// uma goroutine que o leu e decided imprimi-la: é um UPDATE que só vale para
// quem conseguir mudar status de queued/retry_waiting para printing. Nove
// chamadores podem acordar ao mesmo tempo (HTTP, nuvem, worker de retry, monitor,
// reimpressão manual) e exatamente um escreve; os outros veem 0 linha afetada e
// não abrem conexão com a impressora. Duplicar um cupom fiscal é o pior defeito
// possível num PDV, e a proteção precisa morar no banco — não na disciplina de
// quem chamou.
//
// A segunda é a classificação do erro (ADR-05). Retry automático só existe
// quando NENHUM byte chegou à impressora. Falha no meio da escrita pode ter
// impresso metade do cupom, e repetir entregaria papel ao cliente duas vezes —
// por isso o caminho de falha parcial termina em reprint_confirmation e espera o
// operador. Tentativas esgotadas sem byte nenhum NÃO entram nesse caminho: não
// há o que confirmar, o job vira failed.
//
// O lock é por impressora física (ADR-10), não global: com o processMu global do
// ancestral, uma cozinha desligada atrasava o cupom do caixa e do motoboy.

const (
	statusQueued              = "queued"
	statusPrinting            = "printing"
	statusSentToPrinter       = "sent_to_printer"
	statusRetryWaiting        = "retry_waiting"
	statusReprintConfirmation = "reprint_confirmation"
	statusFailed              = "failed"
)

// ---------------------------------------------------------------------------
// Lock por impressora física (ADR-10)
// ---------------------------------------------------------------------------

// lockPrinter reserva a impressora física do perfil e devolve a função de
// liberação, para `defer unlock()`.
//
// A chave é a impressora, não o destino: cozinha e motoboy apontados para o
// mesmo 192.168.0.50 travam um ao outro, e isso é o comportamento correto — um
// corpo de impressão por vez. Duas impressoras diferentes, sim, imprimem em
// paralelo.
//
// O mapa fica no Daemon (e não em `var` de pacote) porque os testes criam
// vários daemons no mesmo processo: um mapa de pacote vaza lock entre instâncias
// e faz um teste travar atrás do lock que outro teste ainda segura. A criação é
// preguiçosa porque `&Daemon{}` precisa continuar válido (ver ADR-02, fase 2.1):
// a inicialização passa por d.mu porque seis goroutines de `process` chegam aqui
// ao mesmo tempo num daemon recém-construído, e escrever o campo sem lock é uma
// corrida que o detector pega — e que|resultaria em dois mapas, isto é, em
// impressões duplicadas.
func (d *Daemon) lockPrinter(profile PrinterProfile, destination string) func() {
	key := d.physicalPrinterID(profile, destination)

	d.mu.Lock()
	if d.printerLocks == nil {
		d.printerLocks = &sync.Map{}
	}
	locks := d.printerLocks
	d.mu.Unlock()

	value, _ := locks.LoadOrStore(key, &sync.Mutex{})
	mutex := value.(*sync.Mutex)
	mutex.Lock()
	return mutex.Unlock
}

// ---------------------------------------------------------------------------
// Validação de payload (ADR-14)
// ---------------------------------------------------------------------------

// validatePrintRequest rejeita o pedido antes de ele virar job.
//
// Os limites não são estética: acima deles o cupom sai com lixo ilegível, ou —
// no caso do QR — com bytes virarem comando ESC/POS (ver addQRCode). Um pedido
// rejeitado aqui é rejeitado de vez (o evento da nuvem é confirmado como
// "rejected"), então a validação precisa pegar o que é realmente impossível de
// imprimir, e não o que é apenas improvável.
func validatePrintRequest(req PrintRequest) error {
	if strings.TrimSpace(req.OrderID) == "" {
		return errors.New("order_id é obrigatório")
	}
	if strings.TrimSpace(req.Destination) == "" {
		return errors.New("destination é obrigatório")
	}
	// job_id não é exigido aqui: a camada HTTP e a nuvem o sintetizam quando o
	// cliente não manda (daemonOrder.js já manda `${orderId}-${destination}`).
	for i, item := range req.Order.Items {
		if len(item.Name) > maxItemName {
			return fmt.Errorf("item %d: nome acima de %d caracteres (%d)", i, maxItemName, len(item.Name))
		}
		if len(item.Notes) > maxItemNotes {
			return fmt.Errorf("item %d: observação acima de %d caracteres (%d)", i, maxItemNotes, len(item.Notes))
		}
		if len(item.Addons) > maxAddons {
			return fmt.Errorf("item %d: acima de %d adicionais (%d)", i, maxAddons, len(item.Addons))
		}
		// Adicional usa maxItemName e não maxItemNotes: ele sai na mesma linha
		// do item ("  + adicional"), e o limite de observação é de texto
		// corrido abaixo do nome.
		for j, addon := range item.Addons {
			if len(addon) > maxItemName {
				return fmt.Errorf("item %d: adicional %d acima de %d caracteres (%d)", i, j, maxItemName, len(addon))
			}
		}
	}
	if len(req.Order.Notes) > 2000 {
		return fmt.Errorf("observação do pedido acima de 2000 caracteres (%d)", len(req.Order.Notes))
	}
	if len(req.Order.Delivery.Address) > 300 {
		return fmt.Errorf("endereço de entrega acima de 300 caracteres (%d)", len(req.Order.Delivery.Address))
	}
	if len(req.Order.Fiscal.QRCodeURL) > qrMaxBytes {
		return fmt.Errorf("QR Code fiscal acima de %d bytes (%d): o tamanho de 16 bits do GS ( k daria a volta", qrMaxBytes, len(req.Order.Fiscal.QRCodeURL))
	}
	if req.Order.TotalCents < 0 {
		return fmt.Errorf("total negativo: %d centavos", req.Order.TotalCents)
	}
	if req.Order.Payment.ChangeCents < 0 {
		return fmt.Errorf("troco negativo: %d centavos", req.Order.Payment.ChangeCents)
	}
	return nil
}

// profileConfigured diz se o perfil tem destino de verdade.
//
// É o que separa "instalação nova" de "impressora configurada": perfil sem
// endereço (ou só com espaços) precisa responder ready=false no /health, senão o
// cupom sai para um endereço herdado de outra loja — que não dá erro nenhum, dá
// papel onde não devia.
//
// A regra espelha transportFor: transporte vazio é tcp e quer address; cups,
// ipp e os variantes do Spooler do Windows querem printer_name. PrinterID não
// configura ninguém: ele identifica a impressora física para lock e health, mas
// nenhum dos transportes o usa como destino.
func profileConfigured(profile PrinterProfile) bool {
	switch strings.ToLower(strings.TrimSpace(profile.Transport)) {
	case "", "tcp", "tcp9100":
		return strings.TrimSpace(profile.Address) != ""
	case "cups", "cups_raw", "ipp", "windows_spooler", "winspool", "spooler":
		return strings.TrimSpace(profile.PrinterName) != ""
	default:
		// Transporte desconhecido não pode ser considerado pronto: o técnico
		// digitou algo que o daemon não sabe falar.
		return false
	}
}

// ---------------------------------------------------------------------------
// Enfileiramento (ADR-04)
// ---------------------------------------------------------------------------

// enqueue persiste o job e devolve (job_id, duplicata, erro).
//
// Reenvio do mesmo (order_id, destination) RE-ENFILEIRA em vez de duplicar:
// volta para queued, zera as tentativas, limpa o erro anterior e troca
// payload/template pelos mais novos, preservando o id. É a semântica que o
// cliente web assume (daemonOrder.js monta job_id = `${orderId}-${destination}`
// justamente para isso) — trocar esse id faria o mesmo pedido virar dois jobs.
//
// A detecção de duplicata vem de `ON CONFLICT DO NOTHING` + RowsAffected, e
// não de um SELECT antes do INSERT: entre o SELECT e o INSERT outro caminho
// poderia inserir a mesma linha, e aí a verificação diria "novo" para um job que
// já existia. O RowsAffected é do próprio banco, na própria transação.
//
// Nada aqui filtra encoding nem exige impressora configurada: quem valida o
// pedido é o chamador (o pedido pode ter sido aceito antes de o técnico
// configurar a impressora, e voltar a queued é o comportamento correto).
func (d *Daemon) enqueue(req PrintRequest, template Template, payload []byte, hash string) (string, bool, error) {
	jobID := strings.TrimSpace(req.JobID)
	if jobID == "" {
		// Mesmo formato do cliente web: reenvio cai no mesmo job em vez de
		// criar um segundo.
		jobID = req.OrderID + "-" + req.Destination
	}
	printerID := d.physicalPrinterID(d.cfg.Printers[req.Destination], req.Destination)
	now := time.Now().UTC().Format(time.RFC3339)

	tx, err := d.db.Begin()
	if err != nil {
		return "", false, err
	}
	defer func() { _ = tx.Rollback() }()

	result, err := tx.Exec(`INSERT INTO print_jobs (id, order_id, destination, printer_id, payload_json, payload_hash, template_id, template_version, status, attempts, next_attempt_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?) ON CONFLICT(order_id, destination) DO NOTHING`,
		jobID, req.OrderID, req.Destination, printerID, payload, hash, template.ID, template.Version, statusQueued, now, now)
	if err != nil {
		return "", false, fmt.Errorf("enfileirar job %s: %w", jobID, err)
	}
	inserted, err := result.RowsAffected()
	if err != nil {
		return "", false, err
	}
	if inserted > 0 {
		if err := tx.Commit(); err != nil {
			return "", false, err
		}
		return jobID, false, nil
	}

	// Já existe: reenfileira o mesmo job (id preservado) com o conteúdo novo.
	var existing string
	if err := tx.QueryRow(`SELECT id FROM print_jobs WHERE order_id=? AND destination=?`, req.OrderID, req.Destination).Scan(&existing); err != nil {
		return "", false, fmt.Errorf("reenfileirar job %s: %w", jobID, err)
	}
	if _, err := tx.Exec(`UPDATE print_jobs SET printer_id=?, payload_json=?, payload_hash=?, template_id=?, template_version=?, status=?, attempts=0, last_error='', blocked_reason=NULL, next_attempt_at=NULL, updated_at=? WHERE id=?`,
		printerID, payload, hash, template.ID, template.Version, statusQueued, now, existing); err != nil {
		return "", false, fmt.Errorf("reenfileirar job %s: %w", existing, err)
	}
	if err := tx.Commit(); err != nil {
		return "", false, err
	}
	return existing, true, nil
}

// ---------------------------------------------------------------------------
// Claim atômico e execução (ADR-03)
// ---------------------------------------------------------------------------

// claimJob reserva o job para quem conseguiu a transição de status, e devolve
// (tentativas já contadas, reservado, erro).
//
// O UPDATE condicional é a serialização: `WHERE status IN ('queued',
// 'retry_waiting')` faz o banco decidir o vencedor, não a ordem de chegada das
// goroutines. Quem não vencia vê RowsAffected() == 0 e sai sem tocar na
// impressora.
//
// next_attempt_at NÃO é filtro aqui, de propósito: o vencimento é do
// processDueJobs. claimJob é o "agora", e quem chama process diretamente
// (impressão na requisição, reimpressão manual, teste) quer o job agora —
// exigir o vencimento deixaria retry_waiting preso para sempre quando o worker
// não está no meio de um poll.
//
// attempts sai já incrementado porque process precisa dele para decidir
// retry_waiting × failed, e releitura competiria com outra conexão num pool de
// MaxOpenConns(1).
func (d *Daemon) claimJob(jobID string) (int, bool, error) {
	result, err := d.db.Exec(`UPDATE print_jobs SET status=?, attempts=attempts+1, next_attempt_at=NULL, updated_at=? WHERE id=? AND status IN (?, ?)`,
		statusPrinting, time.Now().UTC().Format(time.RFC3339), jobID, statusQueued, statusRetryWaiting)
	if err != nil {
		return 0, false, fmt.Errorf("reservar job %s: %w", jobID, err)
	}
	claimed, err := result.RowsAffected()
	if err != nil {
		return 0, false, err
	}
	if claimed == 0 {
		return 0, false, nil
	}
	// Releitura em vez de RETURNING: depois do Exec a conexão já voltou para o
	// pool, então a releitura não compete com o UPDATE (que é o que o
	// RETURNINGuzaria dentro da mesma chamada). E o valor é estável: a linha
	// está em printing e nada mais incrementa attempts enquanto estiver assim.
	var attempts int
	if err := d.db.QueryRow(`SELECT attempts FROM print_jobs WHERE id=?`, jobID).Scan(&attempts); err != nil {
		return 0, false, fmt.Errorf("ler tentativas do job %s: %w", jobID, err)
	}
	return attempts, true, nil
}

// process tenta imprimir o job uma vez. Devolve nil quando não houve erro,
// inclusive nos casos em que optou por não enviar nada (já estava enviado, já
// está em outro status, outro chamador levou o claim).
func (d *Daemon) process(jobID string) error {
	var destination, payload, templateID, currentStatus string
	err := d.db.QueryRow(`SELECT destination, payload_json, template_id, status FROM print_jobs WHERE id=?`, jobID).Scan(&destination, &payload, &templateID, &currentStatus)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return fmt.Errorf("job %s não existe na fila", jobID)
		}
		return err
	}
	if currentStatus != statusQueued && currentStatus != statusRetryWaiting {
		// reprint_confirmation, failed, sent_to_printer, printing (outro
		// chamador): não é daqui. Reimpressão manual passa por `retry`, que
		// devolve o job para queued.
		return nil
	}

	profile := d.cfg.Printers[destination]
	unlock := d.lockPrinter(profile, destination)
	defer unlock()

	// Estado físico bloqueante antes de gastar uma tentativa: sem papel ou com a
	// tampa aberta, o envio só produziria papel em branco, e consumir tentativa
	// esgotaria as retries de um job que ainda nãoprinting. O monitor é quem
	// libera (unblockPrinterJobs) quando a impressora volta.
	//
	// Só o status JÁ CONHECIDO conta aqui: sondar exigiria abrir a conexão que
	// o transporte vai abrir logo em seguida, gastaria a conexão única do pool e
	// — pior — trataria "impressora fora do ar" como bloqueio, quando o caso de
	// impressora fora do ar é justamente o erro transitório que a retry existe
	// para repetir.
	key := d.physicalPrinterID(profile, destination)
	if cached, ok := d.cachedPrinterStatus(key, destination, profile); ok && isBlockingPrinterState(cached.State) {
		message := fmt.Sprintf("impressora %s em %s; aguardando o monitor liberar", key, cached.State)
		d.blockJob(jobID, key, cached.State, message)
		return fmt.Errorf("job %s: %w (%s)", jobID, errPrinterBlocked, cached.State)
	}

	// Encoding inválido é erro de configuração permanente: repetir não conserta
	// um config.json com "klingon". Falha aqui, e sem consumir tentativa, para
	// não transformar erro de técnico em fila de retentativa.
	if _, err := encoderFor(profile); err != nil {
		d.finishJob(jobID, statusFailed, err)
		return err
	}

	attempts, claimed, err := d.claimJob(jobID)
	if err != nil {
		return err
	}
	if !claimed {
		// Outro caminho (HTTP, nuvem, worker) levou. Não há erro: o job está
		// sendo cuidado por ele.
		return nil
	}

	var req PrintRequest
	if err := json.Unmarshal([]byte(payload), &req); err != nil {
		d.finishJob(jobID, statusFailed, fmt.Errorf("payload do job %s inválido: %w", jobID, err))
		return err
	}
	// O template vem do job, não do config: foi o que o cliente usou quando
	// enfileirou, e trocar o template no disco não pode mudar o cupom de um job
	// que já estava na fila (ver risco R8).
	template, err := d.templateFor(templateID, destination)
	if err != nil {
		d.finishJob(jobID, statusFailed, err)
		return err
	}
	buffer, err := renderForProfile(template, req.Order, profile)
	if err != nil {
		d.finishJob(jobID, statusFailed, err)
		return err
	}

	transport, err := transportFor(profile)
	if err != nil {
		// Nenhum byte saiu e repetir não muda nada: endereço ausente ou
		// transporte que esta plataforma não fala.
		d.finishJob(jobID, statusFailed, err)
		return err
	}
	if err := transport.Send(context.Background(), buffer); err != nil {
		return d.handleSendError(jobID, attempts, err)
	}

	d.finishJob(jobID, statusSentToPrinter, nil)
	return nil
}

// handleSendError decide o destino da falha de envio — a parte onde repetir ou
// não repetir é a decisão mais cara do daemon (ADR-05).
func (d *Daemon) handleSendError(jobID string, attempts int, err error) error {
	if !isRetryablePrinterError(err) {
		// Pode ter saído metade do cupom: o operador precisa confirmar se o
		// papel saiu antes de qualquer reenvio.
		d.finishJob(jobID, statusReprintConfirmation, err)
		return err
	}
	if attempts < d.cfg.Retry.MaxAttempts {
		delay := d.retryDelay(attempts)
		next := time.Now().UTC().Add(delay).Format(time.RFC3339)
		_, updateErr := d.db.Exec(`UPDATE print_jobs SET status=?, last_error=?, next_attempt_at=?, updated_at=? WHERE id=?`,
			statusRetryWaiting, err.Error(), next, time.Now().UTC().Format(time.RFC3339), jobID)
		if updateErr != nil {
			log.Printf("job %s: agendar retry: %v", jobID, updateErr)
		}
		log.Printf("job %s: falha transitória na tentativa %d, repetindo em %s: %v", jobID, attempts, next, err)
		return err
	}
	// Tentativas esgotadas e NENHUM byte enviado: não há cupom pela metade para
	// confirmar, então o job falha. Mandá-lo para reprint_confirmation seria
	// pedir ao operador para confirmar algo que não existe — é o erro do
	// ancestral (a4817e1:795-802), corrigido pelos testes.
	d.finishJob(jobID, statusFailed, err)
	return err
}

// finishJob grava o desfecho do job.
//
// UPDATE incondicional por id, e não condicionado ao status de quem chamou: o
// teste chama finishJob sobre um job em retry_waiting, e a reimpressão manual
// chama sobre um job em failed. O próximo passo já é sempre conhecido por quem
// chamou, então a condição não acrescentaria nada.
func (d *Daemon) finishJob(jobID, status string, err error) {
	errorText := ""
	if err != nil {
		errorText = err.Error()
	}
	if _, updateErr := d.db.Exec(`UPDATE print_jobs SET status=?, last_error=?, next_attempt_at=NULL, updated_at=? WHERE id=?`,
		status, errorText, time.Now().UTC().Format(time.RFC3339), jobID); updateErr != nil {
		// Não sobrescreve o erro original: este é secundário e o log precisa
		// deixar claro qual dos dois importa.
		log.Printf("job %s: gravar status %s: %v", jobID, status, updateErr)
	}
}

// jobStatus é o estado do job para a API e para os testes. "unknown" quando o
// job não existe é a resposta que o cliente já sabe tratar.
func (d *Daemon) jobStatus(jobID string) string {
	var status string
	if err := d.db.QueryRow(`SELECT status FROM print_jobs WHERE id=?`, jobID).Scan(&status); err != nil {
		return "unknown"
	}
	return status
}

// ---------------------------------------------------------------------------
// Worker de retry
// ---------------------------------------------------------------------------

// recoverInterruptedJobs roda no boot e devolve para o operador tudo o que o
// daemon anterior deixou no meio de um envio.
//
// Um job parado em printing quando o processo morreu é o pior estado possível:
// ou a impressora recebeu os bytes e ninguém sabe, ou não recebeu e o papel
// sumiu. Repetir sozinho escolhe entre duplicar e perder, então a única saída
// segura é perguntar. E como o status sai de printing, o worker de retry não
// consegue mais reservá-lo — a confirmação do operador é obrigatória mesmo que
// ninguém clique em nada.
func (d *Daemon) recoverInterruptedJobs() (int, error) {
	message := "daemon caiu durante o envio; confirme se o cupom saiu antes de reimprimir"
	result, err := d.db.Exec(`UPDATE print_jobs SET status=?, last_error=?, next_attempt_at=NULL, updated_at=? WHERE status=?`,
		statusReprintConfirmation, message, time.Now().UTC().Format(time.RFC3339), statusPrinting)
	if err != nil {
		return 0, fmt.Errorf("recuperar jobs interrompidos: %w", err)
	}
	recovered, err := result.RowsAffected()
	if err != nil {
		return 0, err
	}
	if recovered > 0 {
		log.Printf("fila: %d job(s) pararam no meio do envio; aguardando confirmação do operador", recovered)
	}
	return int(recovered), nil
}

// processDueJobs é o ÚNICO lugar que respeita next_attempt_at: ele é o
// "agora" do relógio de retry. claimJob e process são o "imediatamente".
//
// Um job bloqueado por estado físico não entra aqui — ele só volta para queued
// quando o monitor confirma que a impressora voltou (unblockPrinterJobs). Sem
// isso, uma cozinha sem papel gastaria as 8 tentativas em segundos.
func (d *Daemon) processDueJobs() {
	now := time.Now().UTC().Format(time.RFC3339)
	rows, err := d.db.Query(`SELECT id FROM print_jobs WHERE attempts < ? AND (status=? OR (status=? AND (next_attempt_at IS NULL OR next_attempt_at <= ?))) ORDER BY created_at LIMIT 20`,
		d.cfg.Retry.MaxAttempts, statusQueued, statusRetryWaiting, now)
	if err != nil {
		log.Printf("fila: consultar jobs para retry: %v", err)
		return
	}
	// Drenar e FECHAR o cursor antes de processar qualquer coisa: o pool tem
	// MaxOpenConns(1), e process abre consultas e updates próprios — deixar o
	// cursor aberto travaria o daemon em espera de conexão (o mesmo cuidado que
	// reportPendingStatuses tem em cloud.go).
	var ids []string
	for rows.Next() {
		var id string
		if rows.Scan(&id) == nil {
			ids = append(ids, id)
		}
	}
	_ = rows.Close()

	for _, id := range ids {
		if err := d.process(id); err != nil {
			log.Printf("fila: processar job %s: %v", id, err)
		}
	}
}

// retryWorker é a goroutine que dá o relógio ao backoff.
//
// Sai no ctx.Done() porque o SCM dá 15 segundos de stop (service_windows.go):
// um worker que não escuta o cancelamento transforma o stop do serviço em
// reinício forçado.
func (d *Daemon) retryWorker(ctx context.Context) {
	interval := d.cfg.Retry.PollIntervalSecs
	if interval <= 0 {
		// time.NewTicker(0) entra em panic; o default é o mesmo do config de
		// fábrica, e a normalização do boot não pode ser a única rede de
		// segurança disso.
		interval = 2
	}
	// Primeira varredura já na subida: um job que sobrou em retry_waiting de
	// antes não espera o primeiro tick para sair.
	d.processDueJobs()

	ticker := time.NewTicker(time.Duration(interval) * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			d.processDueJobs()
		}
	}
}

// retryDelay é o backoff exponencial com teto. Tentativa 1 espera a base, a 2
// o dobro, e assim por diante até max_delay_seconds: um backend fora do ar de
// madrugada não vira 8 tentativas por segundo, mas também não deixa o operador
// esperando horas por um papel.
func (d *Daemon) retryDelay(attempt int) time.Duration {
	base := d.cfg.Retry.BaseDelaySecs
	if base <= 0 {
		base = 2
	}
	limit := d.cfg.Retry.MaxDelaySecs
	if limit <= 0 {
		limit = 120
	}
	seconds := base
	for i := 1; i < attempt && seconds < limit; i++ {
		seconds *= 2
	}
	if seconds > limit {
		seconds = limit
	}
	return time.Duration(seconds) * time.Second
}
