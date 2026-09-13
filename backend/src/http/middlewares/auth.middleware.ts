import type { FastifyRequest, FastifyReply } from "fastify";
import jwt from "jsonwebtoken";
import { config } from "../../config/env.js";
import { Errors } from "../../domain/errors.js";

export interface AuthUser {
  sub: string; // user id
  role: "waiter" | "kitchen" | "manager" | "courier";
}

declare module "fastify" {
  interface FastifyRequest {
    authUser?: AuthUser;
  }
}

export async function authMiddleware(req: FastifyRequest, _reply: FastifyReply) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) throw Errors.unauthorized();
  const token = header.slice("Bearer ".length);
  try {
    const payload = jwt.verify(token, config.jwtSecret) as AuthUser;
    req.authUser = payload;
  } catch {
    throw Errors.unauthorized();
  }
}

export function requireRole(...roles: Array<"waiter" | "kitchen" | "manager" | "courier">) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    if (!req.authUser) throw Errors.unauthorized();
    if (!roles.includes(req.authUser.role)) throw Errors.forbiddenRole();
  };
}

export function verifyTokenRaw(token: string): AuthUser {
  return jwt.verify(token, config.jwtSecret) as AuthUser;
}
