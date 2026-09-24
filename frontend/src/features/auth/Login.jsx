import React, { useState, useEffect, useRef } from "react";
import { Delete, ChefHat, UtensilsCrossed, ClipboardList, Lock, Loader2, Wallet } from "lucide-react";
import { listLoginUsers } from "@/shared/api/auth";
import { getStoreInfo } from "@/shared/api/store";
import { useAuth } from "./AuthContext.jsx";
import { applyBrandPrimary } from "@/shared/lib";

const ROLE_META = {
  waiter: { label: "Garçom", icon: ClipboardList },
  kitchen: { label: "Cozinha", icon: ChefHat },
  manager: { label: "Gerente", icon: UtensilsCrossed },
  courier: { label: "Entregador", icon: UtensilsCrossed },
  cashier: { label: "Caixa", icon: Wallet },
  system: { label: "System", icon: UtensilsCrossed },
};

const MAX_PIN = 6;
const MIN_PIN = 4;

function initials(name) {
  return name.split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase();
}

export default function Login() {
  const { login } = useAuth();
  const [screen, setScreen] = useState("select"); // select | pin
  const [users, setUsers] = useState([]);
  const [storeName, setStoreName] = useState("");
  const [logoUrl, setLogoUrl] = useState("");
  const [loadingUsers, setLoadingUsers] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [selectedUser, setSelectedUser] = useState(null);
  const [pin, setPin] = useState("");
  const [error, setError] = useState(null);
  const [shake, setShake] = useState(false);
  const [checking, setChecking] = useState(false);
  const errorTimer = useRef(null);

  // Carregamento inicial de dados da loja
  useEffect(() => {
    listLoginUsers()
      .then(setUsers)
      .catch((e) => setLoadError(e.message))
      .finally(() => setLoadingUsers(false));
    getStoreInfo()
      .then((s) => {
        setStoreName(s?.merchantName || "");
        setLogoUrl(s?.logoUrl || "");
        applyBrandPrimary(s?.brandColor);
      })
      .catch(() => {});
  }, []);

  function openPinScreen(user) {
    setSelectedUser(user);
    setPin("");
    setError(null);
    setScreen("pin");
  }

  function backToSelect() {
    setScreen("select");
    setSelectedUser(null);
    setPin("");
    setError(null);
  }

  function pressDigit(d) {
    if (checking || pin.length >= MAX_PIN) return;
    const next = pin + d;
    setPin(next);
    setError(null);
    if (next.length === MAX_PIN) attemptLogin(next);
  }

  function backspace() {
    if (checking) return;
    setPin((p) => p.slice(0, -1));
    setError(null);
  }

  // Ouvinte do Teclado para a tela de PIN
  useEffect(() => {
    function loginNumericPadHelper(evento) {
      // Só escuta o teclado se estiver na tela de PIN
      if (screen !== "pin") return;

      // Se for um número de 0 a 9 (teclado normal ou numérico)
      if (/^[0-9]\$/.test(evento.key)) {
        evento.preventDefault();
        pressDigit(evento.key);
      } 
      // Se for a tecla para apagar
      else if (evento.key === "Backspace") {
        evento.preventDefault();
        backspace();
      } 
      // Se for Enter e já tiver o mínimo de dígitos
      else if (evento.key === "Enter") {
        evento.preventDefault();
        confirmPin();
      }
      // Se for a tecla Esc, volta para a seleção de usuário
      else if (evento.key === "Escape") {
        evento.preventDefault();
        backToSelect();
      }
    }

    window.addEventListener('keydown', loginNumericPadHelper);
    
    // Remove o evento ao desmontar ou atualizar estados para evitar bugs
    return () => {
      window.removeEventListener('keydown', loginNumericPadHelper);
    };
  }, [screen, pin, checking]); // Dependências necessárias para ler os estados corretos
  
  async function attemptLogin(candidatePin) {
    setChecking(true);
    try {
      await login(selectedUser.id, candidatePin);
    } catch (e) {
      setChecking(false);
      setError(e.code === "too_many_attempts" ? "Muitas tentativas. Aguarde um minuto." : "PIN incorreto. Tente novamente.");
      setPin("");
      setShake(true);
      clearTimeout(errorTimer.current);
      errorTimer.current = setTimeout(() => setShake(false), 420);
    }
  }

  function confirmPin() {
    if (pin.length >= MIN_PIN) attemptLogin(pin);
  }

  useEffect(() => () => clearTimeout(errorTimer.current), []);

  return (
    <div className="min-h-screen bg-stone-950 text-stone-50 flex flex-col items-center justify-center p-6">
      {screen === "select" && (
        <div className="w-full max-w-md fade-up">
          <div className="text-center mb-10">
            {logoUrl ? (
              <img src={logoUrl} alt="Logo do restaurante" className="w-32 h-32 rounded-full object-contain mx-auto mb-5" />
            ) : (
              <div className="w-14 h-14 rounded-full bg-amber-500 flex items-center justify-center mx-auto mb-4">
                <Lock size={26} className="text-stone-950" strokeWidth={2.5} />
              </div>
            )}
            <h1 className="font-display text-2xl font-bold">{storeName || "Bar do Zé"}</h1>
            <p className="text-stone-500 text-sm mt-1">Selecione seu nome para continuar</p>
          </div>

          {loadingUsers && (
            <div className="flex items-center justify-center gap-2 text-stone-500 py-10">
              <Loader2 size={18} className="animate-spin" /> Carregando...
            </div>
          )}

          {loadError && (
            <div className="text-center text-red-400 text-sm py-10">
              Não foi possível conectar ao servidor. Verifique se o backend está rodando.
            </div>
          )}

          {!loadingUsers && !loadError && (
            <div className="grid grid-cols-2 gap-3">
              {users.map((u) => {
                const meta = ROLE_META[u.role];
                const Icon = meta.icon;
                return (
                  <button
                    key={u.id}
                    onClick={() => openPinScreen(u)}
                    className="flex flex-col items-center gap-2.5 bg-stone-900 border border-stone-800 hover:border-amber-500/50 hover:bg-stone-800 rounded-2xl p-5 transition-colors active:scale-95"
                  >
                    <div className="w-14 h-14 rounded-full bg-stone-800 flex items-center justify-center font-display text-lg font-bold text-amber-400">
                      {initials(u.name)}
                    </div>
                    <div className="text-center">
                      <div className="font-semibold text-sm leading-tight">{u.name}</div>
                      <div className="flex items-center justify-center gap-1 text-stone-500 text-xs mt-1">
                        <Icon size={11} /> {meta.label}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {screen === "pin" && selectedUser && (
        <div className={`w-full max-w-xs fade-up ${shake ? "shake-anim" : ""}`}>
          <div className="text-center mb-8">
            <div className="w-16 h-16 rounded-full bg-stone-800 flex items-center justify-center font-display text-xl font-bold text-amber-400 mx-auto mb-3">
              {initials(selectedUser.name)}
            </div>
            <h2 className="font-display text-xl font-bold">{selectedUser.name}</h2>
            <p className="text-stone-500 text-sm mt-1">Digite seu PIN</p>
          </div>

          <div className="flex items-center justify-center gap-3 mb-2 h-4">
            {Array.from({ length: Math.max(pin.length, MIN_PIN) }).map((_, i) => (
              <span
                key={i}
                className={`w-3 h-3 rounded-full dot-pop ${
                  i < pin.length ? (error ? "bg-red-500" : "bg-amber-400") : "bg-stone-700"
                }`}
              />
            ))}
          </div>
          <div className="h-5 text-center mb-6">
            {error && <span className="text-red-400 text-xs font-medium">{error}</span>}
            {checking && !error && <span className="text-stone-500 text-xs">Verificando…</span>}
          </div>

          <div className="grid grid-cols-3 gap-3">
            {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
              <button
                key={d}
                onClick={() => pressDigit(d)}
                disabled={checking}
                className="font-display text-2xl font-bold bg-stone-900 border border-stone-800 hover:bg-stone-800 active:scale-95 disabled:opacity-40 rounded-2xl py-5 transition-transform"
              >
                {d}
              </button>
            ))}
            <button onClick={backToSelect} className="text-stone-500 hover:text-stone-300 text-xs font-semibold rounded-2xl py-5">
              Voltar (Esc)
            </button>
            <button
              onClick={() => pressDigit("0")}
              disabled={checking}
              className="font-display text-2xl font-bold bg-stone-900 border border-stone-800 hover:bg-stone-800 active:scale-95 disabled:opacity-40 rounded-2xl py-5 transition-transform"
            >
              0
            </button>
            <button
              onClick={backspace}
              disabled={checking || pin.length === 0}
              className="flex items-center justify-center text-stone-500 hover:text-red-400 disabled:opacity-40 rounded-2xl py-5 transition-colors"
            >
              <Delete size={22} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
