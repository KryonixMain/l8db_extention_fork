# hello-rust-extension

A native l8db extension: it runs as its own process, talks to l8db over stdio, and opens a TCP
listener to show that a native extension can serve on the network without any host API.

## Build

```bash
cargo build --manifest-path examples/hello-rust-extension/Cargo.toml
mkdir -p examples/hello-rust-extension/bin
cp examples/hello-rust-extension/target/debug/hello-rust-extension* examples/hello-rust-extension/bin/
```

The copy matters. `l8db-extension.json` declares `"windows-x86_64": "bin/hello-rust-extension.exe"`,
and l8db resolves that path relative to the extension directory — it never looks in `target/`.
The path is also containment-checked in Rust, so it cannot point outside the extension directory.

## Load it

```bash
bun run extension dev examples/hello-rust-extension
```

Then in l8db: **Settings → Community Extensions → load development folder**, pick this directory.
The extension installs disabled; enabling it asks you to grant `runtime:native`, because a native
extension runs outside the JavaScript sandbox with the privileges of a normal process.

Commands: `Hello Rust: Greet` and `Hello Rust: Start a TCP echo listener`. The second prints its
address to the status bar; connect with `nc <address>` and every line comes back prefixed `echo`.

## Test it without l8db

```bash
node examples/hello-rust-extension/e2e.mjs
```

This plays l8db's side of the protocol over stdio, so it needs no GUI and no database. It covers
the full lifecycle (load, activate, execute, deactivate, terminate), RPC in both directions, error
propagation, a real peer connecting to the extension's socket, and a binary event whose payload
contains `0x0A` and `0x0D` — proving those bytes do not break the line framing.

## Writing your own

The trait is the whole surface:

```rust
#[l8db_extension::async_trait]
impl Extension for MyExtension {
    async fn activate(&mut self, context: &Context, api: &Api) -> Result<()> { Ok(()) }
    async fn execute(&mut self, command: &str, payload: Value, api: &Api) -> Result<Value> { … }
    async fn event(&mut self, name: &str, payload: Value, binary: Vec<u8>, api: &Api) { … }
    async fn deactivate(&mut self, api: &Api) -> Result<()> { Ok(()) }
}

fn main() -> Result<()> { l8db_extension::run(MyExtension::default()) }
```

`binary` is empty for ordinary events and carries the raw attachment for binary ones such as
`mediaFrame`.

**stdout is the protocol.** Printing to it corrupts the stream. Use `api.info(…)` for log lines, or
`eprintln!` — stderr is captured by l8db and surfaced as extension warnings.
