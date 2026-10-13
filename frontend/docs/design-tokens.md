# Design tokens — fonte única do tema

## Por que isso existe

Antes desta mudança o tema era "aleatório": ~1800 classes de cor hardcoded
(`bg-stone-900`, `text-amber-400`, …) espalhadas em ~90 arquivos, e as
variáveis em `:root` de `src/index.css` quase não eram usadas pelos
componentes. Consequência: trocar tema/cor/typografia exigia edição
arquivo por arquivo com risco de inconsistência.

Agora `src/index.css` mantém as variáveis de design em `:root` e as expõe
ao Tailwind via `@theme inline`, gerando utilitários semânticos estáveis.

## Tokens disponíveis (Tailwind utilities)

Cor (valores resolvem para as variáveis, trocáveis em um lugar só):

| Token                         | Valor        | Uso típico                      |
| ----------------------------- | ------------ | ------------------------------- |
| `bg-background`               | `--app-bg`   | fundo da página                  |
| `text-foreground`             | `--text-primary` | texto principal          |
| `bg-surface` / `bg-surface-raised` | `--surface-raised` | cards, painéis |
| `bg-surface-overlay`          | `--surface-overlay` | drawers/modais |
| `text-text-secondary`         | `--text-secondary` | texto secundário         |
| `text-text-muted`             | `--text-muted` | texto fraco, legendas          |
| `bg-primary` / `text-primary` | `--brand-accent` | ações principais, destaque |
| `text-primary-foreground`     | `--brand-accent-foreground` | texto sobre botão primário |
| `bg-primary-strong`           | `--brand-accent-strong` | hover/ênfase |
| `border-border` (utility)     | `--border-subtle` | bordas padrão |
| `bg-destructive` / `text-destructive` | `--status-danger` | erro/alerta |
| `bg-success` / `text-success` | `--status-success` | sucesso          |
| `bg-warning` / `text-warning`  | `--status-warning` | aviso               |
| `border-ring`/`outline-ring`   | `--brand-accent` | foco               |

Fontes: `font-sans` (Inter), `font-display` (Fredoka).

Helpers: `cn(...)` em `@/shared/lib` (clsx + tailwind-merge) e `cva` para
variantes de componentes (`Button` é o primeiro exemplo).

## Mapeamento legacy → token (migração gradual)

Ainda não executado em massa; faça por tela/PR:

- `bg-stone-950` (telas cheias) → `bg-background`
- `bg-stone-900` → `bg-surface`
- `bg-stone-800` → `bg-surface-overlay` (borda → `border-border`)
- `text-stone-50/100/200/300` → `text-foreground` (variantes de peso)
- `text-stone-400/500/600` → `text-text-secondary` / `text-text-muted`
- `bg-amber-500` / `text-amber-500` → `bg-primary` / `text-primary`
- `border-amber-500` → `border-ring`
- `bg-red-500` → `bg-destructive`
- `bg-emerald-500` → `bg-success`

## Regras

1. Componentes compartilhados usam **apenas** tokens (nunca `stone-*`/`amber-*`).
2. `pages`/`widgets` já estão migrados para tokens (verificação
   reversa: 107 utilitários de cor usados, todos gerados no CSS).
3. Toda nova cor/spacing/tipo passa por este arquivo (`:root` + `@theme`), não
   por classe ad-hoc.
4. Estilo visual (mudança de tema) = edição em `src/index.css`, não em N arquivos.

## Migração concluída

- [x] ~90 arquivos migrados de `stone-*`/`amber-*`/`red-*`/`emerald-*`
      para utilitários semânticos (`bg-surface`, `text-foreground`, …).
- [x] `Form.jsx` (inputClass/Section/Field/ToggleRow) via tokens.
- [x] CVA em componentes compartilhados (Button, Card, Badge, Input).
- [x] Exceções intencionais mantidas: `PrintReceipt.jsx` (cupom
      térmico preto/branco) e `PixQrScreen.jsx` (fundo branco do QR).
- [x] **Re-skin Cheempa aplicado**: paleta creme/marrom/dourado, fonte
      Fredoka (títulos) + Inter (corpo), radius lg=10/xl=14/2xl=18px,
      sidebar marrom com item ativo dourado. Tudo via `:root` + `@theme`.

## Pendente / próximos passos

- [ ] Revisão visual de contraste tela a tela (dourado sobre creme, etc.).
- [ ] Tokens de spacing/radius expostos como tokens (hoje via Tailwind scale).
- [ ] Revisar `color-scheme` e prefers-contrast em componentes com
      contraste borderline.

## UI kit (iniciativa B)

Construídos com os tokens acima + `cn`/`cva`. Preferir em vez de copiar variantes locais:
- `Button` (+ `buttonVariants`) — primary/secondary/danger/ghost × sm/md/lg
- `Card` (+ `cardVariants`) — superfície/padding padronizados (tone, padding)
- `Badge` (+ `badgeVariants`) — tom por tipo: default/primary/success/warning/danger/muted
- `Input`, `Textarea` — campo padrão com estado `invalid`
- `Form.jsx`: `inputClass`, `Section`, `Field`, `ToggleRow` (agora via tokens)

Migração gradual dos wrappers em `pages`/`widgets`: substituir blocos de `div + classes stone/amber` por esses componentes.

## Storybook e contribuição

O catálogo de componentes usa Storybook 10 com React/Vite e é executado na
pasta `frontend/`:

- `npm run storybook`: desenvolvimento em `http://localhost:6006`.
- `npm run build-storybook`: gera `storybook-static/` para publicação estática.
- `.storybook/preview.jsx` carrega `src/index.css`, de forma que as histórias
  usam os mesmos tokens, tema de marca e utilities Tailwind da aplicação.
- As histórias `*.stories.jsx` ficam próximas aos componentes compartilhados;
  documente variantes, estados disabled/invalid e um exemplo contextual quando
  isso ajudar quem consome o componente. Não dependa de API, sessão ou dados
  privados nos exemplos.
- Os add-ons Docs e A11y estão habilitados. O painel de acessibilidade reporta
  violações como erros durante a validação automatizada do Storybook.

A visão geral dos princípios e cores está em
`src/shared/components/DesignSystem.mdx`; o README do frontend documenta o
fluxo de contribuição.

## Tema claro e escuro

O app oferece os esquemas `light` (padrão) e `dark` por meio do controle
`ThemeToggle`, visível no cabeçalho do app e na tela de login. A escolha fica
salva no `localStorage` (`pdv:color-scheme`) neste dispositivo e é aplicada no
elemento raiz (`data-theme`) antes do primeiro paint. O modo escuro redefine os
tokens semânticos em `src/index.css`; a cor de marca escolhida pela loja é
mantida nos dois modos. O Storybook oferece a mesma alternância na toolbar do
canvas.
