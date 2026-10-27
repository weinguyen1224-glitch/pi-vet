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
  Review 3 file(s)

  > [x] [mod] src/auth.ts   +5 -1
    [x] [new] src/utils.ts  +7
    [ ] [del] src/old.ts    -2

  ↑↓ move | ␣ toggle | a all | n none | ⏎ open | y apply | esc cancel
```

Files open into their steps. Each agent tool call is its own step with its own diff. Steps are never merged.

---

## Workflow

```
  Agent runs tools -> each tool call becomes a step (base + steps per file)
       |
       v
  Turn ends -> review UI
       |
       +-- y / enter on apply --> checked steps stay, unchecked are removed
       +-- esc                 --> nothing changes on disk
       |
       v
  /vet history   settled steps of this session
  /vet rewind    pick any step, files go back to exactly that state
```

Edits you make by hand between agent steps are recorded as `external` steps so rewind stays exact.

### Change labels

| Label | Meaning |
| --- | --- |
| `[new]` | File did not exist before |
| `[mod]` | File existed, content changed |
| `[del]` | File existed, was deleted |

---

## Keybindings

### Lists

| Key | Action |
| --- | --- |
| Up / Down, j / k | Move selection |
| Space | Toggle checkbox |
| a / n | Select all / none |
| Enter | Open file steps or diff |
| y | Apply |
| Esc | Cancel / back |

### Diff overlay

| Key | Action |
| --- | --- |
| Up / Down, j / k | Move cursor |
| Space | Toggle hunk under cursor |
| Ctrl+U / Ctrl+D | Half page |
| g / G | Top / bottom |
| Left / Right | Horizontal scroll |
| h / H | Horizontal scroll to start / end |
| Esc | Close diff |

---

## Commands

| Command | Action |
| --- | --- |
| `/vet` | Review pending steps |
| `/vet history` | Review settled steps |
| `/vet rewind` | Restore files to the state after a chosen step |
| `/vet off` / `/vet on` | Disable / enable tracking |

---

## How it works

pi-vet hooks `edit`, `write`, `replace`, `replace_match`, `insert`, `copy`, `move`, `undo_last_change` and `bash`. Before a tool runs it snapshots the target files. After it finishes it diffs against the snapshot and stores one step per changed file. The first snapshot of a file is its base; rewinding replays base plus steps up to the chosen one.

Bash commands are parsed for paths: redirections, `rm`, `mv`, `cp`, `touch`, `mkdir`, `tee`, `sed -i`, `perl -i`, quoting, `~`, env vars, globs, and local assignments. Directories are watched, so files created inside them are tracked too.

State lives in `.pi/pi-vet/` per session and is deleted when the session quits. Binary files and files over 8 MiB are skipped.

---

## Limitations

**Bash tracking is static parsing.** Loops, xargs, eval, and command substitution are not resolved, so some files may be missed.

**Dependent steps.** Dropping a step that later steps build on raises a conflict instead of guessing.

---

## FAQ

**Does pi-vet require a git repo?** No. It snapshots file contents directly.

**What if I close Pi with pending changes?** Resuming the session keeps them. Quitting Pi deletes the session data.

**Can I use pi-vet alongside git?** Yes. They are independent and do not conflict.

**How do I turn it off?** `/vet off`. Turn back on with `/vet on`.

**Does it slow down the agent?** Negligibly. File reads and diffs add milliseconds per turn.

**Can I delete the state file?** Yes. Delete `.pi/pi-vet/` to start fresh.

---

## License

MIT



