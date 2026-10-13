export interface DateRange { from: string; to: string }
export interface SalesReport { totalMinor: number; orderCount: number; byDay: Array<{ day: string; totalMinor: number; count: number }> }
export interface DeliveryReport { deliveryCount: number; averageDurationSeconds: number | null }
/** Read models específicos; SQL/joins/índices ficam no adapter PostgreSQL. */
export interface ReportsReader {
  sales(range: DateRange): Promise<SalesReport>;
  deliveries(range: DateRange): Promise<DeliveryReport>;
  overview(at: string): Promise<Record<string, number | null>>;
}
