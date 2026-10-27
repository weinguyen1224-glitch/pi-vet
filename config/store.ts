import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { VetData } from "../types";

export function statePath(cwd: string): string {
	return join(cwd, ".pi", "pi-vet", "state.json");
}

export function configPath(cwd: string): string {
	return join(cwd, ".pi", "pi-vet", "config.json");
}

export function loadEnabled(cwd: string): boolean {
	try {
		const cp = configPath(cwd);
		if (!existsSync(cp)) return true;
		return JSON.parse(readFileSync(cp, "utf8")).enabled !== false;
	} catch {
		return true;
	}
}

export function saveEnabled(enabled: boolean, cwd: string): void {
	const cp = configPath(cwd);
	mkdirSync(dirname(cp), { recursive: true });
	writeFileSync(cp, JSON.stringify({ enabled }, null, 2));
}

function readStateFile(path: string): VetData {
	try {
		const raw = JSON.parse(readFileSync(path, "utf8"));
		return {
			bases: Array.isArray(raw?.bases) ? raw.bases : [],
			steps: Array.isArray(raw?.steps) ? raw.steps : [],
		};
	} catch {
		return { bases: [], steps: [] };
	}
}

export function loadSession(cwd: string, sessionId: string): VetData {
	const disk = readStateFile(statePath(cwd));
	return {
		bases: disk.bases.filter((b) => b.sessionId === sessionId),
		steps: disk.steps.filter((s) => s.sessionId === sessionId),
	};
}

export function saveSession(cwd: string, sessionId: string, own: VetData): void {
	const sp = statePath(cwd);
	const disk = readStateFile(sp);
	const state: VetData = {
		bases: [...disk.bases.filter((b) => b.sessionId !== sessionId), ...own.bases],
		steps: [...disk.steps.filter((s) => s.sessionId !== sessionId), ...own.steps],
	};
	if (state.bases.length === 0 && state.steps.length === 0) {
		rmSync(sp, { force: true });
		return;
	}
	mkdirSync(dirname(sp), { recursive: true });
	const tmp = `${sp}.tmp`;
	writeFileSync(tmp, JSON.stringify(state));
	renameSync(tmp, sp);
}

