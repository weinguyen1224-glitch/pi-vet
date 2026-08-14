import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Change } from "../types";
import { applyHunks, diffFiles, parseHunks } from "../utils/diff";
import { extractBashPaths } from "../utils/bash-paths";
import { saveState } from "../config/store";

// ---------------------------------------------------------------------------
// Tool tracking
// ---------------------------------------------------------------------------

/** Walk a directory recursively, return all file paths inside. */
function walkDir(dir: string): string[] {
	const files: string[] = [];
	try {
		const entries = readdirSync(dir, { withFileTypes: true });
		for (const e of entries) {
			const full = join(dir, e.name);
			if (e.isDirectory()) {
				files.push(...walkDir(full));
			} else if (e.isFile()) {
				files.push(full);
			}
		}
	} catch {
		/* ignore */
	}
	return files;
}

/** Snapshot a path: if it's a directory, snapshot all files inside. */
function snapshotPath(
	abs: string,
): Array<{ path: string; content: string; existed: boolean }> {
	try {
		const st = statSync(abs);
		if (st.isDirectory()) {
			const files = walkDir(abs);
			return files.map((f) => {
				try {
					return { path: f, content: readFileSync(f, "utf8"), existed: true };
				} catch {
					return { path: f, content: "", existed: false };
				}
			});
		}
		// Regular file
		return [{ path: abs, content: readFileSync(abs, "utf8"), existed: true }];
	} catch {
		// Doesn't exist (yet) — new file
		return [{ path: abs, content: "", existed: false }];
	}
}

export function createTracker(
	cwd: string,
	changes: Change[],
	nextId: { val: number },
) {
	const originals = new Map<
		string,
		{ path: string; content: string; existed: boolean }
	>();

	function shouldTrack(abs: string): boolean {
		let resolved = abs;
		try {
			resolved = realpathSync(abs);
		} catch {
			/* doesn't exist yet */
		}
		return (
			resolved.startsWith(cwd) &&
			!resolved.includes("/node_modules/") &&
			!resolved.includes("/.git/")
		);
	}
/** Internal URI schemes that should never be tracked as file paths. */
const INTERNAL_SCHEMES = /^(xd|skill|memory|agent|history|artifact|local|rule|omp|mcp|issue|pr):\/\//;

	function absOf(p: string): string {
		return isAbsolute(p) ? p : resolve(cwd, p);
	}

	function writeChangeToDisk(c: Change): void {
		const final = applyHunks(c.originalContent, c.hunks);
		if (c.existed || final.length > 0) {
			const dir = dirname(c.filePath);
			if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
			writeFileSync(c.filePath, final, "utf8");
		} else {
			rmSync(c.filePath, { force: true });
			// Clean up empty parent dirs
			try {
				const parent = dirname(c.filePath);
				if (readdirSync(parent).length === 0) rmSync(parent, { force: true });
			} catch {
				/* ignore */
			}
		}
	}

	function mergeOrPush(change: Change): void {
		const existing = changes.find(
			(c) => c.filePath === change.filePath && c.status === "pending",
		);
		if (existing) {
			let current = "";
			try {
				current = readFileSync(change.filePath, "utf8");
			} catch {
				/* deleted */
			}
			const diff = diffFiles(
				existing.originalContent,
				current,
				change.relPath,
				cwd,
			);
			existing.hunks = parseHunks(diff);
			existing.toolName = change.toolName;
		} else {
			changes.push(change);
		}
	}

	function onToolCall(event: {
		toolName: string;
		toolCallId: string;
		input: unknown;
	}): void {
		try {
			if (event.toolName === "edit") {
				// edit input is a patch string: "[PATH#TAG]\nPUT ..."
				const input = event.input;
				let p = "";
				if (typeof input === "string") {
					const m = input.match(/^\[([^\]#]+)(?:#[A-F0-9]{4})?\]/m);
					if (m) p = m[1];
				} else if (input && typeof input === "object") {
					p = typeof (input as Record<string, unknown>).path === "string"
						? (input as Record<string, unknown>).path as string
						: "";
				}
				if (!p || INTERNAL_SCHEMES.test(p)) return;
				const abs = absOf(p);
				if (!shouldTrack(abs)) return;
				const snapshots = snapshotPath(abs);
				if (snapshots.length === 1) {
					originals.set(event.toolCallId, {
						path: snapshots[0].path,
						content: snapshots[0].content,
						existed: snapshots[0].existed,
					});
				} else {
					originals.set(event.toolCallId, {
						path: "",
						content: JSON.stringify(snapshots),
						existed: true,
					});
				}
		} else if (event.toolName === "write") {
			const input = event.input as Record<string, unknown>;
			const p = typeof input.path === "string" ? input.path : "";
			if (!p || INTERNAL_SCHEMES.test(p)) return;
			const abs = absOf(p);
			if (!shouldTrack(abs)) return;
				const snapshots = snapshotPath(abs);
				if (snapshots.length === 1) {
					originals.set(event.toolCallId, {
						path: snapshots[0].path,
						content: snapshots[0].content,
						existed: snapshots[0].existed,
					});
				} else {
					originals.set(event.toolCallId, {
						path: "",
						content: JSON.stringify(snapshots),
						existed: true,
					});
				}
			} else if (event.toolName === "bash") {
				const input = event.input as Record<string, unknown>;
				const cmd = typeof input.command === "string" ? input.command : "";
				const paths = extractBashPaths(cmd);
				if (paths.length === 0) return;
				const entries: Array<{
					path: string;
					content: string;
					existed: boolean;
				}> = [];
				for (const p of paths) {
					const abs = absOf(p);
					if (!shouldTrack(abs)) continue;
					const snapshots = snapshotPath(abs);
					for (const s of snapshots) entries.push(s);
				}
				if (entries.length > 0)
					originals.set(event.toolCallId, {
						path: "",
						content: JSON.stringify(entries),
						existed: true,
					});
			}
		} catch {
			/* ignore */
		}
	}

	function onToolResult(event: { toolName: string; toolCallId: string }): void {
		try {
			if (
				event.toolName !== "edit" &&
				event.toolName !== "write" &&
				event.toolName !== "bash"
			)
				return;
			const orig = originals.get(event.toolCallId);
			if (!orig) return;
			originals.delete(event.toolCallId);

			const targets: Array<{
				abs: string;
				originalContent: string;
				existed: boolean;
			}> = [];
			if (event.toolName === "bash" || orig.path === "") {
				try {
					const entries = JSON.parse(orig.content) as Array<{
						path: string;
						content: string;
						existed: boolean;
					}>;
					for (const e of entries)
						targets.push({
							abs: e.path,
							originalContent: e.content,
							existed: e.existed,
						});
				} catch {
					return;
				}
			} else {
				targets.push({
					abs: orig.path,
					originalContent: orig.content,
					existed: orig.existed,
				});
			}

			for (const t of targets) {
				let current = "";
				let deleted = false;
				try {
					current = readFileSync(t.abs, "utf8");
				} catch {
					deleted = true;
				}
				if (!deleted && current === t.originalContent) continue;

				const diff = diffFiles(
					t.originalContent,
					deleted ? "" : current,
					relative(cwd, t.abs),
					cwd,
				);
				const hunks = parseHunks(diff);

				mergeOrPush({
					id: `c${nextId.val++}`,
					filePath: t.abs,
					relPath: relative(cwd, t.abs),
					toolName: event.toolName,
					originalContent: t.originalContent,
					existed: t.existed,
					status: "pending",
					hunks,
					checked: true,
					timestamp: Date.now(),
					batchId: 0,
				});
			}
			saveState(changes, cwd);
		} catch {
			/* ignore */
		}
	}

	function clear(): void {
		originals.clear();
	}

	return { onToolCall, onToolResult, clear, writeChangeToDisk };
}
