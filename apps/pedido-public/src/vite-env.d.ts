/// <reference types="vite/client" />

// Tipos do `import.meta.env` (`VITE_API_BASE_URL`, `VITE_DEV_TENANT_HOST`) e
// das importações de CSS (`import '../styles.css'`). Sem esta referência o
// `tsc -b` reprova as duas coisas: `Property 'env' does not exist on type
// 'ImportMeta'` e `Cannot find module '../styles.css'`.