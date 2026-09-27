import { describe, it, expect } from "vitest";
import { menuSectionsFor, hasExpandableSections, firstItemId } from "./menuSections.js";

const labels = (sections) => sections.flatMap((s) => s.items.map((i) => `${s.label}/${i.label}`));

describe("menuSectionsFor", () => {
  it("gerente: 4 seções, 12 itens com estoque e compras ligados", () => {
    const sections = menuSectionsFor("manager", { inventoryEnabled: true, purchaseEnabled: true });
    expect(sections.map((s) => s.label)).toEqual(["Operação", "Catálogo", "Gestão", "Sistema"]);
    expect(sections.flatMap((s) => s.items)).toHaveLength(12);
  });

  it("gerente: os toggles de estoque e compras entram no catálogo", () => {
    expect(labels(menuSectionsFor("manager"))).toEqual([
      "Operação/Comandas", "Operação/Caixa", "Operação/Entregas", "Operação/iFood",
      "Operação/WhatsApp",
      "Catálogo/Cadastros",
      "Gestão/Equipe", "Gestão/Relatórios", "Gestão/Auditoria",
      "Sistema/Configurações",
    ]);
    const comEstoque = labels(menuSectionsFor("manager", { inventoryEnabled: true }));
    expect(comEstoque).toContain("Catálogo/Estoque");
    const comCompras = labels(menuSectionsFor("manager", { purchaseEnabled: true }));
    expect(comCompras).toContain("Catálogo/Compras");
  });

  it("mantém os ids que a página do gerente já usa", () => {
    const ids = menuSectionsFor("manager", { inventoryEnabled: true, purchaseEnabled: true })
      .flatMap((s) => s.items)
      .map((i) => i.id);
    expect(ids).toEqual(["orders", "cash", "deliveries", "ifood", "whatsapp", "catalog", "stock", "compras", "users", "reports", "audit", "settings"]);
  });

  it("perfis de tela única: uma seção com um item", () => {
    for (const [role, item, label] of [
      ["waiter", "orders", "Comandas"],
      ["kitchen", "kitchen", "Produção"],
      ["cashier", "cash", "Caixa"],
      ["courier", "deliveries", "Entregas"],
    ]) {
      const sections = menuSectionsFor(role);
      expect(sections).toHaveLength(1);
      expect(sections[0].items.map((i) => i.id)).toEqual([item]);
      expect(sections[0].items[0].label).toBe(label);
    }
  });

  it("papel desconhecido cai no menu do garçom (mesmo fallback da rota)", () => {
    expect(menuSectionsFor("system")).toEqual(menuSectionsFor("waiter"));
  });
});

describe("modo do menu", () => {
  it("só o gerente tem algo para expandir", () => {
    expect(hasExpandableSections(menuSectionsFor("manager"))).toBe(true);
    for (const role of ["waiter", "kitchen", "cashier", "courier"]) {
      expect(hasExpandableSections(menuSectionsFor(role))).toBe(false);
    }
  });

  it("firstItemId é o primeiro item da primeira seção", () => {
    expect(firstItemId(menuSectionsFor("manager"))).toBe("orders");
    expect(firstItemId(menuSectionsFor("cashier"))).toBe("cash");
    expect(firstItemId([])).toBeNull();
  });
});
