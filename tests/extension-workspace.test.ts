import { expect, test } from "bun:test";
import { FsGrants, normalizePath, withinRoot } from "../src/lib/extensions/fs-grants";

test("normalizePath unifies separators and collapses dot segments", () => {
  expect(normalizePath("C:\\Users\\me\\proj")).toBe("C:/Users/me/proj");
  expect(normalizePath("/home//me///proj/")).toBe("/home/me/proj");
  expect(normalizePath("/a/b/./c")).toBe("/a/b/c");
  expect(normalizePath("/a/b/../c")).toBe("/a/c");
  expect(normalizePath("C:\\a\\b\\..\\c")).toBe("C:/a/c");
});

test("normalizePath cannot climb above a root", () => {
  expect(normalizePath("/a/../../../etc/passwd")).toBe("/etc/passwd");
  expect(normalizePath("C:\\a\\..\\..\\Windows")).toBe("C:/Windows");
});

test("withinRoot accepts the root and its descendants", () => {
  expect(withinRoot("/home/me/proj", "/home/me/proj")).toBe(true);
  expect(withinRoot("/home/me/proj", "/home/me/proj/src/main.rs")).toBe(true);
  expect(withinRoot("C:\\proj", "C:\\proj\\src\\main.rs")).toBe(true);
});

test("withinRoot rejects sibling prefixes", () => {
  expect(withinRoot("/home/me/proj", "/home/me/project")).toBe(false);
  expect(withinRoot("/home/me/proj", "/home/me/proj-backup")).toBe(false);
  expect(withinRoot("C:\\proj", "C:\\projects\\x")).toBe(false);
});

test("withinRoot rejects traversal out of the root", () => {
  expect(withinRoot("/home/me/proj", "/home/me/proj/../secrets")).toBe(false);
  expect(withinRoot("/home/me/proj", "/home/me/proj/../../etc/passwd")).toBe(false);
  expect(withinRoot("C:\\proj", "C:\\proj\\..\\Windows\\system32")).toBe(false);
  expect(withinRoot("", "/anything")).toBe(false);
});

test("file grants stay exact", () => {
  const grants = new FsGrants();
  grants.allowFile("a.b", "/home/me/one.sql");
  expect(grants.allows("a.b", "/home/me/one.sql")).toBe(true);
  expect(grants.allows("a.b", "\\home\\me\\one.sql")).toBe(true);
  expect(grants.allows("a.b", "/home/me/two.sql")).toBe(false);
  expect(grants.allows("a.b", "/home/me")).toBe(false);
});

test("root grants cover the subtree and nothing else", () => {
  const grants = new FsGrants();
  grants.allowRoot("a.b", "/home/me/proj");
  expect(grants.allows("a.b", "/home/me/proj/src/deep/file.ts")).toBe(true);
  expect(grants.allows("a.b", "/home/me/proj")).toBe(true);
  expect(grants.allows("a.b", "/home/me/other")).toBe(false);
  expect(grants.allows("a.b", "/home/me/proj/../other")).toBe(false);
});

test("grants never leak between extensions", () => {
  const grants = new FsGrants();
  grants.allowRoot("a.b", "/home/me/proj");
  grants.allowFile("a.b", "/tmp/one");
  expect(grants.allows("c.d", "/home/me/proj/x")).toBe(false);
  expect(grants.allows("c.d", "/tmp/one")).toBe(false);
});

test("clear drops every grant an extension held", () => {
  const grants = new FsGrants();
  grants.allowRoot("a.b", "/home/me/proj");
  grants.allowFile("a.b", "/tmp/one");
  grants.clear("a.b");
  expect(grants.allows("a.b", "/home/me/proj/x")).toBe(false);
  expect(grants.allows("a.b", "/tmp/one")).toBe(false);
  expect(grants.rootsFor("a.b")).toEqual([]);
});
