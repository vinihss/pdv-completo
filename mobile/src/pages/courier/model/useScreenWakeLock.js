import { useEffect } from "react";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";

export function useScreenWakeLock(active = true) {
  useEffect(() => {
    if (!active) {
      return;
    }

    activateKeepAwakeAsync().catch(() => {});
    return () => {
      try {
        deactivateKeepAwake();
      } catch {
        // ignorar
      }
    };
  }, [active]);
}
