export {
  searchCustomers,
  listAllCustomers,
  getCustomer,
  createCustomer,
  updateCustomer,
  uploadCustomerPhoto,
  removeCustomerPhoto,
  listCustomerOrders,
  getCustomerSummary,
  addCustomerAddress,
  setDefaultCustomerAddress,
  deleteCustomerAddress,
} from "./api/customer.js";
export { addPublicAddress, createPublicCustomer, lookupPublicCustomer } from "./api/public.js";
export { cpfDigits, validarCpf } from "./model/cpf.js";
export { saveProfileLocal, loadProfileLocal, clearProfileLocal } from "./model/profileStorage.js";
