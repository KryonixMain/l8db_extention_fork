import type { ExtensionDescriptor, ExtensionRuntime, Json, RpcHandler } from "./contracts";

export class RuntimeRouter implements ExtensionRuntime {
  private owners = new Map<string, ExtensionRuntime>();
  constructor(private readonly javascript: ExtensionRuntime, private readonly native: ExtensionRuntime) {}

  private runtimeFor(extension: ExtensionDescriptor) {
    return extension.archive.manifest.runtime === "native" ? this.native : this.javascript;
  }

  private owner(id: string) {
    return this.owners.get(id);
  }

  async load(extension: ExtensionDescriptor, rpc: RpcHandler, onFailure: (error: Error) => void) {
    const id = extension.archive.manifest.id;
    await this.unload(id);
    const runtime = this.runtimeFor(extension);
    this.owners.set(id, runtime);
    try {
      await runtime.load(extension, rpc, onFailure);
    } catch (error) {
      this.owners.delete(id);
      await runtime.unload(id).catch(() => undefined);
      throw error;
    }
  }

  activate(id: string) {
    return this.owner(id)?.activate(id) ?? Promise.resolve();
  }

  deactivate(id: string) {
    return this.owner(id)?.deactivate(id) ?? Promise.resolve();
  }

  async unload(id: string) {
    const runtime = this.owner(id);
    this.owners.delete(id);
    await runtime?.unload(id);
  }

  execute(id: string, command: string, payload?: Json) {
    const runtime = this.owner(id);
    if (!runtime) return Promise.reject(new Error(`Extension runtime unavailable: ${id}`));
    return runtime.execute(id, command, payload);
  }
  
  event(id: string, name: string, payload: Json) {
    this.owner(id)?.event(id, name, payload);
  }
}
