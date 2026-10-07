import { useEffect, useRef } from "react";
import { playAlertSound, isAlertSoundEnabled } from "@/entities/alert";

export function useNewDeliveryAlert({ deliveries, loading, onNewDelivery }) {
  const knownRef = useRef(null);
  const selfActionRef = useRef(false);
  const callbackRef = useRef(onNewDelivery);

  useEffect(() => {
    callbackRef.current = onNewDelivery;
  }, [onNewDelivery]);

  useEffect(() => {
    if (loading) return;
    const list = Array.isArray(deliveries) ? deliveries.filter(Boolean) : [];
    const known = knownRef.current;

    if (known === null) {
      knownRef.current = new Set(list.map((d) => d.id));
      return;
    }

    if (selfActionRef.current) {
      selfActionRef.current = false;
      knownRef.current = new Set(list.map((d) => d.id));
      return;
    }

    const newcomers = list.filter((d) => !known.has(d.id) && d.status === "awaiting_courier");
    knownRef.current = new Set(list.map((d) => d.id));
    if (newcomers.length === 0) return;

    if (isAlertSoundEnabled()) {
      playAlertSound("order_created");
    }
    callbackRef.current?.(newcomers);
  }, [deliveries, loading]);

  return {
    markSelfAction: () => {
      selfActionRef.current = true;
    },
    clearSelfAction: () => {
      selfActionRef.current = false;
    },
  };
}
