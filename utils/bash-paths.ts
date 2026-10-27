import { globSync, statSync } from "node:fs";
import { homedir } from "node:os";

interface Word {
	text: string;
	dynamic: boolean;
	glob: boolean;
}

interface Segment {
	words: Word[];
	targets: Word[];
}

type Quote = "'" | '"' | null;
type Redirect = "target" | "ignore" | "heredoc" | null;

const ASSIGNMENT = /^[A-Za-z_]\w*=/;
const IN_PLACE_FLAG = /^(-[A-Za-z]*i|--in-place)/;
const SCRIPT_FLAG = /^-[A-Za-z]*[ef]$/;
const MAX_NESTED_SHELLS = 3;
const WRAPPERS = new Set(["sudo", "env", "command", "nohup", "time", "exec", "nice"]);
const SHELLS = new Set(["bash", "sh", "zsh"]);
const ALL_POSITIONALS = new Set([
	"rm",
	"touch",
	"mkdir",
	"rmdir",
	"unlink",
	"tee",
	"truncate",
	"mv",
	"cp",
	"ln",
	"install",
]);
const SKIP_FIRST_POSITIONAL = new Set(["chmod", "chown", "chgrp"]);
const GIT_PATH_COMMANDS = new Set(["mv", "rm"]);

function closingIndex(command: string, open: number): number {
	let depth = 0;
	for (let k = open; k < command.length; k++) {
		if (command[k] === "(") depth++;
		else if (command[k] === ")" && --depth === 0) return k;
	}
	return command.length - 1;
}

function skipHeredocBody(command: string, from: number, delimiter: string): number {
	let lineStart = from;
	while (lineStart < command.length) {
		const found = command.indexOf("\n", lineStart);
		const lineEnd = found < 0 ? command.length : found;
		const line = command.slice(lineStart, lineEnd);
		lineStart = lineEnd + 1;
		if (line.trim() === delimiter) break;
	}
	return Math.min(lineStart, command.length);
}

function parseCommand(command: string): Segment[] {
	const segments: Segment[] = [];
	const vars = new Map<string, string>();
	let segment: Segment = { words: [], targets: [] };
	let current = null as Word | null;
	let quote = null as Quote;
	let redirect = null as Redirect;
	let heredocs: string[] = [];

	const word = (): Word => (current ??= { text: "", dynamic: false, glob: false });

	const endWord = () => {
		if (!current) return;
		const finished = current;
		current = null;
		if (redirect === "target") segment.targets.push(finished);
		else if (redirect === "heredoc") heredocs.push(finished.text);
		else if (redirect === null) {
			segment.words.push(finished);
			if (!finished.dynamic && segment.words.every((w) => ASSIGNMENT.test(w.text))) {
				const [name, ...value] = finished.text.split("=");
				vars.set(name, value.join("="));
			}
		}
		redirect = null;
	};

	const endSegment = () => {
		endWord();
		redirect = null;
		if (segment.words.length > 0 || segment.targets.length > 0) segments.push(segment);
		segment = { words: [], targets: [] };
	};

	const expand = (at: number): number => {
		if (command[at + 1] === "(") {
			word().dynamic = true;
			return closingIndex(command, at + 1) + 1;
		}
		const rest = command.slice(at + 1);
		const name = /^\{(\w+)\}/.exec(rest) ?? /^(\w+)/.exec(rest);
		if (!name) {
			word().text += "$";
			return at + 1;
		}
		const value = vars.get(name[1]) ?? process.env[name[1]];
		if (value === undefined) word().dynamic = true;
		else word().text += value;
		return at + 1 + name[0].length;
	};

	const skipBacktick = (at: number): number => {
		word().dynamic = true;
		const end = command.indexOf("`", at + 1);
		return end < 0 ? command.length : end + 1;
	};

	const skipHeredocs = (from: number): number => {
		let at = from;
		for (const delimiter of heredocs) at = skipHeredocBody(command, at, delimiter);
		heredocs = [];
		return at;
	};

	const readRedirect = (at: number): number => {
		if (current && !current.dynamic && /^\d+$/.test(current.text)) current = null;
		else endWord();
		let k = at;
		if (command[k] === "&") k++;
		const direction = command[k++];
		if (direction === "<") {
			if (command[k] === "<" && command[k + 1] === "<") {
				redirect = "ignore";
				return k + 2;
			}
			if (command[k] === "<") {
				redirect = "heredoc";
				return command[k + 1] === "-" ? k + 2 : k + 1;
			}
			redirect = "ignore";
			return k;
		}
		if (command[k] === ">") k++;
		if (command[k] === "|") k++;
		if (command[k] === "&") {
			redirect = "ignore";
			return k + 1;
		}
		redirect = "target";
		return k;
	};

	let i = 0;
	while (i < command.length) {
		const ch = command[i];
		if (quote === "'") {
			if (ch === "'") quote = null;
			else word().text += ch;
			i++;
		} else if (quote === '"') {
			if (ch === '"') {
				quote = null;
				i++;
			} else if (ch === "\\" && i + 1 < command.length) {
				word().text += command[i + 1];
				i += 2;
			} else if (ch === "$") i = expand(i);
			else if (ch === "`") i = skipBacktick(i);
			else {
				word().text += ch;
				i++;
			}
		} else if (ch === "'" || ch === '"') {
			word();
			quote = ch;
			i++;
		} else if (ch === "\\") {
			if (command[i + 1] !== "\n" && i + 1 < command.length) word().text += command[i + 1];
			i += 2;
		} else if (ch === "$") i = expand(i);
		else if (ch === "`") i = skipBacktick(i);
		else if (ch === "#" && current === null) {
			const end = command.indexOf("\n", i);
			i = end < 0 ? command.length : end;
		} else if (ch === "\n") {
			endSegment();
			i = skipHeredocs(i + 1);
		} else if (/\s/.test(ch)) {
			endWord();
			i++;
		} else if (ch === ">" || ch === "<" || (ch === "&" && command[i + 1] === ">")) {
			i = readRedirect(i);
		} else if (";|&()".includes(ch)) {
			endSegment();
			i++;
		} else {
			const next = word();
			if ("*?[".includes(ch)) next.glob = true;
			next.text += ch;
			i++;
		}
	}
	endSegment();
	return segments;
}

function stripPrefix(words: Word[]): Word[] {
	let index = 0;
	let afterWrapper = false;
	while (index < words.length) {
		const text = words[index].text;
		if (WRAPPERS.has(text)) afterWrapper = true;
		else if (!ASSIGNMENT.test(text) && !(afterWrapper && text.startsWith("-"))) break;
		index++;
	}
	return words.slice(index);
}

function inPlaceTargets(args: Word[]): Word[] {
	if (!args.some((arg) => IN_PLACE_FLAG.test(arg.text))) return [];
	const files: Word[] = [];
	let scripted = false;
	for (let k = 0; k < args.length; k++) {
		const text = args[k].text;
		if (SCRIPT_FLAG.test(text)) {
			scripted = true;
			k++;
		} else if (!text.startsWith("-")) files.push(args[k]);
	}
	return scripted ? files : files.slice(1);
}

function pathArguments(name: string, args: Word[]): Word[] {
	const positional = args.filter((arg) => !arg.text.startsWith("-"));
	if (ALL_POSITIONALS.has(name)) return positional;
	if (SKIP_FIRST_POSITIONAL.has(name)) return positional.slice(1);
	if (name === "git") return GIT_PATH_COMMANDS.has(positional[0]?.text ?? "") ? positional.slice(1) : [];
	if (name === "sed" || name === "perl") return inPlaceTargets(args);
	return [];
}

function collectWords(command: string, depth = 0): Word[] {
	const found: Word[] = [];
	for (const segment of parseCommand(command)) {
		found.push(...segment.targets);
		const [head, ...args] = stripPrefix(segment.words);
		if (!head || head.dynamic) continue;
		if (!SHELLS.has(head.text)) {
			found.push(...pathArguments(head.text, args));
			continue;
		}
		const flag = args.findIndex((arg) => arg.text === "-c");
		const script = flag >= 0 ? args[flag + 1] : undefined;
		if (script && !script.dynamic && depth < MAX_NESTED_SHELLS) {
			found.push(...collectWords(script.text, depth + 1));
		}
	}
	return found;
}

function isFile(path: string): boolean {
	return statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
}

function resolveWord(word: Word): string[] {
	if (word.dynamic || word.text === "") return [];
	const text =
		word.text === "~" || word.text.startsWith("~/") ? homedir() + word.text.slice(1) : word.text;
	if (!word.glob) return [text];
	try {
		return globSync(text).filter(isFile);
	} catch {
		return [];
	}
}

export function extractBashPaths(command: string): string[] {
	return [...new Set(collectWords(command).flatMap(resolveWord))];
}

