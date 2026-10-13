/**
 * Módulo de relatórios — Facade / ponto de entrada orientado a objetos.
 *
 * Instancia cada Use Case passando o MESMO objeto de dependências (injetado
 * via construtor) e expõe as instâncias como propriedades readonly.
 */
import type { ReportDependencies } from "./ports/report-dependencies.js";
import { SalesReportUseCase } from "./usecases/sales-report.usecase.js";
import { OverviewReportUseCase } from "./usecases/overview-report.usecase.js";
import { DeliveriesReportUseCase } from "./usecases/deliveries-report.usecase.js";

export class ReportModule {
  public readonly salesReport: SalesReportUseCase;
  public readonly overviewReport: OverviewReportUseCase;
  public readonly deliveriesReport: DeliveriesReportUseCase;

  constructor(deps: ReportDependencies) {
    this.salesReport = new SalesReportUseCase(deps);
    this.overviewReport = new OverviewReportUseCase(deps);
    this.deliveriesReport = new DeliveriesReportUseCase(deps);
  }
}
