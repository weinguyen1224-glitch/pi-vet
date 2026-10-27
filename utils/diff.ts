import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { Hunk } from "../types";

export class ConflictError extends Error {}

export function parseHunks(diff: string): Hunk[] {
	const hunks: Hunk[] = [];
	for (const line of diff.split("\n")) {
		if (line.startsWith("@@")) {
			hunks.push({ id: `h${hunks.length}`, header: line, lines: [line], accepted: true });
		} else if (line !== "" && hunks.length > 0) {
			hunks[hunks.length - 1].lines.push(line);
		}
	}
	return hunks;
}

export function reverseHunks(hunks: Hunk[]): Hunk[] {
	const flip = (line: string) =>
		line.startsWith("+") ? `-${line.slice(1)}` : line.startsWith("-") ? `+${line.slice(1)}` : line;
	return hunks.map((hunk) => {
		const header = hunk.header.replace(/@@ -(\S+) \+(\S+) @@/, "@@ -$2 +$1 @@");
		return { ...hunk, header, lines: [header, ...hunk.lines.slice(1).map(flip)] };
	});
}

function splitHunk(hunk: Hunk): { oldLines: string[]; newLines: string[] } {
	const oldLines: string[] = [];
	const newLines: string[] = [];
	let last: "both" | "old" | "new" | null = null;
	for (const line of hunk.lines.slice(1)) {
		const text = `${line.slice(1)}\n`;
		if (line.startsWith("\\")) {
			if (last !== "new") oldLines.push(oldLines.pop()!.slice(0, -1));
			if (last !== "old") newLines.push(newLines.pop()!.slice(0, -1));
			last = null;
		} else if (line.startsWith(" ")) {
			oldLines.push(text);
			newLines.push(text);
			last = "both";
		} else if (line.startsWith("-")) {
			oldLines.push(text);
			last = "old";
		} else if (line.startsWith("+")) {
			newLines.push(text);
			last = "new";
		}
	}
	return { oldLines, newLines };
}

function locate(lines: string[], oldLines: string[], expected: number, floor: number): number {
	if (oldLines.length === 0) return Math.min(Math.max(expected, floor), lines.length);
	const fits = (at: number) =>
		at >= floor &&
		at + oldLines.length <= lines.length &&
		oldLines.every((line, k) => lines[at + k] === line);
	for (let distance = 0; distance <= lines.length; distance++) {
		if (fits(expected - distance)) return expected - distance;
		if (fits(expected + distance)) return expected + distance;
	}
	return -1;
}

const oldStartOf = (hunk: Hunk) => parseInt(hunk.header.match(/@@ -(\d+)/)?.[1] ?? "0");

export function applyHunks(original: string, hunks: Hunk[]): string {
	const accepted = hunks.filter((h) => h.accepted).sort((a, b) => oldStartOf(a) - oldStartOf(b));
	if (accepted.length === 0) return original;

	const lines = original.match(/[^\n]*\n|[^\n]+$/g) ?? [];
	let drift = 0;
	let floor = 0;
	for (const hunk of accepted) {
		const m = hunk.header.match(/@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/);
		if (!m) continue;
		const oldStart = parseInt(m[1]);
		const oldCount = m[2] !== undefined ? parseInt(m[2]) : 1;
		const expected = oldCount === 0 ? oldStart : oldStart - 1;

		const { oldLines, newLines } = splitHunk(hunk);
		const at = locate(lines, oldLines, expected + drift, floor);
		if (at < 0) throw new ConflictError(`${hunk.header} no longer matches the file`);
		lines.splice(at, oldLines.length, ...newLines);
		drift = at - expected + newLines.length - oldLines.length;
		floor = at + newLines.length;
	}
	return lines.join("");
}

export function diffFiles(original: string, current: string, rel: string): Promise<string> {
	const dir = mkdtempSync(join(tmpdir(), "pi-vet-"));
	const a = join(dir, "a");
	const b = join(dir, "b");
	writeFileSync(a, original);
	writeFileSync(b, current);
	return new Promise((resolve) => {
		const finish = (result: string) => {
			rmSync(dir, { recursive: true, force: true });
			resolve(result);
		};
		const proc = spawn("diff", ["-u", "--label", `a/${rel}`, "--label", `b/${rel}`, a, b]);
		let stdout = "";
		proc.stdout.setEncoding("utf8");
		proc.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		proc.on("close", (code) =>
			finish(code === 1 ? stdout : code === 0 ? "" : wholeFileDiff(original, current, rel)),
		);
		proc.on("error", () => finish(wholeFileDiff(original, current, rel)));
	});
}

function wholeFileDiff(original: string, current: string, rel: string): string {
	const split = (text: string) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
	const mark = (lines: string[], sign: string) =>
		lines.flatMap((line) =>
			line.endsWith("\n")
				? [`${sign}${line.slice(0, -1)}`]
				: [`${sign}${line}`, "\\ No newline at end of file"],
		);
	const o = split(original);
	const c = split(current);
	return [
		`--- a/${rel}`,
		`+++ b/${rel}`,
		`@@ -${o.length ? 1 : 0},${o.length} +${c.length ? 1 : 0},${c.length} @@`,
		...mark(o, "-"),
		...mark(c, "+"),
	].join("\n");
}

