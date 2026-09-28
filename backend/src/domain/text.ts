// Texto: normalização de acentos para busca. O banco aplica a mesma regra
// via extensão `unaccent` (migration 0003) — as duas pontas precisam
// normalizar igual, senão "Cerveja" não acharia "CERVEJA" num banco sem a
// extensão instalada.
export function normalizeAccents(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}
