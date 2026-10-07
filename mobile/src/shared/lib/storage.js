// Adapter de storage com a API síncrona do `localStorage` por cima do
// react-native-mmkv (`getItem/setItem/removeItem/clear`).
//
// É o que permite copiar módulos prontos do frontend web — que gravam em
// `localStorage` (`pdv:server`, `pdv:session`, …) — quase sem mudança: basta
// trocar o import. A leitura também é síncrona, então o boot não precisa de
// await para restaurar estado.
//
// MMKV (arquivo no sandbox do app) foi escolhido no lugar do SecureStore/Keychain
// para o armazenamento GERAL por ser síncrono e por um único storage cobrir
// config e sessão. A decisão sobre onde fica o TOKEN está comentada no
// AuthProvider (app/providers/auth/AuthProvider.jsx).

import { MMKV } from "react-native-mmkv";

const store = new MMKV({ id: "pdv-storage" });

export const storage = {
  getItem(key) {
    const value = store.getString(key);
    return value === undefined ? null : value;
  },
  setItem(key, value) {
    store.set(key, value);
  },
  removeItem(key) {
    store.remove(key);
  },
  clear() {
    store.clearAll();
  },
  get length() {
    // Não é usado pelo app; exposto por paridade com localStorage.
    throw new Error("storage.length não suportado (use clear/removeItem)");
  },
  key() {
    throw new Error("storage.key não suportado (MMKV é mapa por chave)");
  },
};

export default storage;