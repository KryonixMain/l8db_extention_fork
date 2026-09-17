import type { PeerCursor } from "./contracts";

const STYLE_ID = "l8db-peer-cursor-colours";

const colours = new Map<string, string>();

export interface PeerCursorClasses {
  selection: string;
  caret: string;
}

function classFor(peerId: string): string {
  return `l8db-peer-${peerId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

function paint() {
  if (typeof document === "undefined") return;
  let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement("style");
    style.id = STYLE_ID;
    document.head.append(style);
  }
  const rules = [...colours]
    .map(([peerId, colour]) => {
      const name = classFor(peerId);
      return [
        `.${name}.l8db-peer-selection { background-color: ${colour}38; }`,
        `.${name}.l8db-peer-caret::before { background-color: ${colour}; }`,
      ].join("");
    })
    .join("");
  if (style.textContent !== rules) style.textContent = rules;
}

export function peerCursorClasses(cursors: PeerCursor[]): Map<string, PeerCursorClasses> {
  let added = false;
  for (const cursor of cursors) {
    if (!/^#[0-9a-fA-F]{6}$/.test(cursor.color)) continue;
    if (colours.get(cursor.peerId) === cursor.color) continue;
    colours.set(cursor.peerId, cursor.color);
    added = true;
  }
  if (added) paint();
  return new Map(
    cursors.map((cursor) => {
      const own = colours.has(cursor.peerId) ? ` ${classFor(cursor.peerId)}` : "";
      return [
        cursor.peerId,
        { selection: `l8db-peer-selection${own}`, caret: `l8db-peer-caret${own}` },
      ];
    }),
  );
}

export function forgetPeerColours() {
  colours.clear();
  paint();
}
