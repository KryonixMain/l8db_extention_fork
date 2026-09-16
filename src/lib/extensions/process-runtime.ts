import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { ExtensionDescriptor, ExtensionRuntime, Json, RpcHandler } from "./contracts";
import { ExtensionError } from "./contracts";

interface HostEvent {
  session: number;
  message: Record<string, Json>;
}

interface NativeHost {
  session: number;
  unlisten: UnlistenFn;
  requests: Map<
    number,
    {
      resolve(value: Json | void): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >;
  failure(error: Error): void;
  sequence: number;
  stopped: boolean;
}

export class ProcessRuntime implements ExtensionRuntime {
  private hosts = new Map<string, NativeHost>();
  constructor(private readonly timeout = 10000) {}
  async load(extension: ExtensionDescriptor, rpc: RpcHandler, failure: (error: Error) => void) {
    const manifest = extension.archive.manifest;
    const id = manifest.id;
    await this.unload(id);
    const executables = manifest.executables ?? {};
    if (!Object.keys(executables).length) throw new ExtensionError("ExtensionActivationError", `${id} declares no executables`);
    const host: NativeHost = {
      session: 0,
      unlisten: () => undefined,
      requests: new Map(),
      failure,
      sequence: 0,
      stopped: false,
    };
    this.hosts.set(id, host);
    let count = 0;
    let windowStart = Date.now();
    const unlisten = await listen<HostEvent>(`extension-host://${id}`, ({ payload }) => {
      if (this.hosts.get(id) !== host || host.stopped) return;
      if (payload.session !== host.session) return;
      if (Date.now() - windowStart > 1000) {
        count = 0;
        windowStart = Date.now();
      }
      if (++count > 500) {
        failure(new Error("Extension exceeded RPC rate limit"));
        return;
      }
      const message = payload.message;
      if (!message || typeof message !== "object") return;
      if (message.type === "stderr") {
        void rpc("logger", ["warn", String(message.line)]).catch(() => undefined);
        return;
      }
      if (message.type === "crash") {
        failure(new Error(String(message.error)));
        return;
      }
      if (message.type === "result") {
        const request = host.requests.get(message.id as number);
        if (!request) return;
        clearTimeout(request.timer);
        host.requests.delete(message.id as number);
        if (message.error) request.reject(new Error(String(message.error)));
        else request.resolve(message.value as Json);
        return;
      }
      if (
        message.type === "rpc" &&
        Number.isSafeInteger(message.id) &&
        typeof message.method === "string"
      ) {
        void rpc(message.method, (message.args ?? []) as Json[]).then(
          (value) => this.post(id, host, { type: "rpc-result", id: message.id, value: value ?? null }),
          (error) =>
            this.post(id, host, { type: "rpc-result", id: message.id, error: String(error) }),
        );
      }
    });
    host.unlisten = unlisten;
    try {
      host.session = await invoke<number>("extension_host_spawn", {
        id,
        executables,
        args: [],
        developmentPath: extension.developmentPath ?? null,
      });
      await this.request(id, "load", {
        context: {
          extensionId: id,
          extensionPath: `extension://${id}/`,
          storagePath: `extension-storage://${id}/`,
        },
        manifest: JSON.parse(JSON.stringify(manifest)) as Json,
      });
    } catch (error) {
      await this.unload(id);
      throw error;
    }
  }
  
  private post(id: string, host: NativeHost, message: Record<string, unknown>) {
    if (this.hosts.get(id) !== host || host.stopped) return;
    void invoke("extension_host_send", { id, message: JSON.stringify(message) }).catch((error) => {
      if (this.hosts.get(id) === host && !host.stopped) host.failure(new Error(String(error)));
    });
  }

  private request(id: string, method: string, data: Record<string, unknown> = {}): Promise<Json | void> {
    const host = this.hosts.get(id);
    if (!host || host.stopped) return Promise.reject(new Error(`Extension runtime unavailable: ${id}`));
    const requestId = ++host.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        host.requests.delete(requestId);
        const error = new Error(`Extension ${method} timed out`);
        reject(error);
        host.failure(error);
      }, this.timeout);
      host.requests.set(requestId, { resolve, reject, timer });
      this.post(id, host, { type: "request", id: requestId, method, ...data });
    });
  }

  async activate(id: string) {
    await this.request(id, "activate");
  }

  async deactivate(id: string) {
    await this.request(id, "deactivate");
  }

  execute(id: string, command: string, payload?: Json) {
    return this.request(id, "execute", { command, payload: payload ?? null });
  }

  event(id: string, name: string, payload: Json) {
    const host = this.hosts.get(id);
    if (host) this.post(id, host, { type: "event", name, payload });
  }

  async unload(id: string) {
    const host = this.hosts.get(id);
    if (!host) return;
    host.stopped = true;
    this.hosts.delete(id);
    for (const request of host.requests.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("Extension runtime stopped"));
    }
    host.requests.clear();
    host.unlisten();
    await invoke("extension_host_kill", { id }).catch(() => undefined);
  }
}
