import { pagarmeService } from "../../integrations/pagarme/pagarme.service.js";

export async function createPagarmePayment(storeId: string, paymentData: any) {
  return pagarmeService.createPayment(storeId, paymentData);
}

export async function getStorePagarmeInfo(storeId: string) {
  return pagarmeService.getRecipientInfo(storeId);
}