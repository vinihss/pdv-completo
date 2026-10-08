// Mock em memória do MMKV nativo (C++ via Nitro). Não é automático: o JEST
// aponta `react-native-mmkv` para este arquivo via moduleNameMapper (ver
// package.json), senão o require real morre no Node. Implementa a fatia da
// API que o shared/lib/storage.js usa — o resto não existe de propósito.
const instances = new Map();

class MMKV {
  constructor(config) {
    this.mmkvId = config?.id ?? "default";
    this.storage = new Map();
    instances.set(this.mmkvId, this);
  }

  getString(key) {
    return this.storage.has(key) ? this.storage.get(key) : undefined;
  }

  set(key, value) {
    this.storage.set(key, String(value));
  }

  remove(key) {
    this.storage.delete(key);
  }

  contains(key) {
    return this.storage.has(key);
  }

  clearAll() {
    this.storage.clear();
  }

  getAllKeys() {
    return Array.from(this.storage.keys());
  }
}

// O app real usa a factory `createMMKV` (v4 do react-native-mmkv não exporta
// classe `MMKV` em runtime — só type). A classe acima é a implementação; a
// factory devolve uma instância dela, igual ao módulo real faz.
function createMMKV(config) {
  return new MMKV(config);
}

module.exports = { MMKV, createMMKV, __esModule: true };

// Helper dos testes: todas as instâncias criadas nesta suíte (limpas via
// storage.clear() ou resetMocks).
Object.defineProperty(MMKV, "instances", {
  get: () => Array.from(instances.values()),
});