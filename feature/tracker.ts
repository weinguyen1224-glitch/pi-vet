import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	readlinkSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
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
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const MAX_SNAPSHOT_FILES = 2000;

async function walkDir(dir: string, budget: { bytes: number; files: number }): Promise<string[]> {
	const files: string[] = [];
	try {
		const entries = await readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			if (budget.files <= 0) break;
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				files.push(...await walkDir(full, budget));
			} else if (entry.isFile()) {
				budget.files--;
				files.push(full);
			}
		}
	} catch {
		/* ignore */
	}
	return files;
}

// ponytail: 8MiB/2000-file snapshot cap; raise if legit large dirs need full tracking
async function snapshotPath(
	abs: string,
): Promise<Array<{ path: string; content: string; existed: boolean }>> {
	try {
		const s = await stat(abs);
		if (s.isDirectory()) {
			const budget = { bytes: MAX_SNAPSHOT_BYTES, files: MAX_SNAPSHOT_FILES };
			const files = await walkDir(abs, budget);
			const out: Array<{ path: string; content: string; existed: boolean }> = [];
			for (const f of files) {
				const st = await stat(f);
				if (st.size > budget.bytes) break;
				budget.bytes -= st.size;
				out.push({ path: f, content: await readFile(f, "utf8"), existed: true });
			}
			return out;
		}
		if (s.size > MAX_SNAPSHOT_BYTES) return [];
		return [{ path: abs, content: await readFile(abs, "utf8"), existed: true }];
	} catch {
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
	/** Change ids touched during the current agent turn (for agent_end review). */
	const turnIds = new Set<string>();

	function shouldTrack(abs: string): boolean {
		// Literal path must be under cwd (symlinks may resolve outside)
		if (abs !== cwd && !abs.startsWith(cwd + "/")) return false;
		try {
			const resolved = realpathSync(abs);
			return (
				!resolved.includes("/node_modules/") &&
				!resolved.includes("/.git/") &&
				!resolved.includes("/.pi-vet/")
			);
		} catch {
			// File doesn't exist yet — check parent
			const parent = dirname(abs);
			try {
				const resolved = realpathSync(parent);
				return (
					!resolved.includes("/node_modules/") &&
					!resolved.includes("/.git/")
				);
			} catch {
				return false;
			}
		}
	}

	/** Internal URI schemes that should never be tracked as file paths. */
	const INTERNAL_SCHEMES =
		/^(xd|skill|memory|agent|history|artifact|local|rule|omp|mcp|issue|pr):\/\//;

	function absOf(p: string): string {
		return isAbsolute(p) ? p : resolve(cwd, p);
	}

	function writeChangeToDisk(c: Change): void {
		// Symlink: accept = no-op (tool already created it), reject = remove
		try {
			if (lstatSync(c.filePath).isSymbolicLink()) {
				if (c.status === "reverted") {
					rmSync(c.filePath, { force: true });
				}
				return;
			}
		} catch {
			/* not a symlink, proceed normally */
		}

		const final = applyHunks(c.originalContent, c.hunks);
		if (c.existed || final.length > 0) {
			const dir = dirname(c.filePath);
			if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
			writeFileSync(c.filePath, final, "utf8");
		} else {
			rmSync(c.filePath, { force: true });
			try {
				const parent = dirname(c.filePath);
				if (readdirSync(parent).length === 0)
					rmSync(parent, { force: true });
			} catch {
				/* ignore */
			}
		}
	}

	function mergeOrPush(change: Change): void {
		const existing = changes.find(
			(c) =>
				c.filePath === change.filePath &&
				c.sessionId === change.sessionId &&
				(c.status === "pending" || c.status === "partial"),
		);
		if (existing) {
			existing.hunks = change.hunks;
			existing.originalContent = change.originalContent;
			existing.existed = change.existed;
			existing.toolName = change.toolName;
			existing.timestamp = change.timestamp;
			existing.status = "pending";
			existing.checked = true;
			turnIds.add(existing.id);
		} else {
			changes.push(change);
			turnIds.add(change.id);
		}
	}

	async function onToolCall(event: {
		toolName: string;
		toolCallId: string;
		input: unknown;
	}): Promise<void> {
		try {
			if (event.toolName === "edit") {
				// edit input: string patch "[PATH#TAG]\nPUT ..." or object { input: patch }
				const input = event.input;
				let p = "";
				if (typeof input === "string") {
					const m = input.match(/^\[([^\]#]+)(?:#[A-F0-9]{4})?\]/);
					if (m) p = m[1];
				} else if (input && typeof input === "object") {
					const obj = input as Record<string, unknown>;
					if (typeof obj.path === "string") p = obj.path;
					else if (typeof obj.input === "string") {
						const m = obj.input.match(/^\[([^\]#]+)(?:#[A-F0-9]{4})?\]/);
						if (m) p = m[1];
					}
				}
				if (!p || INTERNAL_SCHEMES.test(p)) return;
				const abs = absOf(p);
				if (!shouldTrack(abs)) return;
				const snapshots = await snapshotPath(abs);
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
			} else if (
				event.toolName === "write" ||
				event.toolName === "replace" ||
				event.toolName === "insert" ||
				event.toolName === "undo_last_change"
			) {
				const input = event.input as Record<string, unknown>;
				const p = typeof input.path === "string" ? input.path : "";
				if (!p || INTERNAL_SCHEMES.test(p)) return;
				const abs = absOf(p);
				if (!shouldTrack(abs)) return;
				const snapshots = await snapshotPath(abs);
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
					const snapshots = await snapshotPath(abs);
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

	async function onToolResult(
		event: {
			toolName: string;
			toolCallId: string;
		},
		sessionId: string,
	): Promise<void> {
		try {
			if (
				event.toolName !== "edit" &&
				event.toolName !== "write" &&
				event.toolName !== "replace" &&
				event.toolName !== "insert" &&
				event.toolName !== "undo_last_change" &&
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
				let isSymlink = false;
				try {
					current = await readFile(t.abs, "utf8");
				} catch {
					// readFileSync fails on directories and some special files.
					// Check if it's a symlink (e.g. ln -s /some/dir ./ext).
					try {
						if (lstatSync(t.abs).isSymbolicLink()) {
							isSymlink = true;
							current = `symlink -> ${readlinkSync(t.abs)}`;
						} else {
							deleted = true;
						}
					} catch {
						deleted = true;
					}
				}
				if (!deleted && !isSymlink && current === t.originalContent) continue;

				const diff = await diffFiles(
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
					sessionId,
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

	/** Return and clear the set of change ids touched this turn. */
	function takeTurnIds(): Set<string> {
		const ids = new Set(turnIds);
		turnIds.clear();
		return ids;
	}

	return { onToolCall, onToolResult, clear, takeTurnIds, writeChangeToDisk };
}



