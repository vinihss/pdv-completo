import fs from "node:fs";
import path from "node:path";
import { Errors } from "../../domain/errors.js";
import {
  contentTypeForFilename,
  isSafeFilename,
  isStorageKind,
  type FileStorage,
  type StorageKind,
  type StoredObject,
} from "./storage.js";

/**
 * Adapter de disco local da porta de storage (hoje o único).
 *
 * Layout, §4.7 do doc 15:
 *
 * ```
 * <root>/<schema>/<kind>/<filename>      kind ∈ product | logo | customer | user
 * uploads/public/logo/logo.png
 * uploads/public/product/0f9c….webp
 * ```
 *
 * O `<schema>` é a barreira de isolamento: a URL pública não o carrega, ele é
 * resolvido por operação (a seam em `tenant.ts`). É o que impede `logo.png` de
 * uma loja sobrescrever o da outra e faz a URL da loja A dar 404 na loja B por
 * construção — sem depender de nome de arquivo.
 */

/** Identificador de schema do Postgres: vira segmento de caminho, então é validado. */
const SCHEMA_RE = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;

export function storageDirFor(root: string, tenant: string, kind: StorageKind): string {
  if (!SCHEMA_RE.test(tenant)) throw Errors.validationFailed({ field: "tenant" });
  if (!isStorageKind(kind)) throw Errors.validationFailed({ field: "kind" });
  return path.join(root, tenant, kind);
}

/** Garante a raiz do volume (chamado no boot — o resto cria o diretório na escrita). */
export function ensureStorageRoot(root: string): void {
  fs.mkdirSync(path.resolve(root), { recursive: true });
}

export interface LocalDiskStorageOptions {
  /** Raiz do volume de uploads (`config.uploadsDir`). */
  root: string;
  /** Schema do tenant, resolvido por operação — a seam (`tenant.ts`). */
  tenant: () => string;
}

export class LocalDiskStorage implements FileStorage {
  private readonly root: string;
  private readonly tenant: () => string;

  constructor(opts: LocalDiskStorageOptions) {
    this.root = path.resolve(opts.root);
    this.tenant = opts.tenant;
  }

  /**
   * Caminho absoluto do arquivo, com as duas guardas: nome validado (`..`,
   * barra, absoluto fora) e, depois, o resolvido precisa continuar dentro da
   * raiz. Era o `startsWith(uploadsDir())` dos use cases — aqui é o adapter que
   * garante, porque é ele quem monta o caminho.
   */
  private fileFor(kind: StorageKind, filename: string): string {
    if (!isSafeFilename(filename)) throw Errors.validationFailed({ field: "file" });
    const full = path.resolve(storageDirFor(this.root, this.tenant(), kind), filename);
    if (full !== this.root && !full.startsWith(this.root + path.sep)) {
      throw Errors.validationFailed({ field: "file" });
    }
    return full;
  }

  async put(kind: StorageKind, filename: string, body: Buffer): Promise<void> {
    const file = this.fileFor(kind, filename);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  }

  async get(kind: StorageKind, filename: string): Promise<StoredObject | null> {
    const file = this.fileFor(kind, filename);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      return null; // inexistente — 404 na rota
    }
    if (!stat.isFile()) return null;
    return {
      body: fs.readFileSync(file),
      contentType: contentTypeForFilename(filename),
      size: stat.size,
      // Fraco de propósito: o conteúdo muda (upload novo no mesmo nome) sem
      // que o mtime resolva resolução de segundo. Evenemente serve como
      // dica de cache; o forte exigiria ler o arquivo inteiro.
      etag: `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`,
      lastModified: stat.mtime,
    };
  }

  async remove(kind: StorageKind, filename: string): Promise<boolean> {
    const file = this.fileFor(kind, filename);
    if (!fs.existsSync(file)) return false;
    try {
      fs.unlinkSync(file);
      return true;
    } catch {
      // Já removido, sem permissão, ou em uso — foto/logo órfão não impede
      // nada: a resposta da API é a mesma nos dois casos.
      return false;
    }
  }

  async exists(kind: StorageKind, filename: string): Promise<boolean> {
    return fs.existsSync(this.fileFor(kind, filename));
  }
}
