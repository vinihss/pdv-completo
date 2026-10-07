import React, { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { dispatchDelivery, deliverDelivery, failDelivery, useDeliveries } from "@/entities/delivery";
import { CourierTrackingMap, useCourierLocationPing } from "@/features/courier-tracking";
import { deliveryDestination } from "./model/orderView";
import { groupDeliveries } from "./model/deliveries";
import { useNewDeliveryAlert } from "./model/useNewDeliveryAlert";
import { useScreenWakeLock } from "./model/useScreenWakeLock";
import { useOnlineStatus } from "@/shared/hooks/useOnlineStatus";
import { useAppStateActive } from "@/shared/hooks/useAppStateActive";
import DeliveryCard from "./ui/DeliveryCard";
import FailedDeliveryCard from "./ui/FailedDeliveryCard";
import FailReasonModal from "./ui/FailReasonModal";
import {
  CourierEmpty,
  CourierError,
  CourierSkeleton,
  OfflineBanner,
  QueueEmpty,
  StaleWarning,
} from "./ui/CourierStates";

const CLOCK_TICK_MS = 30_000;

export default function CourierApp() {
  const { deliveries, loading, reload, error } = useDeliveries("courier");
  const [now, setNow] = useState(() => Date.now());
  const [busyId, setBusyId] = useState(null);
  const [failing, setFailing] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const online = useOnlineStatus();
  useScreenWakeLock(true);

  const list = useMemo(
    () => (Array.isArray(deliveries) ? deliveries.filter(Boolean) : []),
    [deliveries]
  );
  const { active, queue, failed } = useMemo(() => groupDeliveries(list), [list]);

  const hasOutForDelivery = active.length > 0;
  const {
    position: gpsPosition,
    permissionDenied: gpsDenied,
    supported: gpsSupported,
  } = useCourierLocationPing({ active: hasOutForDelivery });

  const currentActive = active[0] || null;
  const currentDestination = currentActive ? deliveryDestination(currentActive) : null;

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const reloadList = useCallback(async () => {
    try {
      await reload();
      setLoadError(null);
    } catch (e) {
      setLoadError(e ?? new Error("Falha ao carregar entregas"));
    }
  }, [reload]);

  useAppStateActive(() => {
    reloadList();
  });

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await reloadList();
    setRefreshing(false);
  }, [reloadList]);

  const { markSelfAction, clearSelfAction } = useNewDeliveryAlert({
    deliveries,
    loading,
  });

  const handleDispatch = async (d) => {
    markSelfAction();
    setBusyId(d.id);
    try {
      await dispatchDelivery(d.id);
      await reloadList();
    } catch (e) {
      clearSelfAction();
      console.error(e);
    } finally {
      setBusyId(null);
    }
  };

  const handleDeliver = async (d) => {
    markSelfAction();
    setBusyId(d.id);
    try {
      await deliverDelivery(d.id);
      await reloadList();
    } catch (e) {
      clearSelfAction();
      console.error(e);
    } finally {
      setBusyId(null);
    }
  };

  const openFail = (d) => {
    setFailing(d);
  };

  const closeFail = () => {
    setFailing(null);
  };

  const handleFailConfirm = async (reason) => {
    if (!failing) return;
    const id = failing.id;
    markSelfAction();
    setBusyId(id);
    try {
      await failDelivery(id, { reason });
      setFailing(null);
      await reloadList();
    } catch (e) {
      clearSelfAction();
      console.error(e);
    } finally {
      setBusyId(null);
    }
  };

  const derivedError = loadError || error;
  const isBlocker = !loading && !list.length && Boolean(derivedError);

  // "Trabalhável" = entrega sobre a qual o entregador pode agir agora. Uma
  // entrega `failed` não é trabalhável: já foi resolvida, não tem ação. É o
  // número que decide se a tela está vazia de verdade — a checagem de "sem
  // entregas" não pode ser `active + queue + failed`, senão uma comanda que
  // falhou esconderia o aviso de que não há mais nada para fazer.
  const workable = active.length + queue.length;

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#fbbf24" />}
    >
      <Text style={styles.badge}>Entregador</Text>
      <Text style={styles.title}>Entregas</Text>

      <View style={styles.section}>
        {!online ? <OfflineBanner /> : null}
        {derivedError && !isBlocker ? <StaleWarning /> : null}
        {loading ? <CourierSkeleton /> : null}
        {isBlocker ? <CourierError message={derivedError?.message} /> : null}
      </View>

      {/* Cada seção é dona do seu "vazio". Antes, a seção "Em rota" também
          desenhava o `<CourierEmpty />` global e o bloco final desenhava de
          novo: com a lista vazia o texto aparecia DUAS vezes (e o
          `getByText` dos testes — que é como o usuário o lê — ficava
          ambíguo). Agora o vazio global é um só, no fim. */}
      {active.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Em rota</Text>
          <CourierTrackingMap
            position={gpsPosition}
            destination={currentDestination}
            permissionDenied={gpsDenied}
            supported={gpsSupported}
          />
          {active.map((d, idx) => (
            <DeliveryCard
              key={d.id}
              delivery={d}
              now={now}
              variant={idx === 0 ? "hero" : "compact"}
              busy={busyId === d.id}
              onDispatch={() => handleDispatch(d)}
              onDeliver={() => handleDeliver(d)}
              onFail={() => openFail(d)}
            />
          ))}
        </View>
      )}

      {workable > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Fila</Text>
          {queue.length === 0 ? <QueueEmpty /> : null}
          {queue.map((d) => (
            <DeliveryCard
              key={d.id}
              delivery={d}
              now={now}
              variant="compact"
              busy={busyId === d.id}
              onDispatch={() => handleDispatch(d)}
              onDeliver={() => handleDeliver(d)}
              onFail={() => openFail(d)}
            />
          ))}
        </View>
      )}

      {failed.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Com problema</Text>
          {failed.map((d) => (
            <FailedDeliveryCard key={d.id} delivery={d} />
          ))}
        </View>
      )}

      {!loading && !isBlocker && workable === 0 && failed.length === 0 && (
        <View style={styles.section}>
          <CourierEmpty />
        </View>
      )}

      <FailReasonModal
        visible={!!failing}
        deliveryId={failing?.id}
        onCancel={closeFail}
        onConfirm={handleFailConfirm}
        busy={Boolean(failing && busyId === failing.id)}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: "#0c0a09",
  },
  content: {
    padding: 20,
    gap: 20,
    paddingBottom: 40,
  },
  badge: {
    color: "#d6d3d1",
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 2,
    textTransform: "uppercase",
  },
  title: {
    color: "#fafaf9",
    fontSize: 30,
    fontWeight: "800",
  },
  section: {
    gap: 12,
  },
  sectionTitle: {
    color: "#e7e5e4",
    fontSize: 14,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 1,
  },
});
