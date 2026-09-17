import { ExtensionError } from "./contracts";

type Listener = (reason: string | null) => void;

let heldBy: string | null = null;
let reason: string | null = null;
const listeners = new Set<Listener>();

export function holdExecution(extensionId: string, why: string | null) {
  if (heldBy !== null && heldBy !== extensionId)
    throw new ExtensionError("PermissionDeniedError", `Execution is already held by ${heldBy}`);
  heldBy = why === null ? null : extensionId;
  reason = why;
  for (const listener of listeners) listener(reason);
}

export function releaseExecution(extensionId: string) {
  if (heldBy !== extensionId) return;
  heldBy = null;
  reason = null;
  for (const listener of listeners) listener(null);
}

export function executionHold(): string | null {
  return reason;
}

export function requireExecutionAllowed() {
  if (reason !== null) throw new Error(reason);
}

export function onExecutionHoldChanged(listener: Listener) {
  listeners.add(listener);
  return { dispose: () => listeners.delete(listener) };
}

const SQL_COMMANDS = new Set([
  "execute_query",
  "execute_query_with_params",
  "execute_in_transaction",
  "execute_in_transaction_with_params",
  "execute_script",
]);

export function installExecutionGate(): () => void {
  const internals = (
    globalThis as unknown as {
      __TAURI_INTERNALS__?: { invoke?: (...args: unknown[]) => unknown };
    }
  ).__TAURI_INTERNALS__;
  const original = internals?.invoke;
  if (!internals || typeof original !== "function") return () => undefined;
  try {
    internals.invoke = (...args: unknown[]) => {
      if (typeof args[0] === "string" && SQL_COMMANDS.has(args[0]) && reason !== null)
        return Promise.reject(new Error(reason));
      return original.apply(internals, args);
    };
  } catch {
    return () => undefined;
  }
  return () => {
    try {
      internals.invoke = original;
    } catch {
      // left as it is; the hold is lifted => because `reason` is cleared
    }
  };
}

export function executionGateInstalled(): boolean {
  const internals = (globalThis as unknown as { __TAURI_INTERNALS__?: unknown })
    .__TAURI_INTERNALS__;
  return Boolean(internals);
}
