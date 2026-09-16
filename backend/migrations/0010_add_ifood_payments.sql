-- iFood: guarda os métodos de pagamento do pedido externo para fechar a
-- comanda local no evento CONCLUDED sem depender de interação manual.
ALTER TABLE "order" ADD COLUMN "ifood_payments" text;