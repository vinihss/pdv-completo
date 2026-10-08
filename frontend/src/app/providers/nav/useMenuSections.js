import { useMemo } from "react";
import { useAuth } from "@/app/providers/auth";
import { menuSectionsFor } from "./menuSections.js";

/**
 * Seções do menu do papel logado, já filtradas pelos toggles de store.
 *
 * Fonte única da "contagem de itens": quem decide se o menu existe (o AppMenu
 * some com 1 item) e quem decide se o botão de menu do header aparece (o
 * AppFrame) precisam da mesma conta — com lógicas separadas, um toggle novo
 * de store desenharia o botão e esconderia o painel (ou vice-versa).
 */
export function useMenuSections() {
  const { session, storeSettings } = useAuth();
  return useMemo(
    () =>
      menuSectionsFor(session?.user?.role, {
        inventoryEnabled: storeSettings?.inventoryEnabled ?? false,
        purchaseEnabled: storeSettings?.purchaseEnabled ?? false,
        ifoodIntegrationEnabled: storeSettings?.ifoodIntegrationEnabled ?? false,
      }),
    [
      session?.user?.role,
      storeSettings?.inventoryEnabled,
      storeSettings?.purchaseEnabled,
      storeSettings?.ifoodIntegrationEnabled,
    ]
  );
}
