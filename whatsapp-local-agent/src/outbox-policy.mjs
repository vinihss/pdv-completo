const TERMINAL_STATUSES = new Set(["sent", "dry_run", "uncertain", "sending"]);

export function isDryRunEnabled(value) {
  return !/^(0|false|no|off)$/i.test(String(value ?? "").trim());
}

export function planOutboxDispatch(record, dryRun = true, maxAttempts = 3) {
  if (!record) return dryRun ? "dry_run" : "dispatch";
  if (TERMINAL_STATUSES.has(record.status)) return "suppress";
  if (record.status !== "failed") return "suppress";
  if (Number(record.attempts || 0) >= maxAttempts) return "attempt_limit";
  return dryRun ? "dry_run" : "dispatch";
}

export function outboxOutcomeAfterError(dispatchStarted) {
  return dispatchStarted ? "uncertain" : "failed";
}

export function recoverOutboxStatus(status) {
  return status === "sending" ? "uncertain" : status;
}
