import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

/**
 * Estado de navegação do app: qual tela do menu está ativa e se o painel
 * lateral do celular está aberto. Vive no `app/` porque é o único estado que
 * atravessa a casca (`app/router.jsx`, que desenha o menu) e a página que
 * renderiza a tela (`pages/manager`) — os dois são irmãos, sem relação de
 * pai e filho, então não dá para passar por prop.
 *
 * A tela ativa persiste em `sessionStorage` por papel: com a sidebar sempre
 * visível, voltar para "Comandas" a cada F5 seria um passo atrás desnecessário
 * — e a sessão já vive no `sessionStorage`, então nada sobrevive à aba fechada.
 */
const NavContext = createContext(null);

const storageKey = (role) => `pdv:nav:${role}`;

function readStored(role) {
  try {
    return sessionStorage.getItem(storageKey(role));
  } catch {
    return null;
  }
}

export function NavProvider({ role, children }) {
  const [activeId, setActiveState] = useState(() => readStored(role));
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Trocar de usuário/papel não pode herdar a tela (nem o painel) do outro.
  useEffect(() => {
    setActiveState(readStored(role));
    setDrawerOpen(false);
  }, [role]);

  // Escolher uma tela no menu fecha o painel do celular — lá o menu cobre a
  // tela inteira, então deixar aberto esconde justamente o que foi escolhido.
  const setActiveId = useCallback(
    (id) => {
      setActiveState(id);
      setDrawerOpen(false);
      try {
        sessionStorage.setItem(storageKey(role), id);
      } catch {
        /* aba anônima sem storage: a navegação funciona, só não persiste */
      }
    },
    [role]
  );

  const value = useMemo(
    () => ({
      activeId,
      setActiveId,
      drawerOpen,
      openDrawer: () => setDrawerOpen(true),
      closeDrawer: () => setDrawerOpen(false),
    }),
    [activeId, setActiveId, drawerOpen]
  );

  return <NavContext.Provider value={value}>{children}</NavContext.Provider>;
}

export function useNav() {
  const ctx = useContext(NavContext);
  if (!ctx) throw new Error("useNav precisa estar dentro de <NavProvider>");
  return ctx;
}
