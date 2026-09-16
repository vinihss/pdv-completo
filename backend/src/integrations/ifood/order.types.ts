// Tipos dos payloads da iFood Order API que a integração consome. Baseados em
// developer.ifood.com.br — Order structure. O shape exato (nomes de campo)
// será conferido na homologação; estes tipos são o contrato interno do módulo.
// Observação: é o MAPEAMENTO ("o que usamos") e não o schema inteiro do iFood.

export interface IfoodEvent {
  id: string; // evt_...
  code: string; // ex.: CONFIRMED
  fullCode?: string; // ex.: ORDER_CONFIRMED
  orderId: string; // ord_...
  merchantId?: string;
  createdAt?: string;
  metadata?: Record<string, unknown>;
}

export interface IfoodOrderItem {
  id: string;
  unitPrice: number;
  quantity: number;
  totalPrice?: number;
  product: {
    id: string; // id UUID no catálogo → caso nosso ifoodSku = externalCode,
    externalCode?: string; // externalCode = nosso código interno (ifood_sku)
    name?: string;
  };
  complement?: Array<{ name?: string }> | Array<string>;
  notes?: string;
}

export interface IfoodDeliveryAddress {
  streetName?: string;
  streetNumber?: string;
  complement?: string;
  neighborhood?: string;
  city?: string;
  reference?: string;
  formattedAddress?: string;
}

export interface IfoodOrder {
  id: string; // ord_...
  merchantId?: string;
  displayId?: string;
  createdAt?: string;
  orderAmount?: { subTotal?: number; total?: number; deliveryFee?: number };
  payments?: Array<{ method?: string; value?: number; type?: string }>;
  delivery?: {
    deliveredBy?: "IFOOD" | "MERCHANT";
    deliveryAddress?: IfoodDeliveryAddress;
  };
  customer?: { name?: string; phone?: string };
  items: IfoodOrderItem[];
}

export interface PollEventsResponse {
  events: IfoodEvent[];
}

export interface Merchant {
  id: string;
  name: string;
}