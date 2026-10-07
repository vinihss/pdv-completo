import { useEffect, useState } from "react";
import * as Location from "expo-location";
import { postCourierLocation } from "../api/tracking";

export const PING_INTERVAL_MS = 60_000;

export function useCourierLocationPing({ active }) {
  const [position, setPosition] = useState(null); // { latitude, longitude, accuracy }
  const [permissionDenied, setPermissionDenied] = useState(false);
  const supported = true;

  useEffect(() => {
    if (!active || !supported) return undefined;
    let cancelled = false;

    async function tick() {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (cancelled) return;
        if (status !== "granted") {
          setPermissionDenied(true);
          return;
        }
        setPermissionDenied(false);
        const loc = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.High,
          mayShowUserSettingsDialog: true,
        });
        if (cancelled) return;
        const { latitude, longitude, accuracy } = loc.coords;
        const nextPos = { latitude, longitude, accuracy };
        setPosition(nextPos);
        postCourierLocation(nextPos).catch(() => {});
      } catch (err) {
        if (cancelled) return;
        const message = String(err?.message || err || "").toLowerCase();
        if (message.includes("permission") || message.includes("denied")) {
          setPermissionDenied(true);
        }
      }
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
