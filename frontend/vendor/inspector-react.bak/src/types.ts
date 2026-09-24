export type InspectorElementContext = {
  tag: string;
  selector: string;
  text?: string;
  dimensions?: { width: number; height: number };
  styles: Record<string, string>;
};

export type InspectorSourceContext = {
  path: string;
  selector: string;
};

export type InspectorChatInput = {
  message: string;
  element: InspectorElementContext;
  source: InspectorSourceContext;
  history: Array<{ role: "user" | "assistant"; text: string }>;
};

export type InspectorSuggestion = {
  path: string;
  selector: string;
  property: string;
  before: string | null;
  after: string;
  reason?: string;
};

export type InspectorChatResponse = {
  message: string;
  suggestions: InspectorSuggestion[];
};

export type InspectorWorkspaceAdapter = {
  listFiles?: () => Promise<string[]>;
  resolveSource?: (selector: string) => Promise<{ path: string; selector: string; hash: string; markupPath?: string; markupHash?: string } | null>;
  readFile?: (path: string) => Promise<{ path: string; content: string; hash: string; bytes: number }>;
  previewMarkupPatch?: (input: { path: string; selector: string; tag: string; text: string; attributes: Array<{ name: string; value: string }>; expectedHash?: string }) => Promise<unknown>;
  writeMarkupPatch?: (input: { path: string; selector: string; tag: string; text: string; attributes: Array<{ name: string; value: string }>; expectedHash: string }) => Promise<{ hash?: string }>;
  previewContentPatch?: (input: { path: string; before: string; after: string; expectedHash?: string }) => Promise<unknown>;
  writeContentPatch?: (input: { path: string; before: string; after: string; expectedHash: string }) => Promise<{ hash?: string }>;
  previewPatch?: (input: InspectorSuggestion & { expectedHash?: string }) => Promise<unknown>;
  writePatch?: (input: InspectorSuggestion & { expectedHash: string }) => Promise<unknown>;
};

export type InspectorAiAdapter = {
  chat: (input: InspectorChatInput) => Promise<InspectorChatResponse>;
};

export type InspectorProviderProps = {
  children?: React.ReactNode;
  enabled?: boolean;
  workspace?: InspectorWorkspaceAdapter;
  ai?: InspectorAiAdapter;
  defaultOpen?: boolean;
};
