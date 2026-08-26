import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import type { Change } from "../types";
import { diffFiles, parseHunks } from "../utils/diff";
import { saveState } from "../config/store";
import { countStats, changeKind, kindLabel, renderDiffOverlay } from "./shared";

// ---------------------------------------------------------------------------
// Pending review UI
// ---------------------------------------------------------------------------

export async function showReview(
	ctx: ExtensionContext,
	changes: Change[],
	cwd: string,
	reviewActive: { val: boolean },
	writeChangeToDisk: (c: Change) => void,
	turnIds?: Set<string>,
	sessionId?: string,
): Promise<void> {
	if (reviewActive.val) return;
	reviewActive.val = true;

	try {
		const pending = changes.filter(
			(c) =>
				(c.status === "pending" || c.status === "partial") &&
				(!sessionId || c.sessionId === sessionId) &&
				(!turnIds || turnIds.has(c.id)),
		);
		if (pending.length === 0) {
			ctx.ui.notify("No pending changes to review", "info");
			return;
		}
		// If the file now matches its original content (e.g. an external edit
		// reverted the agent's change), the change is moot — drop it so it
		// doesn't show as a confusing no-op entry.
		for (let i = pending.length - 1; i >= 0; i--) {
			const c = pending[i];
			let current = "";
			try {
				current = readFileSync(c.filePath, "utf8");
			} catch {
				/* deleted */
			}
			const diff = diffFiles(c.originalContent, current, c.relPath, cwd);
			const newHunks = parseHunks(diff);
			if (newHunks.length === 0) {
				const idx = changes.indexOf(c);
				if (idx !== -1) changes.splice(idx, 1);
				pending.splice(i, 1);
			} else {
				c.hunks = newHunks;
			}
		}
		if (pending.length === 0) {
			ctx.ui.notify("No pending changes to review", "info");
			return;
		}

		// ---- list -> diff loop ----
		let listAction: "apply" | "diff" = "apply";
		let diffTarget: Change | null = null;

		// eslint-disable-next-line no-constant-condition
		while (true) {
			// ---- FILE LIST (no overlay, replaces editor) ----
			await ctx.ui.custom<void>((tui, theme, _kb, done) => {
				let selectedIdx = 0;
				let filter = "";
				let filtering = false;

				function filtered(): number[] {
					if (!filter) return pending.map((_, i) => i);
					const q = filter.toLowerCase();
					const result: number[] = [];
					for (let i = 0; i < pending.length; i++) {
						if (pending[i].relPath.toLowerCase().includes(q)) result.push(i);
					}
					return result;
				}

				return {
					render(width: number): string[] {
						const lines: string[] = [];
						const flt = filtered();

						// Batch summary header
						let totalAdded = 0,
							totalRemoved = 0;
						for (const c of pending) {
							const s = countStats(c);
							totalAdded += s.added;
							totalRemoved += s.removed;
						}
						const summaryParts: string[] = [];
						summaryParts.push(`Review ${pending.length} file(s)`);
						if (totalAdded > 0)
							summaryParts.push(theme.fg("success", `+${totalAdded}`));
						if (totalRemoved > 0)
							summaryParts.push(theme.fg("error", `-${totalRemoved}`));
						lines.push(theme.fg("accent", theme.bold(summaryParts.join(" "))));
						// Filter bar
						if (filtering) {
							lines.push(theme.fg("accent", ` filter: ${filter}_`));
						} else if (filter) {
							lines.push(theme.fg("dim", ` filter: ${filter} (${flt.length} match)`));
						}
						lines.push("");

						const maxVisible = Math.min(
							flt.length,
							Math.max(5, (process.stdout.rows ?? 40) - 7),
						);
						const startIdx = Math.max(
							0,
							Math.min(
								selectedIdx - Math.floor(maxVisible / 2),
								flt.length - maxVisible,
							),
						);
						const endIdx = Math.min(startIdx + maxVisible, flt.length);

						for (let i = startIdx; i < endIdx; i++) {
							const c = pending[flt[i]];
							const { added, removed } = countStats(c);
							const kind = changeKind(c, "disk");
							const check = c.checked ? "[✓]" : "[ ]";
							const cursor = i === selectedIdx ? ">" : " ";
							const plusStr = added > 0 ? `+${added}` : "";
							const minusStr = removed > 0 ? `-${removed}` : "";
							const gap = plusStr && minusStr ? " " : "";

							let line = `${cursor}${check} ${kindLabel(kind, theme)} ${c.relPath}`;
							const statsStr = `${plusStr}${gap}${minusStr}`;
							if (statsStr) line += ` ${statsStr}`;

							if (i === selectedIdx) {
								line = theme.fg("accent", line);
							} else {
								if (added > 0)
									line = line.replace(
										`+${added}`,
										theme.fg("success", `+${added}`),
									);
								if (removed > 0)
									line = line.replace(
										`-${removed}`,
										theme.fg("error", `-${removed}`),
									);
							}
							lines.push(line);
						}

						// Footer: key hints
						const footerKeys = [
							{ key: "↑↓", label: "move" },
							{ key: "␣", label: "toggle" },
							{ key: "a", label: "all" },
							{ key: "r", label: "none" },
							{ key: "/", label: "filter" },
							{ key: "⏎", label: "diff" },
							{ key: "esc", label: "apply" },
						];
						const footerParts = footerKeys.map(
							(fk) =>
								theme.fg("accent", fk.key) + " " + theme.fg("dim", fk.label),
						);
						lines.push(footerParts.join(theme.fg("borderMuted", " │ ")));
						return lines;
					},

					invalidate() {},

					handleInput(data: string): void {
						if (filtering) {
							if (matchesKey(data, "escape")) {
								filtering = false;
								filter = "";
								selectedIdx = 0;
								tui.requestRender();
								return;
							}
							if (matchesKey(data, "enter")) {
								filtering = false;
								selectedIdx = 0;
								tui.requestRender();
								return;
							}
							if (matchesKey(data, "backspace")) {
								filter = filter.slice(0, -1);
								selectedIdx = 0;
								tui.requestRender();
								return;
							}
							if (data.length === 1 && data >= " ") {
								filter += data;
								selectedIdx = 0;
								tui.requestRender();
								return;
							}
							return;
						}

						const flt = filtered();
						if (matchesKey(data, "up") || data === "k") {
							selectedIdx = Math.max(0, selectedIdx - 1);
							tui.requestRender();
						} else if (matchesKey(data, "down") || data === "j") {
							selectedIdx = Math.min(flt.length - 1, selectedIdx + 1);
							tui.requestRender();
						} else if (data === " ") {
							const idx = flt[selectedIdx];
							if (idx !== undefined) {
								pending[idx].checked = !pending[idx].checked;
								saveState(changes, cwd);
								tui.requestRender();
							}
						} else if (data === "/") {
							filtering = true;
							filter = "";
							selectedIdx = 0;
							tui.requestRender();
						} else if (matchesKey(data, "enter")) {
							const idx = flt[selectedIdx];
							if (idx !== undefined) {
								diffTarget = pending[idx];
								listAction = "diff";
								done();
							}
						} else if (data === "a") {
							for (const c of pending) c.checked = true;
							saveState(changes, cwd);
							tui.requestRender();
						} else if (data === "r") {
							for (const c of pending) c.checked = false;
							saveState(changes, cwd);
							tui.requestRender();
						} else if (matchesKey(data, "escape")) {
							listAction = "apply";
							done();
						}
					},
				};
			});

			if (listAction === "apply") break;

			// ---- DIFF VIEW (overlay modal with border) ----
			if (listAction === "diff" && diffTarget) {
				const c = diffTarget as Change;
				await renderDiffOverlay(
					ctx,
					c.hunks,
					c.relPath,
					() => saveState(changes, cwd),
				);
				listAction = "apply";
			}
		}

		// After UI closes, apply checked changes
		const batchId = Date.now();
		for (const c of pending) {
			if (c.checked) {
				writeChangeToDisk(c);
				c.status = "accepted";
				c.batchId = batchId;
			} else {
				if (c.existed) {
					const dir = dirname(c.filePath);
					if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
					writeFileSync(c.filePath, c.originalContent, "utf8");
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
				c.status = "reverted";
				c.batchId = batchId;
			}
		}
		saveState(changes, cwd);
	} finally {
		reviewActive.val = false;
	}
}



