import type { EntityId } from "../persistence.js";
export interface UserRecord { id: EntityId; name: string; role: string; active: boolean; pinHash: string }
export interface UserRepository {
  findById(id: EntityId): Promise<UserRecord | null>;
  findByLogin(login: string): Promise<UserRecord | null>;
  listActive(): Promise<Array<Pick<UserRecord, "id" | "name" | "role">>>;
  save(input: Omit<UserRecord, "id"> & { id?: EntityId }): Promise<UserRecord>;
  setActive(id: EntityId, active: boolean): Promise<void>;
}
