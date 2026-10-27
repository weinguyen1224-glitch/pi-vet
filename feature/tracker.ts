import { realpathSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Base, Step, StepEffect, VetData } from "../types";
import { diffFiles, parseHunks } from "../utils/diff";
import { extractBashPaths } from "../utils/bash-paths";
import { diskView, replay, sameState, stepsFor, type FileState } from "./replay";

const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const MAX_SNAPSHOT_FILES = 2000;
const SKIPPED_DIRS = new Set(["node_modules", ".git"]);
const TRACKED_TOOLS = new Set([
	"edit",
	"write",
	"replace",
	"replace_match",
	"insert",
	"copy",
	"move",
	"undo_last_change",
	"bash",
]);
const PATH_INPUT_TOOLS = new Set(["write", "undo_last_change"]);
const OPTIONAL_PATH_TOOLS = new Set(["replace", "replace_match", "insert"]);
const CROSS_FILE_TOOLS = new Set(["copy", "move"]);
const INTERNAL_SCHEMES =
	/^(xd|skill|memory|agent|history|artifact|local|rule|omp|mcp|issue|pr):\/\//;
const PATCH_PATH = /^\[([^\]#]+)(?:#[A-F0-9]{4})?\]/;

interface Snapshot {
	path: string;
	content: string;
	existed: boolean;
}

interface PendingCall {
	snapshots: Snapshot[];
	watchedFiles: Set<string>;
	watchedDirectories: string[];
}

async function readText(path: string): Promise<string | null> {
	const buffer = await readFile(path);
	return buffer.includes(0) ? null : buffer.toString("utf8");
}

async function walkDir(dir: string, budget: { files: number }): Promise<string[]> {
	const files: string[] = [];
	try {
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			if (budget.files <= 0) break;
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (!SKIPPED_DIRS.has(entry.name)) files.push(...(await walkDir(full, budget)));
			} else if (entry.isFile()) {
				budget.files--;
				files.push(full);
			}
		}
	} catch {
		return files;
	}
	return files;
}

async function snapshotFile(path: string, budget: { bytes: number }): Promise<Snapshot | null> {
	const { size } = await stat(path);
	if (size > budget.bytes) return null;
	const content = await readText(path);
	if (content === null) return null;
	budget.bytes -= size;
	return { path, content, existed: true };
}

async function readState(path: string): Promise<FileState> {
	try {
		return { content: (await readText(path)) ?? "", exists: true };
	} catch {
		return { content: "", exists: false };
	}
}

function effectOf(before: FileState, after: FileState): StepEffect {
	if (!before.exists && after.exists) return "new";
	if (before.exists && !after.exists) return "del";
	return "mod";
}

function pathsOf(toolName: string, input: unknown, cwd: string): string[] {
	const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
	if (toolName === "edit") {
		const patch = typeof input === "string" ? input : obj.input;
		const fromPatch = typeof patch === "string" ? patch.match(PATCH_PATH)?.[1] : undefined;
		const path = typeof obj.path === "string" ? obj.path : fromPatch;
		return path ? [path] : [];
	}
	if (PATH_INPUT_TOOLS.has(toolName)) return typeof obj.path === "string" ? [obj.path] : [];
	if (OPTIONAL_PATH_TOOLS.has(toolName)) return [typeof obj.path === "string" ? obj.path : cwd];
	if (CROSS_FILE_TOOLS.has(toolName)) return [cwd];
	if (toolName === "bash") return extractBashPaths(typeof obj.command === "string" ? obj.command : "");
	return [];
}

export function createTracker(cwd: string, getData: () => VetData, save: () => void) {
	const pending = new Map<string, PendingCall>();
	let touched = false;

	function shouldTrack(abs: string): boolean {
		if (abs !== cwd && !abs.startsWith(cwd + "/")) return false;
		const allowed = (path: string) => {
			const resolved = `${realpathSync(path)}/`;
			return (
				!resolved.includes("/node_modules/") &&
				!resolved.includes("/.git/") &&
				!resolved.includes("/.pi/pi-vet/")
			);
		};
		try {
			return allowed(abs);
		} catch {
			try {
				return allowed(dirname(abs));
			} catch {
				return false;
			}
		}
	}

	const absOf = (p: string) => (isAbsolute(p) ? p : resolve(cwd, p));

	// ponytail: 8MiB/2000-file snapshot cap per tool call; raise if legit large dirs need full tracking
	async function watch(abs: string, call: PendingCall, budget: { bytes: number }): Promise<void> {
		const info = await stat(abs).catch(() => null);
		if (!info) {
			call.snapshots.push({ path: abs, content: "", existed: false });
			call.watchedDirectories.push(abs);
			return;
		}
		if (!info.isDirectory()) {
			const snap = await snapshotFile(abs, budget);
			if (snap) call.snapshots.push(snap);
			return;
		}
		call.watchedDirectories.push(abs);
		for (const file of await walkDir(abs, { files: MAX_SNAPSHOT_FILES })) {
			if (!shouldTrack(file)) continue;
			call.watchedFiles.add(file);
			const snap = await snapshotFile(file, budget).catch(() => null);
			if (snap) call.snapshots.push(snap);
		}
	}

	async function onToolCall(event: {
		toolName: string;
		toolCallId: string;
		input: unknown;
	}): Promise<void> {
		if (!TRACKED_TOOLS.has(event.toolName)) return;
		try {
			const call: PendingCall = { snapshots: [], watchedFiles: new Set(), watchedDirectories: [] };
			const budget = { bytes: MAX_SNAPSHOT_BYTES };
			for (const p of pathsOf(event.toolName, event.input, cwd)) {
				if (INTERNAL_SCHEMES.test(p)) continue;
				const abs = absOf(p);
				if (shouldTrack(abs)) await watch(abs, call, budget);
			}
			if (call.snapshots.length > 0 || call.watchedDirectories.length > 0) {
				pending.set(event.toolCallId, call);
			}
		} catch {
			return;
		}
	}

	async function createdFiles(call: PendingCall): Promise<Snapshot[]> {
		const created: Snapshot[] = [];
		for (const directory of call.watchedDirectories) {
			for (const file of await walkDir(directory, { files: MAX_SNAPSHOT_FILES })) {
				if (call.watchedFiles.has(file) || !shouldTrack(file)) continue;
				call.watchedFiles.add(file);
				created.push({ path: file, content: "", existed: false });
			}
		}
		return created;
	}

	async function makeStep(
		base: Base,
		seq: number,
		toolName: string,
		origin: Step["origin"],
		before: FileState,
		after: FileState,
	): Promise<Step> {
		const diff = await diffFiles(before.content, after.content, base.relPath);
		return {
			id: `${seq}:${base.relPath}`,
			seq,
			filePath: base.filePath,
			relPath: base.relPath,
			sessionId: base.sessionId,
			toolName,
			origin,
			effect: effectOf(before, after),
			status: "pending",
			hunks: parseHunks(diff),
			checked: true,
			timestamp: Date.now(),
		};
	}

	function expectedState(data: VetData, base: Base): FileState | null {
		try {
			return replay(base, stepsFor(data, base), diskView);
		} catch {
			return null;
		}
	}

	async function onToolResult(
		event: { toolName: string; toolCallId: string },
		sessionId: string,
	): Promise<void> {
		const call = pending.get(event.toolCallId);
		if (!call) return;
		pending.delete(event.toolCallId);
		try {
			const taken = [...call.snapshots, ...(await createdFiles(call))];
			const data = getData();
			const plans: Array<{
				base: Base;
				before: FileState;
				after: FileState;
				drifted: FileState | null;
				changed: boolean;
			}> = [];
			for (const snap of taken) {
				const before: FileState = { content: snap.content, exists: snap.existed };
				const after = await readState(snap.path);
				const known = data.bases.find((b) => b.filePath === snap.path);
				const expected = known ? expectedState(data, known) : null;
				const drifted = expected && !sameState(expected, before) ? expected : null;
				const changed = !sameState(before, after);
				if (!changed && !drifted) continue;
				const base: Base = known ?? {
					filePath: snap.path,
					relPath: relative(cwd, snap.path),
					sessionId,
					content: before.content,
					existed: before.exists,
				};
				plans.push({ base, before, after, drifted, changed });
			}
			if (plans.length === 0) return;

			let seq = Math.max(0, ...data.steps.map((s) => s.seq));
			for (const plan of plans) {
				if (!data.bases.includes(plan.base)) data.bases.push(plan.base);
				if (plan.drifted)
					data.steps.push(
						await makeStep(plan.base, ++seq, "external", "external", plan.drifted, plan.before),
					);
			}
			const toolSeq = ++seq;
			for (const plan of plans) {
				if (!plan.changed) continue;
				data.steps.push(
					await makeStep(plan.base, toolSeq, event.toolName, "agent", plan.before, plan.after),
				);
				touched = true;
			}
			save();
		} catch {
			return;
		}
	}

	return {
		onToolCall,
		onToolResult,
		clear: () => pending.clear(),
		takeTouched(): boolean {
			const was = touched;
			touched = false;
			return was;
		},
	};
}

