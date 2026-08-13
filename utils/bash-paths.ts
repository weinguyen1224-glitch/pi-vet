import { globSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Bash path extraction — enhanced with glob, variable, tilde expansion
// ---------------------------------------------------------------------------

/**
 * Scan command string for VAR=value assignments and return a map.
 * Handles: VAR=val, VAR="val", VAR='val', VAR=val cmd, VAR=val && cmd
 */
function extractVars(command: string): Map<string, string> {
	const vars = new Map<string, string>();
	// Match VAR=value patterns (not inside quotes or existing strings)
	const re =
		/(?:^|[\s;&|]+)([A-Za-z_]\w*)=("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s;&|"']+)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(command)) !== null) {
		let val = m[2];
		if (
			(val.startsWith('"') && val.endsWith('"')) ||
			(val.startsWith("'") && val.endsWith("'"))
		) {
			val = val.slice(1, -1);
		}
		vars.set(m[1], val);
	}
	return vars;
}

/**
 * Expand glob patterns in a path. Returns [path] if no glob, or expanded paths.
 * Only expands if the path contains *, ?, or [...].
 */
function expandGlob(p: string): string[] {
	if (!/[*?[]/.test(p)) return [p];
	try {
		const results = globSync(p, { nodir: true, windowsPathsNoEscape: true });
		return results.length > 0 ? results : [p];
	} catch {
		return [p];
	}
}

/**
 * Clean and expand a raw path extracted from a bash command.
 * Steps: strip quotes → tilde → $VAR from command vars → ${VAR} from env → glob
 * Returns empty string if path has unresolved shell variables.
 */
export function cleanPath(
	raw: string,
	cmdVars?: Map<string, string>,
): string[] {
	let p = raw.trim();

	// Strip surrounding quotes
	if (
		(p.startsWith('"') && p.endsWith('"')) ||
		(p.startsWith("'") && p.endsWith("'"))
	) {
		p = p.slice(1, -1);
	}

	// Tilde expansion
	if (p.startsWith("~/") || p === "~") {
		p = p.replace(/^~/, homedir());
	}

	// Expand $VAR and ${VAR} — first from command-local vars, then process.env
	p = p.replace(/\$\{(\w+)\}/g, (_, name) => {
		if (cmdVars?.has(name)) return cmdVars.get(name)!;
		return process.env[name] ?? `$\{${name}}`;
	});
	p = p.replace(/\$(\w+)/g, (_, name) => {
		if (cmdVars?.has(name)) return cmdVars.get(name)!;
		return process.env[name] ?? `$${name}`;
	});

	// Unresolved shell variable → can't track
	if (/\$[{]/.test(p) || /\$\w/.test(p)) return [];

	// Glob expansion
	return expandGlob(p);
}

/**
 * Extract file paths from a bash command string.
 * Covers: redirections (>, >>, 2>), rm, mv, cp, touch, mkdir, echo >, cat >, tee, sed -i, perl -i
 */
export function extractBashPaths(command: string): string[] {
	const paths: string[] = [];
	const cmdVars = extractVars(command);

	// Helper: clean and push all expanded paths
	const pushPaths = (raw: string) => {
		const expanded = cleanPath(raw, cmdVars);
		for (const ep of expanded) {
			if (ep && !paths.includes(ep)) paths.push(ep);
		}
	};

	// 1. Redirections: >, >>, 2>, 2>>, &>, &>>
	for (const m of command.matchAll(/(?:[0-2&]?>>?|>>?)\s*([^\s;&|]+)/g)) {
		pushPaths(m[1]);
	}

	// 2. rm [flags] <paths>
	for (const m of command.matchAll(/\brm\s+(?:-[^\s]*\s+)*([^\s;&|]+)/g)) {
		pushPaths(m[1]);
	}

	// 3. mv <src> <dst>
	for (const m of command.matchAll(
		/\bmv\s+(?:-[^\s]*\s+)*([^\s;&|]+)\s+([^\s;&|]+)/g,
	)) {
		pushPaths(m[1]);
		pushPaths(m[2]);
	}

	// 4. cp [flags] <src> <dst>
	for (const m of command.matchAll(
		/\bcp\s+(?:-[^\s]*\s+)*([^\s;&|]+)\s+([^\s;&|]+)/g,
	)) {
		pushPaths(m[1]);
		pushPaths(m[2]);
	}

	// 5. touch <paths>
	for (const m of command.matchAll(/\btouch\s+(?:-[^\s]*\s+)*([^\s;&|]+)/g)) {
		pushPaths(m[1]);
	}

	// 6. mkdir <paths>
	for (const m of command.matchAll(/\bmkdir\s+(?:-[^\s]*\s+)*([^\s;&|]+)/g)) {
		pushPaths(m[1]);
	}

	// 7. echo ... > file
	for (const m of command.matchAll(/\becho\s+.*?>\s*([^\s;&|]+)/g)) {
		pushPaths(m[1]);
	}

	// 8. cat > file
	for (const m of command.matchAll(/\bcat\s+.*?>\s*([^\s;&|]+)/g)) {
		pushPaths(m[1]);
	}

	// 9. tee [flags] <paths>
	for (const m of command.matchAll(/\btee\s+(?:-[^\s]*\s+)*([^\s;&|]+)/g)) {
		pushPaths(m[1]);
	}

	// 10. sed -i / perl -i
	const sedMatch = command.match(
		/(?:sed|perl)\s+-i[^\s]*\s+(?:-e\s+[^\s]+\s+)?(?:[^\s]+\s+)?([^\s;&|]+)$/,
	);
	if (sedMatch) pushPaths(sedMatch[1]);

	return paths;
}
