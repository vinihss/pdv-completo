/**
 * MIME aceitos nos uploads de imagem (logo, foto de produto, foto de usuário,
 * foto de cliente) → extensão de arquivo.
 *
 * Módulo compartilhado entre as rotas (antes morava em `misc.routes.ts`,
 * que era o "saco de tudo"). A lista precisa ser a MESMA em todos os uploads:
 * `POST /auth/me/photo` (self-service, em `auth.routes.ts`) valida com esta
 * régua porque senão o usuário não consegue subir a foto que o gerente
 * subiria por ele.
 */
export const imageExtByMime: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};
