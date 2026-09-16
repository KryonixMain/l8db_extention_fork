import type {
  EditorChange,
  EditorContentChange,
  EditorDocument,
  EditorDocumentInfo,
  EditorSelection,
  PeerCursor,
} from "../../../packages/extension-api/src";
import { ExtensionError } from "./contracts";

export interface EditorSurface {
  listDocuments(): EditorDocumentInfo[];
  readDocument(documentId: string): { title: string; languageId: string; text: string } | null;
  replaceText(documentId: string, text: string): void;
}

export interface EditorView {
  getSelection(): { anchor: number; active: number } | null;
  setSelection(anchor: number, active: number): void;
  reveal(offset: number): void;
  setPeerCursors(cursors: PeerCursor[]): void;
}

type Listener<T> = (event: T) => void;

export function applyChanges(text: string, edits: EditorChange[]): string {
  const ordered = [...edits].sort((a, b) => b.start - a.start);
  let result = text;
  for (const edit of ordered) {
    if (
      !Number.isSafeInteger(edit.start) ||
      !Number.isSafeInteger(edit.end) ||
      edit.start < 0 ||
      edit.end < edit.start ||
      edit.end > result.length
    )
      throw new ExtensionError("ProtocolError", "Edit range is out of bounds");
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  }
  return result;
}

export function diffChange(previous: string, next: string): EditorChange | null {
  if (previous === next) return null;
  let start = 0;
  const limit = Math.min(previous.length, next.length);
  while (start < limit && previous[start] === next[start]) start += 1;
  let fromEnd = 0;
  while (
    fromEnd < limit - start &&
    previous[previous.length - 1 - fromEnd] === next[next.length - 1 - fromEnd]
  )
    fromEnd += 1;
  return {
    start,
    end: previous.length - fromEnd,
    text: next.slice(start, next.length - fromEnd),
  };
}

export class EditorBridge {
  private surface: EditorSurface | null = null;
  private versions = new Map<string, number>();
  private shadows = new Map<string, string>();
  private activeListeners = new Set<Listener<EditorDocumentInfo | null>>();
  private contentListeners = new Set<Listener<EditorContentChange>>();
  private selectionListeners = new Set<Listener<EditorSelection>>();
  private lastActive: string | null = null;
  private views = new Map<string, EditorView>();
  private active: string | null = null;

  attach(surface: EditorSurface) {
    this.surface = surface;
    return {
      dispose: () => {
        if (this.surface === surface) this.surface = null;
      },
    };
  }
  attachView(documentId: string, view: EditorView) {
    this.views.set(documentId, view);
    return {
      dispose: () => {
        if (this.views.get(documentId) === view) this.views.delete(documentId);
      },
    };
  }
  setActive(documentId: string | null) {
    this.active = documentId;
    if (documentId === this.lastActive) return;
    const info =
      documentId === null
        ? null
        : (this.surface
            ?.listDocuments()
            .find((document) => document.documentId === documentId) ?? null);
    this.reportActive(info);
  }

  private view(documentId: string): EditorView {
    const view = this.views.get(documentId);
    if (!view) throw new ExtensionError("EditorUnavailableError", `Document ${documentId} is not visible`);
    return view;
  }

  private require(): EditorSurface {
    if (!this.surface) throw new ExtensionError("EditorUnavailableError", "No editor is open");
    return this.surface;
  }

  private version(documentId: string) {
    return this.versions.get(documentId) ?? 1;
  }

  private bump(documentId: string) {
    const next = this.version(documentId) + 1;
    this.versions.set(documentId, next);
    return next;
  }

  listDocuments(): EditorDocumentInfo[] {
    return this.require().listDocuments().map((document) => ({ ...document, version: this.version(document.documentId) }));
  }

  getDocument(documentId: string): EditorDocument {
    const found = this.require().readDocument(documentId);
    if (!found) throw new ExtensionError("EditorDocumentNotFoundError", documentId);
    this.shadows.set(documentId, found.text);
    return {
      documentId,
      title: found.title,
      languageId: found.languageId,
      text: found.text,
      version: this.version(documentId),
    };
  }

  getActive(): EditorDocument | null {
    this.require();
    return this.active ? this.getDocument(this.active) : null;
  }

  applyEdits(documentId: string, edits: EditorChange[], baseVersion?: number): number {
    const surface = this.require();
    const current = surface.readDocument(documentId);
    if (!current) throw new ExtensionError("EditorDocumentNotFoundError", documentId);
    if (baseVersion !== undefined && baseVersion !== this.version(documentId))
      throw new ExtensionError(
        "EditorVersionConflictError",
        `Document ${documentId} moved past version ${baseVersion}`,
      );
    const next = applyChanges(current.text, edits);
    this.shadows.set(documentId, next);
    surface.replaceText(documentId, next);
    return this.bump(documentId);
  }

  getSelection(documentId: string): EditorSelection | null {
    const selection = this.view(documentId).getSelection();
    if (!selection) return null;
    return { documentId, anchor: selection.anchor, active: selection.active };
  }

  setSelection(documentId: string, anchor: number, active: number) {
    this.view(documentId).setSelection(anchor, active);
  }

  reveal(documentId: string, offset: number) {
    this.view(documentId).reveal(offset);
  }

  setPeerCursors(documentId: string, cursors: PeerCursor[]) {
    this.view(documentId).setPeerCursors(cursors);
  }

  onActiveChanged(listener: Listener<EditorDocumentInfo | null>) {
    this.activeListeners.add(listener);
    return { dispose: () => this.activeListeners.delete(listener) };
  }
  onContentChanged(listener: Listener<EditorContentChange>) {
    this.contentListeners.add(listener);
    return { dispose: () => this.contentListeners.delete(listener) };
  }

  onSelectionChanged(listener: Listener<EditorSelection>) {
    this.selectionListeners.add(listener);
    return { dispose: () => this.selectionListeners.delete(listener) };
  }

  reportContent(documentId: string, text: string) {
    const previous = this.shadows.get(documentId);
    this.shadows.set(documentId, text);
    if (previous === undefined) return;
    const change = diffChange(previous, text);
    if (!change) return;
    const event: EditorContentChange = {
      documentId,
      changes: [change],
      version: this.bump(documentId),
    };
    for (const listener of [...this.contentListeners]) listener(event);
  }

  reportSelection(documentId: string, anchor: number, active: number) {
    const event: EditorSelection = { documentId, anchor, active };
    for (const listener of [...this.selectionListeners]) listener(event);
  }
  
  reportActive(document: EditorDocumentInfo | null) {
    const documentId = document?.documentId ?? null;
    if (documentId === this.lastActive) return;
    this.lastActive = documentId;
    for (const listener of [...this.activeListeners]) listener(document);
  }
}

export const editorBridge = new EditorBridge();
