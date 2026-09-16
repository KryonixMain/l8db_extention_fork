import type {
  MediaCapabilities,
  MediaFrameMeta,
  MediaRequest,
  MediaSource,
  MediaTrackInfo,
} from "../../../packages/extension-api/src";
import { ExtensionError } from "./contracts";
import type { CapturedTrack, MediaEngine } from "./media-engine";
import { webCodecsEngine } from "./media-engine";

const MAX_TRACKS_PER_EXTENSION = 4;

type Listener<T> = (event: T) => void;

interface Entry {
  owner: string;
  info: MediaTrackInfo;
  track: CapturedTrack;
}

export interface FrameEvent {
  owner: string;
  frame: MediaFrameMeta;
  data: Uint8Array;
}

export class MediaBridge {
  private entries = new Map<string, Entry>();
  private frameListeners = new Set<Listener<FrameEvent>>();
  private endedListeners = new Set<Listener<{ owner: string; trackId: string }>>();
  private sequence = 0;
  constructor(private readonly engine: MediaEngine = webCodecsEngine) {}

  private allowed(
    capabilities: MediaCapabilities | undefined,
    source: MediaSource,
    request: MediaRequest,
  ) {
    if (!capabilities) throw new ExtensionError("PermissionDeniedError", "No media capability declared");
    if (source === "screen" && capabilities.screen !== true) throw new ExtensionError("PermissionDeniedError", "Screen capture is not declared");
    if (source === "camera") {
      if (request.video !== false && capabilities.camera !== true) throw new ExtensionError("PermissionDeniedError", "Camera capture is not declared");
      if (request.audio === true && capabilities.microphone !== true) throw new ExtensionError("PermissionDeniedError", "Microphone capture is not declared");
    }
  }

  async start(owner: string, capabilities: MediaCapabilities | undefined, source: MediaSource, request: MediaRequest): Promise<MediaTrackInfo> {
    this.allowed(capabilities, source, request);
    if (this.list(owner).length >= MAX_TRACKS_PER_EXTENSION) throw new ExtensionError("MediaLimitError", "Too many active capture tracks");
    const captured = await this.engine.capture(source, request);
    const trackId = `${owner}:${++this.sequence}`;
    const info: MediaTrackInfo = {
      trackId,
      source,
      video: captured.video,
      audio: captured.audio,
      width: captured.width,
      height: captured.height,
      muted: false,
    };
    this.entries.set(trackId, { owner, info, track: captured });
    captured.onEnded(() => this.finish(trackId));
    captured.start((chunk) => {
      if (!this.entries.has(trackId)) return;
      const frame: MediaFrameMeta = {
        trackId,
        kind: chunk.kind,
        keyframe: chunk.keyframe,
        timestamp: chunk.timestamp,
        duration: chunk.duration,
      };
      for (const listener of [...this.frameListeners]) listener({ owner, frame, data: chunk.data });
    });
    return { ...info };
  }

  private finish(trackId: string) {
    const entry = this.entries.get(trackId);
    if (!entry) return;
    this.entries.delete(trackId);
    try {
      entry.track.stop();
    } catch {
      // a track that ended => no further teardown
    }
    for (const listener of [...this.endedListeners]) listener({ owner: entry.owner, trackId });
  }

  stop(owner: string, trackId: string) {
    const entry = this.entries.get(trackId);
    if (!entry || entry.owner !== owner) throw new ExtensionError("MediaTrackNotFoundError", trackId);
    this.finish(trackId);
  }

  stopAll(owner: string) {
    for (const [trackId, entry] of [...this.entries])
      if (entry.owner === owner) this.finish(trackId);
  }

  list(owner: string): MediaTrackInfo[] {
    return [...this.entries.values()].filter((entry) => entry.owner === owner).map((entry) => ({ ...entry.info }));
  }

  setMuted(owner: string, trackId: string, muted: boolean) {
    const entry = this.entries.get(trackId);
    if (!entry || entry.owner !== owner) throw new ExtensionError("MediaTrackNotFoundError", trackId);
    entry.track.setMuted(muted);
    entry.info.muted = muted;
  }

  onFrame(listener: Listener<FrameEvent>) {
    this.frameListeners.add(listener);
    return { dispose: () => this.frameListeners.delete(listener) };
  }

  onTrackEnded(listener: Listener<{ owner: string; trackId: string }>) {
    this.endedListeners.add(listener);
    return { dispose: () => this.endedListeners.delete(listener) };
  }
}

export const mediaBridge = new MediaBridge();
