import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

/**
 * Estado de navegação do app: qual tela do menu está ativa e se o painel
 * lateral do celular está aberto. Vive no `app/` porque é o único estado que
 * atravessa a casca (`app/router.jsx`, que desenha o menu) e a página que
 * renderiza a tela (`pages/manager`) — os dois são irmãos, sem relação de
 * pai e filho, então não dá para passar por prop.
 *
 * A tela ativa persiste em `sessionStorage` por papel — a seleção sobrevive a
 * um F5, mas nada sobrevive à aba fechada. A migração abaixo troca uma única
 * vez o antigo padrão do gerente ("orders") pela nova Home.
 */
const NavContext = createContext(null);

const storageKey = (role) => `pdv:nav:${role}`;
const managerHomeMigrationKey = "pdv:nav:manager:home-migrated";

function readStored(role) {
  try {
    const key = storageKey(role);
    const stored = sessionStorage.getItem(key);
    if (role === "manager" && sessionStorage.getItem(managerHomeMigrationKey) !== "true") {
      sessionStorage.setItem(managerHomeMigrationKey, "true");
      if (stored === "orders") {
        sessionStorage.setItem(key, "home");
        return "home";
      }
    }
    return stored;
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
