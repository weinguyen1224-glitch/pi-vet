import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import type { Hunk, StepEffect } from "../types";

export function countStats(hunks: Hunk[]): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const hunk of hunks) {
		if (!hunk.accepted) continue;
		for (const line of hunk.lines.slice(1)) {
			if (line.startsWith("+")) added++;
			else if (line.startsWith("-")) removed++;
		}
	}
	return { added, removed };
}

export function kindLabel(effect: StepEffect, theme: Theme): string {
	if (effect === "new") return theme.fg("success", "[new]");
	if (effect === "del") return theme.fg("error", "[del]");
	return theme.fg("warning", "[mod]");
}

function window(text: string, skip: number, max: number): { text: string; width: number } {
	let skipped = 0;
	let width = 0;
	let out = "";
	for (const ch of text) {
		const w = visibleWidth(ch);
		if (skipped < skip) {
			skipped += w;
			continue;
		}
		if (width + w > max) break;
		width += w;
		out += ch;
	}
	return { text: out, width };
}

type OverlayContext = Pick<ExtensionContext, "ui">;

export async function renderDiffOverlay(
	ctx: OverlayContext,
	hunks: Hunk[],
	title: string,
	onHunkToggle?: () => void,
): Promise<void> {
	const diffLines: string[] = [];
	const hunkOfLine: number[] = [];
	hunks.forEach((hunk, hunkIndex) => {
		diffLines.push(hunk.header);
		hunkOfLine.push(hunkIndex);
		for (const line of hunk.lines.slice(1)) {
			diffLines.push(line);
			hunkOfLine.push(hunkIndex);
		}
	});

	await ctx.ui.custom<void>(
		(tui, theme, _kb, done) => {
			let scrollOffset = 0;
			let cursor = 0;
			let hScroll = 0;
			let pageSize = 40;
			const maxScroll = () => Math.max(0, diffLines.length - pageSize);
			const moveCursor = (index: number) => {
				cursor = Math.max(0, Math.min(index, diffLines.length - 1));
				if (cursor < scrollOffset) scrollOffset = cursor;
				else if (cursor >= scrollOffset + pageSize) scrollOffset = cursor - pageSize + 1;
				tui.requestRender();
			};

			return {
				render(width: number): string[] {
					const lines: string[] = [];
					const boxWidth = width - 2;
					const innerWidth = boxWidth - 2;
					pageSize = Math.max(10, (process.stdout.rows ?? 40) - 4);
					scrollOffset = Math.min(scrollOffset, maxScroll());

					const heading = ` Diff: ${title} `;
					const left = Math.max(0, Math.floor((boxWidth - visibleWidth(heading)) / 2));
					const right = Math.max(0, boxWidth - visibleWidth(heading) - left);
					lines.push(
						theme.fg(
							"borderAccent",
							`╭${"─".repeat(left)}${theme.fg("accent", theme.bold(heading))}${theme.fg("borderAccent", "─".repeat(right) + "╮")}`,
						),
					);

					const end = Math.min(scrollOffset + pageSize, diffLines.length);
					for (let i = scrollOffset; i < end; i++) {
						const raw = diffLines[i];
						const isHeader = raw.startsWith("@@");
						const prefix = isHeader ? (hunks[hunkOfLine[i]].accepted ? "[✓] " : "[ ] ") : "";
						const full = prefix + raw;
						const hasLeft = hScroll > 0;
						const hasRight = visibleWidth(full) > hScroll + innerWidth;
						const room = innerWidth - (hasLeft ? 1 : 0) - (hasRight ? 1 : 0);
						const shown = window(full, hScroll, room);

						let colored = theme.fg("dim", shown.text);
						if (isHeader) colored = theme.fg("accent", shown.text);
						else if (raw.startsWith("+")) colored = theme.fg("success", shown.text);
						else if (raw.startsWith("-")) colored = theme.fg("error", shown.text);
						if (hasLeft) colored = theme.fg("dim", "◀") + colored;
						if (hasRight) colored += theme.fg("dim", "▶");

						const padding = innerWidth - shown.width - (hasLeft ? 1 : 0) - (hasRight ? 1 : 0);
						lines.push(
							theme.fg("borderAccent", i === cursor ? "│" : "│ ") +
								(i === cursor ? theme.fg("accent", "▸") : "") +
								colored +
								" ".repeat(Math.max(0, padding)) +
								theme.fg("borderAccent", " │"),
						);
					}

					for (let i = end - scrollOffset; i < pageSize; i++) {
						lines.push(theme.fg("borderAccent", `│${" ".repeat(innerWidth + 2)}│`));
					}

					const scrollInfo =
						diffLines.length > pageSize
							? ` ${scrollOffset + 1}-${end}/${diffLines.length} `
							: "";
					const footer = ` esc back  ↑↓ ctrl+u/d g/G  ←→ h/H scroll  ␣ toggle hunk${scrollInfo} `;
					const fill = Math.max(0, boxWidth - visibleWidth(footer));
					lines.push(theme.fg("borderAccent", `╰${footer}${"─".repeat(fill)}╯`));
					return lines;
				},

				invalidate() {},

				handleInput(data: string): void {
					if (matchesKey(data, "up") || data === "k") moveCursor(cursor - 1);
					else if (matchesKey(data, "down") || data === "j") moveCursor(cursor + 1);
					else if (matchesKey(data, "ctrl+u")) moveCursor(cursor - Math.floor(pageSize / 2));
					else if (matchesKey(data, "ctrl+d")) moveCursor(cursor + Math.floor(pageSize / 2));
					else if (data === "g") moveCursor(0);
					else if (data === "G") moveCursor(diffLines.length - 1);
					else if (matchesKey(data, "left")) {
						hScroll = Math.max(0, hScroll - 8);
						tui.requestRender();
					} else if (matchesKey(data, "right")) {
						hScroll += 8;
						tui.requestRender();
					} else if (data === "h") {
						hScroll = 0;
						tui.requestRender();
					} else if (data === "H") {
						hScroll = 99999;
						tui.requestRender();
					} else if (data === " ") {
						const hunk = hunks[hunkOfLine[cursor]];
						if (hunk) {
							hunk.accepted = !hunk.accepted;
							onHunkToggle?.();
							tui.requestRender();
						}
					} else if (matchesKey(data, "escape")) done();
				},
			};
		},
		{ overlay: true, overlayOptions: { anchor: "center", margin: 1 } },
	);
}

