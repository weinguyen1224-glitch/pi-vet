# pi-vet

Review agent file changes in the terminal. Checkbox-driven. Accept or revert. No git required.

pi-vet is for Pi users who want a review checkpoint after every agent turn. If you have ever discovered a bad agent edit ten turns later, pi-vet is for you.

It works in any directory. No git repo needed.

```bash
pi install npm:pi-vet
```

---

## How it looks

```
  Review 3 file(s)  +12 -3

  > [x] [mod] src/auth.ts   +5 -1
    [x] [new] src/utils.ts  +7
    [ ] [del] src/old.ts    -2

  up/down move | space toggle | a all | r none | enter diff | esc apply
```

Press Enter to see the full diff for any file.

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
       +-- [x] checked  --> Esc --> file stays (accepted)
       |
       +-- [ ] unchecked --> Esc --> file restored (reverted)
                |
                v
         Change moves to history
                |
                +-- /vet --> review history, toggle, re-apply
                |
                +-- u --> undo entire batch back to pending
```

### Change labels

| Label | Meaning |
| ----- | ------- |
| `[new]` | File did not exist before |
| `[mod]` | File existed, content changed |
| `[del]` | File existed, was deleted |

---

## Keybindings

### File list

| Key | Action |
| --- | ------ |
| Up / Down, j / k | Move selection |
| Space | Toggle checkbox |
| a | Select all |
| r | Deselect all |
| Enter | Open diff view |
| Esc | Apply and close |
| u | Undo batch (history only) |

### Diff overlay

| Key | Action |
| --- | ------ |
| Up / Down, j / k | Scroll one line |
| Ctrl+U / Ctrl+D | Scroll half page |
| g / G | Jump to top / bottom |
| Left / Right | Horizontal scroll |
| h / H | Horizontal scroll to start / end |
| Esc | Close diff, back to list |

---

## Commands

| Command | Action |
| ------- | ------ |
| `/vet` | Open review UI (pending or history) |
| `/vet off` | Disable tracking |
| `/vet on` | Re-enable tracking |

---

## How it works

pi-vet listens to `edit`, `write`, and `bash` tool events. Before each tool runs, it snapshots the target files. After the tool finishes, it diffs the current file against the snapshot and stores the changes as hunks.

For bash commands, pi-vet parses the command string to find file paths. It recognizes redirections (`>`, `>>`, `2>`), file operations (`rm`, `mv`, `cp`, `touch`, `mkdir`), inline writes (`echo >`, `cat >`, `tee`), and in-place edits (`sed -i`, `perl -i`). It also expands tildes, environment variables, glob patterns, and command-local variable assignments.

State is saved to `.pi/pi-vet/state.json` in your project root. Pending changes survive restarts. The file cleans itself up: only pending changes and the latest history batch are kept.

---

## Limitations

**Bash tracking uses regex, not shell execution.** Loops, pipes with xargs, command substitution, eval, and heredocs are not resolved. When the agent uses complex bash, some files may be missed.

**File-level only.** You accept or revert entire files, not individual hunks within a file.

**No merge conflict handling.** If you manually edit a file with pending changes, the diff is regenerated from current disk state.

---

## FAQ

**Does pi-vet require a git repo?** No. It snapshots file contents directly.

**What if I close Pi with pending changes?** They are saved to `.pi/pi-vet/state.json`. Run `/vet` after restart.

**Can I use pi-vet alongside git?** Yes. They are independent and do not conflict.

**How do I turn it off?** `/vet off`. Turn back on with `/vet on`.

**Does it slow down the agent?** Negligibly. File reads and diffs add milliseconds per turn.

**Can I delete the state file?** Yes. Delete `.pi/pi-vet/state.json` to start fresh.

---

## License

MIT

