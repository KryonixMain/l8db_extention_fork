export function normalizePath(path: string): string {
  const unified = path.replace(/\\/g, "/");
  const windowsRoot = /^[a-zA-Z]:\//.test(unified) ? unified.slice(0, 3) : null;
  const uncRoot = !windowsRoot && unified.startsWith("//") ? "//" : null;
  const posixRoot = !windowsRoot && !uncRoot && unified.startsWith("/") ? "/" : null;
  const root = windowsRoot ?? uncRoot ?? posixRoot ?? "";
  const resolved: string[] = [];
  for (const segment of unified.slice(root.length).split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (resolved.length) resolved.pop();
      else if (!root) resolved.push("..");
      continue;
    }
    resolved.push(segment);
  }
  const joined = resolved.join("/");
  if (!root) return joined;
  if (windowsRoot) return joined ? `${windowsRoot}${joined}` : windowsRoot;
  return `${root}${joined}`;
}

export function withinRoot(root: string, path: string): boolean {
  const normalizedRoot = normalizePath(root);
  const normalizedPath = normalizePath(path);
  if (!normalizedRoot) return false;
  if (normalizedPath === normalizedRoot) return true;
  const prefix = normalizedRoot.endsWith("/") ? normalizedRoot : `${normalizedRoot}/`;
  return normalizedPath.startsWith(prefix);
}

export class FsGrants {
  private files = new Map<string, Set<string>>();
  private roots = new Map<string, Set<string>>();
  private add(store: Map<string, Set<string>>, id: string, path: string) {
    let entries = store.get(id);
    if (!entries) {
      entries = new Set();
      store.set(id, entries);
    }
    entries.add(normalizePath(path));
  }
  allowFile(id: string, path: string) {
    this.add(this.files, id, path);
  }
  allowRoot(id: string, path: string) {
    this.add(this.roots, id, path);
  }
  rootsFor(id: string): string[] {
    return [...(this.roots.get(id) ?? [])];
  }
  allows(id: string, path: string): boolean {
    const normalized = normalizePath(path);
    if (this.files.get(id)?.has(normalized)) return true;
    for (const root of this.roots.get(id) ?? []) if (withinRoot(root, normalized)) return true;
    return false;
  }
  clear(id: string) {
    this.files.delete(id);
    this.roots.delete(id);
  }
}
