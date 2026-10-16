import { request } from "@/shared/api/http";

export function listTables() {
  return request("GET", "/tables");
}
