/**
 * Pure reading of Claude Code transcript lines, and the two judgement calls that
 * decide whether what they say can be believed.
 *
 * Kept free of any `vscode` import for the same reason as reconstruct.ts: this is
 * where "did this tool call actually change the file" is decided, and a wrong
 * answer here is what turns an Undo into data loss. It needs to be executable in
 * a plain unit test.
 */

import { FileBackup, fileBackupFrom } from "./fileHistory";
import { EditEvent } from "./reconstruct";

export interface ToolUseBlock {
  /** Absent in a malformed record; without it a result cannot be correlated. */
  id: string | undefined;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  toolUseId: string;
  /** The tool reported a failure, so the file was not changed. */
  failed: boolean;
}

export interface TranscriptLine {
  /** The line's own timestamp in epoch milliseconds, if it has a usable one. */
  timestamp: number | undefined;
  uses: ToolUseBlock[];
  results: ToolResultBlock[];
  /**
   * The working directory this line was recorded in.
   *
   * Not the same as the workspace root, and not constant within a session: a
   * `cd` in a Bash call persists, and one real session here records 13 distinct
   * values. It is what a relative `file_path` has to be resolved against.
   */
  cwd: string | undefined;
  /**
   * Pointers to Claude Code's own pre-edit copies of a file.
   *
   * These arrive on their own records, not inside a message, which is why they
   * used to be dropped on the floor: the parser returned as soon as
   * `message.content` was not an array. They are the most faithful baseline
   * available anywhere — see fileHistory.ts.
   */
  backups: FileBackup[];
}

/**
 * Split one transcript line into the tool calls it announces and the results it
 * reports.
 *
 * Results are the half that used to be invisible: they live in a *user* message,
 * and the watcher only ever looked at `tool_use` blocks. Without them a call that
 * Claude Code refused ("String to replace not found in file") or that the user
 * denied at the permission prompt was ingested exactly like one that landed.
 */
export function parseTranscriptLine(line: string): TranscriptLine | undefined {
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return undefined;
  }
  const record = obj as {
    message?: { content?: unknown };
    timestamp?: unknown;
    cwd?: unknown;
  };
  const cwd =
    typeof record.cwd === "string" && record.cwd ? record.cwd : undefined;
  const timestamp = parseTimestamp(record.timestamp);

  // Checked before `message.content`, because a file-history record has no
  // message at all and would otherwise be discarded by the guard below — which
  // is exactly what kept the extension reconstructing baselines it could simply
  // have read.
  const backup = fileBackupFrom(obj, timestamp);
  if (backup) {
    return { timestamp, cwd, uses: [], results: [], backups: [backup] };
  }

  const content = record?.message?.content;
  if (!Array.isArray(content)) {
    return undefined;
  }
  const uses: ToolUseBlock[] = [];
  const results: ToolResultBlock[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const typed = block as Record<string, unknown>;
    if (typed.type === "tool_use") {
      if (typeof typed.name === "string" && isRecord(typed.input)) {
        uses.push({
          id: typeof typed.id === "string" ? typed.id : undefined,
          name: typed.name,
          input: typed.input,
        });
      }
    } else if (typed.type === "tool_result") {
      if (typeof typed.tool_use_id === "string") {
        results.push({
          toolUseId: typed.tool_use_id,
          failed: isErrorResult(typed),
        });
      }
    }
  }
  return { timestamp, cwd, uses, results, backups: [] };
}

/**
 * Did this tool_result report a failure?
 *
 * `is_error` is the documented signal but it is not always present: Claude Code
 * also carries the failure as a `<tool_use_error>` prefix inside the result
 * content, so both have to be checked or a refused edit reads as a successful
 * one.
 */
export function isErrorResult(block: Record<string, unknown>): boolean {
  if (block.is_error === true) {
    return true;
  }
  return resultText(block.content).includes("<tool_use_error>");
}

/** The edit a file-mutating tool call performs, or undefined for anything else. */
export function editEventFor(
  name: string,
  input: Record<string, unknown>
): EditEvent | undefined {
  if (name === "Edit") {
    return {
      kind: "edit",
      oldString: asString(input.old_string),
      newString: asString(input.new_string),
      replaceAll: !!input.replace_all,
    };
  }
  if (name === "MultiEdit" && Array.isArray(input.edits)) {
    return {
      kind: "multiedit",
      edits: (input.edits as Record<string, unknown>[]).map((e) => ({
        oldString: asString(e?.old_string),
        newString: asString(e?.new_string),
        replaceAll: !!e?.replace_all,
      })),
    };
  }
  if (name === "Write") {
    return { kind: "write" };
  }
  // A NotebookEdit replaces one cell's source, but the file on disk wraps that
  // source in JSON with its own escaping, `outputs` and `execution_count`.
  // Modelling it as a string edit would hand `reverseApply` an `old_string` that
  // does not occur in the file — or, far worse, one that occurs by coincidence.
  // Treated as a whole-file write instead, so it takes the backup/snapshot path
  // where the content is retrieved rather than replayed.
  return name === "NotebookEdit" ? { kind: "write" } : undefined;
}

/**
 * The file path a tool call names, verbatim (still possibly relative).
 *
 * `notebook_path` is the third key rather than an afterthought: `NotebookEdit`
 * carries its target under that name alone, so without it every notebook edit
 * was dropped before any other decision was reached.
 */
export function filePathOf(input: Record<string, unknown>): string | undefined {
  for (const key of ["file_path", "filePath", "notebook_path"]) {
    const value = input[key];
    if (typeof value === "string" && value) {
      return value;
    }
  }
  return undefined;
}

/**
 * Key names an MCP server might put a file path under. There is no convention,
 * so this is the observed union rather than a specification.
 */
const MCP_PATH_KEYS = [
  "path",
  "file",
  "file_path",
  "filePath",
  "filename",
  "fileName",
  "uri",
  "target",
  "destination",
];

/**
 * Verbs that mean an MCP tool changes a file rather than reading one.
 *
 * Matched against the tool name, never the arguments. The asymmetry is
 * deliberate: a false negative leaves the tool undetected, which is exactly
 * where things stand today, while a false positive puts a file the server only
 * *read* into the review queue with a note saying its content is unknown. The
 * first is a gap, the second is noise in the one surface that must stay
 * trustworthy.
 */
const MCP_WRITE_VERBS =
  /(write|edit|create|save|update|patch|append|move|rename|delete|remove|mkdir|put)/i;

/**
 * The files an MCP tool call appears to have changed.
 *
 * Nothing here tries to reconstruct what it did — the semantics are per-server
 * and unknowable — so the caller's only honest move is `noteUnreviewable`:
 * the file is listed with an explanation instead of silently missing. Only
 * absolute paths are returned, because a relative one would have to be resolved
 * against a working directory this call does not record.
 */
export function mcpWritePathsFrom(
  name: string,
  input: Record<string, unknown>
): string[] {
  if (!name.startsWith("mcp__") || !MCP_WRITE_VERBS.test(name)) {
    return [];
  }
  const out: string[] = [];
  for (const key of MCP_PATH_KEYS) {
    const value = input[key];
    if (typeof value !== "string" || !value) {
      continue;
    }
    const candidate = value.startsWith("file://")
      ? decodeFileUri(value)
      : value;
    if (candidate && isAbsolutePath(candidate) && !out.includes(candidate)) {
      out.push(candidate);
    }
  }
  return out;
}

function decodeFileUri(uri: string): string | undefined {
  try {
    const withoutScheme = uri.slice("file://".length);
    // `file:///abs` keeps its leading slash; a host form is not a local path.
    return withoutScheme.startsWith("/")
      ? decodeURIComponent(withoutScheme)
      : undefined;
  } catch {
    return undefined;
  }
}

/** POSIX absolute, or a Windows drive/UNC path — this runs on both. */
function isAbsolutePath(value: string): boolean {
  return (
    value.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    value.startsWith("\\\\")
  );
}

/**
 * What the file looked like when a `Write` was announced, plus the evidence that
 * decides whether it can be believed.
 */
export interface WriteSnapshotFacts {
  /** undefined means the file did not exist: the Write creates it. */
  content: string | undefined;
  /** When we read it. */
  ts: number;
  /** The file's mtime at that moment, or undefined if it was not there. */
  mtimeMs: number | undefined;
  /** The timestamp of the transcript line announcing the write. */
  toolTs: number | undefined;
}

export type WriteTrust =
  | { kind: "baseline"; baseline: string; created: boolean }
  | { kind: "reject"; reason: string };

/**
 * Decide whether a captured pre-`Write` snapshot is really the pre-write state.
 *
 * The whole `Write` strategy rests on the tool_use line being *observed* before
 * the tool runs, and it is not: it is observed whenever the poll or the directory
 * watcher next fires, which can be half a minute later — and a project whose
 * session directory does not exist yet has no watcher at all. By then the write
 * may have landed, and what we read is Claude's own output.
 *
 * Testing "the content differs from what is on disk now" does not catch that: a
 * follow-up edit in the same burst makes Claude's first draft differ from
 * `current` too, and registering it as the baseline silently replaces the user's
 * file with it. So require the file's own mtime to predate the tool call.
 */
export function trustWriteSnapshot(
  snapshot: WriteSnapshotFacts,
  current: string,
  now: number,
  ttlMs: number
): WriteTrust {
  if (now - snapshot.ts >= ttlMs) {
    // Older than any tool call it could describe. Trusting it is how a file that
    // exists gets reported as one Claude created — and then deleted.
    return { kind: "reject", reason: "the snapshot outlived its tool call" };
  }
  if (snapshot.content === undefined) {
    // The file did not exist when the Write was announced. That is evidence in
    // itself — Claude's output cannot be an absent file — so no timing proof is
    // needed: the whole file is an addition.
    return current === ""
      ? { kind: "reject", reason: "the file is still empty" }
      : { kind: "baseline", baseline: "", created: true };
  }
  if (snapshot.content === current) {
    // Either the write has not landed yet, or we read the file after it landed and
    // it has not moved since. Indistinguishable, and guessing means offering an
    // Undo that empties the file.
    return {
      kind: "reject",
      reason: "the file has not changed away from the snapshot",
    };
  }
  if (snapshot.mtimeMs === undefined || snapshot.toolTs === undefined) {
    return {
      kind: "reject",
      reason: "its capture time cannot be proven to precede the tool call",
    };
  }
  if (snapshot.mtimeMs >= snapshot.toolTs) {
    return {
      kind: "reject",
      reason:
        "the file was already modified when the tool call was announced, so the content read is Claude's own",
    };
  }
  return { kind: "baseline", baseline: snapshot.content, created: false };
}

/**
 * The working directory a transcript belongs to, read from its opening lines.
 *
 * Claude Code names its project folder by replacing every non-alphanumeric
 * character in the cwd with a dash, which is lossy and not invertible:
 * `/x/proj/sub`, `/x/proj-sub`, `/x/proj_sub` and `/x/proj.sub` all produce the
 * same folder. Deriving the folder from the workspace root therefore both misses
 * sessions (one launched from a subdirectory writes somewhere else entirely) and
 * finds foreign ones. The transcript states its own `cwd`, so it is read instead
 * of guessed.
 *
 * `head` is the first few KB of the file, not the whole of it: the field appears
 * within the opening records — the third line in every transcript on this
 * developer's machine — and a transcript can be hundreds of megabytes.
 */
export function transcriptCwdFrom(head: string): string | undefined {
  for (const line of head.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // A truncated final line is expected — `head` cuts at a byte count — and
      // is simply not the line we are looking for.
      continue;
    }
    const cwd = (parsed as { cwd?: unknown })?.cwd;
    if (typeof cwd === "string" && cwd) {
      return cwd;
    }
  }
  return undefined;
}

/** A tool_result's content is either a string or an array of content blocks. */
function resultText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((block) =>
      block && typeof block === "object"
        ? asString((block as { text?: unknown }).text)
        : ""
    )
    .join("\n");
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}
