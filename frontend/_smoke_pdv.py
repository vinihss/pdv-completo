import json, uuid, urllib.request, urllib.error
B = "http://localhost/api"

def req(m, path, token=None, body=None):
    r = urllib.request.Request(B + path, method=m)
    r.add_header("content-type", "application/json")
    if token: r.add_header("authorization", "Bearer " + token)
    if body is not None: r.data = json.dumps(body).encode()
    try:
        with urllib.request.urlopen(r) as x:
            return x.status, json.load(x)
    except urllib.error.HTTPError as e:
        try: return e.code, json.load(e)
        except Exception: return e.code, {"raw": e.read().decode()[:160]}

ok = True
def step(label, cond, detail=""):
    global ok
    ok = ok and cond
    print(f"[{'OK ' if cond else 'FAIL'}] {label}" + (f"  ({detail})" if not cond else ""))

# 0. health
s, h = req("GET", "/health")
step("GET /health", s == 200, (s, h))

# 1. usuários públicos (dropdown do login)
s, users = req("GET", "/auth/users")
step("GET /auth/users dropdown", s == 200 and len(users) >= 3, (s, users))
W = next(u["id"] for u in users if u["role"] == "waiter")
M = next(u["id"] for u in users if u["role"] == "manager")
print(f"  perfis: garçom={W[:8]} gerente={M[:8]}")

def login(uid, pin):
    s, d = req("POST", "/auth/login", body={"userId": uid, "pin": str(pin)})
    return s, (d.get("token", "") if isinstance(d, dict) else ""), (s, d)

# 2. logins por perfil (PINs do AGENTS § como rodar)
sW, tW, dW = login(W, "1234"); step("login garçom 1234", sW == 200, dW)
sM, tM, dM = login(M, "9999"); step("login gerente 9999", sM == 200, dM)

# kitchen não sai no dropdown (mas existe no seed) — pegar id via banco p/ testar
import sqlite3
try:
    ku = sqlite3.connect("backend/data/data.db").execute("SELECT id FROM user WHERE role='kitchen' LIMIT 1").fetchone()
    K = ku[0] if ku else None
except Exception:
    K = None
sK, tK, dK = login(K, "0000") if K else (0, "", {})
step("login cozinha (seed 0000)", sK == 200, (sK, dK))

# 3. garçom: abrir comanda (mesa free) — requisito da spec: correlationId
s, tabs = req("GET", "/tables", tM)
free = next((t["id"] for t in tabs if t["status"] == "free") if isinstance(tabs, list) else [], None)
step("GET /tables (mesa free)", isinstance(tabs, list) and free, tabs)

s, o = req("POST", "/orders", tM, {"tableId": str(free), "userId": str(W), "correlationId": str(uuid.uuid4())})
order = (o or {}).get("order") or (o or {})
oid = order.get("id") if isinstance(order, dict) else None
step("abrir comanda", s in (200, 201) and oid, o)

# 4. garçom lança itens
s, prods = req("GET", "/products", tM)
step("GET /products", s == 200 and isinstance(prods, list), prods)
p1, p2 = prods[0], prods[1]

def add_item(pid, qty):
    return req("POST", f"/orders/{oid}/items", tM,
               {"productId": pid, "quantity": qty, "correlationId": str(uuid.uuid4())})

s, it1 = add_item(p1["id"], 2)
step("lançar 2x itemA", s in (200, 201), (s, it1))
items = it1.get("order", {}).get("items", [])
iid = items[0]["id"] if items else None
s, it2 = add_item(p2["id"], 1)
ok1 = s in (200, 201)
step("lançar 1x itemB", ok1, (s, it2))

# 5. cozinha marca itemA pronto
s, rd = req("PATCH", f"/orders/{oid}/items/{iid}", tK, {"action": "ready"}) if (iid and tK) else (0, {})
step("cozinha pronto itemA", s in (200, 201), (s, rd))

# 6. garçom entrega itemA
s, dl = req("PATCH", f"/orders/{oid}/items/{iid}", tM, {"action": "deliver"}) if iid else (0, {})
step("garçom entrega", s in (200, 201), (s, dl))

# 7. gerente paga (cash) e fecha
s, oget = req("GET", f"/orders/{oid}", tM)
total = (oget.get("order") or {}).get("total")
step("GET comanda (total)", total is not None, oget)
s, pay = req("POST", f"/orders/{oid}/payments", tM, {"method": "cash", "amount": total, "correlationId": str(uuid.uuid4())})
step("pagar cash", s in (200, 201), (s, pay))
s, cl = req("PATCH", f"/orders/{oid}/close", tM, {})
step("fechar comanda", s in (200, 201), (s, cl))

print("\nSMOKE: " + ("COMPLETO PASS" if ok else "FALHOU nas etapas marcadas"))
raise SystemExit(0 if ok else 2)
