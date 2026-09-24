# @inspector/react

Devtools React completo para inspeção de elementos, preview de CSS, histórico de alterações, persistência opcional e conversa contextual com IA.

## Instalação

```bash
pnpm add @inspector/react
```

### Uso rápido

Para o caso comum, basta renderizar o componente ao lado da aplicação. Ele usa `import.meta.env.DEV` automaticamente, aponta para `/api/inspector/ai` e permanece desativado em produção. O drawer completo inclui as abas Elemento, Estilos, Alterações e Conversar com IA:

```tsx
import { InspectorDevTools } from "@inspector/react";

createRoot(document.getElementById("root")!).render(
  <>
    <App />
    <InspectorDevTools />
  </>,
);
```

Para SSR, use `ssr` para aguardar a hidratação:

```tsx
<InspectorDevTools ssr />
```

### Uso avançado

O provider continua disponível quando o projeto precisa controlar adapters e estado:

```tsx
import { InspectorProvider } from "@inspector/react";
import "@inspector/react/styles.css";

export function Root() {
  return (
    <InspectorProvider enabled={import.meta.env.DEV}>
      <App />
    </InspectorProvider>
  );
}
```

## Adapter de IA

O pacote não expõe tokens no navegador. Use um adapter que converse com o backend do host:

```tsx
import { createTrpcAiAdapter, InspectorProvider } from "@inspector/react";

const ai = createTrpcAiAdapter((input) => trpc.ai.chat.mutate(input));

<InspectorProvider enabled={import.meta.env.DEV} ai={ai}>
  <App />
</InspectorProvider>
```

Também existe `createHttpAiAdapter` para um gateway HTTP controlado pelo projeto host. Nesse caso, o gateway deve proteger o token e validar o contrato de resposta `{ message, suggestions }`.

## Filesystem via tRPC

Para conectar o drawer completo ao filesystem real sem expor caminhos ou credenciais no navegador, use `createTrpcWorkspaceAdapter` no host:

```tsx
const workspace = createTrpcWorkspaceAdapter({
  listFiles: () => trpc.workspace.listFiles.fetch(),
  readFile: (path) => trpc.workspace.readFile.fetch({ path }),
  previewPatch: (input) => trpc.workspace.previewPatch.mutate(input),
  writePatch: (input) => trpc.workspace.writePatch.mutate(input),
});

<InspectorProvider enabled={import.meta.env.DEV} ai={ai} workspace={workspace}>
  <App />
</InspectorProvider>
```

O router do host continua responsável por validar path traversal, extensões permitidas, hash esperado e modo de desenvolvimento. O Inspector aplica primeiro no preview; a gravação exige uma ação explícita do usuário.

## Funcionalidades

O provider captura hover e cliques em elementos com contorno visual, identifica seletor, dimensões e estilos computados, resolve automaticamente o arquivo CSS ou HTML/JSX/TSX correspondente no workspace, exibe o painel flutuante e permite editar estilos, texto, links e a tag do elemento apenas no preview. A gravação no disco deve continuar sendo feita pelo adapter server-side do projeto host, após revisão do diff. Não é necessário selecionar manualmente um arquivo local.

A opção `VITE_INSPECTOR_PACKAGE=true` habilita a instância de exemplo neste repositório. Em produção, mantenha `enabled={false}`.
