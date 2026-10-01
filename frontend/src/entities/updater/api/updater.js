import { isDesktop } from "@/shared/lib";

// ============================================================
// Auto-update do app desktop (plugin oficial do Tauri).
//
// No web não existe: quem atualiza o web é o deploy (o navegador recarrega o
// index novo). Aqui, o app confere se há versão nova, mostra o progresso e
// deixa o instalador assinado fazer a troca.
//
// Regra que atravessa este arquivo: **falha de update nunca impede o app de
// abrir**. Sem internet, endpoint fora do ar ou plugin ausente viram
// `available: false` e o boot segue. Quem decide se o sistema está no ar é o
// health check, não o updater.
// ============================================================

// Manifesto é um JSON minúsculo; 3s cobrem uma rede boa e não seguram o
// gerente numa tela de espera quando a instalação local está sem internet.
export const UPDATE_CHECK_TIMEOUT_MS = 3000;

function errorText(err) {
  if (!err) return "erro desconhecido";
  if (typeof err === "string") return err;
  return err.message ?? String(err);
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise
    .race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} expirou em ${ms}ms`)), ms);
      }),
    ])
    .finally(() => clearTimeout(timer));
}

/**
 * Procura atualização. `timeoutMs` cobre o caso "sem internet": não espera
 * o timeout padrão do Rust.
 */
export async function checkForUpdate(timeoutMs = UPDATE_CHECK_TIMEOUT_MS) {
  if (!isDesktop()) return { available: false, reason: "web" };

  let check;
  try {
    ({ check } = await import(/* @vite-ignore */ "@tauri-apps/plugin-updater"));
  } catch {
    return { available: false, reason: "plugin do updater indisponível" };
  }

  let update;
  try {
    update = await withTimeout(check(), timeoutMs, "checagem de atualização");
  } catch (err) {
    return { available: false, reason: errorText(err) };
  }

  if (!update) return { available: false, reason: "já está na última versão" };
  return {
    available: true,
    version: update.version,
    notes: update.body ?? "",
    date: update.date,
    update,
  };
}

/**
 * Baixa e instala. Traduz os eventos do plugin em bytes/percentual para o
 * splash e nunca lança: devolve `{ ok: false }` e o boot continua.
 */
export async function installUpdate(update, onProgress) {
  let downloaded = 0;
  let total = 0;
  try {
    await update.downloadAndInstall((event) => {
      if (event.event === "Started") {
        downloaded = 0;
        total = event.data?.contentLength ?? 0;
        onProgress?.({ downloaded, total, percent: 0 });
      } else if (event.event === "Progress") {
        downloaded += event.data?.chunkLength ?? 0;
        const percent = total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : 0;
        onProgress?.({ downloaded, total, percent });
      } else if (event.event === "Finished") {
        onProgress?.({ downloaded: total || downloaded, total: total || downloaded, percent: 100 });
      }
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: errorText(err) };
  } finally {
    try {
      update.close?.();
    } catch {
      // objeto já liberado — irrelevante
    }
  }
}

/**
 * Reabre o app depois da instalação. No Windows o instalador fecha o processo
 * em andamento, então pode não dar tempo de reabrir: devolve `false` e o
 * splash oferece o botão em vez de sumir.
 */
export async function relaunch() {
  try {
    const mod = await import(/* @vite-ignore */ "@tauri-apps/plugin-process");
    await mod.relaunch();
    return true;
  } catch {
    return false;
  }
}
