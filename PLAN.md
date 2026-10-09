# Plano de Melhorias UI/UX

Branch: `feat/ui-ux-improvements`

## Resumo dos Ajustes

| # | Ajuste | Prioridade | Complexidade | Arquivo Principal |
|---|--------|------------|--------------|-------------------|
| 1 | Reposicionar bolinha verde de status | Média | Baixa | `widgets/alert-bell/AlertBell.jsx` |
| 2 | Melhorar upload de foto no perfil | Alta | Média | `pages/manager/tabs/profile/ProfilePage.jsx` |
| 3 | Ajustar listagem de equipe | Alta | Média | `pages/manager/tabs/users/UsersTab.jsx` |
| 4 | Reorganizar página de configurações | Alta | Alta | `pages/manager/tabs/settings/SettingsTab.jsx` |
| 5 | Corrigir foto do usuário no header | Crítica | Baixa | `app/router.jsx` |
| 6 | Melhorar hierarquia visual do menu | Alta | Alta | `shared/components/AccordionMenu.jsx` |

---

## Ajuste 1: Reposicionar Bolinha Verde de Status

**Problema:** A bolinha verde (`ConnectionLed`) está posicionada no canto inferior esquerdo do sino (`absolute -bottom-0.5 -left-0.5`), o que pode ficar estranho visualmente.

**Arquivo:** `frontend/src/widgets/alert-bell/AlertBell.jsx`

**Solução Proposta:**
- Mover para o canto superior direito (padrão de badges/notificações)
- Posição: `absolute -top-0.5 -right-0.5`
- Reduzir tamanho ligeiramente: `w-2.5 h-2.5`

**Código Atual (linhas 39-48):**
```jsx
function ConnectionLed({ online }) {
  return (
    <span
      aria-hidden="true"
      className="absolute -bottom-0.5 -left-0.5 w-3 h-3 rounded-full border-2 border-stone-900"
      style={{ backgroundColor: online ? "#22c55e" : "#ef4444", transition: "background-color 150ms ease" }}
      title={online ? "Conectado ao servidor" : "Sem conexao com o servidor"}
    />
  );
}
```

**Código Proposto:**
```jsx
function ConnectionLed({ online }) {
  return (
    <span
      aria-hidden="true"
      className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-stone-900"
      style={{ backgroundColor: online ? "#22c55e" : "#ef4444", transition: "background-color 150ms ease" }}
      title={online ? "Conectado ao servidor" : "Sem conexao com o servidor"}
    />
  );
}
```

**Alternativas Consideradas:**
- Posicionar abaixo do sino (como agora) - não é padrão
- Usar um tooltip mais elaborado - excessivo para um indicador simples
- Remover o LED - perderia informação visual importante

**Testes:** Nenhum teste existente cobre posicionamento visual. Verificar manualmente em desktop e mobile.

---

## Ajuste 2: Melhorar Upload de Foto no Perfil

**Problema:** 
1. O `ProfilePage.jsx` usa um `<input type="file">` cru com estilo, diferente do `PhotoBlock` do `UserModal.jsx` (que tem botão com ícone de câmera sobre o avatar)
2. A página muda a URL para `/manager/profile` (intencional - é uma rota standalone fora do NavProvider/AlertsProvider)

**Arquivo:** `frontend/src/pages/manager/tabs/profile/ProfilePage.jsx`

**Solução Proposta:**

### 2.1. Reutilizar PhotoBlock
- Extrair `PhotoBlock` do `UserModal.jsx` para um componente compartilhado em `shared/components/PhotoUpload.jsx`
- Usar no `ProfilePage.jsx` e `UserModal.jsx`

**Passos:**
1. Criar `frontend/src/shared/components/PhotoUpload.jsx`
2. Extrair lógica do `PhotoBlock` (linhas 12-43 do `UserModal.jsx`)
3. Atualizar imports em `UserModal.jsx` e `ProfilePage.jsx`
4. Substituir o input cru do `ProfilePage.jsx` (linhas 152-165) pelo `PhotoUpload`

### 2.2. Sobre a Mudança de URL
**Não é um bug, é intencional.** O código tem comentário explícito (router.jsx linhas 216-217):
> "Perfil do usuário logado: página standalone dentro do AuthProvider (usa useAuth/useNavigate; não precisa de NavProvider/AlertsProvider)."

**Razão:** A página de perfil não precisa do menu lateral nem dos alertas, então é renderizada fora do `AppFrame`.

**Alternativas (se quiser manter o header):**
- Renderizar `ProfilePage` dentro do `AppFrame` (mas perde a simplicidade atual)
- Adicionar um `ScreenHeader` com botão "Voltar" (já tem - linha 129)

**Recomendação:** Manter como está. O `ScreenHeader` com `onBack={() => navigate(-1)}` já resolve a navegação.

### 2.3. Bug no handleRemovePhoto
**Problema:** Linha 118 referencia `e` que não está no escopo:
```jsx
await handleSave(e); // 'e' não existe aqui
```

**Correção:** Remover a chamada a `handleSave` ou passar um evento dummy:
```jsx
async function handleRemovePhoto() {
  setPhotoBusy(true);
  try {
    await removeUserMePhoto();
    setPhotoPath(null);
    // Não precisa salvar novamente - o photoPath já foi atualizado
  } catch (err) {
    const msg = err?.message ?? "Não foi possível remover a foto.";
    setFeedback({ kind: "error", text: msg });
  } finally {
    setPhotoBusy(false);
  }
}
```

**Testes:** `ProfilePage.test.jsx` - adicionar teste para upload e remoção de foto.

---

## Ajuste 3: Ajustar Listagem de Equipe

**Problemas:**
1. Não tem pesquisa/filtro por perfil
2. Botão "Desativar" é texto, deve ser ícone
3. Verificar placeholders (alt) e cursor pointer

**Arquivo:** `frontend/src/pages/manager/tabs/users/UsersTab.jsx`

**Solução Proposta:**

### 3.1. Adicionar Filtro por Perfil
```jsx
const [filterRole, setFilterRole] = useState("all");

const filteredUsers = filterRole === "all" 
  ? users 
  : users.filter(u => u.role === filterRole);
```

**UI:**
```jsx
<select 
  value={filterRole} 
  onChange={(e) => setFilterRole(e.target.value)}
  className={inputClass}
>
  <option value="all">Todos os perfis</option>
  <option value="waiter">Garçons</option>
  <option value="kitchen">Cozinha</option>
  <option value="manager">Gerentes</option>
  <option value="cashier">Caixa</option>
  <option value="courier">Entregadores</option>
</select>
```

### 3.2. Trocar "Desativar" por Ícone
**Imports:**
```jsx
import { Pencil, Plus, RefreshCcw, UserX, UserCheck } from "lucide-react";
```

**Botão (linha 72-74):**
```jsx
<button 
  onClick={() => handleToggleActive(u)} 
  className="text-stone-500 hover:text-amber-400 cursor-pointer"
  title={u.active ? "Desativar usuário" : "Ativar usuário"}
  aria-label={u.active ? `Desativar ${u.name}` : `Ativar ${u.name}`}
>
  {u.active ? <UserX size={15} /> : <UserCheck size={15} />}
</button>
```

### 3.3. Verificar Acessibilidade
- **UserAvatar:** Já tem `alt={name}` ✓ (linha 59)
- **Cursor pointer:** Adicionar `cursor-pointer` em todos os botões de ação:
  - Editar (linha 66) - já tem `hover:text-amber-400`, adicionar `cursor-pointer`
  - Redefinir PIN (linha 69) - adicionar `cursor-pointer`
  - Ativar/Desativar (linha 72) - adicionar `cursor-pointer`

**Código Completo Proposto:**
```jsx
<div className="flex items-center gap-3 shrink-0">
  <button 
    onClick={() => setEditing(u)} 
    title="Editar usuário" 
    aria-label={`Editar ${u.name}`} 
    className="text-stone-500 hover:text-amber-400 cursor-pointer"
  >
    <Pencil size={15} />
  </button>
  <button 
    onClick={() => handleResetPin(u)} 
    className="text-stone-500 hover:text-amber-400 cursor-pointer" 
    title="Redefinir PIN" 
    aria-label={`Redefinir PIN de ${u.name}`}
  >
    <RefreshCcw size={15} />
  </button>
  <button 
    onClick={() => handleToggleActive(u)} 
    className="text-stone-500 hover:text-amber-400 cursor-pointer"
    title={u.active ? "Desativar usuário" : "Ativar usuário"}
    aria-label={u.active ? `Desativar ${u.name}` : `Ativar ${u.name}`}
  >
    {u.active ? <UserX size={15} /> : <UserCheck size={15} />}
  </button>
</div>
```

**Testes:** `UsersTab.test.jsx` - adicionar teste para filtro por perfil.

---

## Ajuste 4: Reorganizar Página de Configurações

**Problemas:**
1. Tudo em uma coluna só (`max-w-lg mx-auto`) - muito longo
2. Logo tem botão "Enviar" separado, deveria ser o próprio logo

**Arquivo:** `frontend/src/pages/manager/tabs/settings/SettingsTab.jsx`

**Solução Proposta:**

### 4.1. Layout com Sidebar de Navegação
**Desktop (lg+):**
```
┌─────────────┬──────────────────────────────┐
│ Menu        │ Conteúdo da Seção            │
│ ─────────   │                              │
│ • Identidade│                              │
│ • Operação  │                              │
│ • Impressão │                              │
│ • Entrega   │                              │
│ • Pagamento │                              │
│ • Pix       │                              │
│ • App       │                              │
└─────────────┴──────────────────────────────┘
```

**Mobile:** Accordion ou tabs horizontais

**Estrutura Proposta:**
```jsx
const [activeSection, setActiveSection] = useState("identity");

const sections = [
  { id: "identity", label: "Identidade", icon: Store },
  { id: "operation", label: "Operação", icon: UtensilsCrossed },
  { id: "printer", label: "Impressão", icon: Printer },
  { id: "delivery", label: "Entrega", icon: Truck },
  { id: "payment", label: "Pagamento", icon: CreditCard },
  { id: "pix", label: "Pix", icon: QrCode, condition: form.enabledPaymentMethods.includes("pix") },
  { id: "app", label: "App", icon: Monitor, condition: isDesktop() },
];
```

**Layout:**
```jsx
<div className="flex gap-6 p-5">
  {/* Sidebar */}
  <aside className="hidden lg:block w-48 shrink-0">
    <nav className="space-y-1">
      {sections.filter(s => s.condition !== false).map(section => (
        <button
          key={section.id}
          onClick={() => setActiveSection(section.id)}
          className={`w-full flex items-center gap-2 px-3 py-2 rounded-xl text-sm transition-colors ${
            activeSection === section.id
              ? "bg-amber-500 text-stone-950 font-semibold"
              : "text-stone-400 hover:text-stone-100 hover:bg-stone-800/60"
          }`}
        >
          <section.icon size={15} />
          {section.label}
        </button>
      ))}
    </nav>
  </aside>

  {/* Conteúdo */}
  <div className="flex-1 max-w-2xl space-y-6">
    {/* Renderizar seção ativa */}
    {activeSection === "identity" && <IdentitySection form={form} set={set} ... />}
    {activeSection === "operation" && <OperationSection form={form} set={set} ... />}
    {/* ... */}
  </div>
</div>
```

### 4.2. Logo como Botão de Upload
**Reutilizar PhotoUpload** (criado no Ajuste 2):

```jsx
<Field label="Logo do restaurante">
  <div className="relative inline-block">
    {displayLogo ? (
      <img 
        src={displayLogo} 
        alt="Logo do restaurante" 
        className="w-20 h-20 rounded-xl object-cover border-2 border-stone-700 cursor-pointer hover:border-amber-500 transition-colors"
        onClick={() => logoInputRef.current?.click()}
      />
    ) : (
      <button
        type="button"
        onClick={() => logoInputRef.current?.click()}
        className="w-20 h-20 rounded-xl bg-stone-800 border-2 border-dashed border-stone-700 flex items-center justify-center text-stone-600 hover:border-amber-500 hover:text-amber-500 transition-colors cursor-pointer"
      >
        <Store size={24} />
      </button>
    )}
    <input
      ref={logoInputRef}
      type="file"
      accept="image/jpeg,image/png,image/webp"
      className="hidden"
      onChange={handleLogoFile}
    />
  </div>
  {displayLogo && (
    <button 
      onClick={handleRemoveLogo} 
      className="ml-3 text-red-400 hover:text-red-300 text-sm"
    >
      Remover
    </button>
  )}
</Field>
```

**Alternativa:** Usar o `PhotoUpload` compartilhado (se criado no Ajuste 2).

**Testes:** `SettingsTab.test.jsx` (se existir) - testar navegação entre seções.

---

## Ajuste 5: Corrigir Foto do Usuário no Header

**Problema:** A foto do usuário não aparece no header porque usa `session.user.photoPath` diretamente, sem passar por `assetUrl()`.

**Arquivo:** `frontend/src/app/router.jsx`

**Bug:** Linhas 122-132 e 141-146 usam `<img src={session.user.photoPath} ...>` diretamente.

**Solução:** Usar o componente `UserAvatar` (que já faz `assetUrl()` internamente):

```jsx
import { UserAvatar } from "@/shared/components";

// Linha 122-132:
<button
  type="button"
  onClick={() => setProfileMenuOpen((v) => !v)}
  aria-label="Menu do usuário"
  aria-expanded={profileMenuOpen}
  aria-haspopup="true"
  title="Menu do usuário"
  className="w-10 h-10 -mr-1 flex items-center justify-center rounded-full hover:bg-stone-800/60 transition-colors"
>
  <UserAvatar 
    name={session?.user?.name} 
    photoPath={session?.user?.photoPath} 
    className="w-8 h-8"
  />
</button>

// Linha 141-146 (dentro do menu flutuante):
<UserAvatar 
  name={session?.user?.name} 
  photoPath={session?.user?.photoPath} 
  className="w-8 h-8 shrink-0"
/>
```

**Por que funciona:**
- `UserAvatar` (shared/components/UserAvatar.jsx linha 38) usa `assetUrl(photoPath)`
- `assetUrl()` (shared/lib/server.js linha 100) converte path relativo em URL absoluta
- Ex: `/uploads/photos/user-123.jpg` → `http://localhost:3000/uploads/photos/user-123.jpg`

**Testes:** `router.test.jsx` - já testa o header (linha 38-46), verificar se a foto aparece.

---

## Ajuste 6: Melhorar Hierarquia Visual do Menu

**Problema:** Os ícones estão no mesmo nível visual, dificultando a identificação rápida de seções vs itens.

**Arquivos:** 
- `frontend/src/shared/components/AccordionMenu.jsx`
- `frontend/src/app/providers/nav/menuSections.js`

**Solução Proposta:**

### 6.1. Diferenciar Seções de Itens
**Seções (cabeçalhos expansíveis):**
- Texto em uppercase, menor, com cor mais clara
- Ícone menor
- Chevron à direita

**Itens (navegáveis):**
- Texto normal, cor mais escura
- Ícone maior
- Sem chevron (exceto se tiver submenu)

**Código Atual (AccordionMenu.jsx linhas 97-115):**
```jsx
<button
  type="button"
  onClick={() => onToggleSection(section.id)}
  aria-expanded={isOpen}
  aria-controls={`menu-section-${section.id}`}
  className="w-full flex items-center gap-2 rounded-xl px-3 py-2 text-stone-500 hover:text-stone-200 hover:bg-stone-800/40 transition-colors"
>
  <section.icon size={13} className="shrink-0" />
  <span className="text-[11px] font-bold uppercase tracking-wider truncate text-left">{section.label}</span>
  {/* ... */}
</button>
```

**Código Proposto:**
```jsx
<button
  type="button"
  onClick={() => onToggleSection(section.id)}
  aria-expanded={isOpen}
  aria-controls={`menu-section-${section.id}`}
  className="w-full flex items-center gap-2 rounded-xl px-3 py-2 text-stone-500 hover:text-stone-200 hover:bg-stone-800/40 transition-colors"
>
  <section.icon size={12} className="shrink-0 opacity-60" />
  <span className="text-[10px] font-bold uppercase tracking-widest truncate text-left opacity-70">{section.label}</span>
  {/* ... */}
</button>
```

### 6.2. Destacar Itens Ativos
**Item ativo (linha 19-24):**
```jsx
className={`w-full flex items-center gap-2.5 rounded-xl px-3 py-2 text-sm transition-colors ${
  active ? "bg-amber-500 text-stone-950 font-semibold" : "text-stone-400 hover:text-stone-100 hover:bg-stone-800/60"
}`}
```

**Melhoria:** Adicionar indicador visual à esquerda (barra vertical):
```jsx
className={`w-full flex items-center gap-2.5 rounded-xl px-3 py-2 text-sm transition-colors relative ${
  active ? "bg-amber-500/10 text-amber-400 font-semibold border-l-2 border-amber-500" : "text-stone-400 hover:text-stone-100 hover:bg-stone-800/60"
}`}
```

### 6.3. Agrupar Visualmente Seções Relacionadas
**Ideia:** Adicionar espaçamento maior entre seções:
```jsx
<div key={section.id} className="mb-3">
  {/* conteúdo da seção */}
</div>
```

**Alternativa:** Adicionar separador visual (linha horizontal) entre seções:
```jsx
{index > 0 && <div className="border-t border-stone-800/50 my-2" />}
```

**Testes:** `AccordionMenu.test.jsx` - verificar renderização correta.

---

## Ordem de Execução

1. **Ajuste 5 (Crítica):** Corrigir foto do usuário no header - bug simples, alto impacto
2. **Ajuste 1 (Baixa):** Reposicionar bolinha verde - mudança mínima
3. **Ajuste 2 (Alta):** Melhorar upload de foto no perfil - requer criar componente compartilhado
4. **Ajuste 3 (Alta):** Ajustar listagem de equipe - filtro + ícones
5. **Ajuste 6 (Alta):** Melhorar hierarquia do menu - requer testes visuais
6. **Ajuste 4 (Alta):** Reorganizar configurações - mudança mais complexa

**Commits Sugeridos:**
```bash
git commit -m "fix: corrigir foto do usuário no header (usa UserAvatar)"
git commit -m "fix: reposicionar bolinha verde de status (canto superior direito)"
git commit -m "feat: criar componente PhotoUpload compartilhado"
git commit -m "feat: usar PhotoUpload no perfil e modal de usuário"
git commit -m "feat: adicionar filtro por perfil na listagem de equipe"
git commit -m "feat: trocar botão 'Desativar' por ícone na listagem de equipe"
git commit -m "feat: melhorar hierarquia visual do menu (seções vs itens)"
git commit -m "feat: reorganizar página de configurações com sidebar"
git commit -m "feat: usar o próprio logo como botão de upload"
```

---

## Validação

### Comandos
```bash
cd frontend
npm run lint    # oxlint
npm run build   # tsc
npm run test    # vitest
```

### Smoke Test Manual
1. Login como gerente
2. Verificar foto do usuário no header (Ajuste 5)
3. Verificar bolinha verde no sino (Ajuste 1)
4. Abrir menu do usuário → Perfil → testar upload de foto (Ajuste 2)
5. Voltar → Equipe → testar filtro e ícones (Ajuste 3)
6. Voltar → Configurações → testar navegação lateral (Ajuste 4)
7. Verificar hierarquia do menu lateral (Ajuste 6)

### Testes Unitários
- `router.test.jsx` - foto do usuário
- `ProfilePage.test.jsx` - upload de foto
- `UsersTab.test.jsx` - filtro por perfil
- `AccordionMenu.test.jsx` - hierarquia visual

---

## Riscos e Considerações

1. **Ajuste 2 (PhotoUpload):** Criar componente compartilhado pode quebrar outros usos. Testar `UserModal.jsx` e `CustomerModal.jsx` (se existir).

2. **Ajuste 4 (Configurações):** Mudança de layout pode afetar mobile. Testar em resoluções pequenas.

3. **Ajuste 6 (Menu):** Mudanças visuais podem afetar a percepção dos usuários. Considerar A/B test ou feedback.

4. **Ajuste 5 (Foto):** Se `session.user.photoPath` for nulo, `UserAvatar` mostra iniciais - comportamento correto.

5. **Performance:** Sidebar de configurações não deve afetar performance (é só CSS).

---

## Arquivos Afetados

| Arquivo | Tipo de Mudança |
|---------|-----------------|
| `frontend/src/widgets/alert-bell/AlertBell.jsx` | Modificar (posicionamento) |
| `frontend/src/pages/manager/tabs/profile/ProfilePage.jsx` | Modificar (upload + bug) |
| `frontend/src/pages/manager/tabs/users/UsersTab.jsx` | Modificar (filtro + ícones) |
| `frontend/src/pages/manager/tabs/settings/SettingsTab.jsx` | Refatorar (layout + logo) |
| `frontend/src/app/router.jsx` | Modificar (foto do usuário) |
| `frontend/src/shared/components/AccordionMenu.jsx` | Modificar (hierarquia) |
| `frontend/src/shared/components/PhotoUpload.jsx` | Criar (componente compartilhado) |
| `frontend/src/shared/components/index.js` | Modificar (exportar PhotoUpload) |

---

## Dependências

- Nenhum ajuste depende de backend
- Ajuste 2 (PhotoUpload) é pré-requisito para Ajuste 4 (logo)
- Todos os ajustes são independentes entre si (exceto 2→4)

---

## Estimativa de Tempo

| Ajuste | Tempo Estimado |
|--------|----------------|
| 1. Bolinha verde | 15 min |
| 2. Upload de foto | 1h |
| 3. Listagem equipe | 1h |
| 4. Configurações | 2h |
| 5. Foto no header | 15 min |
| 6. Menu | 1h |
| **Total** | **~5h 15min** |

---

## Próximos Passos

1. Revisar este plano com o usuário
2. Confirmar ordem de execução
3. Iniciar implementação (Ajuste 5 primeiro - bug crítico)
4. Testar cada ajuste antes de passar para o próximo
5. Abrir PR com todos os ajustes (ou PRs separados, se preferir)
