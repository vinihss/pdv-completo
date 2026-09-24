import type { InspectorAiAdapter, InspectorChatInput, InspectorChatResponse, InspectorWorkspaceAdapter } from "./types";

export function createTrpcAiAdapter(chat: (input: {
  message: string;
  element: Omit<InspectorChatInput["element"], "styles">;
  styles: Record<string, string>;
  source: InspectorChatInput["source"];
  history: InspectorChatInput["history"];
}) => Promise<InspectorChatResponse>): InspectorAiAdapter {
  return {
    chat: (input) => chat({
      message: input.message,
      element: {
        tag: input.element.tag,
        selector: input.element.selector,
        text: input.element.text,
        dimensions: input.element.dimensions,
      },
      styles: input.element.styles,
      source: input.source,
      history: input.history,
    }),
  };
}

export function createTrpcWorkspaceAdapter(api: {
  listFiles: () => Promise<string[]>;
  resolveSource: (selector: string) => Promise<{ path: string; selector: string; hash: string; markupPath?: string; markupHash?: string } | null>;
  readFile: (path: string) => Promise<{ path: string; content: string; hash: string; bytes: number }>;
  previewContentPatch?: (input: { path: string; before: string; after: string; expectedHash?: string }) => Promise<unknown>;
  writeContentPatch?: (input: { path: string; before: string; after: string; expectedHash: string }) => Promise<{ hash?: string }>;
  previewPatch?: (input: Parameters<NonNullable<InspectorWorkspaceAdapter["previewPatch"]>>[0]) => Promise<unknown>;
  writePatch?: (input: Parameters<NonNullable<InspectorWorkspaceAdapter["writePatch"]>>[0]) => Promise<unknown>;
}): InspectorWorkspaceAdapter {
  return {
    listFiles: api.listFiles,
    resolveSource: api.resolveSource,
    readFile: api.readFile,
    previewContentPatch: api.previewContentPatch,
    writeContentPatch: api.writeContentPatch,
    previewPatch: api.previewPatch,
    writePatch: api.writePatch,
  };
}

export function createHttpAiAdapter(config: { url: string; token?: string; timeoutMs?: number }): InspectorAiAdapter {
  return {
    async chat(input: InspectorChatInput) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? 30_000);
      try {
        const response = await fetch(config.url, {
          method: "POST",
          signal: controller.signal,
          headers: {
            "Content-Type": "application/json",
            ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
          },
          body: JSON.stringify({ message: input.message, context: input }),
        });
        if (!response.ok) throw new Error(`AI endpoint returned HTTP ${response.status}`);
        return (await response.json()) as InspectorChatResponse;
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

export function createFetchWorkspaceAdapter(baseUrl = "/api/inspector/workspace"): InspectorWorkspaceAdapter {
  const request = async <T>(path: string, init?: RequestInit) => {
    const response = await fetch(`${baseUrl}${path}`, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
    if (!response.ok) throw new Error(`Workspace endpoint returned HTTP ${response.status}`);
    return (await response.json()) as T;
  };
  return {
    listFiles: () => request<string[]>("/files"),
    resolveSource: (selector) => request(`/source?selector=${encodeURIComponent(selector)}`),
    readFile: (path) => request(`/file?path=${encodeURIComponent(path)}`),
    previewContentPatch: (input) => request("/preview-content", { method: "POST", body: JSON.stringify(input) }),
    writeContentPatch: (input) => request("/write-content", { method: "POST", body: JSON.stringify(input) }),
    previewPatch: (input) => request("/preview", { method: "POST", body: JSON.stringify(input) }),
    writePatch: (input) => request("/write", { method: "POST", body: JSON.stringify(input) }),
  };
}
