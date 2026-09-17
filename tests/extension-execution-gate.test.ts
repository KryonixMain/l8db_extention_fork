import { expect, test } from "bun:test";
import {
  executionHold,
  holdExecution,
  installExecutionGate,
  releaseExecution,
  requireExecutionAllowed,
} from "../src/lib/extensions/execution-gate";

function fakeTauri() {
  const seen: string[] = [];
  (globalThis as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: (command: string) => {
      seen.push(command);
      return Promise.resolve("ran");
    },
  };
  return seen;
}

test("a hold stops statements reaching the database and lets everything else through", async () => {
  const seen = fakeTauri();
  const remove = installExecutionGate();
  const internals = (globalThis as unknown as { __TAURI_INTERNALS__: { invoke: Function } })
    .__TAURI_INTERNALS__;

  await expect(internals.invoke("execute_query")).resolves.toBe("ran");

  holdExecution("acme.demo", "Ask the host for full access.");
  await expect(internals.invoke("execute_query")).rejects.toThrow(/full access/);
  await expect(internals.invoke("execute_query_with_params")).rejects.toThrow(/full access/);
  await expect(internals.invoke("list_schemas")).resolves.toBe("ran");
  expect(seen).toEqual(["execute_query", "list_schemas"]);

  holdExecution("acme.demo", null);
  await expect(internals.invoke("execute_query")).resolves.toBe("ran");
  remove();
});

test("only the extension that set a hold can lift it, and stopping releases it", () => {
  holdExecution("acme.demo", "held");
  expect(() => holdExecution("other.ext", null)).toThrow(/already held/);
  expect(executionHold()).toBe("held");
  expect(() => requireExecutionAllowed()).toThrow(/held/);

  releaseExecution("other.ext");
  expect(executionHold()).toBe("held");
  releaseExecution("acme.demo");
  expect(executionHold()).toBeNull();
  requireExecutionAllowed();
});

test("a webview that refuses the patch costs nothing but the hold", async () => {
  const original = () => Promise.resolve("ran");
  const internals = {};
  Object.defineProperty(internals, "invoke", { value: original, writable: false });
  (globalThis as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = internals;

  let remove: (() => void) | undefined;
  expect(() => {
    remove = installExecutionGate();
  }).not.toThrow();

  holdExecution("acme.demo", "held");
  await expect(
    (internals as { invoke: () => Promise<string> }).invoke(),
  ).resolves.toBe("ran");
  holdExecution("acme.demo", null);
  expect(() => remove?.()).not.toThrow();
});
