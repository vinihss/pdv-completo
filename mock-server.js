import http from "http";

const menu = {
  merchantName: "Boteco do Zé",
  logoUrl: null,
  usesDelivery: true,
  deliveryFee: 5,
  enabledPaymentMethods: ["cash", "card", "pix"],
  brandColor: "#f59e0b",
  categories: [
    {
      id: "c1",
      name: "Lanches",
      products: [
        { id: "p1", name: "X-Burger", price: 28, description: "Carne 150g, queijo e salada.", variations: [{ name: "Ponto da carne", options: ["Mal passado", "Ao ponto"], required: true, allowMultiple: false }] },
        { id: "p2", name: "Chopp 300ml", price: 9.5, description: "Chopp gelado.", variations: null },
      ],
    },
    {
      id: "c2",
      name: "Porções",
      products: [
        { id: "p3", name: "Batata frita", price: 22, description: "Porção de batata frita.", variations: null },
      ],
    },
  ],
};

const carts = new Map();

const server = http.createServer((req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") { res.writeHead(200); res.end(); return; }

  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/health") { res.writeHead(200); res.end(JSON.stringify({ ok: true })); return; }
  if (url.pathname === "/store-info") { res.writeHead(200); res.end(JSON.stringify({ store: null })); return; }
  if (url.pathname === "/public/menu") { res.writeHead(200); res.end(JSON.stringify(menu)); return; }

  if (url.pathname === "/public/cart" && req.method === "GET") {
    const phone = url.searchParams.get("phone");
    const cart = carts.get(phone);
    res.writeHead(200); res.end(JSON.stringify(cart ? { items: cart } : null)); return;
  }
  if (url.pathname === "/public/cart" && req.method === "PUT") {
    let body = "";
    req.on("data", (c) => body += c);
    req.on("end", () => {
      const { phone, items } = JSON.parse(body);
      carts.set(phone, items);
      res.writeHead(200); res.end(JSON.stringify({}));
    });
    return;
  }
  if (url.pathname === "/public/cart" && req.method === "DELETE") {
    let body = "";
    req.on("data", (c) => body += c);
    req.on("end", () => {
      const { phone } = JSON.parse(body);
      carts.delete(phone);
      res.writeHead(200); res.end(JSON.stringify({}));
    });
    return;
  }

  if (url.pathname === "/public/orders" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => body += c);
    req.on("end", () => {
      const order = JSON.parse(body);
      res.writeHead(200); res.end(JSON.stringify({ orderId: "mock-order-1" }));
    });
    return;
  }
  if (url.pathname === "/public/orders/active") { res.writeHead(200); res.end(JSON.stringify(null)); return; }
  if (url.pathname === "/public/orders/status") { res.writeHead(200); res.end(JSON.stringify({ orderStatus: "open" })); return; }
  if (url.pathname === "/public/customers/lookup") { res.writeHead(200); res.end(JSON.stringify({ found: false })); return; }

  res.writeHead(404); res.end(JSON.stringify({ error: "not found" }));
});

server.listen(3000, () => console.log("Mock server on :3000"));
