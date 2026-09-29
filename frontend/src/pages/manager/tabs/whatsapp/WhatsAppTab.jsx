import React, { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Check, Loader2, MessageCircle, Plug, RefreshCcw } from "lucide-react";
import {
  disconnectWhatsApp,
  exchangeEmbeddedSignup,
  getWhatsAppMessages,
  getWhatsAppSignupConfig,
  getWhatsAppStatus,
  startEmbeddedSignup,
} from "@/entities/whatsapp";
import { useAuth } from "@/app/providers/auth";
import { useRealtime } from "@/shared/hooks";
import { ConfirmModal } from "@/shared/components";

/**
 * Painel do WhatsApp (Embedded Signup) do gerente.
 *
 * O botão "Conectar" não abre um formulário: ele dispara o popup da Meta,
 * onde o gerente escolhe a conta da empresa e autoriza o WhatsApp Business.
 * Tudo que é segredo (app_secret) fica no backend — ver `entities/whatsapp/lib/
 * embeddedSignup.js` para quem faz o quê nos três passos.
 */

const STATUS_LABEL = {
  sent: "Enviada",
  delivered: "Entregue",
  read: "Lida",
  failed: "Falhou",
};

const STATUS_CLASS = {
  sent: "bg-stone-800 text-stone-400",
  delivered: "bg-emerald-500/15 text-emerald-400",
  read: "bg-sky-500/15 text-sky-400",
  failed: "bg-red-500/15 text-red-400",
};

const KIND_LABEL = { notification: "Notificação", bot_reply: "Resposta do bot" };

export default function WhatsAppTab({ showToast }) {
  const { session } = useAuth();
  const [status, setStatus] = useState(null);
  const [config, setConfig] = useState(null);
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  const load = useCallback(async () => {
    try {
      const [s, m] = await Promise.all([getWhatsAppStatus(), getWhatsAppMessages(50)]);
      setStatus(s);
      setMessages(m ?? []);
    } catch (e) {
      showToast(e?.message ?? "Falha ao carregar o WhatsApp", "error");
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    load();
    getWhatsAppSignupConfig().then(setConfig).catch(() => setConfig(null));
  }, [load]);

  // O status de cada mensagem chega por webhook e é aplicado no backend; o
  // realtime só evita o F5 para ver "entregue"/"falhou".
  const handleEvent = useCallback(
    (msg) => {
      if (msg.type === "whatsapp.message_status") load();
    },
    [load]
  );
  useRealtime(session?.token, ["whatsapp"], handleEvent, load);

  const onConnect = async () => {
    setConnecting(true);
    try {
      // O postMessage chega e o code é trocado no servidor. Se a troca
      // falhar, o gerente refaz o fluxo inteiro: o code é de uso único.
      const payload = await startEmbeddedSignup({
        appId: config?.appId,
        configId: config?.configId,
      });
      const result = await exchangeEmbeddedSignup(payload);
      showToast(`WhatsApp conectado: ${result.displayPhoneNumber ?? "número"}`, "success");
      await load();
    } catch (e) {
      showToast(e?.message ?? "Falha ao conectar o WhatsApp", "error");
    } finally {
      setConnecting(false);
    }
  };

  const onDisconnect = async () => {
    setDisconnecting(true);
    try {
      const r = await disconnectWhatsApp();
      showToast(
        r.disconnected ? "WhatsApp desconectado" : "Não havia WhatsApp conectado",
        "success"
      );
      setConfirmDisconnect(false);
      await load();
    } catch (e) {
      showToast(e?.message ?? "Falha ao desconectar", "error");
    } finally {
      setDisconnecting(false);
    }
  };

  if (loading) {
    return (
      <div className="p-5 max-w-2xl mx-auto py-12 text-center text-stone-500">
        Carregando…
      </div>
    );
  }

  const conn = status?.connection;
  const connected = Boolean(status?.connected);
  const expired = Boolean(conn?.tokenExpired);

  return (
    <div className="p-5 max-w-2xl mx-auto space-y-4">
      {/* Falta de configuração do servidor: não adianta tentar conectar. */}
      {status && !status.canConnect && (
        <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-300 space-y-2">
          <div className="flex items-center gap-2 font-semibold">
            <AlertTriangle size={16} />
            WhatsApp não configurado neste servidor
          </div>
          <p className="text-amber-200/80">
            Faltam estas variáveis no backend:
          </p>
          <ul className="list-disc pl-5 font-mono text-xs">
            {status.missing.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="bg-stone-900 border border-stone-800 rounded-2xl p-5 space-y-3">
        <div className="flex items-center justify-between">
          <span className="font-semibold text-sm flex items-center gap-2">
            <MessageCircle size={16} className="text-emerald-400" />
            WhatsApp Business
          </span>
          <span
            className={`text-xs font-bold px-2.5 py-1 rounded-full ${
              connected
                ? "bg-emerald-500 text-emerald-950"
                : expired
                  ? "bg-amber-500/15 text-amber-400"
                  : "bg-stone-800 text-stone-400"
            }`}
          >
            {connected ? "Conectado" : expired ? "Token expirado" : "Não conectado"}
          </span>
        </div>

        {conn && (
          <dl className="text-sm space-y-1.5">
            <div className="flex justify-between gap-4">
              <dt className="text-stone-500">Número</dt>
              <dd className="text-right">{conn.displayPhoneNumber ?? conn.phoneNumberId}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-stone-500">Nome na Meta</dt>
              <dd className="text-right">{conn.displayName ?? "—"}</dd>
            </div>
            {conn.businessName && (
              <div className="flex justify-between gap-4">
                <dt className="text-stone-500">Empresa</dt>
                <dd className="text-right">{conn.businessName}</dd>
              </div>
            )}
            <div className="flex justify-between gap-4">
              <dt className="text-stone-500">Conectado em</dt>
              <dd className="text-right">{new Date(conn.connectedAt).toLocaleString("pt-BR")}</dd>
            </div>
          </dl>
        )}

        {conn?.lastError && (
          <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-2.5 py-1.5">
            {conn.lastError}
          </div>
        )}

        {expired && (
          <p className="text-xs text-amber-400">
            O token da WABA expirou. Reconecte para voltar a enviar e receber.
          </p>
        )}

        <div className="flex gap-2 pt-1">
          {connected || expired ? (
            <>
              <button
                onClick={onConnect}
                disabled={connecting}
                className="flex-1 bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-stone-950 font-semibold py-2.5 rounded-xl flex items-center justify-center gap-2"
              >
                {connecting ? <Loader2 size={16} className="animate-spin" /> : <Plug size={16} />}
                {connecting ? "Conectando…" : expired ? "Reconectar" : "Trocar conta"}
              </button>
              <button
                onClick={() => setConfirmDisconnect(true)}
                disabled={disconnecting}
                className="px-3 py-2.5 rounded-xl bg-stone-800 hover:bg-stone-700 text-stone-300 text-sm font-semibold"
              >
                Desconectar
              </button>
            </>
          ) : (
            <button
              onClick={onConnect}
              disabled={connecting || !status?.canConnect}
              className="flex-1 bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-stone-950 font-semibold py-3 rounded-xl flex items-center justify-center gap-2"
            >
              {connecting ? <Loader2 size={16} className="animate-spin" /> : <Plug size={16} />}
              {connecting ? "Conectando…" : "Conectar WhatsApp"}
            </button>
          )}
        </div>
      </div>

      {/* Histórico: existe para o gerente descobrir por que o cliente não
          recebeu, então o motivo da falha aparece junto do status. */}
      <div className="bg-stone-900 border border-stone-800 rounded-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3 border-b border-stone-800">
          <span className="font-semibold text-sm">Mensagens enviadas</span>
          <button
            onClick={load}
            className="text-stone-500 hover:text-stone-300"
            aria-label="Atualizar mensagens"
          >
            <RefreshCcw size={15} />
          </button>
        </div>
        {messages.length === 0 ? (
          <p className="px-5 py-8 text-sm text-stone-500 text-center">
            Nenhuma mensagem enviada ainda.
          </p>
        ) : (
          <ul className="divide-y divide-stone-800">
            {messages.map((m) => (
              <li key={m.id} className="px-5 py-3 flex items-center gap-3 text-sm">
                <div className="flex-1 min-w-0">
                  <div className="font-mono text-xs text-stone-400 truncate">{m.toPhone}</div>
                  <div className="text-xs text-stone-500">
                    {KIND_LABEL[m.kind] ?? m.kind} ·{" "}
                    {new Date(m.createdAt).toLocaleString("pt-BR")}
                  </div>
                  {m.status === "failed" && m.errorMessage && (
                    <div className="text-xs text-red-400 mt-0.5">{m.errorMessage}</div>
                  )}
                </div>
                <span
                  className={`text-xs font-semibold px-2 py-1 rounded-full shrink-0 ${
                    STATUS_CLASS[m.status] ?? STATUS_CLASS.sent
                  }`}
                >
                  {m.status === "delivered" && <Check size={11} className="inline mr-1" />}
                  {STATUS_LABEL[m.status] ?? m.status}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {confirmDisconnect && (
        <ConfirmModal
          title="Desconectar o WhatsApp?"
          message="O token da WABA é apagado e as mensagens param de ser enviadas até reconectar."
          confirmLabel="Desconectar"
          destructive
          onCancel={() => setConfirmDisconnect(false)}
          onConfirm={onDisconnect}
        />
      )}
    </div>
  );
}
