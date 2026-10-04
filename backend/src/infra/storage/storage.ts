/**
 * Porta de storage de arquivos — §4.7 de `docs/15-multi-tenant-schema.md`.
 *
 * O banco guarda **só o nome do arquivo** (`products.image_path`,
 * `store_settings.logo_path`, `user.photo_path`, `customer.photo_path`) e o
 * arquivo mora em `<UPLOADS_DIR>/<schema>/<kind>/<filename>`. Esta porta é o
 * ÚNICO lugar do backend que conhece esse layout: antes dela existiam 4 cópias
 * independentes da mesma lógica, uma por coluna, cada uma com seu
 * `uploadsDir()`/`removeFile()`.
 *
 * Nada aqui é específico de `fs` — é a mesma promessa que a §4.1 do doc faz
 * pelo `db`: quando S3/R2 entrar, troca o adapter e nenhum use case muda. Por
 * isso a interface fala em `(kind, filename)` e devolve **bytes + metadados**,
 * e o schema do tenant é resolvido por fora (a seam em `tenant.ts`).
 */

/** Domínios de arquivo que o app guarda. É também a whitelist da rota de serving. */
export const STORAGE_KINDS = ["product", "logo", "customer", "user"] as const;
export type StorageKind = (typeof STORAGE_KINDS)[number];

export function isStorageKind(value: string): value is StorageKind {
  return (STORAGE_KINDS as readonly string[]).includes(value);
}

/** Prefixo público servido pelo backend. Não muda (o `Caddyfile` e o compose dependem dele). */
export const UPLOADS_PREFIX = "/uploads";

/**
 * Caminho público que a API devolve. Um segmento a mais que antes
 * (`/uploads/<filename>` → `/uploads/<kind>/<filename>`), porque o layout em
 * disco passou a ter o tenant no meio.
 */
export function storageAssetPath(kind: StorageKind, filename: string): string {
  return `${UPLOADS_PREFIX}/${kind}/${filename}`;
}

/**
 * Só aceitamos o que o upload aceita (`imageExtByMime` em
 * `http/routes/misc.routes.ts`). Servir qualquer outra extensão é superfície de
 * XSS sem ganho: nenhum arquivo gravado pelo app tem outra terminação.
 */
const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

function extensionOf(filename: string): string | null {
  const dot = filename.lastIndexOf(".");
  if (dot <= 0 || dot === filename.length - 1) return null;
  return filename.slice(dot + 1).toLowerCase();
}

/** `true` quando a extensão é servível (o resto cai em 404 na rota). */
export function isServableFilename(filename: string): boolean {
  const ext = extensionOf(filename);
  return ext !== null && ext in CONTENT_TYPE_BY_EXT;
}

/**
 * MIME pela extensão. Extensão desconhecida vira `application/octet-stream` —
 * a rota já recusou antes de chegar aqui, mas um adapter novo (S3) pode devolver
 * o que o bucket tem.
 */
export function contentTypeForFilename(filename: string): string {
  const ext = extensionOf(filename);
  return (ext !== null && CONTENT_TYPE_BY_EXT[ext]) || "application/octet-stream";
}

/**
 * Nome de arquivo aceito: só basename, sem traversal e sem caminho absoluto.
 *
 * O nome **sempre** é gerado pelo app (`<id>.<ext>`, ou `logo.<ext>`), nunca
 * o que o cliente enviou no multipart — essa é a primeira guarda. Esta é a
 * segunda: `basename`/`..`/barra rejeitados na entrada, para que nem um
 * registro adulterado no banco vire leitura de arquivo fora do volume.
 */
const FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,190}$/;

export function isSafeFilename(filename: string): boolean {
  if (!filename || filename.length > 200) return false;
  if (filename.includes("/") || filename.includes("\\") || filename.includes("\0")) return false;
  if (filename === "." || filename === "..") return false;
  return FILENAME_RE.test(filename);
}

/**
 * Normaliza o que está no banco para o nome de arquivo: as colunas guardam só
 * o basename, mas um valor legado (`sub/dir/x.png`) não pode virar caminho —
 * `split` em `/` e `\`, e o resto é o nome.
 */
export function storageFilename(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const name = raw.split(/[\\/]/).pop() ?? "";
  return name.length > 0 ? name : null;
}

export interface StoredObject {
  body: Buffer;
  contentType: string;
  size: number;
  /**
   * Identificador de versão, para `if-none-match` → 304. Fraco: o adapter
   * decide (o de disco deriva de tamanho+mtime, que só não acerta dentro da
   * mesma milissegundo). `null` quando o adapter não souber — a rota só
   * responde 304 com ETag.
   */
  etag: string | null;
  lastModified: Date | null;
}

export interface FileStorage {
  /** Grava (sobrescreve) o corpo. Cria o diretório do tenant/kind se preciso. */
  put(kind: StorageKind, filename: string, body: Buffer): Promise<void>;
  /** Lê o objeto; `null` quando não existe (ou não é um arquivo). */
  get(kind: StorageKind, filename: string): Promise<StoredObject | null>;
  /** Remove; `false` quando já não existia. Arquivo órfão nunca é erro. */
  remove(kind: StorageKind, filename: string): Promise<boolean>;
  exists(kind: StorageKind, filename: string): Promise<boolean>;
}
