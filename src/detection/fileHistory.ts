import * as path from "path";

/**
 * Claude Code's own pre-edit backups, and how to find them on disk.
 *
 * Before it applies an Edit or a Write, Claude Code copies the file aside under
 * `~/.claude/file-history/<session>/<name>@v<n>` and announces the copy in the
 * transcript as a `file-history-delta` record. That copy is a byte-exact image
 * of the file *before* the tool ran — which is precisely the baseline this
 * extension exists to record.
 *
 * Using it turns the transcript channel from *reconstruction* into *retrieval*.
 * Reverse-applying an edit list can only ever be as good as the list: it refuses
 * `replace_all`, it refuses an ambiguous anchor, and — worst of all — a *missing*
 * edit produces a baseline that passes forward verification and is still wrong
 * (see the comment in transcriptWatcher.ts about why a subset replays cleanly).
 * A backup has none of those failure modes. It is not a better guess; it is the
 * absence of a guess.
 *
 * Verified against this machine's transcript history before the code was
 * written: one delta per path per session, `version` always 1, every named
 * backup still present, and a controlled probe whose backup was sha256-identical
 * to the known pre-edit content. `backupFileName: null` occurred 236 times and
 * *only* where the first tool touching that path was a `Write` — never with an
 * `Edit` — which is what makes it a trustworthy "the file did not exist" signal
 * rather than an absence of information.
 *
 * Deliberately free of any `vscode` *and* `fs` import: everything here is a pure
 * decision about untrusted input read out of a file on disk, and both decisions
 * it makes — which path a record describes, and which file name may be joined
 * onto a directory — are ones a unit test has to be able to pin down.
 */

/**
 * What a `file-history-delta` says about one file.
 *
 * The two cases are kept apart rather than collapsed onto "name or undefined",
 * because `backupFileName: null` and a *malformed* record must not be read the
 * same way. The first is Claude Code stating that there was nothing to copy —
 * the file did not exist — and it is the authoritative answer to the question
 * `trustWriteSnapshot` can only ever answer by timing heuristics. The second is
 * a record we do not understand, and the only safe response to that is to
 * discard it.
 */
export type FileBackup =
  | {
      kind: "content";
      /** Absolute path of the file the backup is a copy of. */
      path: string;
      /** File name under the session's file-history directory. */
      name: string;
      ts: number | undefined;
    }
  | {
      kind: "created";
      /** Absolute path of the file this tool call brought into existence. */
      path: string;
      ts: number | undefined;
    };

/**
 * A backup file name we are willing to join onto a directory.
 *
 * The name comes out of a JSON file we do not write, and it is about to become a
 * path component. Anything with a separator or a `..` in it would reach outside
 * the session's own history directory, so the shape is allowlisted rather than
 * sanitised: the real names are content hashes with an `@v<n>` suffix
 * (`a242946403ba6fa0@v2`), and nothing outside that shape is worth accepting.
 */
const SAFE_BACKUP_NAME = /^[A-Za-z0-9][A-Za-z0-9@._-]*$/;

/**
 * Read a parsed transcript record as a file-history announcement, or return
 * undefined for anything that is not one — including one whose shape we do not
 * recognise.
 *
 * `timestamp` is passed in already parsed rather than re-derived here, so this
 * module never has to duplicate the caller's date handling.
 */
export function fileBackupFrom(
  record: unknown,
  timestamp: number | undefined
): FileBackup | undefined {
  if (!isRecord(record) || record.type !== "file-history-delta") {
    return undefined;
  }
  const backup = record.backup;
  if (!isRecord(backup)) {
    return undefined;
  }
  const absPath = backedUpPath(record.trackingPath, backup.realParentDir);
  if (absPath === undefined) {
    return undefined;
  }
  const name = backup.backupFileName;
  if (name === null) {
    // Claude Code took no copy. It does that in exactly one situation — the file
    // was not there to copy — so the whole file is an addition and Undo must
    // delete it rather than write an empty one.
    return { kind: "created", path: absPath, ts: timestamp };
  }
  if (typeof name !== "string" || !SAFE_BACKUP_NAME.test(name)) {
    return undefined;
  }
  return { kind: "content", path: absPath, name, ts: timestamp };
}

/**
 * The absolute path a delta describes.
 *
 * `realParentDir` is used for the directory and `trackingPath` only for the file
 * name, which is what the two fields actually mean: `trackingPath` is relative to
 * the project in most records but absolute in others, while `realParentDir` is
 * always absolute and always *resolved*. A probe run against `/tmp` recorded
 * `realParentDir: "/private/tmp"` — so this composition follows symlinks the way
 * the file system does, and a workspace reached through a symlink will produce
 * paths that `ChangeStore.isInScope` compares against its own unresolved root.
 * That is a miss, never a wrong file: the two disagree only by refusing to match.
 */
function backedUpPath(
  trackingPath: unknown,
  realParentDir: unknown
): string | undefined {
  if (typeof trackingPath !== "string" || trackingPath === "") {
    return undefined;
  }
  const name = path.basename(trackingPath);
  if (name === "" || name === "." || name === "..") {
    return undefined;
  }
  if (typeof realParentDir === "string" && path.isAbsolute(realParentDir)) {
    return path.join(realParentDir, name);
  }
  // `realParentDir` is absent from a small number of real records. When
  // `trackingPath` is itself absolute it carries the whole answer, so using it is
  // a fallback and not a guess. A *relative* trackingPath with no parent
  // directory is genuinely incomplete — resolving it would mean inventing a
  // working directory — and is refused.
  return path.isAbsolute(trackingPath) ? trackingPath : undefined;
}

/**
 * Which session a transcript file belongs to, which is the directory its backups
 * live in.
 *
 * Two layouts, both real on disk:
 *
 *   <projectDir>/<sessionId>.jsonl                            the session itself
 *   <projectDir>/<sessionId>/subagents/.../agent-<id>.jsonl    its subagents
 *
 * so the id is the first path segment either way — with its `.jsonl` suffix
 * stripped only when the segment *is* the file. Anything that escapes the
 * project directory, or that contains a separator once split, is refused: the
 * answer becomes a path component below.
 */
export function sessionIdForTranscript(
  projectDir: string,
  file: string
): string | undefined {
  const rel = path.relative(projectDir, file);
  if (rel === "" || path.isAbsolute(rel)) {
    return undefined;
  }
  const segments = rel.split(path.sep).filter((s) => s !== "");
  const [first] = segments;
  if (first === undefined || first === "." || first === "..") {
    return undefined;
  }
  const id = segments.length === 1 ? stripJsonl(first) : first;
  return SAFE_BACKUP_NAME.test(id) ? id : undefined;
}

function stripJsonl(name: string): string {
  return name.endsWith(".jsonl") ? name.slice(0, -".jsonl".length) : name;
}

/**
 * Where a named backup for this session is stored, or undefined when either
 * component is not safe to join.
 *
 * Both are re-checked here even though the producers already validated them:
 * this is the single place that builds a path out of transcript-supplied text,
 * and a caller that skips a check is a caller that reads an arbitrary file.
 */
export function backupFilePath(
  historyDir: string,
  sessionId: string,
  name: string
): string | undefined {
  if (!SAFE_BACKUP_NAME.test(sessionId) || !SAFE_BACKUP_NAME.test(name)) {
    return undefined;
  }
  return path.join(historyDir, sessionId, name);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
