# Splitting today's work, and the submodule

Nothing here has been committed: this is the map, you run the commands. Written because the
working tree holds two different kinds of change that belong on two different branches, and
telling them apart after the fact is much harder than before.

The rule that decides every line below: **does it work for any extension, or only for Code
Together?** Anything general is l8db's extension API and goes on the API branch. Only the
extension's own source is Code Together.

## 1. Rename the API branch

```bash
git branch -m feat/extension-api-collaboration feat/extension-api-extends
```

## 2. What belongs on `feat/extension-api-extends`

The base extension API/SDK of l8db. None of it mentions sessions, participants or pens.

**Changed**
```
packages/extension-api/src/index.ts        panel surface/bounds, PeerCursor, media types
packages/extension-api/src/manifest.ts     "surface": "tab" | "overlay" on a panel contribution
packages/extension-sdk-rs/src/api.rs       close_view, set_panel_bounds, set_panel_interactive,
                                           request_keyframe, storage helpers
src/lib/extensions/contracts.ts
src/lib/extensions/editor-bridge.ts
src/lib/extensions/editor-tabs-source.ts
src/lib/extensions/host.ts
src/lib/extensions/manager.ts              workspace.closeView, panels.setBounds/setInteractive,
                                           media.requestKeyframe
src/lib/extensions/media-bridge.ts         requestKeyframe on a track
src/lib/extensions/media-engine.ts         re-configure on resize, scale frames, content hint,
                                           screen bitrate, key frame on demand
src/lib/extensions/registries.ts           panel surface, interactive, bounds
src/lib/extensions/worker-bootstrap.js
src/features/extensions/extension-panel-view.tsx    transparent panels
src/features/extensions/extension-prompts.tsx       mounts the layer's components
src/features/query/query-editor-pane.tsx            10 lines: use the class names the layer
                                                    returns for peer cursors. No colour logic.
src-tauri/src/lib.rs, Cargo.toml, Cargo.lock        camera/microphone permission plumbing
tests/extension-media.test.ts
tests/extension-native-runtime.test.ts
```

**New**
```
src/lib/extensions/execution-gate.ts       hold SQL execution (any extension may)
src/lib/extensions/peer-cursors.ts         per-peer cursor colours, out of the query editor
src/lib/extensions/workspace-views.ts      report/open/close a window
src/features/extensions/extension-panel-opener.tsx
src/features/extensions/extension-panel-overlay.tsx   renders overlay panels
src/features/extensions/extension-tab-badges.tsx
src/features/extensions/extension-toolbar-items.tsx
src/features/extensions/extension-view-reporter.tsx
src-tauri/src/media_permissions.rs         WebView2 answers camera/microphone requests
tests/extension-execution-gate.test.ts
tests/extension-peer-cursors.test.ts
tests/extension-surfaces.test.ts
```

## 3. What belongs on `feat/code-together-extension`

Branched from the API branch, so it carries everything above plus:

```
.gitignore        only the two test-profile lines (.l8db-instance-*, .l8db-smoke);
                  the `extensions/code-together/target|bin` lines move into the submodule's own
                  .gitignore, because those paths stop existing in this repo
.gitmodules       written by `git submodule add` in step 4
extensions/code-together   a submodule pointer, not files
```

## 4. The extension's own repo — **done**

`extensions/code-together` is its own repository and a submodule of this one.

- 40 files, 643 KB, pushed to `git@github.com:KryonixMain/l8db_code_together.git` as commit
  `f548a0f` on `main`. `target/`, `bin/`, `panel/dist/` and `node_modules/` are ignored there.
- The fork stages `.gitmodules` and the gitlink `extensions/code-together` — both are in the index
  now, uncommitted, and belong to the `feat/code-together-extension` commit.
- Added from the repository that was already on disk rather than by cloning, so the built binary
  and the 1.6 GB `target/` were not thrown away and the two running l8db instances kept working.
- The two `extensions/code-together/target|bin` lines are out of this repo's `.gitignore`: those
  paths live in the submodule now, which ignores them itself.

`bin/code-together.exe` is ignored but the manifest points at it, so a fresh clone has to build the
extension once before l8db can load it — worth a line in the new repo's README.

## 5. Then rebase

```bash
git fetch origin                                   # origin/main is 19 commits ahead
git checkout feat/extension-api-extends && git rebase origin/main
git checkout feat/code-together-extension && git rebase feat/extension-api-extends
```

Expect conflicts in `src/lib/extensions/` and `packages/extension-api/`: those 19 commits touch
the same area. Everything is tested, so after the rebase the three suites are the check —
`bun test`, `cargo test` in the extension, and `node extensions/code-together/selftest.mjs`.
