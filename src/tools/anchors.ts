import { isAbsolute, resolve } from "node:path";

/** Short content tag: with the line number it pins a line to the content that was read. */
export function lineTag(line: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < line.length; i++) {
    hash ^= line.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return ((hash >>> 0) & 0xfff).toString(16).padStart(3, "0");
}

export function formatAnchor(lineNumber: number, line: string): string {
  return `${lineNumber}#${lineTag(line)}`;
}

/** `LINE#TAG|text`, the format `read` prints and `edit` addresses. */
export function formatTaggedLine(lineNumber: number, line: string, maxChars = 4000): string {
  const shown = line.length > maxChars ? `${line.slice(0, maxChars)}…[+${line.length - maxChars} chars]` : line;
  return `${formatAnchor(lineNumber, line)}|${shown}`;
}

export interface Anchor {
  line: number;
  tag: string;
}

const ANCHOR = /^\s*(\d+)\s*#\s*([0-9a-f]{3})(?:\s*\|.*)?$/is;

/** Accepts `12#a3f`, and tolerates a whole copied `12#a3f|text` line. */
export function parseAnchor(value: string): Anchor | undefined {
  const match = ANCHOR.exec(value);
  if (!match) return undefined;
  return { line: Number(match[1]), tag: match[2]!.toLowerCase() };
}

export interface ParsedFile {
  lines: string[];
  eol: "\n" | "\r\n";
  trailingNewline: boolean;
  bom: boolean;
}

export function parseFileText(raw: string): ParsedFile {
  const bom = raw.startsWith("\uFEFF");
  const text = bom ? raw.slice(1) : raw;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const trailingNewline = text.length === 0 || text.endsWith("\n");
  const lines = text.length === 0 ? [] : text.split(/\r?\n/);
  if (text.endsWith("\n")) lines.pop();
  return { lines, eol, trailingNewline, bom };
}

export function serializeFile(file: ParsedFile): string {
  const body = file.lines.join(file.eol);
  const text = file.lines.length > 0 && file.trailingNewline ? body + file.eol : body;
  return (file.bom ? "\uFEFF" : "") + text;
}

export function resolveWorkspacePath(cwd: string, path: string): string {
  const cleaned = path.startsWith("@") ? path.slice(1) : path;
  return isAbsolute(cleaned) ? cleaned : resolve(cwd, cleaned);
}
