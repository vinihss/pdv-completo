import { config } from "../../config/env.js";
import { Errors } from "../../domain/errors.js";
import type { FileKind, FileStorage as FileStoragePort } from "../../application/ports/effects.js";
import type { TenantContext } from "../../application/ports/tenant-context.js";
import { LocalDiskStorage } from "./local-disk-storage.js";
import { isSafeFilename, type FileStorage, type StorageKind } from "./storage.js";

/**
 * Adapter do port `FileStorage` de `application/ports/effects.ts` — FASE 0.
 *
 * O port é DELIBERADAMENTE menor que a porta de infra de `storage.ts`:
 * só `put`/`remove` (efeitos de escrita dos use cases). Leitura/serving
 * continua na porta de infra (`get`/`exists`, rota `uploads.routes.ts`) —
 * não há leitura pelo port nesta fase.
 *
 * O schema do tenant é resolvido EXPLICITAMENTE pelo `tenant.schemaName`
 * recebido no construtor (a seam `resolveTenantSchema()` de `tenant.ts` lê
 * ALS; este adapter não depende dela). O layout em disco é o mesmo de sempre
 * (`<UPLOADS_DIR>/<schema>/<kind>/<filename>`, §4.7 do doc 15), a barreira de
 * isolamento continua sendo o segmento `<schema>` e o banco segue guardando
 * só o basename — nada disto muda.
 */
export class StoragePortAdapter implements FileStoragePort {
  /** Adapter de infra já ligado ao `schemaName` EXPLÍCITO deste tenant. */
  private readonly storage: FileStorage;

  /**
   * @param tenant contexto do tenant (só o `schemaName` é usado)
   * @param root raiz do volume de uploads (`config.uploadsDir` por default;
   *   injetável para teste com diretório temporário)
   */
  constructor(tenant: Pick<TenantContext, "schemaName">, root: string = config.uploadsDir) {
    this.storage = new LocalDiskStorage({ root, tenant: () => tenant.schemaName });
  }

  async put(kind: FileKind, filename: string, content: Buffer): Promise<void> {
    // Guarda no nível do port, independente do backend de storage: um nome
    // inseguro nunca vira caminho (mesma regra de `isSafeFilename`). Hoje o
    // `LocalDiskStorage.fileFor` também valida; aqui vale mesmo quando o
    // adapter de trás for trocado (S3/R2).
    if (!isSafeFilename(filename)) throw Errors.validationFailed({ field: "file" });
    await this.storage.put(kind as StorageKind, filename, content);
  }

  /** Arquivo órfão nunca é erro: o retorno booleano da infra é descartado. */
  async remove(kind: FileKind, filename: string): Promise<void> {
    if (!isSafeFilename(filename)) throw Errors.validationFailed({ field: "file" });
    await this.storage.remove(kind as StorageKind, filename);
  }
}
