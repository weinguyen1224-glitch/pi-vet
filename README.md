# pi-vet

> **Vet** *(verb)* — to examine carefully and critically, especially for errors.

pi-vet is a terminal-based file review tool for the [Pi coding agent](https://pi.dev). After the agent edits your code, pi-vet shows you every changed file with diffs, line stats, and checkboxes. You decide what stays and what goes, all from the keyboard.

---

## Table of Contents

- [What problem does it solve?](#what-problem-does-it-solve)
- [How it looks](#how-it-looks)
- [Install](#install)
- [Quick start](#quick-start)
- [Workflow](#workflow)
- [Keybindings](#keybindings)
- [Commands](#commands)
- [How it works](#how-it-works)
- [Limitations](#limitations)
- [FAQ](#faq)
- [License](#license)

---

## What problem does it solve?

AI coding agents edit your files directly. Sometimes they get it right. Sometimes they don't. Without a review step, bad changes slip through and you discover them later, or worse, you don't notice at all.

pi-vet gives you a review checkpoint after every agent turn. Before the agent continues, you see exactly what changed and decide whether to keep or discard each change. No `git diff`, no `git checkout -p`, no scrolling through terminal history. Just a clean list with checkboxes.

---

## How it looks

When the agent finishes editing, pi-vet shows a list of changed files:

```
  Review 3 file(s)  +12 -3

  > [x] [mod] src/auth.ts   +5 -1
    [x] [new] src/utils.ts  +7
    [ ] [del] src/old.ts    -2

  up/down move | space toggle | a all | r none | enter diff | esc apply
```

Press Enter on any file to see the full diff:

```
  --- Diff: src/auth.ts ---
  @@ -12,7 +12,8 @@
   export function login(user: string, pass: strin
  -  if (!user) throw new Error("no user");
  +  if (!user || !pass) throw new Error("missing"
  +  logger.info(`login attempt: ${user}`);
     const token = await db.auth(user, pass);

  esc back | up/down ctrl+u/d g/G | left/right h/H scroll | 1-5/5
```

Each file gets a label that tells you what kind of change it is:

| Label | Meaning |
| ------- | --------- |
| `[new]` | File didn't exist before. Brand new. |
| `[mod]` | File existed. Content was changed. |
| `[del]` | File existed. It was deleted. |

---

## Install

```bash
pi install npm:pi-vet
```

That's it. pi-vet activates automatically on the next agent turn.

To try it without installing:

```bash
pi -e npm:pi-vet
```

---

## Quick start

1. Start a Pi session. pi-vet loads automatically.
2. Ask the agent to do something, like "add a login function to auth.ts".
3. The agent finishes editing and pi-vet's review screen appears.
4. Review each file: toggle with Space, view the diff with Enter.
5. Press Esc. Checked files are kept, unchecked files are reverted.
6. The agent continues with only the changes you approved.

That's the whole loop. Agent turn, review, continue. Repeat.

---

## Workflow

```
  You ask agent
       |
       v
  Agent edits files
       |
       v
  pi-vet shows review UI
       |
       +-- You check [x] --> Esc --> file stays (accepted)
       |
       +-- You uncheck [ ] --> Esc --> file restored (reverted)
                |
                v
         Change moves to history (/vet to view)
                |
                +-- Press u --> undo entire batch, back to pending
                |
                +-- Toggle + Esc --> flip individual accept/revert
```

### Lifecycle of a single change

1. Agent runs an `edit` or `write` tool.
2. pi-vet snapshots the file before the edit happens.
3. Agent writes new content to disk.
4. pi-vet diffs the before and after, stores the changes as hunks.
5. Agent turn ends. Review UI appears.
6. You check or uncheck each file, then press Esc.
7. Checked files stay modified. Unchecked files are restored to their original content.
8. The batch moves to history. You can revisit it anytime with `/vet`.

---

## Keybindings

### File list (pending review)

| Key | Action |
| ----- | -------- |
| Up / Down, j / k | Move selection |
| Space | Toggle checkbox on selected file |
| a | Select all files |
| r | Deselect all files |
| Enter | Open diff view for selected file |
| Esc | Apply decisions and close |

### File list (history view)

Same as pending, plus:

| Key | Action |
|-----|--------|
| u | Undo entire batch. All files go back to pending review. |

### Diff overlay

| Key | Action |
| ----- | -------- |
| Up / Down, j / k | Scroll one line |
| Ctrl+U / Ctrl+D | Scroll half page |
| g | Jump to top |
| G | Jump to bottom |
| Left / Right | Horizontal scroll |
| h | Horizontal scroll to start |
| H | Horizontal scroll to end |
| Esc | Close diff, back to file list |

---

## Commands

| Command | Action |
| --------- | -------- |
| `/vet` | Open review UI. Shows pending changes if any exist, otherwise shows the most recent history batch. |
| `/vet off` | Disable pi-vet. Agent edits are no longer tracked or reviewed. |
| `/vet on` | Re-enable pi-vet. |

---

## How it works

### Tracking

pi-vet listens to three Pi tool events and snapshots files before the agent modifies them:

| Tool | What pi-vet does |
| ------ | ------------------ |
| `edit` | Snapshots the file before the edit runs |
| `write` | Snapshots the file before the write runs |
| `bash` | Parses the command for file paths, snapshots each one |

For bash commands, pi-vet recognizes these patterns:

- Redirections: `> file`, `>> file`, `2> file`
- File operations: `rm`, `mv`, `cp`, `touch`, `mkdir`
- Inline writes: `echo ... > file`, `cat > file`, `tee file`
- In-place edits: `sed -i file`, `perl -i file`

It also expands tildes (`~/file`), environment variables (`$HOME/file`), glob patterns (`src/*.ts`), and command-local variable assignments (`F=out.txt; echo > $F`).

### Diffing

After the tool runs, pi-vet reads the current file and diffs it against the snapshot. The diff is broken into hunks, each storing the exact lines added and removed.

### Review

The review UI shows every changed file with a checkbox (checked by default), a kind label (`[new]`, `[mod]`, or `[del]`), line stats (`+N -M`), and a batch summary showing total additions and deletions across all files.

When you press Esc, checked files are accepted and unchecked files are reverted to their original content.

### History

After you apply changes, the batch moves to history. Run `/vet` when no pending changes exist to see the most recent batch. From history you can toggle individual files and press Esc to flip their accept or revert status, or press `u` to undo the entire batch and send everything back to pending review.

### Persistence

All state is saved to `.pi/pi-vet/state.json` in your project root. Pending changes survive Pi restarts. History survives session switches. You can close Pi, come back tomorrow, and `/vet` still shows your last batch.

The state file cleans itself up automatically: only pending changes and the latest history batch are kept, duplicate file content is deduplicated, and corrupted state falls back to a `.bak` backup.

---

## Limitations

### Bash tracking uses regex, not shell execution

pi-vet parses bash command strings with regular expressions. It cannot resolve shell loops (`for f in *.ts; do ...`), pipes with xargs, command substitution (`$(...)`), `eval`, or heredocs. When the agent uses complex bash, pi-vet may miss some files. Use `/vet` to check, and fall back to `git diff` if needed.

### File-level only, no hunk staging

You can accept or revert entire files, not individual hunks within a file. This is intentional. Hunk-level staging adds complexity without proportional benefit for most workflows.

### No merge conflict handling

If you manually edit a file while pi-vet has pending changes for it, the diff is regenerated from the current disk state. This is usually what you want, but the original diff may be lost.

---

## FAQ

**Does pi-vet require a git repo?**

No. pi-vet works in any directory. It snapshots file contents directly, not git state.

**What happens if I close Pi with pending changes?**

Pending changes are saved to `.pi/pi-vet/state.json`. When you restart Pi in the same project, they are still there. Run `/vet` to review them.

**Can I use pi-vet alongside git?**

Yes. pi-vet and git are independent. pi-vet tracks file contents directly. You can still use `git diff`, `git add -p`, and so on. They do not conflict.

**What if the agent edits a file I am also editing manually?**

pi-vet snapshots before the agent's tool runs. If you edited the file between the snapshot and the review, the diff will include your changes too. This is usually fine. You will see the combined diff and can decide.

**How do I turn it off temporarily?**

Run `/vet off`. Agent edits are no longer tracked. Turn it back on with `/vet on`.

**Does pi-vet slow down the agent?**

Negligibly. pi-vet reads files before and after tool calls and runs `diff` on changed files. For typical projects, this adds milliseconds per turn.

**Can I delete the state file?**

Yes. Delete `.pi/pi-vet/state.json` to start fresh. All pending changes and history will be lost.

---

## License

MIT
