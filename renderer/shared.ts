import { readFileSync } from "node:fs";
import { matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import type { Change } from "../types";

// ---------------------------------------------------------------------------
// Shared helpers for review-list and history-list
// ---------------------------------------------------------------------------

/** Count added/removed lines from hunks. */
export function countStats(c: Change): { added: number; removed: number } {
	let added = 0,
		removed = 0;
	for (const h of c.hunks) {
		for (let i = 1; i < h.lines.length; i++) {
			const l = h.lines[i];
			if (l.startsWith("+") && !l.startsWith("+++")) added++;
			else if (l.startsWith("-") && !l.startsWith("---")) removed++;
		}
	}
	return { added, removed };
}

/** Classify change kind. mode="disk" reads current file; mode="hunks" uses hunks.length heuristic. */
export function changeKind(
	c: Change,
	mode: "disk" | "hunks",
): "new" | "del" | "mod" {
	if (!c.existed) return "new";
	if (mode === "disk") {
		let current = "";
		try {
			current = readFileSync(c.filePath, "utf8");
		} catch {
			/* gone */
		}
		if (current === "" && c.originalContent !== "") return "del";
	} else {
		if (c.originalContent !== "" && c.hunks.length === 0) return "del";
	}
	return "mod";
}

/** Kind label with theme color. */
export function kindLabel(
	kind: "new" | "del" | "mod",
	theme: { fg: (c: string, t: string) => string },
): string {
	if (kind === "new") return theme.fg("success", "[new]");
	if (kind === "del") return theme.fg("error", "[del]");
	return theme.fg("warning", "[mod]");
}

// ---------------------------------------------------------------------------
// Diff overlay (shared between pending review and history)
// ---------------------------------------------------------------------------

export interface DiffOverlayResult {
	action: "back";
}

export async function renderDiffOverlay(
	ctx: {
		ui: {
			custom: <T>(
				factory: (
					tui: { requestRender: () => void },
					theme: {
						fg: (c: string, t: string) => string;
						bold: (t: string) => string;
					},
					_kb: unknown,
					done: (value?: T) => void,
				) => {
					render: (width: number) => string[];
					invalidate: () => void;
					handleInput: (data: string) => void;
				},
				opts?: {
					overlay?: boolean;
					overlayOptions?: { anchor?: string; margin?: number };
				},
			) => Promise<T>;
		};
	},
	diffText: string,
	relPath: string,
): Promise<DiffOverlayResult> {
	await ctx.ui.custom<void>(
		(tui, theme, _kb, done) => {
			let scrollOffset = 0;
			const hScroll = { val: 0 };
			let totalDL = 0;
			const maxDL = 40;

			return {
				render(width: number): string[] {
					const lines: string[] = [];
					const boxW = width - 2;
					const innerW = boxW - 2;

					// Top border
					const title = ` Diff: ${relPath} `;
					const titleW = visibleWidth(title);
					const tLeft = Math.max(0, Math.floor((boxW - titleW) / 2));
					const tRight = Math.max(0, boxW - titleW - tLeft);
					lines.push(
						theme.fg(
							"borderAccent",
							`╭${"─".repeat(tLeft)}${theme.fg("accent", theme.bold(title))}${theme.fg("borderAccent", "─".repeat(tRight) + "╮")}`,
						),
					);

					// Diff lines
					const diffLines = diffText.split("\n");
					totalDL = diffLines.length;
					const startDL = Math.max(
						0,
						Math.min(scrollOffset, Math.max(0, totalDL - maxDL)),
					);
					const endDL = Math.min(startDL + maxDL, totalDL);

					for (let i = startDL; i < endDL; i++) {
						const raw = diffLines[i];

						// Horizontal scroll left
						let text = raw;
						let skippedW = 0;
						let skipChars = 0;
						for (let ci = 0; ci < text.length; ci++) {
							const charW = text[ci].charCodeAt(0) > 127 ? 2 : 1;
							if (skippedW + charW > hScroll.val) break;
							skippedW += charW;
							skipChars = ci + 1;
						}
						text = text.slice(skipChars);

						// Overflow arrows needed?
						const showLeftArrow = hScroll.val > 0;
						const showRightArrow = visibleWidth(raw) > hScroll.val + innerW;

						// Truncate to innerW
						const maxTextW =
							innerW - (showLeftArrow ? 1 : 0) - (showRightArrow ? 1 : 0);
						let visibleW = 0;
						let keepChars = 0;
						for (let ci = 0; ci < text.length; ci++) {
							const charW = text[ci].charCodeAt(0) > 127 ? 2 : 1;
							if (visibleW + charW > maxTextW) break;
							visibleW += charW;
							keepChars = ci + 1;
						}
						text = text.slice(0, keepChars);

						// Color by diff line type
						let colored: string;
						if (raw.startsWith("+") && !raw.startsWith("+++")) {
							colored = theme.fg("success", text);
						} else if (raw.startsWith("-") && !raw.startsWith("---")) {
							colored = theme.fg("error", text);
						} else if (raw.startsWith("@@")) {
							colored = theme.fg("accent", text);
						} else {
							colored = theme.fg("dim", text);
						}

						// Overflow arrows after coloring
						if (showLeftArrow) colored = theme.fg("dim", "◀") + colored;
						if (showRightArrow) colored = colored + theme.fg("dim", "▶");

						// Pad + borders
						const leftBorder = theme.fg("borderAccent", "│ ");
						const rightBorder = theme.fg("borderAccent", " │");
						const padding =
							innerW -
							visibleW -
							(showLeftArrow ? 1 : 0) -
							(showRightArrow ? 1 : 0);
						lines.push(
							leftBorder +
								colored +
								" ".repeat(Math.max(0, padding)) +
								rightBorder,
						);
					}

					// Fill empty lines
					for (let i = endDL - startDL; i < maxDL; i++) {
						lines.push(theme.fg("borderAccent", `│${" ".repeat(innerW + 2)}│`));
					}

					// Bottom border
					const scrollInfo =
						totalDL > maxDL ? ` ${startDL + 1}-${endDL}/${totalDL} ` : "";
					const footer = ` esc back  ↑↓ ctrl+u/d g/G  ←→ h/H scroll${scrollInfo} `;
					const fPad = Math.max(0, boxW - visibleWidth(footer));
					lines.push(
						theme.fg("borderAccent", `╰${footer}${"─".repeat(fPad)}╯`),
					);

					return lines;
				},

				invalidate() {},

				handleInput(data: string): void {
					if (matchesKey(data, "up") || data === "k") {
						scrollOffset = Math.max(0, scrollOffset - 1);
						tui.requestRender();
					} else if (matchesKey(data, "down") || data === "j") {
						scrollOffset++;
						tui.requestRender();
					} else if (matchesKey(data, "ctrl+u")) {
						scrollOffset = Math.max(0, scrollOffset - Math.floor(maxDL / 2));
						tui.requestRender();
					} else if (matchesKey(data, "ctrl+d")) {
						scrollOffset += Math.floor(maxDL / 2);
						tui.requestRender();
					} else if (data === "g") {
						scrollOffset = 0;
						tui.requestRender();
					} else if (data === "G") {
						scrollOffset = Math.max(0, totalDL - maxDL);
						tui.requestRender();
					} else if (matchesKey(data, "left")) {
						hScroll.val = Math.max(0, hScroll.val - 8);
						tui.requestRender();
					} else if (matchesKey(data, "right")) {
						hScroll.val += 8;
						tui.requestRender();
					} else if (data === "h") {
						hScroll.val = 0;
						tui.requestRender();
					} else if (data === "H") {
						hScroll.val = 99999;
						tui.requestRender();
					} else if (matchesKey(data, "escape")) {
						done();
					}
				},
			};
		},
		{ overlay: true, overlayOptions: { anchor: "center", margin: 1 } },
	);
	return { action: "back" };
}
