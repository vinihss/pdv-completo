import React, { useState, useEffect, useRef, useCallback } from "react";
import { Delete, ChefHat, UtensilsCrossed, ClipboardList, Lock, Loader2, Wallet, Server } from "lucide-react";
import { listLoginUsers } from "@/entities/session";
import { getStoreInfo } from "@/entities/store";
import { useAuth } from "@/app/providers/auth";
import { Modal, UserAvatar } from "@/shared/components";
import { applyBrandPrimary } from "@/shared/lib";
import { assetUrl, currentServerLabel, fetchTag, setServerBase, getServerBase, serverDefault } from "@/shared/lib/server";

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

// Só dígitos, no máximo MAX_PIN: mesma regra para o keypad, para o teclado
// físico e para o input transparente (teclado nativo do celular).
function onlyDigits(value) {
  return (value ?? "").replace(/\D/g, "").slice(0, MAX_PIN);
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
  const [serverTag, setServerTag] = useState(null);
  // App desktop: o servidor é configuração (a origem do app é tauri://localhost).
  // No navegador o campo aparece preenchido com a origem atual, mas o app
  // funciona sem tocar nele.
  const [serverOpen, setServerOpen] = useState(false);
  const [serverDraft, setServerDraft] = useState(getServerBase());
  const [serverError, setServerError] = useState(null);
  const errorTimer = useRef(null);

  function saveServer() {
    const result = setServerBase(serverDraft);
    if (!result.ok) {
      setServerError(result.error);
      return;
    }
    // Recarrega para que login, logo e store info venham do servidor novo.
    window.location.reload();
  }

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

  useEffect(() => {
    fetchTag().then(setServerTag);
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

  const pressDigit = useCallback((d) => {
    if (checking) return;
    setPin((p) => (p.length >= MAX_PIN ? p : p + d));
    setError(null);
  }, [checking]);

  const backspace = useCallback(() => {
    if (checking) return;
    setPin((p) => p.slice(0, -1));
    setError(null);
  }, [checking]);

  const attemptLogin = useCallback(async (candidatePin) => {
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
  }, [login, selectedUser]);

  // Só entra com 4+ dígitos: o PIN do cadastro vai de 4 a 6, e completar a
  // sequência não pode ser o gatilho — o envio é explícito (Enter ou "Entrar").
  const confirmPin = useCallback(() => {
    if (checking) return;
    if (pin.length >= MIN_PIN) attemptLogin(pin);
  }, [checking, pin, attemptLogin]);

  // Teclado físico. Dígitos e backspace são ignorados quando o evento veio do
  // input de PIN (data-pin-input): quem corta em MAX_PIN é o onChange dele.
  // Enter e Esc valem nos dois caminhos.
  useEffect(() => {
    function loginNumericPadHelper(evento) {
      // Só escuta o teclado se estiver na tela de PIN
      if (screen !== "pin") return;

      const fromPinInput = evento.target?.dataset?.pinInput === "true";

      // Se for um número de 0 a 9 (teclado normal ou numérico)
      if (!fromPinInput && /^[0-9]$/.test(evento.key)) {
        evento.preventDefault();
        pressDigit(evento.key);
      }
      // Se for a tecla para apagar
      else if (!fromPinInput && evento.key === "Backspace") {
        evento.preventDefault();
        backspace();
      }
      // Se for a tecla Enter, confirma o PIN
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
  }, [screen, pressDigit, backspace, confirmPin]); // Dependências necessárias para ler os estados corretos

  useEffect(() => () => clearTimeout(errorTimer.current), []);

  return (
    <div className="min-h-screen bg-stone-950 text-stone-50 flex flex-col items-center justify-center p-6">
      {screen === "select" && (
        <div className="w-full max-w-md fade-up">
          <div className="text-center mb-10">
            {logoUrl ? (
              <img src={assetUrl(logoUrl)} alt="Logo do restaurante" className="w-32 h-32 rounded-full object-contain mx-auto mb-5" />
            ) : (
              <div className="w-14 h-14 rounded-full bg-amber-500 flex items-center justify-center mx-auto mb-4">
                <Lock size={26} className="text-stone-950" strokeWidth={2.5} />
              </div>
            )}
            <h1 className="font-display text-2xl font-bold">{storeName || "PDV"}</h1>
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
                    <UserAvatar name={u.name} photoPath={u.photoPath} className="w-14 h-14 text-lg" />
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

          <div className="mt-8 flex justify-center">
            <button
              type="button"
              onClick={() => {
                setServerDraft(getServerBase());
                setServerError(null);
                setServerOpen(true);
              }}
              className="inline-flex items-center gap-2 text-stone-600 hover:text-stone-400 text-xs transition-colors max-w-full"
            >
              <Server size={12} className="shrink-0" />
              <span className="truncate">Servidor: {currentServerLabel()}{serverTag ? ` v${serverTag}` : ""}</span>
            </button>
          </div>
        </div>
      )}

      {serverOpen && (
        <Modal
          title="Servidor"
          subtitle="Endereço do backend (vazio = servidor padrão do app)"
          onClose={() => setServerOpen(false)}
          footer={
            <div className="flex gap-2 w-full">
              <button
                type="button"
                onClick={() => setServerOpen(false)}
                className="flex-1 py-3 rounded-xl bg-stone-800 hover:bg-stone-700 transition-colors text-sm font-medium"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={saveServer}
                className="flex-1 py-3 rounded-xl bg-amber-500 hover:bg-amber-400 transition-colors text-stone-950 text-sm font-semibold"
              >
                Salvar
              </button>
            </div>
          }
        >
          <input
            type="url"
            inputMode="url"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            value={serverDraft}
            onChange={(e) => {
              setServerDraft(e.target.value);
              setServerError(null);
            }}
            placeholder="https://app.seudominio.com.br"
            aria-label="Endereço do servidor"
            className="w-full bg-stone-900 border border-stone-800 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-amber-500"
          />
          {serverError && <p className="text-red-400 text-xs mt-2">{serverError}</p>}
          <p className="text-stone-600 text-xs mt-3">
            O app recarrega ao salvar. Vazio volta ao servidor padrão
            {serverDefault() ? ` (${serverDefault()})` : " desta instalação"}.
          </p>
        </Modal>
      )}

      {screen === "pin" && selectedUser && (
        <div className={`w-full max-w-xs fade-up ${shake ? "shake-anim" : ""}`}>
          <div className="text-center mb-6">
            <UserAvatar
              name={selectedUser.name}
              photoPath={selectedUser.photoPath}
              className="w-16 h-16 text-xl mx-auto mb-3"
            />
            <h2 className="font-display text-xl font-bold">{selectedUser.name}</h2>
            <p className="text-stone-500 text-sm mt-1">Digite seu PIN</p>
          </div>

          {/* Input real (transparente) sobre os pontos: tocar na linha abre o
              teclado numérico do celular, e o PIN digitado passa pelos mesmos
              cortes do keypad. Os pontos continuam sendo a leitura visual. */}
          <div className="relative">
            <div className="flex items-center justify-center gap-3 h-10">
              {Array.from({ length: Math.max(pin.length, MIN_PIN) }).map((_, i) => (
                <span
                  key={i}
                  className={`w-3 h-3 rounded-full dot-pop ${
                    i < pin.length ? (error ? "bg-red-500" : "bg-amber-400") : "bg-stone-700"
                  }`}
                />
              ))}
            </div>
            <input
              data-pin-input="true"
              type="password"
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus={false}
              maxLength={MAX_PIN}
              value={pin}
              onChange={(e) => {
                setPin(onlyDigits(e.target.value));
                setError(null);
              }}
              aria-label="PIN"
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
            />
          </div>
          <div className="h-5 text-center mb-4">
            {error && <span className="text-red-400 text-xs font-medium">{error}</span>}
            {checking && !error && <span className="text-stone-500 text-xs">Verificando…</span>}
          </div>

          <div className="grid grid-cols-3 gap-3">
            {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
              <button
                key={d}
                type="button"
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
              type="button"
              onClick={() => pressDigit("0")}
              disabled={checking}
              className="font-display text-2xl font-bold bg-stone-900 border border-stone-800 hover:bg-stone-800 active:scale-95 disabled:opacity-40 rounded-2xl py-5 transition-transform"
            >
              0
            </button>
            <button
              type="button"
              onClick={backspace}
              disabled={checking || pin.length === 0}
              className="flex items-center justify-center text-stone-500 hover:text-red-400 disabled:opacity-40 rounded-2xl py-5 transition-colors"
            >
              <Delete size={22} />
            </button>
          </div>

          <button
            type="button"
            onClick={confirmPin}
            disabled={checking || pin.length < MIN_PIN}
            className="w-full mt-4 bg-amber-500 hover:bg-amber-400 disabled:opacity-40 text-stone-950 font-semibold py-4 rounded-2xl flex items-center justify-center gap-2 transition-colors"
          >
            {checking ? <Loader2 size={18} className="animate-spin" /> : null}
            {checking ? "Verificando…" : "Entrar"}
          </button>
        </div>
      )}
    </div>
  );
}
