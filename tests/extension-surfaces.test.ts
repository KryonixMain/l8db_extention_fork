import { expect, test } from "bun:test";
import { validateManifest } from "../packages/extension-api/src/manifest";
import { CommandRegistry, PanelRegistry } from "../src/lib/extensions/registries";
import { useTableTabs } from "../src/lib/table-tabs";

const manifest = validateManifest({
  id: "acme.demo",
  name: "Demo",
  version: "1.0.0",
  publisher: "acme",
  engines: { l8db: ">=0.5.0", api: "^1.2.0" },
  main: "extension.js",
  activationEvents: ["onStartup"],
  contributes: {
    commands: [
      { id: "demo.open", title: "Demo: Open", icon: "users" },
      { id: "demo.hidden", title: "Demo: Hidden" },
    ],
    panels: [{ id: "demo.panel", title: "Demo Panel" }],
    menus: [
      { command: "demo.open", location: "toolbar" },
      { command: "demo.hidden", location: "palette" },
    ],
  },
});

test("an extension can put a command in the window toolbar", () => {
  const commands = new CommandRegistry();
  commands.reserve(manifest);
  const toolbar = commands.menusFor("toolbar");
  expect(toolbar.map((entry) => entry.command)).toEqual(["demo.open"]);
  expect(commands.list().find((entry) => entry.id === "demo.open")?.icon).toBe("users");
  expect(toolbar.some((entry) => entry.command === "demo.hidden")).toBe(false);
});

test("opening a panel marks it open with a fresh timestamp", () => {
  const panels = new PanelRegistry();
  panels.reserve(manifest);
  const before = Date.now();
  panels.open("acme.demo", "demo.panel", "<p>hello</p>");
  const snapshot = panels.list().find((entry) => entry.panelId === "demo.panel");
  expect(snapshot?.open).toBe(true);
  expect(snapshot?.updatedAt).toBeGreaterThanOrEqual(before);
  panels.close("acme.demo", "demo.panel");
  expect(panels.list().some((entry) => entry.panelId === "demo.panel")).toBe(false);
  panels.open("acme.demo", "demo.panel", "<p>again</p>");
  const reopened = panels.list().find((entry) => entry.panelId === "demo.panel");
  expect(reopened?.open).toBe(true);
  expect(reopened?.updatedAt).toBeGreaterThanOrEqual(snapshot?.updatedAt ?? 0);
});

test("a panel becomes a normal workspace tab, alongside tables and queries", () => {
  const tabs = useTableTabs.getState();
  tabs.closeAll?.();
  tabs.openExtensionPanel({
    extensionId: "acme.demo",
    panelId: "demo.panel",
    title: "Demo Panel",
  });
  const opened = useTableTabs.getState().tabs.find((tab) => tab.kind === "extension-panel");
  expect(opened).toBeTruthy();
  expect(opened).toMatchObject({
    kind: "extension-panel",
    extensionId: "acme.demo",
    panelId: "demo.panel",
  });
});

test("opening the same panel twice does not duplicate the tab", () => {
  const before = useTableTabs
    .getState()
    .tabs.filter((tab) => tab.kind === "extension-panel").length;
  useTableTabs.getState().openExtensionPanel({
    extensionId: "acme.demo",
    panelId: "demo.panel",
    title: "Demo Panel",
  });
  const after = useTableTabs.getState().tabs.filter((tab) => tab.kind === "extension-panel").length;
  expect(after).toBe(before);
});

const withOverlay = validateManifest({
  id: "acme.glass",
  name: "Glass",
  version: "1.0.0",
  publisher: "acme",
  engines: { l8db: ">=0.5.0", api: "^1.2.0" },
  main: "extension.js",
  activationEvents: ["onStartup"],
  contributes: {
    panels: [
      { id: "glass.tab", title: "Glass Tab" },
      { id: "glass.over", title: "Glass", surface: "overlay" },
    ],
  },
});

test("an overlay panel opens passive, and only its owner may give it the pointer", () => {
  const panels = new PanelRegistry();
  panels.reserve(withOverlay);
  panels.open("acme.glass", "glass.over", "<canvas></canvas>");
  const opened = panels.list().find((entry) => entry.panelId === "glass.over");
  expect(opened?.surface).toBe("overlay");
  expect(opened?.interactive).toBe(false);

  panels.setInteractive("acme.glass", "glass.over", true);
  expect(panels.list().find((entry) => entry.panelId === "glass.over")?.interactive).toBe(true);
  expect(() => panels.setInteractive("other.ext", "glass.over", true)).toThrow();
  panels.open("acme.glass", "glass.tab", "<p>hi</p>");
  expect(() => panels.setInteractive("acme.glass", "glass.tab", true)).toThrow();
});

test("a panel without a surface is still a tab, so nothing that exists today moves", () => {
  const panels = new PanelRegistry();
  panels.reserve(manifest);
  panels.open("acme.demo", "demo.panel", "<p>hello</p>");
  expect(panels.list().find((entry) => entry.panelId === "demo.panel")?.surface).toBe("tab");
});
