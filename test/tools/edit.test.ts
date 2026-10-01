import { afterEach, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanupWorkspaces, runToolScript, tempWorkspace } from "./harness.js";

afterEach(cleanupWorkspaces);

const anchorOf = (text: string, needle: string) => {
  const line = text.split("\n").find((l) => l.endsWith(`|${needle}`));
  if (!line) throw new Error(`no line "${needle}" in:\n${text}`);
  return line.slice(0, line.indexOf("|"));
};

describe("anchored read/edit on a real session", () => {
  it("read tags lines and edit applies by anchor; chained edit uses the anchors the result prints", async () => {
    const cwd = await tempWorkspace();
    const file = join(cwd, "a.txt");
    await writeFile(file, "one\ntwo\nthree\nfour\n");
    const results = await runToolScript(cwd, ["read", "edit"], [
      () => ({ name: "read", args: { path: "a.txt" } }),
      (read) => ({
        name: "edit",
        args: {
          path: "a.txt",
          edits: [
            { op: "replace", at: anchorOf(read!.text, "two"), text: "TWO\n2.5" },
            { op: "delete", at: anchorOf(read!.text, "four") },
            { op: "insert_after", at: "EOF", text: "five" },
          ],
        },
      }),
      (edit) => ({
        name: "edit",
        args: {
          path: "a.txt",
          edits: [{ op: "insert_before", at: anchorOf(edit!.text, "three"), text: "between" }],
        },
      }),
    ]);
    expect(results.map((r) => r.isError)).toEqual([false, false, false]);
    expect(results[0]!.text).toMatch(/^1#[0-9a-f]{3}\|one\n2#[0-9a-f]{3}\|two/);
    expect(await readFile(file, "utf8")).toBe("one\nTWO\n2.5\nbetween\nthree\nfive\n");
  });

  it("rejects a stale tag atomically and shows the current line", async () => {
    const cwd = await tempWorkspace();
    const file = join(cwd, "a.txt");
    await writeFile(file, "alpha\nbeta\ngamma\n");
    const results = await runToolScript(cwd, ["read", "edit"], [
      () => ({ name: "read", args: { path: "a.txt" } }),
      (read) => {
        // The file changes under the worker between its read and its edit.
        writeFileSync(file, "alpha\nBETA CHANGED\ngamma\n");
        return {
          name: "edit",
          args: {
            path: "a.txt",
            edits: [
              { op: "replace", at: anchorOf(read!.text, "alpha"), text: "ALPHA" },
              { op: "replace", at: anchorOf(read!.text, "beta"), text: "BETA" },
            ],
          },
        };
      },
    ]);
    const edit = results[1]!;
    expect(edit.isError).toBe(true);
    expect(edit.text).toContain("stale");
    expect(edit.text).toContain("|BETA CHANGED");
    expect(edit.text).toContain("no changes made");
    expect(await readFile(file, "utf8")).toBe("alpha\nBETA CHANGED\ngamma\n");
  });

  it("rejects overlapping edits and out-of-range anchors; keeps CRLF", async () => {
    const cwd = await tempWorkspace();
    const file = join(cwd, "w.txt");
    await writeFile(file, "a\r\nb\r\nc\r\n");
    const results = await runToolScript(cwd, ["read", "edit"], [
      () => ({ name: "read", args: { path: "w.txt" } }),
      (read) => ({
        name: "edit",
        args: {
          path: "w.txt",
          edits: [
            { op: "replace", at: anchorOf(read!.text, "a"), to: anchorOf(read!.text, "b"), text: "x" },
            { op: "replace", at: anchorOf(read!.text, "b"), text: "y" },
          ],
        },
      }),
      () => ({ name: "edit", args: { path: "w.txt", edits: [{ op: "delete", at: "99#abc" }] } }),
      (_, all) => ({
        name: "edit",
        args: { path: "w.txt", edits: [{ op: "replace", at: anchorOf(all[0]!.text, "b"), text: "B" }] },
      }),
    ]);
    expect(results[1]!.isError).toBe(true);
    expect(results[1]!.text).toContain("overlaps");
    expect(results[2]!.isError).toBe(true);
    expect(results[2]!.text).toContain("only 3 lines");
    expect(results[3]!.isError).toBe(false);
    expect(await readFile(file, "utf8")).toBe("a\r\nB\r\nc\r\n");
  });

  it("read pages with offset/limit and notes the continuation", async () => {
    const cwd = await tempWorkspace();
    await writeFile(join(cwd, "n.txt"), Array.from({ length: 10 }, (_, i) => `l${i + 1}`).join("\n") + "\n");
    const results = await runToolScript(cwd, ["read"], [
      () => ({ name: "read", args: { path: "n.txt", offset: 3, limit: 2 } }),
    ]);
    expect(results[0]!.text).toMatch(/^3#[0-9a-f]{3}\|l3\n4#[0-9a-f]{3}\|l4\n\n\[Showing lines 3-4 of 10\. Use offset=5 to continue\.\]$/);
  });
});
