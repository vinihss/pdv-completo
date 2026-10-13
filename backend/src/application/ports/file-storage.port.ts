import type { Buffer } from "node:buffer";
import type { TenantContext } from "./tenant-context.js";

export type FileKind = "product" | "logo" | "customer" | "user";

export interface StoredFile {
  body: Buffer;
  contentType: string;
  size: number;
  etag: string | null;
  lastModified: Date | null;
}

/** Tenant explícito; o contrato não revela filesystem, bucket nem schema PostgreSQL. */
export interface FileStoragePort {
  put(tenant: TenantContext, kind: FileKind, filename: string, body: Buffer): Promise<void>;
  get(tenant: TenantContext, kind: FileKind, filename: string): Promise<StoredFile | null>;
  remove(tenant: TenantContext, kind: FileKind, filename: string): Promise<boolean>;
}
