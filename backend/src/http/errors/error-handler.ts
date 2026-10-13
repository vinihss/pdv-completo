import type{ FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { AppError } from "../../domain/errors.js";

export function configureGlobalErrorHandler(app: FastifyInstance) {
    app.setErrorHandler((err, _req, reply) => {
        if (err instanceof AppError) {
            return reply.code(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
        }

        const isZodError =
            err instanceof ZodError ||
            (typeof err === "object" &&
                err !== null &&
                (err as { name?: unknown }).name === "ZodError" &&
                Array.isArray((err as { issues?: unknown }).issues));

        if (isZodError) {
            return reply
                .code(400)
                .send({ error: { code: "validation_failed", message: "Payload inválido.", details: (err as ZodError).issues } });
        }

        app.log.error(err);
        return reply.code(500).send({ error: { code: "internal_error", message: "Erro interno." } });
    });
}
