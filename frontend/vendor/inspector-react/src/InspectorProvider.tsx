import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { InspectorAiAdapter, InspectorChatResponse, InspectorElementContext, InspectorProviderProps, InspectorSuggestion } from "./types";
import "./styles.css";

type InspectorTab = "element" | "styles" | "changes" | "chat" | "history";
type Selected = InspectorElementContext & { node: HTMLElement };
type PreviewStyle = "display" | "gap" | "padding" | "color" | "backgroundColor" | "borderRadius" | "boxShadow";
type PreviewStyles = Record<PreviewStyle, string>;
type ChatMessage = { role: "user" | "assistant"; text: string; suggestions?: InspectorSuggestion[] };
type WorkspaceEvent = { id: number; status: "success" | "error"; message: string; path: string; kind: "style" | "markup" | "mixed"; timestamp: number };

const previewProperties: Array<{ key: PreviewStyle; label: string }> = [
  { key: "display", label: "display" },
  { key: "gap", label: "gap" },
  { key: "padding", label: "padding" },
  { key: "color", label: "color" },
  { key: "backgroundColor", label: "background" },
  { key: "borderRadius", label: "border-radius" },
  { key: "boxShadow", label: "box-shadow" },
];

const propertyMap: Record<string, PreviewStyle> = {
  display: "display",
  gap: "gap",
  padding: "padding",
  color: "color",
  background: "backgroundColor",
  "background-color": "backgroundColor",
  "border-radius": "borderRadius",
  "box-shadow": "boxShadow",
};

function toSelector(element: HTMLElement) {
  if (element.id) return `#${CSS.escape(element.id)}`;
  const className = typeof element.className === "string"
    ? element.className.split(/\s+/).filter(Boolean).filter((name) => !name.includes("inspector")).slice(0, 2)
    : [];
  return className.length ? `.${className.join(".")}` : element.tagName.toLowerCase();
}

function inspectElement(node: HTMLElement): Selected {
  const computed = window.getComputedStyle(node);
  const styles = ["display", "gap", "padding", "color", "backgroundColor", "borderRadius", "boxShadow"].reduce<Record<string, string>>((result, property) => {
    result[property] = computed.getPropertyValue(property);
    return result;
  }, {});
  const rect = node.getBoundingClientRect();
  return {
    node,
    tag: node.tagName.toLowerCase(),
    selector: toSelector(node),
    text: node.innerText?.slice(0, 240),
    dimensions: { width: Math.round(rect.width), height: Math.round(rect.height) },
    styles,
  };
}

function applyCss(selector: string, property: string, value: string) {
  if (!selector || !/^[a-zA-Z0-9_.#\- >:+()[\]="']+$/.test(selector) || !/^[a-z-]+$/.test(property) || !value.trim()) return false;
  let style = document.querySelector<HTMLStyleElement>('style[data-inspector-preview="true"]');
  if (!style) {
    style = document.createElement("style");
    style.dataset.inspectorPreview = "true";
    document.head.appendChild(style);
  }
  style.textContent += `\n/* inspector preview */\n${selector} { ${property}: ${value}; }`;
  return true;
}

function styleSnapshot(selected: Selected | null): PreviewStyles {
  const values = selected?.styles ?? {};
  return {
    display: values.display ?? "",
    gap: values.gap ?? "",
    padding: values.padding ?? "",
    color: values.color ?? "",
    backgroundColor: values.backgroundColor ?? "",
    borderRadius: values.borderRadius ?? "",
    boxShadow: values.boxShadow ?? "",
  };
}

export function InspectorProvider({ children, enabled = true, workspace, ai, defaultOpen = false }: InspectorProviderProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [selecting, setSelecting] = useState(false);
  const [tab, setTab] = useState<InspectorTab>("styles");
  const [selected, setSelected] = useState<Selected | null>(null);
  const [currentStyles, setCurrentStyles] = useState<PreviewStyles>(() => styleSnapshot(null));
  const [savedStyles, setSavedStyles] = useState<PreviewStyles>(() => styleSnapshot(null));
  const [history, setHistory] = useState<PreviewStyles[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [source, setSource] = useState<{ path: string; selector: string; hash: string; markupPath?: string; markupHash?: string } | null>(null);
  const [markupText, setMarkupText] = useState("");
  const [markupHref, setMarkupHref] = useState("");
  const [markupTag, setMarkupTag] = useState("");
  const [savedMarkup, setSavedMarkup] = useState("");
  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([
    { role: "assistant", text: "Selecione um elemento para inspecionar seus estilos e conversar com a IA." },
  ]);
  const [pending, setPending] = useState(false);
  const [toast, setToast] = useState("");
  const [workspaceHistory, setWorkspaceHistory] = useState<WorkspaceEvent[]>([]);
  const [expandedTreeNodes, setExpandedTreeNodes] = useState<Set<string>>(() => new Set());
  const [newAttributeName, setNewAttributeName] = useState("");
  const [newAttributeValue, setNewAttributeValue] = useState("");
  const [attributeToRemove, setAttributeToRemove] = useState<{ node: HTMLElement; name: string } | null>(null);

  const showToast = useCallback((text: string) => {
    setToast(text);
    window.setTimeout(() => setToast(""), 2600);
  }, []);

  const recordWorkspaceEvent = useCallback((event: Omit<WorkspaceEvent, "id" | "timestamp">) => {
    setWorkspaceHistory((items) => [{ ...event, id: Date.now() + Math.random(), timestamp: Date.now() }, ...items].slice(0, 50));
  }, []);

  const nodeKey = useCallback((node: HTMLElement) => {
    const parts: string[] = [];
    let current: HTMLElement | null = node;
    while (current && current !== document.body) {
      const parent: HTMLElement | null = current.parentElement;
      if (!parent) break;
      const index = Array.from(parent.children).filter((child) => !(child as HTMLElement).matches("[data-inspector-ui='true']")).indexOf(current);
      parts.unshift(`${current.tagName.toLowerCase()}:${index}`);
      current = parent;
    }
    return parts.join("/") || "body";
  }, []);

  const elementAttributes = (node: HTMLElement) => {
    const attrs: string[] = [];
    if (node.id) attrs.push(`#${node.id}`);
    if (typeof node.className === "string") attrs.push(...node.className.split(/\s+/).filter((name) => name && !name.includes("inspector")).slice(0, 2).map((name) => `.${name}`));
    return attrs.join("");
  };

  const editableAttributes = (node: HTMLElement) => Array.from(node.attributes)
    .filter((attribute) => !attribute.name.startsWith("data-inspector"))
    .map((attribute) => ({ name: attribute.name, value: attribute.value }));

  const directText = (node: HTMLElement) => Array.from(node.childNodes)
    .filter((child) => child.nodeType === Node.TEXT_NODE)
    .map((child) => child.textContent ?? "")
    .join(" ")
    .trim();

  const updateNodeAttribute = (node: HTMLElement, name: string, value: string) => {
    if (value.trim()) node.setAttribute(name, value);
    else node.removeAttribute(name);
    if (selected?.node === node) {
      setSelected(inspectElement(node));
      setMarkupHref(node instanceof HTMLAnchorElement ? node.getAttribute("href") ?? "" : "");
      setMarkupText(node.textContent ?? "");
    }
  };

  const updateNodeText = (node: HTMLElement, value: string) => {
    const textNode = Array.from(node.childNodes).find((child) => child.nodeType === Node.TEXT_NODE);
    if (textNode) textNode.textContent = value;
    else node.insertBefore(document.createTextNode(value), node.firstChild);
    if (selected?.node === node) {
      setSelected(inspectElement(node));
      setMarkupText(node.textContent ?? "");
    }
  };

  const addNodeAttribute = (node: HTMLElement) => {
    const name = newAttributeName.trim().toLowerCase();
    if (!/^[a-z][a-z0-9:-]*$/i.test(name)) {
      showToast("Nome de atributo inválido");
      return;
    }
    if (node.hasAttribute(name)) {
      showToast(`O atributo ${name} já existe neste elemento`);
      return;
    }
    node.setAttribute(name, newAttributeValue);
    setNewAttributeName("");
    setNewAttributeValue("");
    if (selected?.node === node) {
      setSelected(inspectElement(node));
      showToast(`Atributo ${name} adicionado ao preview`);
    }
  };

  const confirmRemoveAttribute = () => {
    if (!attributeToRemove) return;
    const { node, name } = attributeToRemove;
    node.removeAttribute(name);
    setAttributeToRemove(null);
    if (selected?.node === node) {
      setSelected(inspectElement(node));
      setMarkupHref(node instanceof HTMLAnchorElement ? node.getAttribute("href") ?? "" : "");
      setMarkupText(node.textContent ?? "");
      showToast(`Atributo ${name} removido do preview`);
    }
  };

  const treeChildren = (node: HTMLElement) => Array.from(node.children).filter((child) => {
    const element = child as HTMLElement;
    return !element.matches("[data-inspector-ui='true']") && !element.matches("script,style,link,meta");
  }) as HTMLElement[];

  useEffect(() => {
    if (!selected) return;
    const expanded = new Set<string>();
    let current: HTMLElement | null = selected.node;
    while (current && current !== document.body) {
      expanded.add(nodeKey(current));
      current = current.parentElement;
    }
    expanded.add("body");
    setExpandedTreeNodes(expanded);
  }, [nodeKey, selected]);

  const selectElement = useCallback(async (node: HTMLElement) => {
    const next = inspectElement(node);
    const snapshot = styleSnapshot(next);
    setSelected(next);
    setCurrentStyles(snapshot);
    setSavedStyles(snapshot);
    setHistory([snapshot]);
    setHistoryIndex(0);
    setMarkupText(next.node.textContent ?? "");
    setMarkupHref(next.node instanceof HTMLAnchorElement ? next.node.getAttribute("href") ?? "" : "");
    setMarkupTag(next.tag);
    setSavedMarkup(next.node.outerHTML);
    setNewAttributeName("");
    setNewAttributeValue("");
    document.querySelectorAll<HTMLElement>("[data-inspector-selected='true']").forEach((element) => element.removeAttribute("data-inspector-selected"));
    next.node.setAttribute("data-inspector-selected", "true");
    setSelecting(false);
    setTab("element");
    setOpen(true);
    setSource(null);
    if (workspace?.resolveSource) {
      try {
        const resolved = await workspace.resolveSource(next.selector);
        setSource(resolved);
        if (!resolved) showToast("Nenhum stylesheet editável encontrado para este seletor");
      } catch (error) {
        showToast(error instanceof Error ? error.message : "Não foi possível resolver a origem CSS");
      }
    }
  }, [showToast, workspace]);

  useEffect(() => {
    if (!enabled) return;
    const handleHover = (event: MouseEvent) => {
      if (!selecting) return;
      const target = event.target;
      if (!(target instanceof HTMLElement) || target.closest("[data-inspector-ui='true']")) return;
      document.querySelectorAll<HTMLElement>("[data-inspector-hover='true']").forEach((node) => node.removeAttribute("data-inspector-hover"));
      target.setAttribute("data-inspector-hover", "true");
    };
    const handleClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || target.closest("[data-inspector-ui='true']")) return;
      if (selecting) {
        event.preventDefault();
        event.stopPropagation();
        void selectElement(target);
      }
    };
    document.addEventListener("click", handleClick, true);
    document.addEventListener("mouseover", handleHover, true);
    return () => {
      document.removeEventListener("click", handleClick, true);
      document.removeEventListener("mouseover", handleHover, true);
      document.querySelectorAll<HTMLElement>("[data-inspector-hover='true']").forEach((node) => {
        node.removeAttribute("data-inspector-hover");
      });
    };
  }, [enabled, selectElement, selecting]);

  const markupDirty = Boolean(selected && selected.node.outerHTML !== savedMarkup);

  const updateMarkup = useCallback((kind: "text" | "href" | "tag", value: string) => {
    if (!selected) return;
    if (kind === "text") {
      selected.node.textContent = value;
      setMarkupText(value);
    } else if (kind === "href" && selected.node instanceof HTMLAnchorElement) {
      selected.node.setAttribute("href", value);
      setMarkupHref(value);
    } else if (kind === "tag" && /^[a-z][a-z0-9-]*$/i.test(value)) {
      const replacement = document.createElement(value.toLowerCase());
      Array.from(selected.node.attributes).forEach((attribute) => replacement.setAttribute(attribute.name, attribute.value));
      while (selected.node.firstChild) replacement.appendChild(selected.node.firstChild);
      selected.node.replaceWith(replacement);
      const next = inspectElement(replacement);
      setSelected(next);
      setMarkupTag(next.tag);
    }
  }, [selected]);

  const pendingChanges = useMemo(() => previewProperties
    .filter(({ key }) => currentStyles[key] !== savedStyles[key])
    .map(({ key, label }) => ({ key, label, before: savedStyles[key], after: currentStyles[key] })), [currentStyles, savedStyles]);

  const updateStyle = useCallback((key: PreviewStyle, value: string) => {
    if (!selected) return;
    const next = { ...currentStyles, [key]: value };
    setCurrentStyles(next);
    setHistory((items) => [...items.slice(0, historyIndex + 1), next]);
    setHistoryIndex((index) => index + 1);
    const cssProperty = key === "backgroundColor" ? "background-color" : key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
    applyCss(selected.selector, cssProperty, value);
  }, [currentStyles, historyIndex, selected]);

  const undo = () => {
    if (historyIndex <= 0) return;
    setHistoryIndex((index) => index - 1);
    setCurrentStyles(history[historyIndex - 1] ?? currentStyles);
  };

  const redo = () => {
    if (historyIndex >= history.length - 1) return;
    setHistoryIndex((index) => index + 1);
    setCurrentStyles(history[historyIndex + 1] ?? currentStyles);
  };

  const applySuggestion = (suggestion: InspectorSuggestion) => {
    if (!selected) return;
    const key = propertyMap[suggestion.property.toLowerCase()];
    if (!key) {
      showToast(`A propriedade ${suggestion.property} não está disponível no preview`);
      return;
    }
    if (suggestion.selector) selected.node.setAttribute("data-inspector-target", suggestion.selector);
    if (workspace?.resolveSource && suggestion.selector !== selected.selector) {
      void workspace.resolveSource(suggestion.selector).then(setSource).catch(() => undefined);
    }
    updateStyle(key, suggestion.after);
    setTab("styles");
    showToast(`${suggestion.property} aplicado no preview`);
  };

  const askAi = async () => {
    if (!ai || !selected || !message.trim() || pending) return;
    const text = message.trim();
    setMessage("");
    setPending(true);
    setMessages((items) => [...items, { role: "user", text }]);
    try {
      const response: InspectorChatResponse = await ai.chat({
        message: text,
        element: { tag: selected.tag, selector: selected.selector, text: selected.text, dimensions: selected.dimensions, styles: currentStyles },
        source: { path: source?.path || source?.markupPath || "", selector: source?.selector ?? selected.selector },
        history: messages.slice(-8).map(({ role, text: item }) => ({ role, text: item })),
      });
      setMessages((items) => [...items, { role: "assistant", text: response.message, suggestions: response.suggestions }]);
    } catch (error) {
      setMessages((items) => [...items, { role: "assistant", text: error instanceof Error ? `Falha na IA: ${error.message}` : "Falha na IA." }]);
    } finally {
      setPending(false);
    }
  };

  const persistChanges = async () => {
    const canWriteMarkup = Boolean(markupDirty && workspace?.writeContentPatch && workspace.readFile && source?.markupPath);
    const canWriteStyles = Boolean(pendingChanges.length > 0 && workspace?.writePatch && workspace.readFile && source?.path);
    if (!workspace?.readFile || !source || !selected || (!canWriteMarkup && !canWriteStyles)) {
      showToast("Alteração aplicada somente no preview");
      return;
    }
    try {
      let wroteMarkup = false;
      let wroteStyles = false;
      if (markupDirty && workspace.writeContentPatch) {
        const contentPath = source.markupPath as string;
        const file = await workspace.readFile(contentPath);
        if (workspace.previewContentPatch) await workspace.previewContentPatch({ path: contentPath, before: savedMarkup, after: selected.node.outerHTML, expectedHash: file.hash });
        const result = await workspace.writeContentPatch({ path: contentPath, before: savedMarkup, after: selected.node.outerHTML, expectedHash: file.hash });
        if (result.hash) setSource((current) => current ? { ...current, markupHash: result.hash } : current);
        setSavedMarkup(selected.node.outerHTML);
        wroteMarkup = true;
      }
      for (const change of pendingChanges) {
        if (!source.path) throw new Error("Nenhum stylesheet editável foi encontrado para este elemento");
        const writePatch = workspace.writePatch;
        if (!writePatch) throw new Error("Adapter de estilos não configurado");
        const file = await workspace.readFile(source.path);
        const property = change.key === "backgroundColor" ? "background-color" : change.key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
        if (workspace.previewPatch) await workspace.previewPatch({ path: source.path, selector: source.selector, property, before: change.before, after: change.after, expectedHash: file.hash });
        const result = await writePatch({ path: source.path, selector: source.selector, property, before: change.before, after: change.after, expectedHash: file.hash }) as { hash?: string };
        if (result.hash) setSource((current) => current ? { ...current, hash: result.hash ?? current.hash } : current);
        wroteStyles = true;
      }
      setSavedStyles(currentStyles);
      setTab("changes");
      showToast("Alterações salvas com sucesso no workspace");
      recordWorkspaceEvent({ status: "success", message: "Alterações gravadas com sucesso", path: source.markupPath || source.path, kind: wroteMarkup && wroteStyles ? "mixed" : wroteMarkup ? "markup" : "style" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Falha ao gravar alterações";
      showToast(message);
      recordWorkspaceEvent({ status: "error", message, path: source?.markupPath || source?.path || "origem não resolvida", kind: markupDirty && pendingChanges.length > 0 ? "mixed" : markupDirty ? "markup" : "style" });
    }
  };

  if (!enabled) return <>{children}</>;

  const selectedLabel = selected ? `${selected.tag}${selected.selector}` : "Nenhum elemento selecionado";
  const treeRoot = selected?.node.ownerDocument.body ?? null;
  const toggleTreeNode = (node: HTMLElement) => {
    const key = nodeKey(node);
    setExpandedTreeNodes((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };
  const renderDomNode = (node: HTMLElement, depth = 0): ReactNode => {
    const children = depth < 8 ? treeChildren(node) : [];
    const key = nodeKey(node);
    const expanded = expandedTreeNodes.has(key);
    const isSelected = selected?.node === node;
    const text = Array.from(node.childNodes).filter((child) => child.nodeType === Node.TEXT_NODE).map((child) => child.textContent?.trim()).filter(Boolean).join(" ").slice(0, 48);
    return <div className={`inspector-dom-node ${isSelected ? "selected" : ""}`} key={key} style={{ paddingLeft: `${depth * 12}px` }}>
      <div className="inspector-dom-row">
        {children.length > 0 ? <button className="inspector-dom-expander" onClick={() => toggleTreeNode(node)} aria-label={expanded ? "Recolher nó" : "Expandir nó"}>{expanded ? "⌄" : "›"}</button> : <span className="inspector-dom-expander-spacer" />}
        <button className="inspector-dom-label" onClick={() => void selectElement(node)}><span className="inspector-dom-tag">&lt;{node.tagName.toLowerCase()}&gt;</span><span className="inspector-dom-attrs">{elementAttributes(node)}</span>{text && <span className="inspector-dom-text">{text}</span>}</button>
      </div>
      {isSelected && <div className="inspector-dom-inline-editor" style={{ marginLeft: `${(depth + 1) * 12 + 18}px` }} onClick={(event) => event.stopPropagation()}><label><span>texto</span><input value={directText(node)} onChange={(event) => updateNodeText(node, event.target.value)} placeholder="Texto direto do nó" /></label>{editableAttributes(node).map((attribute) => <div className="inspector-dom-attribute-row" key={attribute.name}><label><span>{attribute.name}</span><input value={attribute.value} onChange={(event) => updateNodeAttribute(node, attribute.name, event.target.value)} /></label><button className="inspector-dom-remove-attribute" onClick={() => setAttributeToRemove({ node, name: attribute.name })} aria-label={`Remover atributo ${attribute.name}`}>×</button></div>)}<div className="inspector-dom-add-attribute"><input value={newAttributeName} onChange={(event) => setNewAttributeName(event.target.value)} placeholder="nome do atributo" aria-label="Nome do novo atributo" /><input value={newAttributeValue} onChange={(event) => setNewAttributeValue(event.target.value)} placeholder="valor" aria-label="Valor do novo atributo" /><button onClick={() => addNodeAttribute(node)} aria-label="Adicionar atributo">+</button></div></div>}
      {expanded && children.map((child) => renderDomNode(child, depth + 1))}
    </div>;
  };
  return <>
    {children}
    <div data-inspector-ui="true" className={`inspector-full ${open ? "inspector-full-open" : ""}`}>
      {open && <aside className="inspector-full-drawer">
        <header className="inspector-full-header"><div className="inspector-full-brand"><span>✦</span><div><strong>Inspector</strong><small>Visual workspace</small></div><b>DEV</b></div><button onClick={() => setOpen(false)} aria-label="Fechar Inspector">×</button></header>
        <div className="inspector-full-toolbar"><button className={selecting ? "active" : ""} onClick={() => setSelecting((value) => !value)}>⌖ {selecting ? "Selecionando" : "Selecionar"}</button><span /><button onClick={undo} disabled={historyIndex <= 0}>↶</button><button onClick={redo} disabled={historyIndex >= history.length - 1}>↷</button></div>
        <div className="inspector-full-selection"><small>ELEMENTO SELECIONADO</small><code>{selectedLabel}</code>{selected?.dimensions && <em>{selected.dimensions.width} × {selected.dimensions.height}px</em>}</div>
        <nav className="inspector-full-tabs">{(["element", "styles", "changes", "chat", "history"] as InspectorTab[]).map((item) => <button key={item} className={tab === item ? "active" : ""} onClick={() => setTab(item)}>{item === "element" ? "Elemento" : item === "styles" ? "Estilos" : item === "changes" ? `Alterações${pendingChanges.length + (markupDirty ? 1 : 0) ? ` (${pendingChanges.length + (markupDirty ? 1 : 0)})` : ""}` : item === "chat" ? "Conversar com IA" : `Histórico${workspaceHistory.length ? ` (${workspaceHistory.length})` : ""}`}</button>)}</nav>
        <main className="inspector-full-content">
          <section className="inspector-full-source"><div><small>SOURCE TARGET</small><p>A origem é resolvida automaticamente a partir do seletor DOM.</p></div><code className="inspector-full-source-path">{source?.path || source?.markupPath || (selected ? "Procurando arquivo…" : "Selecione um elemento")}</code><input value={source?.selector ?? selected?.selector ?? ""} readOnly placeholder=".primary-button" /></section>
          {tab === "element" && <section className="inspector-full-section"><div className="inspector-full-section-title"><h3>Árvore DOM</h3><span>{selected ? "SELECIONADO" : "SELECIONE UM NÓ"}</span></div><div className="inspector-dom-tree">{treeRoot ? renderDomNode(treeRoot) : <div className="inspector-full-empty">Clique em <b>Selecionar</b> e escolha um elemento para abrir a árvore.</div>}</div><div className="inspector-full-card"><code>{selected ? `<${selected.tag}>` : "Nenhum elemento selecionado"}</code><p>{selected?.text || "Selecione um nó na árvore ou diretamente na página."}</p>{selected?.dimensions && <div className="inspector-full-metrics"><span>width <b>{selected.dimensions.width}px</b></span><span>height <b>{selected.dimensions.height}px</b></span></div>}</div><div className="inspector-full-markup-fields"><label><span>Tag HTML</span><input value={markupTag} onChange={(event) => updateMarkup("tag", event.target.value)} placeholder="h1" disabled={!selected} /></label><label><span>Texto</span><textarea value={markupText} onChange={(event) => updateMarkup("text", event.target.value)} placeholder="Texto do elemento" disabled={!selected} /></label><label><span>Link href</span><input value={markupHref} onChange={(event) => updateMarkup("href", event.target.value)} placeholder="https://…" disabled={!selected || !(selected.node instanceof HTMLAnchorElement)} /></label></div></section>}
          {tab === "styles" && <section className="inspector-full-section"><div className="inspector-full-section-title"><h3>Computed styles</h3><span>PREVIEW</span></div>{selected ? previewProperties.map(({ key, label }) => <label className="inspector-full-style" key={key}><code>{label}</code><input value={currentStyles[key]} onChange={(event) => updateStyle(key, event.target.value)} /></label>) : <div className="inspector-full-empty">Clique em <b>Selecionar</b> e depois em qualquer elemento da página.</div>}<p className="inspector-full-hint">Edite qualquer valor para atualizar o preview instantaneamente. Nada é gravado sem sua ação.</p></section>}
          {tab === "changes" && <section className="inspector-full-section"><div className="inspector-full-section-title"><h3>Alterações pendentes</h3><span>{pendingChanges.length + (markupDirty ? 1 : 0)} edits</span></div>{pendingChanges.length === 0 && !markupDirty ? <div className="inspector-full-empty">Tudo sincronizado no preview.</div> : <>{markupDirty && <div className="inspector-full-change"><code>markup / texto / tag / href</code><span>DOM → <b>modificado</b></span></div>}{pendingChanges.map((change) => <div className="inspector-full-change" key={change.key}><code>{change.label}</code><span>{change.before || "—"} → <b>{change.after}</b></span></div>)}<button className="inspector-full-primary" onClick={() => void persistChanges()}>Salvar no workspace</button></>}</section>}
          {tab === "history" && <section className="inspector-full-section"><div className="inspector-full-section-title"><h3>Histórico do workspace</h3><span>{workspaceHistory.length} eventos</span></div>{workspaceHistory.length === 0 ? <div className="inspector-full-empty">As gravações feitas pelo Inspector aparecerão aqui.</div> : <div className="inspector-full-history">{workspaceHistory.map((event) => <article className={`inspector-full-history-item ${event.status}`} key={event.id}><div className="inspector-full-history-icon">{event.status === "success" ? "✓" : "!"}</div><div className="inspector-full-history-body"><strong>{event.message}</strong><code>{event.path}</code><small>{event.kind} · {new Date(event.timestamp).toLocaleString()}</small></div></article>)}</div>}<button className="inspector-full-secondary" onClick={() => setWorkspaceHistory([])} disabled={workspaceHistory.length === 0}>Limpar histórico</button></section>}
          {tab === "chat" && <section className="inspector-full-section inspector-full-chat"><div className="inspector-full-chat-context">Contexto ativo · <code>{selectedLabel}</code></div><div className="inspector-full-messages">{messages.map((item, index) => <div className={`inspector-full-message ${item.role}`} key={`${item.role}-${index}`}><small>{item.role === "user" ? "Você" : "Prism AI"}</small><p>{item.text}</p>{item.suggestions?.map((suggestion) => <div className="inspector-full-suggestion" key={`${suggestion.selector}-${suggestion.property}`}><div><code>{suggestion.property}: {suggestion.before ?? "—"} → {suggestion.after}</code><small>{suggestion.path} · {suggestion.selector}</small></div><button onClick={() => applySuggestion(suggestion)}>Aplicar no preview</button></div>)}</div>)}</div><div className="inspector-full-input"><input value={message} onChange={(event) => setMessage(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void askAi(); }} placeholder={pending ? "Consultando a IA…" : selected ? "Pergunte sobre este elemento" : "Selecione um elemento primeiro"} disabled={pending || !selected} /><button onClick={() => void askAi()} disabled={pending || !selected}>↑</button></div></section>}
        </main>
        <footer className="inspector-full-footer"><span><i /> {workspace ? "API: workspace conectado" : "Preview local"}</span><span>{ai ? "IA pronta" : "IA não configurada"}</span></footer>
      </aside>}
      <button className="inspector-full-trigger" onClick={() => setOpen((value) => !value)} aria-label={open ? "Fechar Inspector" : "Abrir Inspector"}>✦</button>
      {toast && <div className="inspector-full-toast">✓ {toast}</div>}
      {attributeToRemove && <div className="inspector-confirm-backdrop" role="presentation" onClick={() => setAttributeToRemove(null)}><div className="inspector-confirm-modal" role="dialog" aria-modal="true" aria-labelledby="inspector-remove-title" onClick={(event) => event.stopPropagation()}><h3 id="inspector-remove-title">Remover atributo?</h3><p>O atributo <code>{attributeToRemove.name}</code> será removido do preview. A alteração só será gravada no workspace quando você salvar.</p><div className="inspector-confirm-actions"><button className="inspector-confirm-cancel" onClick={() => setAttributeToRemove(null)}>Cancelar</button><button className="inspector-confirm-danger" onClick={confirmRemoveAttribute}>Remover</button></div></div></div>}
    </div>
  </>;
}
