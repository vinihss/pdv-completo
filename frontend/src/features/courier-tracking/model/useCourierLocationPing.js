import { useEffect, useState } from "react";
import { postCourierLocation } from "../api/tracking.js";

/**
 * Ping de GPS do entregador: enquanto houver entrega `out_for_delivery`,
 * lê a posição e manda `POST /courier/location` a cada 60s (e uma vez na
 * ativação, para o mapa do gerente não esperar um minuto pelo primeiro
 * ponto).
 *
 * Decisões:
 *
 * - `getCurrentPosition` num `setInterval`, e não `watchPosition`: o watch
 *   reage a movimento, e no trânsito isso dispara muito mais que 1/min —
 *   bateria e 4G de rua agradecem o passo fixo. A leitura em si já vem do
 *   GPS do aparelho (`enableHighAccuracy`), então cada tick é uma posição
 *   nova, não um replay do cache.
 * - Liga/desliga pela PROP `active` (há entrega em rota?), e não por dentro:
 *   quem sabe o status das entregas é a tela que já as carrega
 *   (`useDeliveries`), e duplicar a lista aqui seria uma segunda fonte de
 *   verdade para a mesma pergunta.
 * - Erro de ENVIO é engolido (corrida com a conclusão da entrega, 4G caindo)
 *   — o próximo tick tenta de novo. Erro de PERMISSÃO de GPS vira estado
 *   (`permissionDenied`), porque esse não se resolve sozinho: a tela mostra
 *   o aviso "Ative a localização…" até o entregador liberar no navegador.
 *
 * Retorna `{ position, permissionDenied, supported }`: `position` é a
 * última leitura local (alimenta o marker do próprio mapa do entregador sem
 * esperar o roundtrip do servidor).
 */
export const PING_INTERVAL_MS = 60_000;

export function useCourierLocationPing({ active }) {
  const [position, setPosition] = useState(null); // { latitude, longitude, accuracy }
  const [permissionDenied, setPermissionDenied] = useState(false);
  const supported = typeof navigator !== "undefined" && !!navigator.geolocation;

  useEffect(() => {
    if (!active || !supported) return undefined;
    let cancelled = false;

    function tick() {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          if (cancelled) return;
          const { latitude, longitude, accuracy } = pos.coords;
          setPermissionDenied(false);
          setPosition({ latitude, longitude, accuracy });
          // Sem `await` e sem toast: falha de envio é transitória por
          // definição (o próximo tick refaz) e o entregador está dirigindo —
          // a última tela que ele precisa é de um erro piscando.
          postCourierLocation({ latitude, longitude, accuracy }).catch(() => {});
        },
        (err) => {
          if (cancelled) return;
          // code 1 = PERMISSION_DENIED. Os outros (2 indisponível, 3
          // timeout) são transitórios — o tick seguinte tenta de novo.
          if (err?.code === 1) setPermissionDenied(true);
        },
        { enableHighAccuracy: true, maximumAge: 30_000, timeout: 20_000 }
      );
    }

    tick();
    const timer = setInterval(tick, PING_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [active, supported]);

  return { position, permissionDenied, supported };
}
