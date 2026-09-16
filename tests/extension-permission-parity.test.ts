import { expect, test } from "bun:test";
import { permissions } from "../packages/extension-api/src/manifest";
import { hostChannel } from "../src/lib/extensions/process-runtime";
import { PermissionManager } from "../src/lib/extensions/registries";

async function rustGrantablePermissions() {
  const source = await Bun.file("src-tauri/src/community_extensions.rs").text();
  const block = source.match(/GRANTABLE_PERMISSIONS: \[&str; (\d+)\] = \[([\s\S]*?)\];/);
  if (!block) throw new Error("GRANTABLE_PERMISSIONS not found in community_extensions.rs");
  const entries = [...block[2].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  expect(entries).toHaveLength(Number(block[1]));
  return entries;
}

test("the Rust storage allowlist matches the manifest permission list", async () => {
  expect([...(await rustGrantablePermissions())].sort()).toEqual([...permissions].sort());
});

test("the runtime permission manager matches the manifest permission list", () => {
  expect([...new PermissionManager().supported].sort()).toEqual([...permissions].sort());
});

test("host channel names stay within the Tauri event character set", async () => {
  const name = hostChannel("l8db.hello-rust");
  expect(name).toBe("extension-host://l8db_hello-rust");
  expect(name).toMatch(/^[A-Za-z0-9\-/:_]+$/);
  expect(hostChannel("a.b")).not.toBe(hostChannel("a.c"));
});

test("the Rust channel builder matches the TypeScript one", async () => {
  const source = await Bun.file("src-tauri/src/extension_host.rs").text();
  const body = source.match(
    /fn channel\(id: &str\) -> String \{\s*format!\("([^"]+)",\s*id\.replace\('([^']+)', "([^"]+)"\)\)/,
  );
  if (!body) throw new Error("channel() in extension_host.rs no longer has the expected shape");
  const [, template, from, to] = body;
  expect(template).toBe("extension-host://{}");
  expect(hostChannel("l8db.hello-rust")).toBe(
    `extension-host://${"l8db.hello-rust".replaceAll(from, to)}`,
  );
});

test("every declared permission can actually be granted", async () => {
  const rust = await rustGrantablePermissions();
  const manager = new PermissionManager();
  for (const permission of permissions) {
    expect(manager.supported).toContain(permission);
    expect(rust).toContain(permission);
  }
});
