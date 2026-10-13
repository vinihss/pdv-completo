/**
 * Relatórios gerenciais — ponto de entrada de COMPATIBILIDADE.
 *
 * A implementação foi decomposta em um Use Case por operação (Command Pattern
 * / Single Use Case Class) em `usecases/*.usecase.ts` (vendas, visão geral e
 * entregas), com as dependências em `ports/report-dependencies.ts`, os
 * helpers de bucket em `shared/report-buckets.ts` e o facade `ReportModule`
 * em `report.module.ts`.
 *
 * Este arquivo mantém as TRÊS factories legadas (`createReportUsecases`,
 * `createOverviewReportUsecases`, `createDeliveriesReportUsecases`) com os
 * NOMES LEGADOS, para a composition root
 * (`infra/composition/default-usecases.ts`), que re-exporta para as rotas.
 * Nada muda na assinatura observada de fora. Para uso novo, prefira
 * `ReportModule` e `.salesReport.execute(...)`.
 *
 * Os helpers de bucket (`bucketKeyFor`/`bucketLabel`/`fillBuckets`/
 * `isValidReportDate`) seguem re-exportados daqui — `customer/` e qualquer
 * relatório novo que agrupe por período os consomem.
 */
import { ReportModule } from "./report.module.js";
import type { ReportDependencies } from "./ports/report-dependencies.js";
import type { SalesReportInput } from "./usecases/sales-report.usecase.js";
import type { OverviewReportInput } from "./usecases/overview-report.usecase.js";
import type { DeliveriesReportInput } from "./usecases/deliveries-report.usecase.js";

export { ReportModule };
export type { ReportDependencies };
export type {
  ReportUsecasesDeps,
  OverviewReportUsecasesDeps,
  DeliveriesReportUsecasesDeps,
} from "./ports/report-dependencies.js";
export {
  SalesReportUseCase,
  type SalesReportInput,
} from "./usecases/sales-report.usecase.js";
export {
  OverviewReportUseCase,
  type OverviewReportInput,
  type OverviewResult,
} from "./usecases/overview-report.usecase.js";
export {
  DeliveriesReportUseCase,
  type DeliveriesReportInput,
  type DeliveriesReport,
} from "./usecases/deliveries-report.usecase.js";
export {
  bucketKeyFor,
  bucketLabel,
  fillBuckets,
  isValidReportDate,
} from "./shared/report-buckets.js";

export function createReportUsecases(deps: ReportDependencies) {
  const module = new ReportModule(deps);
  return {
    salesReportUsecase: (input: SalesReportInput) => module.salesReport.execute(input),
  };
}

export type ReportUsecases = ReturnType<typeof createReportUsecases>;

export function createOverviewReportUsecases(deps: ReportDependencies) {
  const module = new ReportModule(deps);
  return {
    overviewReportUsecase: (input: OverviewReportInput) => module.overviewReport.execute(input),
  };
}

export type OverviewReportUsecases = ReturnType<typeof createOverviewReportUsecases>;

export function createDeliveriesReportUsecases(deps: ReportDependencies) {
  const module = new ReportModule(deps);
  return {
    deliveriesReportUsecase: (input: DeliveriesReportInput) =>
      module.deliveriesReport.execute(input),
  };
}

export type DeliveriesReportUsecases = ReturnType<typeof createDeliveriesReportUsecases>;
