# Testes e validação do frontend

## Instalação

O projeto usa **npm** e mantém `package-lock.json` como lockfile oficial. Em checkout limpo:

```bash
npm ci
```

Node.js 20+ é necessário; o backend de desenvolvimento deve estar disponível em `localhost:3000` para fluxos que consultam a API.

## Comandos

```bash
npm run lint       # oxlint
npm run test       # Vitest + Testing Library (jsdom)
npm run build      # build multi-entry padrão
npm run build:kds  # exemplo de build isolado por perfil
```

`npm run test` inclui testes de comportamento de componentes e páginas, limites FSD em `src/__tests__/fsd-boundaries.test.js` e configurações de perfil em `vite/`.

## Boas práticas de testes

- Coloque o teste junto ao módulo como `Nome.test.jsx` ou `Nome.test.js`.
- Teste o comportamento visível e acessível (`getByRole`, nome do botão/campo, mensagens de estado), não a implementação interna.
- Cubra interações principais, disabled/loading, erro e ausência de conteúdo sempre que aplicável.
- Ao mockar um barrel de entity, preserve os exports reais e substitua apenas a função necessária:

```js
vi.mock("@/entities/cart", async (importOriginal) => ({
  ...(await importOriginal()),
  getPublicCart: () => Promise.resolve(null),
}));
```

## Revisão visual manual

Com o backend em execução:

```bash
npm run dev
```

Verifique ao menos o perfil afetado em uma viewport estreita (aprox. 360–390 px) e em tablet/desktop. Revise foco visível, contraste, texto longo, rolagem, estados vazio/carregando/erro e a preferência de movimento reduzido. Para a cozinha e o garçom, faça a revisão em uma viewport/touch próxima ao dispositivo operacional. A aplicação usa quatro entradas; confirme que a mudança não afeta outras entradas nem a identidade configurável da loja.
