import React, { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  Check,
  Loader2,
  MessageCircle,
  Plug,
  RefreshCcw,
  Smartphone,
} from "lucide-react";
import {
  connectWhatsAppSocket,
  disconnectWhatsApp,
  disconnectWhatsAppSocket,
  exchangeEmbeddedSignup,
  getWhatsAppMessages,
  getWhatsAppSignupConfig,
  getWhatsAppSocketStatus,
  getWhatsAppStatus,
  startEmbeddedSignup,
} from "@/entities/whatsapp";
import { useAuth } from "@/app/providers/auth";
import { useRealtime } from "@/shared/hooks";
import { ConfirmModal } from "@/shared/components";

/**
 * Painel do WhatsApp do gerente — dois providers, um por vez (o
 * backend escolhe via `WHATSAPP_PROVIDER`):
 *
 *  · cloudapi (padrão): Embedded Signup da Meta. O botão "Conectar"
 *    não abre um formulário: ele dispara o popup da Meta, onde o
 *    gerente escolhe a conta da empresa e autoriza o WhatsApp
 *    Business. Tudo que é segredo (app_secret) fica no backend — ver
 *    `entities/whatsapp/lib/embeddedSignup.js` para quem faz o quê
 *    nos três passos.
 *  · baileys (WhatsApp Web): sem webhook. O card "WhatsApp Web" só
 *    existe quando o servidor reporta esse provider: o gerente
 *    vincula o telefone por QR ou código de pareamento e a sessão
 *    é sondada por REST até conectar.
 *
 * `embedded`: o painel já não é mais uma tela do menu — ele mora
 * dentro de Configurações atrás do toggle "Integração WhatsApp". Nesse
 * modo perde o padding/margem de tela cheia para caber no fluxo da
 * página de configurações.
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

export default function WhatsAppTab({ showToast, embedded = false }) {
  const { session } = useAuth();
  const [status, setStatus] = useState(null);
  const [config, setConfig] = useState(null);
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  // WhatsApp Web (modo socket): `socketStatus` é nulo enquanto não se
  // sabe qual provider está ativo — e permanece nulo em falha, para o
  // card simplesmente não existir fora do baileys.
  const [socketStatus, setSocketStatus] = useState(null);
  const [socketConnecting, setSocketConnecting] = useState(false);
  const [socketDisconnecting, setSocketDisconnecting] = useState(false);
  const [socketPairing, setSocketPairing] = useState(null);
  const [awaitingLink, setAwaitingLink] = useState(false);
  const [confirmSocketDisconnect, setConfirmSocketDisconnect] = useState(false);

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

  // Falha aqui é silenciosa de propósito: num backend sem o provider
  // alternativo (ou no cloudapi com instabilidade) o card não pode
  // derrubar a aba — ele só deixa de existir.
  const loadSocketStatus = useCallback(async () => {
    try {
      const s = await getWhatsAppSocketStatus();
      setSocketStatus(s);
      return s;
    } catch {
      setSocketStatus(null);
      return null;
    }
  }, []);

  useEffect(() => {
    load();
    getWhatsAppSignupConfig().then(setConfig).catch(() => setConfig(null));
    loadSocketStatus();
  }, [load, loadSocketStatus]);

  // O status de cada mensagem chega por webhook e é aplicado no backend; o
  // realtime só evita o F5 para ver "entregue"/"falhou".
  const handleEvent = useCallback(
    (msg) => {
      if (msg.type === "whatsapp.message_status") load();
    },
    [load]
  );
  useRealtime(session?.token, ["whatsapp"], handleEvent, load);

  // O vínculo (QR/código) só completa no servidor, depois que o
  // gerente escaneia ou digita o código — o connect não espera por
  // isso. Sonda o status até conectar: para ao detectar
  // `connected`, ao backend reportar erro e no unmount.
  useEffect(() => {
    if (!awaitingLink) return undefined;
    let cancelled = false;
    let timer = null;
    const poll = async () => {
      const s = await loadSocketStatus();
      if (cancelled) return;
      if (s?.connected) {
        setAwaitingLink(false);
        setSocketPairing(null);
        showToast("WhatsApp Web conectado", "success");
        return;
      }
      if (s?.lastError) {
        setAwaitingLink(false); // erro reportado: para de sondar
        return;
      }
      timer = setTimeout(poll, 3000);
    };
    poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [awaitingLink, loadSocketStatus, showToast]);

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

  const onConnectSocket = async () => {
    setSocketConnecting(true);
    setSocketPairing(null);
    try {
      // O backend devolve QR, código de pareamento ou ambos — o
      // gerente usa o que aparecer. A sondagem descobre quando
      // o vínculo efetivamente aconteceu no telefone.
      const r = await connectWhatsAppSocket();
      setSocketPairing({
        qrDataUrl: r?.qrDataUrl ?? null,
        pairingCode: r?.pairingCode ?? null,
      });
      setAwaitingLink(true);
    } catch (e) {
      setAwaitingLink(false);
      setSocketPairing(null);
      showToast(e?.message ?? "Falha ao conectar o WhatsApp Web", "error");
      await loadSocketStatus();
    } finally {
      setSocketConnecting(false);
    }
  };

  const onDisconnectSocket = async () => {
    setSocketDisconnecting(true);
    try {
      await disconnectWhatsAppSocket();
      setConfirmSocketDisconnect(false);
      setSocketPairing(null);
      setAwaitingLink(false);
      showToast("WhatsApp Web desconectado", "success");
      await loadSocketStatus();
    } catch (e) {
      showToast(e?.message ?? "Falha ao desconectar o WhatsApp Web", "error");
    } finally {
      setSocketDisconnecting(false);
    }
  };

  if (loading) {
    return (
      <div className={`${embedded ? "" : "p-5 max-w-2xl mx-auto"} py-12 text-center text-stone-500`}>
        Carregando…
      </div>
    );
  }

  const conn = status?.connection;
  const connected = Boolean(status?.connected);
  const expired = Boolean(conn?.tokenExpired);
  const socketConnected = Boolean(socketStatus?.connected);

  return (
    <div className={`${embedded ? "" : "p-5 max-w-2xl mx-auto"} space-y-4`}>
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

      {/* WhatsApp Web (modo socket/Baileys): provider
          alternativo, opt-in no backend. O card só existe
          quando o servidor reporta baileys — no cloudapi
          nada muda nesta tela. */}
      {socketStatus?.provider === "baileys" && (
        <div className="bg-stone-900 border border-stone-800 rounded-2xl p-5 space-y-3">
          <div className="flex items-center justify-between">
            <span className="font-semibold text-sm flex items-center gap-2">
              <Smartphone size={16} className="text-sky-400" />
              WhatsApp Web
            </span>
            <span
              className={`text-xs font-bold px-2.5 py-1 rounded-full ${
                socketStatus?.lastError
                  ? "bg-amber-500/15 text-amber-400"
                  : socketConnected
                    ? "bg-emerald-500 text-emerald-950"
                    : "bg-stone-800 text-stone-400"
              }`}
            >
              {socketStatus?.lastError
                ? "Erro"
                : socketConnected
                  ? "Conectado"
                  : "Não conectado"}
            </span>
          </div>

          <dl className="text-sm space-y-1.5">
            <div className="flex justify-between gap-4">
              <dt className="text-stone-500">Número</dt>
              <dd className="text-right">{socketStatus?.phone ?? "—"}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-stone-500">Conectado em</dt>
              <dd className="text-right">
                {socketStatus?.linkedAt
                  ? new Date(socketStatus.linkedAt).toLocaleString("pt-BR")
                  : "—"}
              </dd>
            </div>
          </dl>

          {socketStatus?.lastError && (
            <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-2.5 py-1.5">
              {socketStatus.lastError}
            </div>
          )}

          {/* O connect devolve QR, código de pareamento ou
              ambos — exiba o que vier. */}
          {socketPairing?.pairingCode && (
            <div className="rounded-xl border border-stone-700 bg-stone-950 p-4 space-y-2 text-center">
              <p className="text-xs text-stone-400">
                No telefone: Ajustes → Dispositivos vinculados → Vincular com
                código. Digite:
              </p>
              <p className="font-mono text-3xl font-bold tracking-[0.35em] text-stone-100">
                {socketPairing.pairingCode}
              </p>
            </div>
          )}
          {socketPairing?.qrDataUrl && (
            <div className="space-y-2">
              <p className="text-xs text-stone-400 text-center">
                Aponte a câmera do telefone para o QR (Ajustes → Dispositivos
                vinculados → Vincular com dispositivo).
              </p>
              <div className="flex justify-center">
                <img
                  src={socketPairing.qrDataUrl}
                  alt="QR code para vincular"
                  className="w-44 h-44 object-contain rounded-xl border border-stone-800 bg-white p-2"
                />
              </div>
            </div>
          )}

          {awaitingLink && !socketConnected && !socketStatus?.lastError && (
            <p className="text-xs text-stone-500 flex items-center justify-center gap-2">
              <Loader2 size={13} className="animate-spin" />
              Aguardando o vínculo com o telefone…
            </p>
          )}

          <div className="flex gap-2 pt-1">
            {socketConnected ? (
              <button
                onClick={() => setConfirmSocketDisconnect(true)}
                disabled={socketDisconnecting}
                className="px-3 py-2.5 rounded-xl bg-stone-800 hover:bg-stone-700 text-stone-300 text-sm font-semibold disabled:opacity-50"
              >
                Desconectar
              </button>
            ) : (
              <button
                onClick={onConnectSocket}
                disabled={socketConnecting}
                className="flex-1 bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-stone-950 font-semibold py-2.5 rounded-xl flex items-center justify-center gap-2"
              >
                {socketConnecting ? (
                  <Loader2 size={16} className="animate-spin" />
                ) : (
                  <Plug size={16} />
                )}
                {socketConnecting
                  ? "Conectando…"
                  : socketStatus?.linkedAt || socketStatus?.lastError
                    ? "Reconectar"
                    : "Conectar WhatsApp Web"}
              </button>
            )}
          </div>
        </div>
      )}

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

      {confirmSocketDisconnect && (
        <ConfirmModal
          title="Desconectar o WhatsApp Web?"
          message="A sessão é encerrada e as credenciais apagadas; mensagens param até reconectar."
          confirmLabel="Desconectar"
          destructive
          onCancel={() => setConfirmSocketDisconnect(false)}
          onConfirm={onDisconnectSocket}
        />
      )}
    </div>
  );
}
