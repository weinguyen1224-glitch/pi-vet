import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import type { Change } from "../types";
import { applyHunks } from "../utils/diff";
import { saveState } from "../config/store";
import { countStats, changeKind, kindLabel, renderDiffOverlay } from "./shared";

// ---------------------------------------------------------------------------
// History UI (tick + apply per-file, undo all shortcut)
// ---------------------------------------------------------------------------

export async function showHistory(
	ctx: ExtensionContext,
	changes: Change[],
	batch: Change[],
	cwd: string,
	writeChangeToDisk: (c: Change) => void,
): Promise<void> {
	const batchId = batch[0].batchId;
	const statusLabel = batch[0].status === "accepted" ? "accepted" : "reverted";
	const timeStr = new Date(batchId).toLocaleTimeString();

	// Init checkboxes from current status: accepted → [✓], reverted → [ ]
	for (const c of batch) {
		c.checked = c.status === "accepted";
	}

	// Reconstruct diff from stored hunks — history always shows original diff
	function buildDiffView(c: Change): string {
		const lines: string[] = [];
		lines.push(`--- a/${c.relPath}`);
		lines.push(`+++ b/${c.relPath}`);
		for (const h of c.hunks) {
			lines.push(h.header);
			for (let i = 1; i < h.lines.length; i++) {
				lines.push(h.lines[i]);
			}
		}
		return lines.join("\n");
	}

	let listAction: "quit" | "diff" | "undo" | "apply" = "quit";
	let diffTarget: Change | null = null;

	// eslint-disable-next-line no-constant-condition
	while (true) {
		// ---- HISTORY LIST (no overlay, replaces editor) ----
		await ctx.ui.custom<void>((tui, theme, _kb, done) => {
			let selectedIdx = 0;

			return {
				render(width: number): string[] {
					const lines: string[] = [];

					// Batch summary header
					let totalAdded = 0,
						totalRemoved = 0;
					for (const c of batch) {
						const s = countStats(c);
						totalAdded += s.added;
						totalRemoved += s.removed;
					}
					const summaryParts: string[] = [];
					summaryParts.push(
						`Last batch (${statusLabel} at ${timeStr}) — ${batch.length} file(s)`,
					);
					if (totalAdded > 0)
						summaryParts.push(theme.fg("success", `+${totalAdded}`));
					if (totalRemoved > 0)
						summaryParts.push(theme.fg("error", `-${totalRemoved}`));
					lines.push(theme.fg("accent", theme.bold(summaryParts.join(" "))));
					lines.push("");

					const maxVisible = Math.min(batch.length, 20);
					const startIdx = Math.max(
						0,
						Math.min(
							selectedIdx - Math.floor(maxVisible / 2),
							batch.length - maxVisible,
						),
					);
					const endIdx = Math.min(startIdx + maxVisible, batch.length);

					for (let i = startIdx; i < endIdx; i++) {
						const c = batch[i];
						const { added, removed } = countStats(c);
						const kind = changeKind(c, "hunks");
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
						{ key: "u", label: "undo" },
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
						selectedIdx = Math.min(batch.length - 1, selectedIdx + 1);
						tui.requestRender();
					} else if (data === " ") {
						const c = batch[selectedIdx];
						if (c) {
							c.checked = !c.checked;
							saveState(changes, cwd);
							tui.requestRender();
						}
					} else if (data === "a") {
						for (const c of batch) c.checked = true;
						saveState(changes, cwd);
						tui.requestRender();
					} else if (data === "r") {
						for (const c of batch) c.checked = false;
						saveState(changes, cwd);
						tui.requestRender();
					} else if (matchesKey(data, "enter")) {
						const c = batch[selectedIdx];
						if (c) {
							diffTarget = c;
							listAction = "diff";
							done();
						}
					} else if (matchesKey(data, "escape")) {
						listAction = "apply";
						done();
					} else if (data === "u") {
						listAction = "undo";
						done();
					}
				},
			};
		});

		if (listAction === "quit") break;

		if (listAction === "undo") {
			for (const c of batch) {
				const modified = applyHunks(c.originalContent, c.hunks);
				if (c.existed || modified.length > 0) {
					const dir = dirname(c.filePath);
					if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
					writeFileSync(c.filePath, modified, "utf8");
				} else {
					rmSync(c.filePath, { force: true });
				}
				c.status = "pending";
				c.checked = true;
			}
			saveState(changes, cwd);
			ctx.ui.notify(
				`Undone ${batch.length} file(s) — back to pending review`,
				"info",
			);
			break;
		}

		if (listAction === "apply") {
			let changed = 0;
			for (const c of batch) {
				const wantAccept = c.checked;
				const isAccepted = c.status === "accepted";
				if (wantAccept === isAccepted) continue;
				changed++;
				if (wantAccept) {
					writeChangeToDisk(c);
					c.status = "accepted";
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
				}
			}
			saveState(changes, cwd);
			if (changed > 0) {
				ctx.ui.notify(`Applied ${changed} change(s)`, "info");
			}
			break;
		}

		// ---- DIFF VIEW (overlay modal with border, same as pending) ----
		if (listAction === "diff" && diffTarget) {
			const diffText = buildDiffView(diffTarget);
			await renderDiffOverlay(ctx, diffText, diffTarget.relPath);
			listAction = "quit";
		}
	}
}
