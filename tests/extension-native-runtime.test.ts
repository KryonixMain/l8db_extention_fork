import { expect, test } from "bun:test";
import {
  validateArchive,
  validateManifest,
} from "../packages/extension-api/src/manifest";
import {
  applyChanges,
  diffChange,
  EditorBridge,
  type EditorSurface,
} from "../src/lib/extensions/editor-bridge";

const base = {
  id: "acme.demo",
  name: "Demo",
  version: "1.0.0",
  publisher: "acme",
  engines: { l8db: ">=0.5.0", api: "^1.2.0" as const },
  activationEvents: ["onStartup" as const],
};

const js = { ...base, main: "./extension.js" };
const native = {
  ...base,
  runtime: "native",
  permissions: ["runtime:native"],
  executables: { "windows-x86_64": "./bin/demo.exe", "linux-x86_64": "bin/demo" },
};

test("javascript manifests keep validating unchanged", () => {
  const result = validateManifest(js);
  expect(result.main).toBe("extension.js");
  expect(result.runtime).toBeUndefined();
  expect(validateManifest({ ...base, main: "a.js", engines: { l8db: ">=0.5.0" } }).engines.api).toBe(
    "^1.0.0",
  );
});

test("native manifests normalise their executables", () => {
  const result = validateManifest(native);
  expect(result.runtime).toBe("native");
  expect(result.main).toBeUndefined();
  expect(result.executables).toEqual({
    "windows-x86_64": "bin/demo.exe",
    "linux-x86_64": "bin/demo",
  });
});

test("native manifests must declare runtime:native", () => {
  expect(() => validateManifest({ ...native, permissions: [] })).toThrow();
  expect(() => validateManifest({ ...native, permissions: undefined })).toThrow();
});

test("main and executables are mutually exclusive", () => {
  expect(() => validateManifest({ ...native, main: "extension.js" })).toThrow();
  expect(() => validateManifest({ ...js, executables: { "linux-x86_64": "bin/demo" } })).toThrow();
});

test("executable paths cannot escape the extension directory", () => {
  for (const path of ["../../etc/passwd", "/abs/bin", ""])
    expect(() => validateManifest({ ...native, executables: { "linux-x86_64": path } })).toThrow();
  expect(() =>
    validateManifest({ ...native, executables: { "plan9-x86_64": "bin/demo" } }),
  ).toThrow();
  expect(() => validateManifest({ ...native, executables: {} })).toThrow();
});

test("unknown runtimes are rejected", () => {
  expect(() => validateManifest({ ...js, runtime: "wasm" })).toThrow();
});

test("archives require an entry point only for javascript extensions", () => {
  expect(() =>
    validateArchive({ format: 1, manifest: js, files: {} }),
  ).toThrow(/Missing entry point/);
  expect(validateArchive({ format: 1, manifest: native, files: {} }).manifest.runtime).toBe(
    "native",
  );
});

function surface(documents: Record<string, string>) {
  const state = new Map(Object.entries(documents));
  const handle: EditorSurface & { state: Map<string, string> } = {
    state,
    listDocuments: () =>
      [...state.keys()].map((documentId) => ({
        documentId,
        title: documentId,
        languageId: "sql",
        version: 1,
      })),
    readDocument: (id) =>
      state.has(id) ? { title: id, languageId: "sql", text: state.get(id)! } : null,
    replaceText: (id, text) => {
      state.set(id, text);
    },
  };
  return handle;
}

test("applyChanges edits against the original offsets", () => {
  expect(applyChanges("hello", [{ start: 5, end: 5, text: " world" }])).toBe("hello world");
  expect(applyChanges("hello world", [{ start: 5, end: 11, text: "" }])).toBe("hello");
  expect(
    applyChanges("abcdef", [
      { start: 0, end: 1, text: "X" },
      { start: 5, end: 6, text: "Y" },
    ]),
  ).toBe("XbcdeY");
});

test("applyChanges rejects out-of-bounds ranges", () => {
  expect(() => applyChanges("abc", [{ start: 0, end: 99, text: "" }])).toThrow();
  expect(() => applyChanges("abc", [{ start: 2, end: 1, text: "" }])).toThrow();
  expect(() => applyChanges("abc", [{ start: -1, end: 1, text: "" }])).toThrow();
});

test("diffChange round-trips through applyChanges", () => {
  const pairs = [
    ["", "hello"],
    ["hello", ""],
    ["select 1", "select 1 union select 2"],
    ["aaa", "aa"],
    ["abc", "axc"],
    ["line1\nline2", "line1\nline2\nline3"],
  ];
  for (const [before, after] of pairs) {
    const change = diffChange(before, after);
    expect(applyChanges(before, change ? [change] : [])).toBe(after);
  }
  expect(diffChange("same", "same")).toBeNull();
});

test("applyEdits writes through and bumps the version", () => {
  const bridge = new EditorBridge();
  const target = surface({ tab1: "select 1" });
  bridge.attach(target);
  expect(bridge.getDocument("tab1").version).toBe(1);
  expect(bridge.applyEdits("tab1", [{ start: 7, end: 8, text: "2" }])).toBe(2);
  expect(target.state.get("tab1")).toBe("select 2");
});

test("applyEdits refuses a stale base version", () => {
  const bridge = new EditorBridge();
  bridge.attach(surface({ tab1: "select 1" }));
  bridge.applyEdits("tab1", [{ start: 7, end: 8, text: "2" }], 1);
  expect(() => bridge.applyEdits("tab1", [{ start: 7, end: 8, text: "3" }], 1)).toThrow();
});

test("a detached editor and unknown documents fail loudly", () => {
  const bridge = new EditorBridge();
  expect(() => bridge.getActive()).toThrow();
  const handle = bridge.attach(surface({ tab1: "x" }));
  expect(() => bridge.getDocument("nope")).toThrow();
  handle.dispose();
  expect(() => bridge.getActive()).toThrow();
});

test("reportContent emits one incremental change per edit", () => {
  const bridge = new EditorBridge();
  bridge.attach(surface({ tab1: "select 1" }));
  const seen: { changes: unknown[]; version: number }[] = [];
  bridge.onContentChanged((event) => seen.push(event));
  bridge.getDocument("tab1");
  bridge.reportContent("tab1", "select 12");
  bridge.reportContent("tab1", "select 12");
  expect(seen).toHaveLength(1);
  expect(seen[0].changes).toEqual([{ start: 8, end: 8, text: "2" }]);
  expect(seen[0].version).toBe(2);
});

test("setActive drives getActive and emits once per change", () => {
  const bridge = new EditorBridge();
  bridge.attach(surface({ tab1: "select 1", tab2: "select 2" }));
  const seen: unknown[] = [];
  bridge.onActiveChanged((event) => seen.push(event));
  expect(bridge.getActive()).toBeNull();
  bridge.setActive("tab2");
  expect(bridge.getActive()?.documentId).toBe("tab2");
  bridge.setActive("tab2");
  bridge.setActive(null);
  expect(seen).toHaveLength(2);
});

test("selections and peer cursors need a visible view", () => {
  const bridge = new EditorBridge();
  bridge.attach(surface({ tab1: "select 1" }));
  expect(() => bridge.getSelection("tab1")).toThrow();
  const calls: unknown[] = [];
  const view = bridge.attachView("tab1", {
    getSelection: () => ({ anchor: 1, active: 4 }),
    setSelection: (anchor, active) => calls.push(["set", anchor, active]),
    reveal: (offset) => calls.push(["reveal", offset]),
    setPeerCursors: (cursors) => calls.push(["peers", cursors.length]),
  });
  expect(bridge.getSelection("tab1")).toEqual({ documentId: "tab1", anchor: 1, active: 4 });
  bridge.setSelection("tab1", 2, 3);
  bridge.reveal("tab1", 5);
  bridge.setPeerCursors("tab1", [
    { peerId: "p", label: "P", color: "#ff0000", anchor: 0, active: 0 },
  ]);
  expect(calls).toEqual([
    ["set", 2, 3],
    ["reveal", 5],
    ["peers", 1],
  ]);
  view.dispose();
  expect(() => bridge.getSelection("tab1")).toThrow();
});

test("reportActive only fires on a real change", () => {
  const bridge = new EditorBridge();
  const seen: unknown[] = [];
  bridge.onActiveChanged((event) => seen.push(event));
  const info = { documentId: "tab1", title: "tab1", languageId: "sql", version: 1 };
  bridge.reportActive(info);
  bridge.reportActive(info);
  bridge.reportActive(null);
  expect(seen).toHaveLength(2);
  expect(seen[1]).toBeNull();
});
