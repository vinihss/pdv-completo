// Tocar som no browser, sem arquivo de áudio.
//
// Web Audio API em vez de mp3/wav: nada para baixar, nada para cachear no PWA
// e o timbre é descrito em código (a tabela de tons fica na entity que sabe o
// que cada tipo de alerta significa). Só isto mora em `shared`: o google, os
// osciladores e o ganho.
//
// Por que o contexto é criado sob demanda e nunca no load: browsers só liberam
// áudio depois de um gesto do usuário. Criar o `AudioContext` no import já
// nasce `suspended` em todo celular, e o `resume()` só funciona dentro de um
// gesto — daí o `unlock()` que o provider chama no primeiro clique/toque.

let ctx = null;

function audioContextCtor() {
  if (typeof window === "undefined") return null;
  return window.AudioContext ?? window.webkitAudioContext ?? null;
}

/**
 * Devolve o contexto, criando se preciso. `rethrow = false` é o caminho do
 * provider: um navegador sem Web Audio (ou com ele bloqueado) não pode derrubar
 * o app — no máximo o alerta fica sem som.
 */
export function getAudioContext({ rethrow = true } = {}) {
  if (ctx) return ctx;
  const Ctor = audioContextCtor();
  if (!Ctor) {
    if (rethrow) throw new Error("Web Audio indisponível neste navegador");
    return null;
  }
  ctx = new Ctor();
  return ctx;
}

/** Já houve um gesto do usuário? (o autoplay policy do browser) */
export function isAudioUnlocked() {
  return ctx?.state === "running";
}

/**
 * Destrava o áudio. Chamar de dentro de um handler de clique/toque — é o
 * requisito do autoplay policy, e não tem efeito se o contexto ainda não
 * existir (criar aqui e já tocar é justamente o caminho que o browser bloqueia).
 */
export async function unlockAudio() {
  try {
    const context = getAudioContext({ rethrow: false });
    if (!context) return false;
    if (context.state === "suspended") await context.resume();
    return context.state === "running";
  } catch {
    return false;
  }
}

/**
 * Toca uma sequência de notas. Cada tom é `{ freq, at, duration, gain }` em Hz
 * e segundos, com `at` relativo ao início — é assim que se descreve "dois bipes
 * de alerta". Os osciladores nascem já dentro da janela (`at` > 0 fica
 * agendado), então a sequência é um `start()` por tom, todo no mesmo relógio
 * do `AudioContext`.
 *
 * Devolve `false` (sem lançar) quando não dá para tocar — o som é um extra, a
 * lista de alertas é o essencial.
 */
export function playTones(tones, { rethrow = false } = {}) {
  if (!Array.isArray(tones) || tones.length === 0) return false;
  let context;
  try {
    context = getAudioContext({ rethrow: false });
  } catch {
    return false;
  }
  if (!context) return false;

  try {
    if (context.state === "suspended") {
      // Fora de um gesto do usuário o browser só promete: a nota é agendada e
      // toca assim que o `unlockAudio()` rodar. Melhor que perder o aviso.
      context.resume().catch(() => {});
    }
    const start = context.currentTime;
    for (const tone of tones) {
      const at = start + Math.max(0, tone.at ?? 0);
      const duration = Math.max(0.02, tone.duration ?? 0.12);
      const osc = context.createOscillator();
      const gain = context.createGain();
      osc.type = tone.type ?? "sine";
      osc.frequency.setValueAtTime(tone.freq, at);
      // Envelope em rampa: um `gain` constante estoura no clique (o bipe fica
      // "seco" e com estalo nas bordas). Sobe em 10ms e desce nos últimos 30ms.
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, tone.gain ?? 0.12), at + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
      osc.connect(gain);
      gain.connect(context.destination);
      osc.start(at);
      osc.stop(at + duration + 0.02);
    }
    return true;
  } catch (err) {
    if (rethrow) throw err;
    return false;
  }
}

/** Só para teste/ HMR: solta o contexto para o próximo `getAudioContext`. */
export function __resetAudioContext() {
  ctx = null;
}
