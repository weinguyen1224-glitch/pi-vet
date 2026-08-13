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
): Promise<void> {
	if (reviewActive.val) return;
	reviewActive.val = true;

	try {
		const pending = changes.filter(
			(c) => c.status === "pending" || c.status === "partial",
		);
		if (pending.length === 0) {
			ctx.ui.notify("No pending changes to review", "info");
			return;
		}

		// Always regenerate hunks from disk to ensure freshness.
		// If regeneration produces empty hunks but we already have hunks
		// (e.g. file was moved/deleted after tracking), keep the old ones.
		for (const c of pending) {
			let current = "";
			try {
				current = readFileSync(c.filePath, "utf8");
			} catch {
				/* deleted */
			}
			const diff = diffFiles(c.originalContent, current, c.relPath, cwd);
			const newHunks = parseHunks(diff);
			if (newHunks.length > 0 || c.hunks.length === 0) {
				c.hunks = newHunks;
			}
		}

		function buildDiff(c: Change): string {
			let current = "";
			try {
				current = readFileSync(c.filePath, "utf8");
			} catch {
				/* deleted */
			}
			const diff = diffFiles(c.originalContent, current, c.relPath, cwd);
			// If file was moved/deleted and diff is empty but we have stored hunks,
			// reconstruct diff from hunks so the overlay still shows the change.
			if (diff || c.hunks.length === 0) return diff;
			const lines: string[] = [];
			lines.push(`--- a/${c.relPath}`);
			lines.push(`+++ b/${c.relPath}`);
			for (const h of c.hunks) {
				lines.push(h.header);
				for (let i = 1; i < h.lines.length; i++) lines.push(h.lines[i]);
			}
			return lines.join("\n");
		}

		// ---- list -> diff loop ----
		let listAction: "apply" | "diff" = "apply";
		let diffTarget: Change | null = null;

		// eslint-disable-next-line no-constant-condition
		while (true) {
			// ---- FILE LIST (no overlay, replaces editor) ----
			await ctx.ui.custom<void>((tui, theme, _kb, done) => {
				let selectedIdx = 0;

				return {
					render(width: number): string[] {
						const lines: string[] = [];

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
						lines.push("");

						const maxVisible = Math.min(pending.length, 20);
						const startIdx = Math.max(
							0,
							Math.min(
								selectedIdx - Math.floor(maxVisible / 2),
								pending.length - maxVisible,
							),
						);
						const endIdx = Math.min(startIdx + maxVisible, pending.length);

						for (let i = startIdx; i < endIdx; i++) {
							const c = pending[i];
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
						if (matchesKey(data, "up") || data === "k") {
							selectedIdx = Math.max(0, selectedIdx - 1);
							tui.requestRender();
						} else if (matchesKey(data, "down") || data === "j") {
							selectedIdx = Math.min(pending.length - 1, selectedIdx + 1);
							tui.requestRender();
						} else if (data === " ") {
							const c = pending[selectedIdx];
							if (c) {
								c.checked = !c.checked;
								saveState(changes, cwd);
								tui.requestRender();
							}
						} else if (matchesKey(data, "enter")) {
							const c = pending[selectedIdx];
							if (c) {
								diffTarget = c;
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
				const diffText = buildDiff(diffTarget);
				await renderDiffOverlay(ctx, diffText, diffTarget.relPath);
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
					// Clean up empty parent dirs
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
