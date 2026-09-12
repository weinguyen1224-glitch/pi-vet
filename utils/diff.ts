import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { Hunk } from "../types";

export function parseHunks(diff: string): Hunk[] {
	if (!diff) return [];
	const lines = diff.split("\n");
	const hunks: Hunk[] = [];
	let current: string[] = [];
	let header = "";
	let hunkId = 0;

	for (const line of lines) {
		if (line.startsWith("@@")) {
			if (header) {
				hunks.push({
					id: `h${hunkId++}`,
					header,
					lines: current,
					accepted: true,
				});
			}
			header = line;
			current = [line];
		} else if (header) {
			current.push(line);
		}
	}
	if (header) {
		hunks.push({ id: `h${hunkId++}`, header, lines: current, accepted: true });
	}
	return hunks;
}

export function applyHunks(original: string, hunks: Hunk[]): string {
	const accepted = hunks.filter((h) => h.accepted);
	if (accepted.length === 0) return original;

	const origLines = original.split("\n");
	const sorted = [...accepted].sort((a, b) => {
		const aM = a.header.match(/@@ -(\d+)/);
		const bM = b.header.match(/@@ -(\d+)/);
		return (bM ? parseInt(bM[1]) : 0) - (aM ? parseInt(aM[1]) : 0);
	});

	const result = [...origLines];
	for (const hunk of sorted) {
		const m = hunk.header.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
		if (!m) continue;
		const oldStart = parseInt(m[1]) - 1;
		const oldCount = m[2] !== undefined ? parseInt(m[2]) : 1;

		const newLines: string[] = [];
		for (let i = 1; i < hunk.lines.length; i++) {
			const line = hunk.lines[i];
			if (line.startsWith(" ") || line.startsWith("+")) {
				newLines.push(line.slice(1));
			}
		}

		if (oldStart < 0) {
			result.splice(0, 0, ...newLines);
		} else {
			result.splice(oldStart, oldCount, ...newLines);
		}
	}
	const hadTrailingNewline = original.endsWith("\n");
	return result.join("\n") + (hadTrailingNewline ? "\n" : "");
}

export function diffFiles(
	original: string,
	current: string,
	rel: string,
	cwd: string,
): Promise<string> {
	const tmp = join(cwd, ".pi", "pi-vet", "tmp");
	mkdirSync(tmp, { recursive: true });
	const id = `${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
	const a = join(tmp, `a_${id}.txt`);
	const b = join(tmp, `b_${id}.txt`);
	writeFileSync(a, original);
	writeFileSync(b, current);
	return new Promise((resolve) => {
		const proc = spawn("diff", [
			"-u",
			"--label",
			`a/${rel}`,
			"--label",
			`b/${rel}`,
			a,
			b,
		]);
		let stdout = "";
		proc.stdout.on("data", (d: Buffer) => {
			stdout += d.toString();
		});
		proc.on("close", (code) => {
			rmSync(a, { force: true });
			rmSync(b, { force: true });
			if (code === 1) resolve(stdout);
			else if (code !== 0) resolve(simpleDiff(original, current, rel));
			else resolve("");
		});
		proc.on("error", () => {
			rmSync(a, { force: true });
			rmSync(b, { force: true });
			resolve(simpleDiff(original, current, rel));
		});
	});
}

function simpleDiff(original: string, current: string, rel: string): string {
	const oLines = original.split("\n");
	const cLines = current.split("\n");
	const out: string[] = [];
	out.push(`--- a/${rel}`);
	out.push(`+++ b/${rel}`);

	let oIdx = 0;
	let cIdx = 0;
	const hunkLines: string[] = [];
	let oStart = 1;
	let cStart = 1;

	while (oIdx < oLines.length || cIdx < cLines.length) {
		if (
			oIdx < oLines.length &&
			cIdx < cLines.length &&
			oLines[oIdx] === cLines[cIdx]
		) {
			if (hunkLines.length > 0) {
				hunkLines.push(` ${oLines[oIdx]}`);
			} else {
				oStart = oIdx + 1;
				cStart = cIdx + 1;
			}
			oIdx++;
			cIdx++;
		} else {
			if (hunkLines.length === 0) {
				oStart = oIdx + 1;
				cStart = cIdx + 1;
			}
			if (oIdx < oLines.length) {
				hunkLines.push(`-${oLines[oIdx]}`);
				oIdx++;
			}
			if (cIdx < cLines.length) {
				hunkLines.push(`+${cLines[cIdx]}`);
				cIdx++;
			}
		}
	}

	if (hunkLines.length === 0) return "";
	const oCount = oLines.length - oStart + 1;
	const cCount = cLines.length - cStart + 1;
	out.push(
		`@@ -${oStart},${Math.max(oCount, 0)} +${cStart},${Math.max(cCount, 0)} @@`,
	);
	out.push(...hunkLines);
	return out.join("\n");
}
