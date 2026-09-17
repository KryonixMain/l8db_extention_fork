import type { Tab } from "@/lib/table-tabs";
import { tabKey } from "@/lib/table-tabs";
import { tabLabel } from "@/lib/tab-navigation";
import type { Json } from "./contracts";

export interface WorkspaceView {
  key: string;
  label: string;
  tab: Json;
}

type Listener = (view: WorkspaceView | null) => void;

let current: WorkspaceView | null = null;
const listeners = new Set<Listener>();

export function describeTab(tab: Tab): WorkspaceView {
  return { key: tabKey(tab), label: tabLabel(tab), tab: tab as unknown as Json };
}

export function reportWorkspaceView(tab: Tab | undefined) {
  const next = tab ? describeTab(tab) : null;
  if (next?.key === current?.key) return;
  current = next;
  for (const listener of listeners) listener(current);
}

export function currentWorkspaceView(): WorkspaceView | null {
  return current;
}

type Opener = (tab: Tab) => boolean;
type Closer = (key: string) => boolean;
let opener: Opener | null = null;
let closer: Closer | null = null;

export function setWorkspaceViewOpener(open: Opener | null) {
  opener = open;
}

export function setWorkspaceViewCloser(close: Closer | null) {
  closer = close;
}

export function closeWorkspaceView(key: string): boolean {
  return closer ? closer(key) : false;
}

export function openWorkspaceView(descriptor: Json): boolean {
  const tab = descriptor as unknown as Tab;
  if (!tab || typeof tab !== "object" || typeof (tab as { kind?: string }).kind !== "string")
    return false;
  return opener ? opener(tab) : false;
}

export function onWorkspaceViewChanged(listener: Listener) {
  listeners.add(listener);
  return { dispose: () => listeners.delete(listener) };
}
