import { InspectorProvider } from "./InspectorProvider";
import { createHttpAiAdapter } from "./adapters";
import type { InspectorProviderProps } from "./types";
import { useEffect, useState } from "react";

export type InspectorDevToolsProps = Omit<InspectorProviderProps, "children" | "ai" | "enabled"> & {
  enabled?: boolean;
  aiEndpoint?: string;
  aiToken?: string;
  timeoutMs?: number;
  ssr?: boolean;
};

function viteDevelopmentMode() {
  return Boolean((import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV);
}

export function InspectorDevTools({
  enabled,
  aiEndpoint = "/api/inspector/ai",
  aiToken,
  timeoutMs = 30_000,
  ssr = false,
  workspace,
  defaultOpen,
}: InspectorDevToolsProps) {
  const [hydrated, setHydrated] = useState(!ssr);
  useEffect(() => {
    if (ssr) setHydrated(true);
  }, [ssr]);
  const active = (enabled ?? viteDevelopmentMode()) && hydrated;
  const ai = createHttpAiAdapter({ url: aiEndpoint, token: aiToken, timeoutMs });

  return <InspectorProvider enabled={active} ai={ai} workspace={workspace} defaultOpen={defaultOpen}>{null}</InspectorProvider>;
}
