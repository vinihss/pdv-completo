# Convenções do frontend

Este frontend usa React + Vite, JSX, Tailwind CSS 4 e a organização Feature-Sliced Design descrita em `src/features/README.md`. Os documentos deste diretório são a referência prática para alterações novas.

## Direção das dependências

```text
app → pages → widgets → features → entities → shared
```

- Cada camada importa apenas as camadas abaixo; `shared` não depende do domínio.
- Uma página não importa outra página. Elementos usados por mais de uma página podem virar `widgets`; primitives sem vocabulário de negócio pertencem a `shared/components`.
- Use os barrels públicos (`index.js`) das camadas/domínios. Mantenha os barrels sincronizados com os exports.
- Use o alias `@/` para imports a partir de `src/`.
- API de domínio fica em `entities/<domínio>/api`; `shared/api/http.js` é a infraestrutura comum.
- Mutações esperam a resposta do servidor e atualizam os dados autoritativos; WebSocket serve para refresh direcionado.

## Linguagem visual

- A escala base é escura: fundo `stone-950`, superfícies `stone-900/800`, bordas `stone-800/700` e texto claro. Amber identifica a ação principal; verde, sucesso/pronto; amarelo, atenção; vermelho, erro/urgência.
- Os tokens semânticos do shell estão em `src/index.css` (`--app-bg`, `--surface-raised`, `--border-subtle`, `--text-*` e `--status-*`). Ao introduzir uma cor global, prefira um token a um novo hexadecimal espalhado.
- A cor principal da marca é configurável pela loja através de `src/shared/lib/theme.js`; não substitua os utilitários amber por outra paleta sem preservar essa personalização.
- Reutilize `Button`, `PageHeader`, `ScreenHeader`, `Modal`, `ConfirmModal`, `Drawer`, `Section` e `EmptyState` em vez de copiar variantes locais.
- `PageHeader` é o título do conteúdo; o cabeçalho global pertence à casca em `app/router.jsx`. `ScreenHeader` é para uma tela de fluxo com navegação de retorno.
- Listas devem distinguir carregamento, erro, conteúdo e ausência de dados. Use mensagens úteis e uma ação seguinte quando existir.
- Formulários e ações tocáveis precisam de estados hover, focus-visible e disabled discerníveis. Não remova foco de teclado sem uma alternativa acessível.
- Respeite `prefers-reduced-motion`, layouts estreitos e tablets de operação. Mantenha alvos táteis confortáveis e evite depender somente da cor para comunicar estado.

## Onde colocar código

| Responsabilidade | Local |
|---|---|
| Inicialização, router e providers | `src/app/` |
| Tela por perfil/rota | `src/pages/<perfil>/` |
| Bloco composto reutilizado por mais de uma tela | `src/widgets/<bloco>/` |
| Fluxo de ação com estado próprio | `src/features/<ação>/` |
| Conceito de negócio, modelo, API ou UI de domínio | `src/entities/<domínio>/` |
| Primitive, hook, utilidade ou infraestrutura sem domínio | `src/shared/` |

## Checklist de uma alteração de UI

1. Verifique se já existe um componente equivalente em `shared/components` ou `widgets`.
2. Confira que a tela funciona com teclado, leitor de tela e conteúdo vazio/loading/erro.
3. Teste pelo menos a largura estreita e a largura de tablet/desktop apropriada ao perfil.
4. Prefira classes e tokens já existentes; se criar um padrão reutilizável, atualize o barrel e os testes.
5. Rode `npm run lint`, `npm run test` e `npm run build`.
6. Atualize `docs/agent-frontend-map.md` se a rota/perfil ou sua responsabilidade mudou.
