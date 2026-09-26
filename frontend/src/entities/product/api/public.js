import { request } from "@/shared/api/http";

// Cardápio público (sem auth — ver public.routes.ts)
export function getPublicMenu() {
  return request("GET", "/public/menu");
}
