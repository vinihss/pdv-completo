import { config } from "../../config/env.js";
import { ensureStorageRoot, LocalDiskStorage } from "./local-disk-storage.js";
import { resolveTenantSchema } from "./tenant.js";
import type { FileStorage } from "./storage.js";

/**
 * Fachada do storage: resolve o tenant por operação (a seam de `tenant.ts`) e
 * delega no adapter. É a única superfície que os use cases e a rota de serving
 * conhecem — trocar disco por S3/R2 é trocar o que `createStorage()` devolve.
 */

export function createStorage(
  root: string = config.uploadsDir,
  tenant: () => string = resolveTenantSchema
): FileStorage {
  return new LocalDiskStorage({ root, tenant });
}

let instance: FileStorage | null = null;

export function getStorage(): FileStorage {
  if (!instance) instance = createStorage();
  return instance;
}

/** Raiz do volume criada no boot (o resto do volume nasce na primeira escrita). */
export function initStorage(): void {
  ensureStorageRoot(config.uploadsDir);
}

export { resolveTenantSchema } from "./tenant.js";
export { storageDirFor, LocalDiskStorage } from "./local-disk-storage.js";
export {
  STORAGE_KINDS,
  UPLOADS_PREFIX,
  isSafeFilename,
  isServableFilename,
  isStorageKind,
  storageAssetPath,
  storageFilename,
} from "./storage.js";
export type { FileStorage, StorageKind, StoredObject } from "./storage.js";
