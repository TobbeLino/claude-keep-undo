/**
 * Deciding what a shell command changed, and what those files looked like before.
 *
 * Claude Code runs the `Bash` tool roughly twelve times for every `Edit`, and a
 * shell command records only itself: `{command, description}`, never the files it
 * touched. So `sed -i`, a redirect, `mv`, a formatter or a code generator changed
 * files with nothing anywhere to say which, and the extension showed nothing at
 * all.
 *
 * The answer is git, for one measured reason: `git status` is O(tracked files)
 * while walking the tree is O(tree). On a real 69,056-file checkout with 780
 * tracked files, status answers in 23.5 ms and the walk needs 708 ms — and the
 * walk still would not say what the files *used to hold*. git knows both.
 *
 * This module is the pure half: parsing git's output and deciding which bucket
 * each changed path falls into. It has no `vscode` import and no `fs` import, so
 * it unit-tests in plain Node — and the hook, a separate process, loads the
 * compiled output through `createRequire` exactly as it already loads
 * `out/ignore.js`. Both sides therefore share one implementation of the rules,
 * which is the same reason the ignore matcher is shared.
 *
 * The governing invariant is the one that governs the whole extension: every
 * path either gets a byte-exact baseline or gets no baseline and an explanation.
 * Nothing here guesses.
 */

/** How much detection the user has asked for. */
export type BashMode =
  /** Bash is not in the hook matcher at all; nothing runs. */
  | "off"
  /** Only files the command created. Exact by construction, reads nothing. */
  | "created"
  /** Also files it modified, recovered from git or from a pre-command copy. */
  | "recover";

export interface StatusEntry {
  /** The two-character XY code: `1 `/`2 ` records, or `??` / `!!` / `uu`. */
  xy: string;
  /** The four-character submodule field; `N...` for an ordinary file. */
  sub: string;
  /** For a rename or copy record, the path it came from. */
  orig?: string;
}

export interface StatusSnapshot {
  /** `# branch.oid`, or undefined on an unborn branch. */
  head?: string;
  /** Repo-relative path -> entry. A clean tracked file is NOT listed. */
  entries: Map<string, StatusEntry>;
}

/**
 * Parse `git status --porcelain=v2 --branch -z -uall`.
 *
 * Two traps, both of which corrupt everything after them rather than failing
 * loudly:
 *
 *  - With `-z` the records are NUL-separated and paths are **not** quoted or
 *    escaped, so a path may contain spaces, newlines, quotes — any byte but NUL.
 *    Splitting on whitespace would break on the first path with a space in it.
 *  - A rename or copy record (`2 `) is **two** NUL-terminated fields: the record,
 *    then the original path. Consuming only the first desynchronises the stream,
 *    and the original path is then read as if it were a status record.
 */
export function parseStatusV2(text: string): StatusSnapshot {
  const records = text.split("\0");
  const entries = new Map<string, StatusEntry>();
  let head: string | undefined;

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) {
      continue;
    }
    if (record.startsWith("# ")) {
      const oid = /^# branch\.oid (\S+)/.exec(record);
      if (oid && oid[1] !== "(initial)") {
        head = oid[1];
      }
      continue;
    }
    const kind = record[0];
    if (kind === "?" || kind === "!") {
      // `? <path>` / `! <path>` — one space, then the path verbatim.
      const p = record.slice(2);
      if (p) {
        entries.set(p, { xy: kind === "?" ? "??" : "!!", sub: "N..." });
      }
      continue;
    }
    if (kind !== "1" && kind !== "2" && kind !== "u") {
      continue;
    }
    // `<kind> <XY> <sub> …fixed fields… <path>`; the path is everything after
    // the last fixed field, so it is taken by field count, never by splitting
    // the whole record.
    const fixed = kind === "1" ? 8 : kind === "2" ? 9 : 10;
    const cut = indexAfterFields(record, fixed);
    if (cut < 0) {
      continue;
    }
    const p = record.slice(cut);
    const parts = record.split(" ");
    const entry: StatusEntry = { xy: parts[1] ?? "", sub: parts[2] ?? "" };
    if (kind === "2") {
      // The original path is its own NUL-terminated field. Consuming it here is
      // what keeps the rest of the stream aligned.
      entry.orig = records[++i] || undefined;
    }
    if (p) {
      entries.set(p, entry);
    }
  }
  return { head, entries };
}

/** Index just past `count` space-separated fields, or -1 if there are too few. */
function indexAfterFields(record: string, count: number): number {
  let at = 0;
  for (let field = 0; field < count; field++) {
    const space = record.indexOf(" ", at);
    if (space < 0) {
      return -1;
    }
    at = space + 1;
  }
  return at;
}

/** An ordinary file, as opposed to a submodule. */
export function isOrdinary(entry: StatusEntry): boolean {
  return entry.sub[0] !== "S";
}

/** Does the worktree half of the XY code say the file is gone? */
export function deletedInWorktree(entry: StatusEntry): boolean {
  return entry.xy[1] === "D";
}

/** Is this path untracked, or newly added to the index? */
function looksNew(entry: StatusEntry): boolean {
  return entry.xy === "??" || entry.xy[0] === "A";
}

export type Bucket =
  /** The command brought this file into existence: baseline "", Undo deletes. */
  | { kind: "created"; path: string }
  /** We hold a copy taken before the command ran. */
  | { kind: "staged"; path: string }
  /** It was clean before the command, so git's copy of it is the baseline. */
  | { kind: "recover"; path: string }
  /** Nothing exact is available; the file is listed with this reason. */
  | { kind: "unreviewable"; path: string; reason: string };

export interface ClassifyInput {
  mode: BashMode;
  pre: {
    head?: string;
    /** Repo-relative paths git reported as not clean before the command. */
    notClean: Set<string>;
    /** Of those, the ones whose content we copied aside. */
    staged: Set<string>;
    /** Of those, the ones we could not copy, and why. */
    skipped: Map<string, string>;
  };
  post: StatusSnapshot;
  /** Paths named by `git diff --name-only preHEAD postHEAD`, when HEAD moved. */
  headMoved: string[];
}

/**
 * The reason a modified file is listed when exact recovery is not switched on.
 * Kept here so the hook and the tests quote the same sentence.
 */
export const REASON_MODIFIED =
  "it was changed by a shell command, and its content before the command was not captured";

/**
 * Sort every candidate path into exactly one bucket.
 *
 * Pure: it asks the filesystem nothing. "Does it exist now", "is it in the
 * previous commit", "does the staged copy still match" are all resolved by the
 * caller, which is what makes the decision testable in isolation.
 *
 * The distinction that matters is *created* versus *modified*, because it is the
 * difference between an Undo that deletes a file and one that rewrites it. It is
 * decided by the state git reports **after** the command: a path that is
 * untracked or newly added was not in the previous commit, and one that is
 * tracked-and-modified was. The caller then confirms `created` a second time,
 * independently, before acting on it.
 */
export function classify(input: ClassifyInput): Bucket[] {
  const { mode, pre, post, headMoved } = input;
  const candidates = new Set<string>([
    ...pre.notClean,
    ...post.entries.keys(),
    ...headMoved,
  ]);

  const out: Bucket[] = [];
  for (const p of candidates) {
    const entry = post.entries.get(p);
    if (entry && !isOrdinary(entry)) {
      continue; // a submodule's internals are a different repository's business
    }
    if (entry?.xy === "!!") {
      continue; // ignored by git; the user's own ignore rules decide separately
    }

    if (pre.staged.has(p)) {
      out.push({ kind: "staged", path: p });
      continue;
    }

    if (pre.notClean.has(p)) {
      // It already differed from the commit before the command ran, so git
      // cannot supply its previous content — only a copy taken at the time
      // could, and we do not have one.
      const why = pre.skipped.get(p);
      out.push({
        kind: "unreviewable",
        path: p,
        reason: why ?? REASON_MODIFIED,
      });
      continue;
    }

    // Clean before the command. Either it did not exist, or it matched the
    // commit exactly — and those are the two cases that can be answered exactly.
    if (entry && looksNew(entry)) {
      out.push({ kind: "created", path: p });
      continue;
    }
    if (!entry && !headMoved.includes(p)) {
      continue; // clean before and clean after: the command left it alone
    }
    if (mode !== "recover") {
      out.push({ kind: "unreviewable", path: p, reason: REASON_MODIFIED });
      continue;
    }
    out.push({ kind: "recover", path: p });
  }
  return out;
}

/**
 * Commands that cannot write to a file, whatever their arguments.
 *
 * Deliberately tiny. This list only ever *skips work*, so a name missing from it
 * costs a few milliseconds; a name wrongly on it costs a silently undetected
 * change, which is the failure this whole feature exists to remove. Anything
 * that can be talked into writing — `sed`, `awk`, `find`, `sort`, `xargs`,
 * `python`, every package manager — is absent on purpose.
 */
const READ_ONLY_COMMANDS = new Set([
  "cat",
  "cd",
  "cksum",
  "column",
  "cut",
  "date",
  "df",
  "diff",
  "du",
  "echo",
  "false",
  "file",
  "grep",
  "head",
  "hostname",
  "id",
  "jq",
  "less",
  "ls",
  "md5sum",
  "nl",
  "printf",
  "ps",
  "pwd",
  "rg",
  "sha1sum",
  "sha256sum",
  "shasum",
  "sleep",
  "stat",
  "tail",
  "tree",
  "true",
  "type",
  "uname",
  "uniq",
  "wc",
  "which",
  "whoami",
]);

/** `git` subcommands that only read. `checkout`, `stash`, `apply`, … are not here. */
const READ_ONLY_GIT = new Set([
  "blame",
  "branch",
  "cat-file",
  "config",
  "describe",
  "diff",
  "log",
  "ls-files",
  "ls-remote",
  "remote",
  "rev-parse",
  "shortlog",
  "show",
  "status",
  "tag",
]);

/**
 * Anything that can redirect, substitute or feed another program.
 *
 * A pipe counts: `... | tee f`, `... | sponge f`, `... | python -` all write.
 * Recognising the *shape* rather than the target is what keeps this safe without
 * trying to parse a shell, which measurement showed cannot be done — a naive
 * redirect regex over 8,468 real commands was 87% false positives, and only 9.4%
 * of them had a statically knowable target at all.
 */
const WRITES_SOMEWHERE = /[>|`]|\$\(|<</;

/**
 * Can this command be skipped without a filesystem snapshot?
 *
 * The gate is inverted on purpose. Used as an allowlist of *writers* it would be
 * a source of misses; used as an allowlist of *readers* a wrong answer only ever
 * costs the snapshot it would have skipped. Roughly 43% of real Bash calls
 * qualify, and each skip saves a `git status` and a process spawn on both
 * phases.
 *
 * Pre and Post must agree, so this is a pure function of the command text: the
 * same string always gets the same answer, and a command whose Pre was skipped
 * finds no snapshot at Post and stops there too.
 */
export function looksReadOnly(command: unknown): boolean {
  if (typeof command !== "string" || command.trim() === "") {
    return false;
  }
  if (WRITES_SOMEWHERE.test(command)) {
    return false;
  }
  // Split on every separator that starts a new command — **including a newline**.
  // Leaving it out was a real hole: a third of real Bash calls are multi-line
  // scripts, and `cd somewhere\nmv a b` was read as the single word `cd` and
  // skipped. Checked against 27,109 recorded commands, which is the only reason
  // it was found. `&` is here because a backgrounded segment writes just as well
  // as a foreground one.
  const segments = command.split(/&&|\|\||[;&\n\r]/);
  for (const segment of segments) {
    const words = segment.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      continue;
    }
    let head = words[0];
    // An inline `VAR=value cmd` prefix, and a leading `command`/`\command`.
    let at = 0;
    while (at < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[at])) {
      at++;
    }
    head = words[at];
    if (!head) {
      return false;
    }
    head = head.replace(/^\\/, "");
    const base = head.slice(head.lastIndexOf("/") + 1);
    if (base === "git") {
      const sub = words.slice(at + 1).find((w) => !w.startsWith("-"));
      if (!sub || !READ_ONLY_GIT.has(sub)) {
        return false;
      }
      continue;
    }
    if (!READ_ONLY_COMMANDS.has(base)) {
      return false;
    }
  }
  return true;
}

/**
 * How long a Bash slot stays valid, from the tool call's own timeout.
 *
 * The global staging TTL is 60 s, and it must not be raised: it is what stops a
 * denied Edit's staging from being promoted as the "original" for an edit made
 * days later. But 1.80% of real Bash calls run longer than 60 s (473 of 26,291;
 * p99 = 118 s, longest 604 s), and the tool's own default timeout is already
 * 120 s — so a shared TTL would corrupt roughly one Bash call in fifty-five.
 * The call states how long it may run; that plus a minute is the answer.
 */
export function bashSlotTtl(timeout: unknown): number {
  const stated =
    typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0
      ? timeout
      : 120_000;
  return Math.min(Math.max(stated + 60_000, 180_000), 1_860_000);
}

/**
 * Which slot file a Bash call's Pre and Post phases share.
 *
 * A path cannot be the key the way it is for Edit, because a shell command names
 * no path. An id from the hook envelope is used when there is one; otherwise the
 * session and the command text identify the call. Two *concurrent, identical*
 * commands in one session then share a slot — measured at 5 occurrences in
 * 26,271 assistant messages — and both would observe the same tree anyway.
 */
export function bashSlotId(
  payload: Record<string, unknown>,
  sha1: (value: string) => string
): string {
  for (const key of ["tool_use_id", "tool_call_id"]) {
    const value = payload[key];
    if (typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value)) {
      return value;
    }
  }
  const session =
    typeof payload.session_id === "string" ? payload.session_id : "";
  const input = payload.tool_input as { command?: unknown } | undefined;
  const command = typeof input?.command === "string" ? input.command : "";
  return sha1(`${session}\0${command}`).slice(0, 16);
}

/**
 * Parse `git check-attr --stdin -z filter` into path -> value.
 *
 * A path with a custom filter driver (`filter=lfs`, a clean/smudge pair) cannot
 * have its previous content reproduced from the object store, so it must be
 * listed rather than recovered. The `-z` output is a flat NUL-separated stream of
 * (path, attribute, value) triples.
 *
 * Only complete triples are returned. A truncated one would otherwise yield an
 * empty value, and the caller reads "no filter configured" from exactly that —
 * so a half-read answer for an LFS pointer would come back as recoverable and
 * the baseline would be the pointer text rather than the file. A path missing
 * from the result must therefore be treated as *unanswered*, not as unfiltered.
 */
export function parseCheckAttr(text: string): Map<string, string> {
  const fields = text.split("\0");
  const out = new Map<string, string>();
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const [p, attribute, value] = [fields[i], fields[i + 1], fields[i + 2]];
    if (p && attribute && value) {
      out.set(p, value);
    }
  }
  return out;
}
