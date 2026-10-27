import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Base, Hunk, Step, VetData } from "../types";
import { applyHunks } from "../utils/diff";

export type View = (step: Step) => Hunk[] | null;

export interface FileState {
	content: string;
	exists: boolean;
}

export const sameState = (a: FileState, b: FileState): boolean =>
	a.exists === b.exists && (!a.exists || a.content === b.content);

export const keeps = (step: Step): boolean =>
	step.checked && (step.hunks.length === 0 || step.hunks.some((h) => h.accepted));

export const diskView: View = (step) => {
	if (step.status === "reverted") return null;
	if (step.status === "accepted") return step.hunks;
	return step.hunks.map((h) => ({ ...h, accepted: true }));
};

export const reviewView: View = (step) =>
	step.status === "pending" ? (keeps(step) ? step.hunks : null) : diskView(step);

export const viewUpTo =
	(seq: number): View =>
	(step) =>
		step.seq <= seq ? diskView(step) : null;

export const stepsFor = (data: VetData, base: Base): Step[] =>
	data.steps.filter((s) => s.filePath === base.filePath);

export function replay(base: Base, steps: Step[], view: View): FileState {
	let content = base.content;
	let exists = base.existed;
	for (const step of steps) {
		const hunks = view(step);
		if (!hunks) continue;
		content = applyHunks(content, hunks);
		if (step.effect === "new") exists = true;
		else if (step.effect === "del") exists = false;
	}
	return { content, exists };
}

function readCurrent(path: string): FileState {
	try {
		return { content: readFileSync(path, "utf8"), exists: true };
	} catch {
		return { content: "", exists: false };
	}
}

function writeState(path: string, state: FileState): void {
	if (sameState(readCurrent(path), state)) return;
	if (state.exists) {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, state.content, "utf8");
	} else {
		rmSync(path, { force: true });
	}
}

export function driftedFiles(data: VetData, view: View, only: Set<string>): string[] {
	const drifted: string[] = [];
	for (const base of data.bases) {
		if (!only.has(base.filePath)) continue;
		try {
			const steps = stepsFor(data, base);
			const current = readCurrent(base.filePath);
			if (sameState(current, replay(base, steps, diskView))) continue;
			if (sameState(current, replay(base, steps, view))) continue;
			drifted.push(base.relPath);
		} catch {
			continue;
		}
	}
	return drifted;
}

export function materialize(
	data: VetData,
	view: View,
	only: Set<string>,
): { failed: Set<string>; errors: string[] } {
	const failed = new Set<string>();
	const errors: string[] = [];
	for (const base of data.bases) {
		if (!only.has(base.filePath)) continue;
		try {
			writeState(base.filePath, replay(base, stepsFor(data, base), view));
		} catch (e) {
			failed.add(base.filePath);
			errors.push(`${base.relPath}: ${(e as Error).message}`);
		}
	}
	return { failed, errors };
}

