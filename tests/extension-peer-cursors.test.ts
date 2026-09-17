import { beforeEach, expect, test } from "bun:test";
import { forgetPeerColours, peerCursorClasses } from "../src/lib/extensions/peer-cursors";

const cursor = (peerId: string, color: string) => ({
  peerId,
  label: peerId,
  color,
  anchor: 0,
  active: 0,
});

beforeEach(() => forgetPeerColours());

test("each participant is drawn with a class of their own", () => {
  const classes = peerCursorClasses([cursor("ada", "#61afef"), cursor("grace", "#98c379")]);
  expect(classes.get("ada")?.caret).toContain("l8db-peer-caret");
  expect(classes.get("ada")?.selection).toContain("l8db-peer-selection");
  expect(classes.get("ada")?.caret).not.toBe(classes.get("grace")?.caret);
});

test("a colour is remembered past the document that introduced it", () => {
  peerCursorClasses([cursor("ada", "#61afef")]);
  peerCursorClasses([cursor("grace", "#98c379")]);
  const again = peerCursorClasses([cursor("ada", "")]);
  expect(again.get("ada")?.caret).toBe(peerCursorClasses([cursor("ada", "#61afef")]).get("ada")?.caret);
});

test("a colour that is not a colour never becomes a rule", () => {
  const classes = peerCursorClasses([cursor("x", "red; } body { display: none; } .x {")]);
  expect(classes.get("x")?.caret).toBe("l8db-peer-caret");
  expect(classes.get("x")?.selection).toBe("l8db-peer-selection");
});

test("an id from an extension cannot become part of a selector", () => {
  const classes = peerCursorClasses([cursor("a b{}.evil", "#61afef")]);
  expect(classes.get("a b{}.evil")?.caret).toBe("l8db-peer-caret l8db-peer-a_b___evil");
});
