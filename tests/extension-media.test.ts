import { expect, test } from "bun:test";
import { validateManifest } from "../packages/extension-api/src/manifest";
import { MediaBridge } from "../src/lib/extensions/media-bridge";
import type { CapturedTrack, EncodedChunk, MediaEngine } from "../src/lib/extensions/media-engine";

const js = {
  id: "acme.demo",
  name: "Demo",
  version: "1.0.0",
  publisher: "acme",
  engines: { l8db: ">=0.5.0", api: "^1.2.0" as const },
  activationEvents: ["onStartup" as const],
  main: "extension.js",
};

test("media capability validates and requires its permission", () => {
  const media = {
    ...js,
    permissions: ["media:capture"],
    capabilities: { media: { camera: true, microphone: true } },
  };
  expect(validateManifest(media).capabilities?.media).toEqual({ camera: true, microphone: true });
  expect(() => validateManifest({ ...media, permissions: [] })).toThrow();
  expect(() => validateManifest({ ...media, capabilities: { media: {} } })).toThrow();
  expect(() =>
    validateManifest({ ...media, capabilities: { media: { camera: false, screen: false } } }),
  ).toThrow();
  expect(() =>
    validateManifest({ ...media, capabilities: { media: { camera: "yes" } } }),
  ).toThrow();
  expect(() => validateManifest({ ...media, capabilities: { media: { webcam: true } } })).toThrow();
  expect(() => validateManifest({ ...js, capabilities: { bluetooth: {} } })).toThrow();
});

test("network and process capabilities still validate", () => {
  const net = { ...js, permissions: ["network"], capabilities: { network: { hosts: ["e.com"] } } };
  expect(validateManifest(net).capabilities?.network?.hosts).toEqual(["e.com"]);
  const proc = {
    ...js,
    permissions: ["process:execute"],
    capabilities: { process: { commands: ["git"] } },
  };
  expect(validateManifest(proc).capabilities?.process?.commands).toEqual(["git"]);
});

interface FakeTrack extends CapturedTrack {
  stopped: boolean;
  isMuted: boolean;
  emit(chunk: EncodedChunk): void;
  end(): void;
}

function fakeEngine() {
  const created: FakeTrack[] = [];
  const engine: MediaEngine = {
    capture: async (_source, request) => {
      let sink: ((chunk: EncodedChunk) => void) | null = null;
      let ended: (() => void) | null = null;
      const track: FakeTrack = {
        stopped: false,
        isMuted: false,
        video: request.video !== false,
        audio: request.audio === true,
        width: 640,
        height: 480,
        setMuted: (value) => {
          track.isMuted = value;
        },
        onEnded: (listener) => {
          ended = listener;
        },
        start: (target) => {
          sink = target;
        },
        stop: () => {
          track.stopped = true;
        },
        emit: (chunk) => sink?.(chunk),
        end: () => ended?.(),
      };
      created.push(track);
      return track;
    },
  };
  return { created, engine };
}

const all = { camera: true, microphone: true, screen: true };
const chunk: EncodedChunk = {
  kind: "video",
  data: new Uint8Array([1, 2, 3]),
  keyframe: true,
  timestamp: 42,
  duration: 7,
};

test("frames are routed to the owning extension", async () => {
  const { created, engine } = fakeEngine();
  const bridge = new MediaBridge(engine);
  const frames: { owner: string; frame: { trackId: string }; data: Uint8Array }[] = [];
  bridge.onFrame((event) => frames.push(event));
  const info = await bridge.start("acme.demo", all, "camera", { video: true });
  created[0].emit(chunk);
  expect(frames).toHaveLength(1);
  expect(frames[0].owner).toBe("acme.demo");
  expect(frames[0].frame.trackId).toBe(info.trackId);
  expect([...frames[0].data]).toEqual([1, 2, 3]);
});

test("undeclared sources are refused before any capture happens", async () => {
  const { created, engine } = fakeEngine();
  const bridge = new MediaBridge(engine);
  expect(bridge.start("a.b", undefined, "camera", {})).rejects.toThrow();
  expect(bridge.start("a.b", { camera: true }, "screen", {})).rejects.toThrow();
  expect(bridge.start("a.b", { screen: true }, "camera", { video: true })).rejects.toThrow();
  expect(
    bridge.start("a.b", { camera: true }, "camera", { video: true, audio: true }),
  ).rejects.toThrow();
  expect(created).toHaveLength(0);
});

test("tracks are scoped to their owner", async () => {
  const { engine } = fakeEngine();
  const bridge = new MediaBridge(engine);
  const mine = await bridge.start("a.b", all, "camera", {});
  await bridge.start("c.d", all, "camera", {});
  expect(bridge.list("a.b").map((t) => t.trackId)).toEqual([mine.trackId]);
  expect(() => bridge.stop("c.d", mine.trackId)).toThrow();
  expect(() => bridge.setMuted("c.d", mine.trackId, true)).toThrow();
});

test("stop tears the track down and reports once", async () => {
  const { created, engine } = fakeEngine();
  const bridge = new MediaBridge(engine);
  const ended: unknown[] = [];
  bridge.onTrackEnded((event) => ended.push(event));
  const info = await bridge.start("a.b", all, "camera", {});
  bridge.stop("a.b", info.trackId);
  expect(created[0].stopped).toBe(true);
  expect(ended).toEqual([{ owner: "a.b", trackId: info.trackId }]);
  expect(() => bridge.stop("a.b", info.trackId)).toThrow();
});

test("a track the user ends reports itself and stops emitting", async () => {
  const { created, engine } = fakeEngine();
  const bridge = new MediaBridge(engine);
  const frames: unknown[] = [];
  const ended: unknown[] = [];
  bridge.onFrame((event) => frames.push(event));
  bridge.onTrackEnded((event) => ended.push(event));
  const info = await bridge.start("a.b", all, "screen", {});
  created[0].end();
  expect(ended).toEqual([{ owner: "a.b", trackId: info.trackId }]);
  created[0].emit(chunk);
  expect(frames).toHaveLength(0);
});

test("stopAll releases only that extension's tracks", async () => {
  const { engine } = fakeEngine();
  const bridge = new MediaBridge(engine);
  await bridge.start("a.b", all, "camera", {});
  await bridge.start("a.b", all, "screen", {});
  const other = await bridge.start("c.d", all, "camera", {});
  bridge.stopAll("a.b");
  expect(bridge.list("a.b")).toHaveLength(0);
  expect(bridge.list("c.d").map((t) => t.trackId)).toEqual([other.trackId]);
});

test("muting flows through to the track and the reported state", async () => {
  const { created, engine } = fakeEngine();
  const bridge = new MediaBridge(engine);
  const info = await bridge.start("a.b", all, "camera", {});
  bridge.setMuted("a.b", info.trackId, true);
  expect(created[0].isMuted).toBe(true);
  expect(bridge.list("a.b")[0].muted).toBe(true);
});

test("an extension cannot hold unlimited tracks", async () => {
  const { engine } = fakeEngine();
  const bridge = new MediaBridge(engine);
  for (let index = 0; index < 4; index += 1) await bridge.start("a.b", all, "camera", {});
  expect(bridge.start("a.b", all, "camera", {})).rejects.toThrow();
});
