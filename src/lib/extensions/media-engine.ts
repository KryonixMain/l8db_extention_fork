import type { MediaRequest, MediaSource } from "../../../packages/extension-api/src";
import { ExtensionError } from "./contracts";

export interface EncodedChunk {
  kind: "video" | "audio";
  data: Uint8Array;
  keyframe: boolean;
  timestamp: number;
  duration: number | null;
}

export interface CapturedTrack {
  video: boolean;
  audio: boolean;
  width: number | null;
  height: number | null;
  setMuted(muted: boolean): void;
  onEnded(listener: () => void): void;
  start(sink: (chunk: EncodedChunk) => void): void;
  stop(): void;
}

export interface MediaEngine {
  capture(source: MediaSource, request: MediaRequest): Promise<CapturedTrack>;
}

const DEFAULT_BITRATE = 1_200_000;
const DEFAULT_FRAME_RATE = 24;
const KEYFRAME_INTERVAL_MS = 2000;

function unsupported(what: string): never {
  throw new ExtensionError("MediaUnsupportedError", `${what} is unavailable in this webview`);
}

function pump(
  track: MediaStreamTrack,
  encode: (frame: VideoFrame | AudioData) => void,
  stopped: () => boolean,
) {
  const Processor = (
    globalThis as unknown as {
      MediaStreamTrackProcessor?: new (init: {
        track: MediaStreamTrack;
      }) => { readable: ReadableStream };
    }
  ).MediaStreamTrackProcessor;
  if (!Processor) unsupported("MediaStreamTrackProcessor");
  const reader = new Processor({ track }).readable.getReader();
  const loop = async () => {
    while (!stopped()) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      const frame = value as VideoFrame | AudioData;
      try {
        encode(frame);
      } finally {
        frame.close();
      }
    }
    reader.cancel().catch(() => undefined);
  };
  void loop().catch(() => undefined);
}

export const webCodecsEngine: MediaEngine = {
  async capture(source, request) {
    const devices = globalThis.navigator?.mediaDevices;
    if (!devices) unsupported("navigator.mediaDevices");
    const wantsVideo = request.video !== false;
    const wantsAudio = request.audio === true;
    const constraints: MediaStreamConstraints = {
      video: wantsVideo
        ? {
            width: request.width ? { ideal: request.width } : undefined,
            height: request.height ? { ideal: request.height } : undefined,
            frameRate: { ideal: request.frameRate ?? DEFAULT_FRAME_RATE },
          }
        : false,
      audio: wantsAudio,
    };
    let stream: MediaStream;
    try {
      stream =
        source === "screen"
          ? await devices.getDisplayMedia(constraints)
          : await devices.getUserMedia(constraints);
    } catch (error) {
      throw new ExtensionError("MediaDeniedError", String(error));
    }
    const videoTrack = stream.getVideoTracks()[0] ?? null;
    const audioTrack = stream.getAudioTracks()[0] ?? null;
    const settings = videoTrack?.getSettings() ?? {};
    let stopped = false;
    const encoders: { close(): void }[] = [];
    const endedListeners: (() => void)[] = [];
    for (const track of stream.getTracks())
      track.addEventListener("ended", () => {
        for (const listener of endedListeners) listener();
      });
    return {
      video: !!videoTrack,
      audio: !!audioTrack,
      width: settings.width ?? null,
      height: settings.height ?? null,
      setMuted: (muted) => {
        for (const track of stream.getTracks()) track.enabled = !muted;
      },
      onEnded: (listener) => {
        endedListeners.push(listener);
      },
      start: (sink) => {
        const VideoEncoderCtor = (globalThis as unknown as { VideoEncoder?: typeof VideoEncoder }).VideoEncoder;
        const AudioEncoderCtor = (globalThis as unknown as { AudioEncoder?: typeof AudioEncoder }).AudioEncoder;
        if (videoTrack) {
          if (!VideoEncoderCtor) unsupported("VideoEncoder");
          let lastKeyframe = 0;
          const encoder = new VideoEncoderCtor({
            output: (chunk) => {
              const data = new Uint8Array(chunk.byteLength);
              chunk.copyTo(data);
              sink({
                kind: "video",
                data,
                keyframe: chunk.type === "key",
                timestamp: chunk.timestamp,
                duration: chunk.duration ?? null,
              });
            },
            error: () => undefined,
          });
          encoder.configure({
            codec: "vp8",
            width: settings.width ?? request.width ?? 1280,
            height: settings.height ?? request.height ?? 720,
            bitrate: request.bitrate ?? DEFAULT_BITRATE,
            framerate: request.frameRate ?? DEFAULT_FRAME_RATE,
          });
          encoders.push(encoder);
          pump(
            videoTrack,
            (frame) => {
              const now = Date.now();
              const keyFrame = now - lastKeyframe >= KEYFRAME_INTERVAL_MS;
              if (keyFrame) lastKeyframe = now;
              encoder.encode(frame as VideoFrame, { keyFrame });
            },
            () => stopped,
          );
        }
        if (audioTrack) {
          if (!AudioEncoderCtor) unsupported("AudioEncoder");
          const audioSettings = audioTrack.getSettings();
          const encoder = new AudioEncoderCtor({
            output: (chunk) => {
              const data = new Uint8Array(chunk.byteLength);
              chunk.copyTo(data);
              sink({
                kind: "audio",
                data,
                keyframe: true,
                timestamp: chunk.timestamp,
                duration: chunk.duration ?? null,
              });
            },
            error: () => undefined,
          });
          encoder.configure({
            codec: "opus",
            sampleRate: audioSettings.sampleRate ?? 48000,
            numberOfChannels: audioSettings.channelCount ?? 1,
          });
          encoders.push(encoder);
          pump(
            audioTrack,
            (frame) => encoder.encode(frame as AudioData),
            () => stopped,
          );
        }
      },
      stop: () => {
        stopped = true;
        for (const encoder of encoders) {
          try {
            encoder.close();
          } catch {
            // an encoder that already failed => drop
          }
        }
        for (const track of stream.getTracks()) track.stop();
      },
    };
  },
};
