import { useEffect, useRef } from "react";
import { playAlertSound, isAlertSoundEnabled } from "@/entities/alert";

/**
 * "Ganhei um pedido": som + aviso quando uma entrega nova entra na lista.
 *
 * O `useDeliveries` recarrega a lista a QUALQUER evento da room `deliveries`
 * (inclusive o `delivery.assigned`, que é o gerente atribuindo um pedido a este
 * entregador) sem distinguir o tipo do evento — e o hook é território de outro
 * agente. A detecção é feita aqui, por diferença de conjunto: um `id` que não
 * estava na lista anterior e está em `awaiting_courier` é, por construção, um
 * pedido que entrou agora.
 *
 * Três cuidado, senão o barulho vira mentira:
 *
 *   1. A primeira carga é a linha de base, não um pedido novo (else quem abre
 *      o app no meio do turno ouve um bip por entrega pendente).
 *   2. Recarregar com `loading` no ar não conta como entrada — é só a lista
 *      sendo repintada.
 *   3. Entrada logo depois de uma ação do próprio usuário não avisa: ele já
 *      está olhando para a tela e já sabe.
 *
 * O som é o de alerta que o repo já tem (`playAlertSound`, a mesma sequência da
 * cozinha e do sino) e respeita a preferência por dispositivo. O toast vai
 * sempre — com o som desligado, quem não está olhando a tela precisa de um
 * aviso visual que dure o suficiente para ser lido.
 */
export function useNewDeliveryAlert({ deliveries, loading, onNewDelivery }) {
  const knownRef = useRef(null); // null = ainda não houve carga de base
  const selfActionRef = useRef(false);
  const callbackRef = useRef(onNewDelivery);
  callbackRef.current = onNewDelivery;

  useEffect(() => {
    // Repintação da mesma lista (hook recarga, reconexão): nada a detectar.
    if (loading) return;
    const list = Array.isArray(deliveries) ? deliveries.filter(Boolean) : [];
    const known = knownRef.current;

    if (known === null) {
      knownRef.current = new Set(list.map((d) => d.id));
      return;
    }

    if (selfActionRef.current) {
      // Consome o crédito: a próxima carga volta a ser avaliada normalmente.
      selfActionRef.current = false;
      knownRef.current = new Set(list.map((d) => d.id));
      return;
    }

    const newcomers = list.filter((d) => !known.has(d.id) && d.status === "awaiting_courier");
    knownRef.current = new Set(list.map((d) => d.id));
    if (newcomers.length === 0) return;

    if (isAlertSoundEnabled()) playAlertSound("order_created");
    callbackRef.current?.(newcomers);
  }, [deliveries, loading]);

  return {
    /**
     * Marca que a próxima carga é consequência de uma ação do próprio toque.
     * Chamar ANTES do `await` da mutation: o toast do sucesso já provoca
     * re-render, e é nesse render que a lista nova aparece — quem marca depois
     * do `await` chega tarde e o som toca no usuário que acabou de agir.
     */
    markSelfAction: () => {
      selfActionRef.current = true;
    },
    /** Devolve o crédito quando a ação falhou (não houve mudança de estado). */
    clearSelfAction: () => {
      selfActionRef.current = false;
    },
  };
}