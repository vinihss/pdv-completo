import { Errors } from "../../domain/errors.js";
import type { PrintJob, Printer } from "../../application/ports/effects.js";
import { printerClient, type DaemonOrder, type DaemonPrintRequest } from "./printer.client.js";

/**
 * Adapter do port `Printer` (ports/effects.ts) — FASE 0.
 *
 * O port recebe o job com o **payload já formatado pelo mapper** (o
 * `DaemonOrder` de `printer.mapper.ts#toDaemonOrder` serializado; o port não
 * conhece layout de cupom). Este adapter é a fronteira que traduz esse payload
 * para o `DaemonPrintRequest` do daemon — e é propositalmente a ÚNICA tradução:
 * as funções `printKitchenOrder`/`printCourierOrder` continuam existindo para
 * os callers atuais (elas buscam o pedido no banco e montam o cupom), mas o
 * port NÃO as usa: quem migra para o port prepara o payload no use case.
 *
 * Semântica de falha: `printerClient.enqueuePrint` NUNCA lança (timeout curto,
 * loga e devolve `null`); o daemon tem a própria fila de retry. Este adapter
 * mantém esse contrato — `enqueue` resolve mesmo com o daemon fora, e o
 * fire-and-forget das usecases não muda de comportamento.
 */
export type PrintClient = Pick<typeof printerClient, "enqueuePrint">;

export class PrinterPortAdapter implements Printer {
  /** `printerClient` por default (stateless, só faz HTTP); injetável para teste. */
  constructor(private readonly client: PrintClient = printerClient) {}

  async enqueue(job: PrintJob): Promise<void> {
    const payload = job.payload;
    // O payload É o cupom (objeto na forma do DaemonOrder). Um primitive aqui
    // seria stringifyado e chegaria ao daemon como corpo inválido — falha mais
    // cedo, com erro de domínio, do que como print mudo.
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      throw Errors.validationFailed({
        field: "payload",
        reason: "payload do job de impressão precisa ser o cupom formatado (objeto)",
      });
    }
    const request: DaemonPrintRequest = {
      job_id: job.jobId,
      order_id: job.orderId,
      destination: job.destination,
      order: payload as unknown as DaemonOrder,
    };
    // `null` (daemon fora/erro) é logado pelo próprio client e vir aqui não
    // muda nada: a impressão é melhor-esforço, com retry no daemon.
    await this.client.enqueuePrint(request);
  }
}
