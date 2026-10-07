// Toast curto do fluxo do garçom (porta o `shared/components/Toast` do web).
// Sem lib de animação: aparece por 2.5s num bloco absoluto no rodapé e some.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Animated, StyleSheet, Text } from "react-native";

const ToastContext = createContext(null);

const DURATION_MS = 2600;

export function ToastProvider({ children }) {
  const [current, setCurrent] = useState(null); // { message, type, id }
  const opacity = useRef(new Animated.Value(0)).current;
  const timerRef = useRef(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const showToast = useCallback(
    (message, type = "info") => {
      setCurrent({ message, type, id: Date.now() });
      Animated.timing(opacity, { toValue: 1, duration: 160, useNativeDriver: true }).start();
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        Animated.timing(opacity, { toValue: 0, duration: 220, useNativeDriver: true }).start(() => {
          setCurrent(null);
        });
      }, DURATION_MS);
    },
    [opacity]
  );

  const value = useMemo(() => ({ showToast }), [showToast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {current && (
        <Animated.View
          pointerEvents="none"
          style={[styles.toast, current.type === "error" ? styles.error : styles.info, { opacity }]}
          accessibilityLiveRegion="polite"
        >
          <Text style={styles.text}>{current.message}</Text>
        </Animated.View>
      )}
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast precisa estar dentro de <ToastProvider>");
  return ctx;
}

const styles = StyleSheet.create({
  toast: {
    position: "absolute",
    left: 16,
    right: 16,
    bottom: 28,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
    zIndex: 999,
    borderWidth: 1,
    borderColor: "#44403c", // stone-700
    backgroundColor: "#1c1917", // stone-900
  },
  info: {
    backgroundColor: "#292524", // stone-800
  },
  error: {
    backgroundColor: "#450a0a", // red-950
    borderColor: "#7f1d1d", // red-900
  },
  text: {
    color: "#fafaf9", // stone-50
    fontSize: 14,
    lineHeight: 20,
  },
});