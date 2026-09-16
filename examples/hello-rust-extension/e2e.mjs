import { spawn } from "node:child_process";
import { connect } from "node:net";
import assert from "node:assert/strict";
import process from "node:process";

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const suffix = process.platform === "win32" ? ".exe" : "";
const BIN = ["release", "debug"].map((profile) => join(here, "target", profile, `hello-rust-extension${suffix}`)).find((candidate) => existsSync(candidate));
if (!BIN) {
  console.error("Build the example first: cargo build --manifest-path examples/hello-rust-extension/Cargo.toml");
  process.exit(1);
}

const child = spawn(BIN, [], { stdio: ["pipe", "pipe", "pipe"] });
const pending = new Map();
const rpcLog = [];
let sequence = 0;
let buffer = "";

child.stderr.on("data", (chunk) => console.error("  [stderr]", String(chunk).trim()));

child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.type === "result") {
      const request = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error));
      else request.resolve(message.value);
    } else if (message.type === "rpc") {
      rpcLog.push({ method: message.method, args: message.args });
      send({ type: "rpc-result", id: message.id, value: null });
    } else if (message.type === "crash") {
      console.error("  [crash]", message.error);
      process.exitCode = 1;
    }
  }
});

const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);

const sendBinary = (message, bytes) => {
  child.stdin.write(JSON.stringify({ ...message, bytes: bytes.length }) + String.fromCharCode(10));
  child.stdin.write(Buffer.from(bytes));
};

const request = (method, data = {}) => {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ type: "request", id, method, ...data });
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`${method} timed out`));
    }, 10000);
  });
};

const waitForRpc = async (method) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const found = rpcLog.find((entry) => entry.method === method);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`extension never called ${method}; saw ${rpcLog.map((e) => e.method).join(", ")}`);
};

let passed = 0;
const test = async (name, run) => {
  await run();
  passed += 1;
  console.log(`  ok  ${name}`);
};

await test("load hands the extension its context", async () => {
  const value = await request("load", {
    context: {
      extensionId: "l8db.hello-rust",
      extensionPath: "extension://l8db.hello-rust/",
      storagePath: "extension-storage://l8db.hello-rust/",
    },
  });
  assert.equal(value, null);
});

await test("activate registers the contributed commands", async () => {
  await request("activate");
  const registered = rpcLog.filter((entry) => entry.method === "commands.register").map((entry) => entry.args[0]).sort();
  assert.deepEqual(registered, ["hello.greet", "hello.listen"]);
});

await test("activate logs through the host logger, not stdout", async () => {
  const logged = await waitForRpc("logger");
  assert.equal(logged.args[0], "info");
  assert.match(logged.args[1], /activated as l8db\.hello-rust/);
});

await test("execute runs a command and returns its value", async () => {
  const value = await request("execute", { command: "hello.greet", payload: { name: "Hendrik" } });
  assert.deepEqual(value, { greeted: "Hendrik" });
  const shown = await waitForRpc("notifications.show");
  assert.deepEqual(shown.args.slice(0, 2), ["info", "Hello, Hendrik!"]);
});

await test("unknown commands surface as an error result", async () => {
  await assert.rejects(() => request("execute", { command: "hello.nope", payload: null }), /CommandNotFoundError: hello\.nope/);
});

let address;
await test("the extension opens a real listening socket", async () => {
  const value = await request("execute", { command: "hello.listen", payload: null });
  assert.equal(value.reused, false);
  assert.match(value.address, /^0\.0\.0\.0:\d+$/);
  address = value.address;
  const status = await waitForRpc("statusBar.set");
  assert.equal(status.args[0], "hello.listener");
});

await test("a peer can connect to that socket and exchange data", async () => {
  const port = Number(address.split(":")[1]);
  const reply = await new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port }, () => socket.write("ping\n"));
    socket.setTimeout(5000, () => reject(new Error("peer connection timed out")));
    socket.on("data", (data) => {
      resolve(String(data));
      socket.end();
    });
    socket.on("error", reject);
  });
  assert.match(reply, /^echo ping/);
});

await test("serving twice reuses the existing session", async () => {
  const value = await request("execute", { command: "hello.listen", payload: null });
  assert.equal(value.reused, true);
  assert.equal(value.address, address);
});

await test("deactivate releases the session", async () => {
  await request("deactivate");
  await waitForRpc("statusBar.hide");
});

await test("a binary event arrives byte-exact, including non-UTF8 bytes", async () => {
  const bytes = [0, 1, 250, 255, 10, 13, 0x1b, 200];
  const checksum = bytes.reduce((a, b) => a + b, 0);
  sendBinary(
    { type: "event", name: "mediaFrame", payload: { trackId: "t1", kind: "video" } },
    bytes,
  );
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const found = rpcLog.find((e) => e.method === "logger" && String(e.args[1]).startsWith("frame t1"));
    if (found) {
      assert.equal(found.args[1], `frame t1 bytes=${bytes.length} checksum=${checksum}`);
      return;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("extension never reported the binary frame");
});

await test("the protocol stays in sync after a binary attachment", async () => {
  const value = await request("execute", { command: "hello.greet", payload: { name: "after" } });
  assert.deepEqual(value, { greeted: "after" });
});

await test("terminate stops the process", async () => {
  send({ type: "terminate" });
  const code = await new Promise((resolve) => child.on("exit", resolve));
  assert.equal(code, 0);
});

console.log(`\n${passed} passed`);
