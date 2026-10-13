/**
 * Composição de domínio — `provisioning` (Onda 5).
 *
 * Reexporta os use cases com os NOMES LEGADOS para as rotas, a partir das
 * instâncias construídas uma única vez no composition root
 * (`../default-usecases.js`). Nenhum adapter vive aqui; a única fonte de
 * verdade de wiring continua sendo o root.
 */
import { provisioningEmailInstances, provisioningInstances } from "../default-usecases.js";

export const generateProvisioningKeyUsecase = provisioningInstances.generateProvisioningKeyUsecase;
export const exchangeProvisioningCodeUsecase = provisioningInstances.exchangeProvisioningCodeUsecase;
export const refreshDeviceSessionUsecase = provisioningInstances.refreshDeviceSessionUsecase;
export const revokeDeviceUsecase = provisioningInstances.revokeDeviceUsecase;
export const listUserDevicesUsecase = provisioningInstances.listUserDevicesUsecase;
export const sendProvisioningEmailUsecase = provisioningEmailInstances.sendProvisioningEmailUsecase;
export const resendProvisioningEmailUsecase = provisioningEmailInstances.resendProvisioningEmailUsecase;
