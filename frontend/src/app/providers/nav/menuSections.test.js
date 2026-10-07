import { describe, it, expect } from "vitest";
import { menuSectionsFor, hasExpandableSections, firstItemId } from "./menuSections.js";

const labels = (sections) => sections.flatMap((s) => s.items.map((i) => `${s.label}/${i.label}`));

describe("menuSectionsFor", () => {
  it("gerente: Home e áreas por perfil com estoque, compras e iFood ligados", () => {
    const sections = menuSectionsFor("manager", {
      inventoryEnabled: true,
      purchaseEnabled: true,
      ifoodIntegrationEnabled: true,
    });
    expect(sections.map((s) => s.label)).toEqual(["Início", "Operação", "Catálogo", "Gestão", "Sistema"]);
    expect(sections.flatMap((s) => s.items)).toHaveLength(13);
  });

  it("gerente: os toggles de estoque e compras entram no catálogo, o de iFood na operação", () => {
    expect(labels(menuSectionsFor("manager"))).toEqual([
      "Início/Início",
      "Operação/Comandas", "Operação/Caixa", "Operação/Clientes", "Operação/Entregas",
      "Catálogo/Cadastros",
      "Gestão/Equipe", "Gestão/Relatórios", "Gestão/Auditoria",
      "Sistema/Configurações",
    ]);
    const comEstoque = labels(menuSectionsFor("manager", { inventoryEnabled: true }));
    expect(comEstoque).toContain("Catálogo/Estoque");
    const comCompras = labels(menuSectionsFor("manager", { purchaseEnabled: true }));
    expect(comCompras).toContain("Catálogo/Compras");
    const comIfood = labels(menuSectionsFor("manager", { ifoodIntegrationEnabled: true }));
    expect(comIfood).toContain("Operação/iFood");
  });

  it("iFood some do menu quando a integração está desligada", () => {
    expect(labels(menuSectionsFor("manager", { ifoodIntegrationEnabled: false }))).not.toContain("Operação/iFood");
  });

  it("WhatsApp não é item de menu: o painel mora em Configurações", () => {
    const ids = menuSectionsFor("manager", {
      inventoryEnabled: true,
      purchaseEnabled: true,
      ifoodIntegrationEnabled: true,
    }).flatMap((s) => s.items.map((i) => i.id));
    expect(ids).not.toContain("whatsapp");
    expect(labels(menuSectionsFor("manager", { ifoodIntegrationEnabled: true }))).not.toContain("Operação/WhatsApp");
  });

  it("mantém os ids que a página do gerente já usa", () => {
    const ids = menuSectionsFor("manager", {
      inventoryEnabled: true,
      purchaseEnabled: true,
      ifoodIntegrationEnabled: true,
    })
      .flatMap((s) => s.items)
      .map((i) => i.id);
    expect(ids).toEqual(["home", "orders", "cash", "customers", "deliveries", "ifood", "catalog", "stock", "compras", "users", "reports", "audit", "settings"]);
  });

  it("perfis de tela única: uma seção com um item", () => {
    for (const [role, item, label] of [
      ["waiter", "orders", "Comandas"],
      ["kitchen", "kitchen", "Produção"],
      ["courier", "deliveries", "Entregas"],
    ]) {
      const sections = menuSectionsFor(role);
      expect(sections).toHaveLength(1);
      expect(sections[0].items.map((i) => i.id)).toEqual([item]);
      expect(sections[0].items[0].label).toBe(label);
    }
  });

  it("caixa tem duas telas: Caixa e Clientes", () => {
    const sections = menuSectionsFor("cashier");
    expect(labels(sections)).toEqual(["Operação/Caixa", "Operação/Clientes"]);
  });

  it("papel desconhecido cai no menu do garçom (mesmo fallback da rota)", () => {
    expect(menuSectionsFor("system")).toEqual(menuSectionsFor("waiter"));
  });
});

describe("modo do menu", () => {
  it("gerente e caixa têm algo para expandir", () => {
    expect(hasExpandableSections(menuSectionsFor("manager"))).toBe(true);
    expect(hasExpandableSections(menuSectionsFor("cashier"))).toBe(true);
    for (const role of ["waiter", "kitchen", "courier"]) {
      expect(hasExpandableSections(menuSectionsFor(role))).toBe(false);
    }
  });

  it("firstItemId é o primeiro item da primeira seção", () => {
    expect(firstItemId(menuSectionsFor("manager"))).toBe("home");
    expect(firstItemId(menuSectionsFor("cashier"))).toBe("cash");
    expect(firstItemId([])).toBeNull();
  });
});
