import test from "node:test";
import assert from "node:assert/strict";
import { isDryRunEnabled, outboxOutcomeAfterError, planOutboxDispatch, recoverOutboxStatus } from "./outbox-policy.mjs";

test("modo simulação fica ligado por padrão e envio real exige opt-in explícito", () => {
  assert.equal(isDryRunEnabled(undefined), true);
  assert.equal(isDryRunEnabled("1"), true);
  assert.equal(isDryRunEnabled("0"), false);
  assert.equal(isDryRunEnabled("false"), false);
});

test("novo envio só é despachado quando simulação está desligada", () => {
  assert.equal(planOutboxDispatch(null), "dry_run");
  assert.equal(planOutboxDispatch(null, false), "dispatch");
  assert.equal(planOutboxDispatch(null, true), "dry_run");
});

test("envios enviados, em andamento, simulados ou incertos nunca são repetidos", () => {
  for (const status of ["sent", "sending", "dry_run", "uncertain"]) {
    assert.equal(planOutboxDispatch({ status, attempts: 1 }, false), "suppress");
  }
});

test("falha antes de iniciar Enter pode ter retry limitado; resultado incerto nunca", () => {
  assert.equal(planOutboxDispatch({ status: "failed", attempts: 1 }, false), "dispatch");
  assert.equal(planOutboxDispatch({ status: "failed", attempts: 3 }, false), "attempt_limit");
  assert.equal(outboxOutcomeAfterError(false), "failed");
  assert.equal(outboxOutcomeAfterError(true), "uncertain");
});

test("falha já recuperada em modo simulação é registrada sem envio", () => {
  assert.equal(planOutboxDispatch({ status: "failed", attempts: 1 }, true), "dry_run");
});

test("envio interrompido é recuperado como incerto, não reenviável", () => {
  const status = recoverOutboxStatus("sending");
  assert.equal(status, "uncertain");
  assert.equal(planOutboxDispatch({ status, attempts: 1 }, false), "suppress");
});
