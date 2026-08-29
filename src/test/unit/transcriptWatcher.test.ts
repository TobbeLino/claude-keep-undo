/**
 * End-to-end tests for the transcript reader, driven against real files on disk.
 *
 * This is the component that had no coverage and every Critical finding: it is the
 * only detection channel that works without hooks installed, and its failures are
 * silent by construction — a dropped line produces a baseline that passes the
 * forward verification and is still wrong, and a stalled offset produces nothing at
 * all, with no error anywhere.
 *
 * `vscode` only resolves inside the extension host, so it is stubbed the way
 * `diffLayout.test.ts` does it. Everything else is the real thing: real `.jsonl`
 * files in a temp directory, the real parser, the real reconstruction.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import Module from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

type Listener = (uri: unknown) => void;

const vscodeStub = {
  Disposable: class {
    dispose(): void {}
  },
  Uri: { file: (p: string) => ({ fsPath: p, scheme: "file" }) },
  window: { showWarningMessage: () => Promise.resolve(undefined) },
  commands: { executeCommand: () => Promise.resolve(undefined) },
};

type Loader = (request: string, parent: unknown, isMain: boolean) => unknown;
interface LoadableModule {
  _load: Loader;
}
const loader = Module as unknown as LoadableModule;
const realLoad: Loader = loader._load.bind(Module);
loader._load = (request: string, parent: unknown, isMain: boolean) =>
  request === "vscode" ? vscodeStub : realLoad(request, parent, isMain);

/** Just enough ChangeStore to talk to, plus a record of what it was told. */
class FakeStore {
  readonly registered: {
    path: string;
    baseline: string;
    created: boolean;
  }[] = [];
  readonly unreviewable = new Map<string, string>();
  private readonly baselines = new Set<string>();
  private listeners: Listener[] = [];

  onDidChange(listener: Listener): { dispose(): void } {
    this.listeners.push(listener);
    return {
      dispose: () => {
        this.listeners = this.listeners.filter((l) => l !== listener);
      },
    };
  }
  isInScope(): boolean {
    return true;
  }
  /** Set by a test that needs every path to look excluded from review. */
  ignoreAll = false;
  isIgnored(): boolean {
    return this.ignoreAll;
  }
  hasBaseline(p: string): boolean {
    return this.baselines.has(p);
  }
  registerBaseline(
    p: string,
    baseline: string,
    options: { created?: boolean } = {}
  ): void {
    this.registered.push({
      path: p,
      baseline,
      created: options.created === true,
    });
    this.baselines.add(p);
  }
  noteUnreviewable(p: string, reason: string): void {
    this.unreviewable.set(p, reason);
  }
  clearUnreviewable(p: string): void {
    this.unreviewable.delete(p);
  }
  recompute(): void {}

  /**
   * What Keep and Undo do to the store: the baseline is dropped and the change
   * is announced. The watcher listens for this and forgets the file's history,
   * so that a later edit starts from a fresh baseline rather than an old one.
   */
  resolve(p: string): void {
    this.baselines.delete(p);
    for (const listener of this.listeners) {
      listener({ fsPath: p, scheme: "file" });
    }
  }
}

interface Watcher {
  tick(): void;
  dispose(): void;
}
type WatcherCtor = new (
  cwd: string,
  store: unknown,
  log: (msg: string) => void
) => Watcher;

const { TranscriptWatcher } = loader._load(
  "../../detection/transcriptWatcher",
  module,
  false
) as { TranscriptWatcher: WatcherCtor };
const { sessionDirFor } = loader._load("../../util", module, false) as {
  sessionDirFor: (cwd: string) => string;
};

// `sessionDirFor` resolves against `os.homedir()`, which reads HOME on POSIX and
// USERPROFILE on Windows. Stubbing only HOME leaves the runner's real home in
// effect on Windows, where every test in this file then fails in `beforeEach`
// with "the stub HOME must be in effect" — so both are stubbed.
const HOME_VARS = ["HOME", "USERPROFILE"] as const;
const realHomeVars = HOME_VARS.map((key) => [key, process.env[key]] as const);
let home: string;
let cwd: string;
let transcript: string;
let store: FakeStore;
let logs: string[];
let watcher: Watcher | undefined;
let sequence = 0;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "keepundo-tw-"));
  for (const key of HOME_VARS) {
    process.env[key] = home;
  }
  cwd = path.join(home, "project");
  fs.mkdirSync(cwd, { recursive: true });
  const sessionDir = sessionDirFor(cwd);
  assert.ok(sessionDir.startsWith(home), "the stub HOME must be in effect");
  fs.mkdirSync(sessionDir, { recursive: true });
  transcript = path.join(sessionDir, "session.jsonl");
  store = new FakeStore();
  logs = [];
});

afterEach(() => {
  watcher?.dispose();
  watcher = undefined;
  for (const [key, value] of realHomeVars) {
    // Assigning `undefined` would put the string "undefined" in the environment,
    // which is not the same as the variable being unset — and on Windows HOME is
    // normally unset.
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  fs.rmSync(home, { recursive: true, force: true });
});

/** Start watching, establishing "everything already there is history". */
function attach(): Watcher {
  watcher = new TranscriptWatcher(cwd, store, (m) => logs.push(m));
  watcher.tick();
  return watcher;
}

/**
 * Wait for the reconstruction debounce. Registration is deliberately deferred
 * until the *transcript* has gone quiet, so nothing is observable before then.
 */
const settle = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 900));

/**
 * Wait until the watcher has produced something, rather than for a fixed span.
 *
 * A flat `settle()` has to over-wait to be safe, and a suite of them is both
 * slow and — on a loaded machine, where Node's timers slip — occasionally short
 * anyway. Polling for the outcome removes both problems: a passing case returns
 * as soon as it is true, and a genuinely broken one still fails, just at the
 * deadline instead of at 900 ms.
 *
 * Only for assertions of the form "this must eventually appear". A test that
 * asserts nothing was registered still has to wait a fixed span, because there
 * is no state change to wait for.
 */
async function settleUntil(
  done: () => boolean,
  timeoutMs = 5000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!done() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function textLine(text: string): string {
  return `${JSON.stringify({
    timestamp: new Date(1_800_000_000_000).toISOString(),
    message: { content: [{ type: "text", text }] },
  })}\n`;
}

/** A tool call and its successful result, which is what commits the edit. */
function edit(file: string, oldString: string, newString: string): string {
  const id = `use_${++sequence}`;
  const at = 1_800_000_000_000 + sequence * 1000;
  return (
    `${JSON.stringify({
      timestamp: new Date(at).toISOString(),
      message: {
        content: [
          {
            type: "tool_use",
            id,
            name: "Edit",
            input: {
              file_path: file,
              old_string: oldString,
              new_string: newString,
            },
          },
        ],
      },
    })}\n` +
    `${JSON.stringify({
      timestamp: new Date(at + 1).toISOString(),
      message: {
        content: [{ type: "tool_result", tool_use_id: id, content: "ok" }],
      },
    })}\n`
  );
}

/** A `Write` tool call and its successful result. */
function write(file: string, content: string): string {
  const id = `use_${++sequence}`;
  const at = 1_800_000_000_000 + sequence * 1000;
  return (
    `${JSON.stringify({
      timestamp: new Date(at).toISOString(),
      message: {
        content: [
          {
            type: "tool_use",
            id,
            name: "Write",
            input: { file_path: file, content },
          },
        ],
      },
    })}\n` +
    `${JSON.stringify({
      timestamp: new Date(at + 1).toISOString(),
      message: {
        content: [{ type: "tool_result", tool_use_id: id, content: "ok" }],
      },
    })}\n`
  );
}

describe("TranscriptWatcher: oversized lines", () => {
  it("reads a line larger than the chunk size instead of skipping it", async () => {
    // The original failure here was total and silent: the reader required a
    // newline inside a fixed 1 MiB window and, finding none, returned *without
    // advancing the offset*, so every later tick re-read the same megabyte and
    // the rest of the session was invisible. That was fixed by skipping the
    // line — which traded a hang for the one outcome that is worse, since a
    // skipped `tool_use` leaves the edit list a subset and a subset replays
    // forward cleanly onto a wrong baseline. The window now stretches instead,
    // so the line is read and nothing is lost. 92 lines in this developer's
    // transcripts exceed 1 MiB; the largest is 1,358,099 bytes.
    const target = path.join(cwd, "app.ts");
    fs.writeFileSync(target, "const port = 9090;\n");
    attach();

    fs.appendFileSync(transcript, textLine("x".repeat(2 * 1024 * 1024)));
    fs.appendFileSync(transcript, edit(target, "8080", "9090"));
    watcher!.tick();
    await settleUntil(() => store.registered.length > 0);

    assert.deepEqual(
      store.registered.map((r) => r.baseline),
      ["const port = 8080;\n"],
      "the edit after the very long line must still be ingested"
    );
    assert.equal(store.unreviewable.size, 0, "and nothing is quarantined");
  });

  it("quarantines instead of reconstructing when a line cannot be read at all", async () => {
    // Past the largest window worth holding in memory the line still has to be
    // skipped, but the files whose history it might have carried must not then be
    // rebuilt from what is left. The edit below lands *after* the hole, so the
    // old behaviour would have reconstructed "8080" happily and been wrong if the
    // unreadable line had carried an earlier edit to the same file.
    const target = path.join(cwd, "app.ts");
    fs.writeFileSync(target, "const port = 9090;\n");
    attach();

    // One tool call before the hole, so the file is in flight when it is hit.
    fs.appendFileSync(transcript, edit(target, "8080", "9090"));
    fs.appendFileSync(transcript, textLine("x".repeat(17 * 1024 * 1024)));
    watcher!.tick();
    await settleUntil(() => store.unreviewable.size > 0);

    assert.deepEqual(store.registered, [], "no baseline is guessed");
    assert.match(
      store.unreviewable.get(target) ?? "",
      /could not be read/,
      "the file is listed with the reason instead"
    );
  });

  it("waits for a partial final line instead of skipping it", async () => {
    // The mirror case, which the old code got right and the fix must not break: a
    // read window that covers the whole tail and finds no newline means the last
    // line is still being appended.
    const target = path.join(cwd, "app.ts");
    fs.writeFileSync(target, "b\n");
    attach();

    const whole = edit(target, "a", "b");
    const cut = whole.indexOf("\n") - 5; // guaranteed inside the first line
    assert.ok(cut > 0);
    fs.appendFileSync(transcript, whole.slice(0, cut));
    watcher!.tick();
    await settle();
    assert.equal(store.registered.length, 0, "nothing complete to ingest yet");

    fs.appendFileSync(transcript, whole.slice(cut));
    watcher!.tick();
    await settle();
    assert.deepEqual(
      store.registered.map((r) => r.baseline),
      ["a\n"],
      "and it is ingested once the line is complete"
    );
  });
});

describe("TranscriptWatcher: offset arithmetic", () => {
  it("does not drift when it attaches inside a multi-byte character", async () => {
    // The offset used to be derived from the *decoded* string, which only matches
    // the bytes consumed when the read began on a character boundary. Attaching at
    // a raw `stat().size` can land inside a 2-byte sequence, whose orphan
    // continuation byte decodes to U+FFFD — three bytes — so the recorded offset
    // overshot the real line boundary, the next line started part-way in, failed to
    // parse, and was dropped in silence. A dropped edit is precisely the case where
    // reconstruction still verifies and still returns the wrong baseline: here the
    // user's own `AAA` would be replaced in the recorded "original" by Claude's
    // `BBB`, and Undo would write that back.
    const target = path.join(cwd, "app.ts");
    fs.writeFileSync(target, "BBB\nDDD\n");

    const history = textLine("città più però àèìòù");
    fs.writeFileSync(transcript, history);
    const accent = Buffer.from(history, "utf8").indexOf(
      Buffer.from("à", "utf8")
    );
    assert.ok(accent > 0);
    // Attach with the file truncated mid-character, then let the rest land.
    fs.truncateSync(transcript, accent + 1);
    attach();
    fs.writeFileSync(transcript, history);

    fs.appendFileSync(transcript, edit(target, "AAA", "BBB"));
    fs.appendFileSync(transcript, edit(target, "CCC", "DDD"));
    watcher!.tick();
    await settle();

    assert.deepEqual(
      store.registered.map((r) => r.baseline),
      ["AAA\nCCC\n"],
      "both edits must be seen, so the baseline is the user's own content"
    );
  });

  it("drains a backlog larger than one chunk in a single tick", async () => {
    // Advancing one chunk per tick means the backlog is consumed at the *poll*
    // rate, which backs off to 30 s exactly when nothing appears to be happening.
    const target = path.join(cwd, "app.ts");
    fs.writeFileSync(target, "final\n");
    attach();

    const filler = textLine("y".repeat(4000));
    let bulk = "";
    while (bulk.length < 3 * 1024 * 1024) {
      bulk += filler;
    }
    fs.appendFileSync(transcript, bulk);
    fs.appendFileSync(transcript, edit(target, "start", "final"));
    watcher!.tick();
    await settle();

    assert.deepEqual(
      store.registered.map((r) => r.baseline),
      ["start\n"],
      "the edit at the end of a 3 MB backlog must be reached by this tick"
    );
  });
});

/** A `file-history-delta` record: Claude Code announcing its own pre-edit copy. */
function backupLine(file: string, backupFileName: string | null): string {
  return `${JSON.stringify({
    type: "file-history-delta",
    trackingPath: file,
    backup: {
      backupFileName,
      version: 1,
      backupTime: new Date(1_800_000_000_000).toISOString(),
      realParentDir: path.dirname(file),
    },
    timestamp: new Date(1_800_000_000_000).toISOString(),
  })}\n`;
}

/** Put a backup where the watcher will look for this session's copies. */
function writeBackup(name: string, content: string): void {
  const dir = path.join(home, ".claude", "file-history", "session");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), content);
}

describe("TranscriptWatcher: Claude Code's own pre-edit backups", () => {
  it("prefers the backup over reverse-applying the edits", async () => {
    // Retrieval beats replay. The two are made to disagree on purpose: reverse
    // -applying the edit would yield "AAA\n", and the backup says the file really
    // held "ORIGINAL\n" — which is what it would hold if the user had edited it
    // between Claude's read and Claude's write, or if an earlier edit never
    // reached us. A missing edit is the case reconstruction cannot detect: the
    // subset replays forward cleanly and still returns the wrong baseline.
    const target = path.join(cwd, "app.ts");
    fs.writeFileSync(target, "BBB\n");
    attach();
    writeBackup("aaaa1111@v1", "ORIGINAL\n");

    fs.appendFileSync(transcript, backupLine(target, "aaaa1111@v1"));
    fs.appendFileSync(transcript, edit(target, "AAA", "BBB"));
    watcher!.tick();
    await settleUntil(() => store.registered.length > 0);

    assert.deepEqual(
      store.registered.map((r) => r.baseline),
      ["ORIGINAL\n"],
      "the copy Claude Code took is the baseline, not the replayed guess"
    );
  });

  it("rescues an edit reconstruction refuses", async () => {
    // `replace_all` is refused by reverseApply because the reverse is ambiguous,
    // so this file used to land on the unreviewable list with an explanation.
    // The backup makes it an ordinary reviewable change.
    const target = path.join(cwd, "app.ts");
    fs.writeFileSync(target, "x\nx\n");
    attach();
    writeBackup("bbbb2222@v1", "y\ny\n");

    fs.appendFileSync(transcript, backupLine(target, "bbbb2222@v1"));
    const id = "use_replace_all";
    fs.appendFileSync(
      transcript,
      `${JSON.stringify({
        timestamp: new Date(1_800_000_100_000).toISOString(),
        message: {
          content: [
            {
              type: "tool_use",
              id,
              name: "Edit",
              input: {
                file_path: target,
                old_string: "y",
                new_string: "x",
                replace_all: true,
              },
            },
          ],
        },
      })}\n${JSON.stringify({
        timestamp: new Date(1_800_000_100_001).toISOString(),
        message: {
          content: [{ type: "tool_result", tool_use_id: id, content: "ok" }],
        },
      })}\n`
    );
    watcher!.tick();
    await settleUntil(
      () => store.registered.length > 0 || store.unreviewable.size > 0
    );

    assert.deepEqual(
      store.registered.map((r) => r.baseline),
      ["y\ny\n"],
      "the backup supplies what reverse-apply refuses to guess"
    );
    assert.equal(store.unreviewable.size, 0);
  });

  it("reads a null backup as a file Claude Code created", async () => {
    // The authoritative answer to the question `trustWriteSnapshot` can only
    // reach by timing: no copy was taken because there was nothing to copy, so
    // Undo must delete the file rather than write an empty one over it.
    const target = path.join(cwd, "new.ts");
    fs.writeFileSync(target, "generated\n");
    attach();

    fs.appendFileSync(transcript, backupLine(target, null));
    fs.appendFileSync(transcript, write(target, "generated\n"));
    watcher!.tick();
    await settleUntil(() => store.registered.length > 0);

    assert.deepEqual(store.registered, [
      { path: target, baseline: "", created: true },
    ]);
  });

  it("falls back to reconstruction when the backup has been pruned", async () => {
    // Claude Code cleans these up. A backup file that is gone is *no evidence*,
    // never "the file was empty" — treating it as the latter would have Undo
    // truncate a file that had content.
    const target = path.join(cwd, "app.ts");
    fs.writeFileSync(target, "BBB\n");
    attach();

    fs.appendFileSync(transcript, backupLine(target, "never-written@v1"));
    fs.appendFileSync(transcript, edit(target, "AAA", "BBB"));
    watcher!.tick();
    await settleUntil(
      () => store.registered.length > 0 || store.unreviewable.size > 0
    );

    assert.deepEqual(
      store.registered.map((r) => r.baseline),
      ["AAA\n"],
      "reconstruction still runs when the copy is not there"
    );
  });

  it("never reads a backup for a path the store excludes", async () => {
    // The ignore promise covers the copy as much as the file: a backup of a
    // .env is still a .env.
    const target = path.join(cwd, "secret.env");
    fs.writeFileSync(target, "AFTER\n");
    store.ignoreAll = true;
    attach();
    writeBackup("cccc3333@v1", "SECRET\n");

    fs.appendFileSync(transcript, backupLine(target, "cccc3333@v1"));
    fs.appendFileSync(transcript, edit(target, "BEFORE", "AFTER"));
    watcher!.tick();
    await settle();

    assert.deepEqual(store.registered, []);
    assert.equal(store.unreviewable.size, 0);
  });
});

describe("TranscriptWatcher: subagent transcripts", () => {
  it("reads a transcript a subagent wrote in a subdirectory", async () => {
    // The sweep used to be flat, and on this machine 90% of the transcripts on
    // disk sat below it — every subagent and every workflow. Their tool calls are
    // not mirrored into the parent transcript, so what they changed was invisible.
    const target = path.join(cwd, "app.ts");
    fs.writeFileSync(target, "BBB\n");
    attach();

    const nested = path.join(
      sessionDirFor(cwd),
      "session",
      "subagents",
      "workflows",
      "wf_1"
    );
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(
      path.join(nested, "agent-a1.jsonl"),
      edit(target, "AAA", "BBB")
    );
    watcher!.tick();
    await settleUntil(() => store.registered.length > 0);

    assert.deepEqual(
      store.registered.map((r) => r.baseline),
      ["AAA\n"],
      "a nested transcript is read like any other"
    );
  });

  it("resolves a nested transcript's backups to the parent session", async () => {
    // A subagent's copies live under the *parent* session's history directory,
    // so the id has to come from the first path segment rather than the file name.
    const target = path.join(cwd, "app.ts");
    fs.writeFileSync(target, "BBB\n");
    attach();
    writeBackup("dddd4444@v1", "FROM-SUBAGENT\n");

    const nested = path.join(sessionDirFor(cwd), "session", "subagents");
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(
      path.join(nested, "agent-a2.jsonl"),
      backupLine(target, "dddd4444@v1") + edit(target, "AAA", "BBB")
    );
    watcher!.tick();
    await settleUntil(() => store.registered.length > 0);

    assert.deepEqual(
      store.registered.map((r) => r.baseline),
      ["FROM-SUBAGENT\n"]
    );
  });

  it("ignores a workflow's journal and its own bookkeeping directories", async () => {
    const target = path.join(cwd, "app.ts");
    fs.writeFileSync(target, "BBB\n");
    attach();

    const wf = path.join(sessionDirFor(cwd), "session", "subagents", "wf");
    fs.mkdirSync(wf, { recursive: true });
    fs.writeFileSync(
      path.join(wf, "journal.jsonl"),
      edit(target, "AAA", "BBB")
    );
    const skipped = path.join(sessionDirFor(cwd), "memory");
    fs.mkdirSync(skipped, { recursive: true });
    fs.writeFileSync(
      path.join(skipped, "notes.jsonl"),
      edit(target, "AAA", "BBB")
    );
    watcher!.tick();
    await settle();

    assert.deepEqual(store.registered, [], "neither is a transcript");
  });
});

describe("TranscriptWatcher: a second round of edits after a review", () => {
  it("does not reuse the first backup once the file has been reviewed", async () => {
    // The dangerous shape. Claude edits a file, the user Keeps it — folding that
    // change into the baseline — and Claude edits it again. If the first copy
    // were still held, the second Undo would rewrite the file back past the
    // change the user had just chosen to keep. That is not a stale display, it
    // is the destruction of accepted work, so the first copy has to be dropped
    // when the file is resolved and the second one used in its place.
    const target = path.join(cwd, "app.ts");
    fs.writeFileSync(target, "ONE\n");
    attach();
    writeBackup("first1111@v1", "ZERO\n");

    fs.appendFileSync(transcript, backupLine(target, "first1111@v1"));
    fs.appendFileSync(transcript, edit(target, "ZERO", "ONE"));
    watcher!.tick();
    await settleUntil(() => store.registered.length > 0);
    assert.deepEqual(
      store.registered.map((r) => r.baseline),
      ["ZERO\n"]
    );

    // The user Keeps it: the baseline is folded in and the entry resolves.
    store.resolve(target);

    // Claude edits the same file again. Claude Code takes a fresh copy, and it
    // is that copy — not the one from before the review — that must be used.
    fs.writeFileSync(target, "TWO\n");
    writeBackup("second222@v1", "ONE\n");
    fs.appendFileSync(transcript, backupLine(target, "second222@v1"));
    fs.appendFileSync(transcript, edit(target, "ONE", "TWO"));
    watcher!.tick();
    await settleUntil(() => store.registered.length > 1);

    assert.deepEqual(
      store.registered.map((r) => r.baseline),
      ["ZERO\n", "ONE\n"],
      "the second review starts from the state the user accepted"
    );
  });
});

describe("TranscriptWatcher: rules that change while a file is in flight", () => {
  it("does not open the copy when the path became excluded after the record", async () => {
    // The window is real: the record is read as soon as the line lands, but the
    // copy is not opened until the transcript has been quiet for the settle
    // period. A `.keepundoignore` saved inside that window has to take effect,
    // because the promise for an excluded file is that it is never read — not
    // that its content is discarded once it is already in memory.
    const target = path.join(cwd, "later-secret.env");
    fs.writeFileSync(target, "AFTER\n");
    attach();
    writeBackup("eeee5555@v1", "SECRET\n");

    fs.appendFileSync(transcript, backupLine(target, "eeee5555@v1"));
    fs.appendFileSync(transcript, edit(target, "BEFORE", "AFTER"));
    watcher!.tick();
    // The rule arrives after the record was read, before the baseline is needed.
    store.ignoreAll = true;
    await settle();

    assert.deepEqual(
      store.registered.filter((r) => r.baseline === "SECRET\n"),
      [],
      "the excluded file's copy is never read"
    );
  });
});

/** The record that states which working directory a transcript belongs to. */
function cwdLine(dir: string): string {
  return `${JSON.stringify({
    type: "user",
    cwd: dir,
    timestamp: new Date(1_800_000_000_000).toISOString(),
  })}\n`;
}

describe("TranscriptWatcher: which session directories belong to this workspace", () => {
  it("reads a session launched from a subdirectory of the workspace", async () => {
    // `cd packages/web && claude` writes to a directory the old derivation never
    // looked at, so everything that session changed was invisible — silently,
    // because a missing directory is indistinguishable from "no session yet".
    const sub = path.join(cwd, "packages", "web");
    fs.mkdirSync(sub, { recursive: true });
    const target = path.join(sub, "app.ts");
    fs.writeFileSync(target, "BBB\n");

    const subDir = sessionDirFor(sub);
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(subDir, "sub-session.jsonl"), cwdLine(sub));
    attach();

    fs.appendFileSync(
      path.join(subDir, "sub-session.jsonl"),
      edit(target, "AAA", "BBB")
    );
    watcher!.tick();
    await settleUntil(() => store.registered.length > 0);

    assert.deepEqual(
      store.registered.map((r) => r.baseline),
      ["AAA\n"],
      "the subdirectory session is followed too"
    );
  });

  it("ignores a directory whose name collides but whose cwd is elsewhere", async () => {
    // The encoding replaces every non-alphanumeric character with a dash, so
    // `/x/proj_sub` and `/x/proj/sub` produce the same folder name — this machine
    // has such a pair. Ingesting the wrong project's edits is how a baseline
    // taken from another repository gets registered.
    const foreign = path.join(home, "elsewhere");
    fs.mkdirSync(foreign, { recursive: true });
    const target = path.join(cwd, "app.ts");
    fs.writeFileSync(target, "BBB\n");

    // A directory that claims a cwd outside the workspace.
    const foreignDir = path.join(sessionDirFor(cwd) + "-other");
    fs.mkdirSync(foreignDir, { recursive: true });
    fs.writeFileSync(
      path.join(foreignDir, "foreign.jsonl"),
      cwdLine(foreign) + edit(target, "AAA", "BBB")
    );
    attach();
    watcher!.tick();
    await settle();

    assert.deepEqual(
      store.registered,
      [],
      "another project's transcript is not ingested"
    );
  });

  it("still follows a directory whose transcripts state no cwd", async () => {
    // The fallback: an unreadable or changed format must lose nothing that used
    // to work, so a directory matching the derived name is kept even with no cwd
    // to confirm it.
    const target = path.join(cwd, "app.ts");
    fs.writeFileSync(target, "BBB\n");
    attach();

    fs.appendFileSync(transcript, edit(target, "AAA", "BBB"));
    watcher!.tick();
    await settleUntil(() => store.registered.length > 0);

    assert.deepEqual(
      store.registered.map((r) => r.baseline),
      ["AAA\n"]
    );
  });
});

describe("TranscriptWatcher: relative paths", () => {
  it("resolves a relative file_path against the cwd the line recorded", async () => {
    // The shell's `cd` persists across Bash calls, so a line's cwd and the
    // workspace root diverge inside one session. Resolving against the root
    // would register the baseline onto a different file entirely.
    const sub = path.join(cwd, "server");
    fs.mkdirSync(sub, { recursive: true });
    const target = path.join(sub, "app.ts");
    fs.writeFileSync(target, "BBB\n");
    // A decoy at the path the workspace root would have produced.
    fs.writeFileSync(path.join(cwd, "app.ts"), "DECOY\n");
    attach();

    const id = "use_rel";
    fs.appendFileSync(
      transcript,
      `${JSON.stringify({
        timestamp: new Date(1_800_000_500_000).toISOString(),
        cwd: sub,
        message: {
          content: [
            {
              type: "tool_use",
              id,
              name: "Edit",
              input: {
                file_path: "app.ts",
                old_string: "AAA",
                new_string: "BBB",
              },
            },
          ],
        },
      })}\n${JSON.stringify({
        timestamp: new Date(1_800_000_500_001).toISOString(),
        message: {
          content: [{ type: "tool_result", tool_use_id: id, content: "ok" }],
        },
      })}\n`
    );
    watcher!.tick();
    await settleUntil(() => store.registered.length > 0);

    assert.deepEqual(
      store.registered.map((r) => r.path),
      [target],
      "the file under the recorded cwd, not the one under the workspace root"
    );
  });

  it("refuses a relative path when the line records no cwd", async () => {
    // Nothing to resolve against, and guessing is what puts a baseline on the
    // wrong file. Every file_path in 4,475 real tool calls was absolute, so this
    // costs nothing that works today.
    fs.writeFileSync(path.join(cwd, "app.ts"), "BBB\n");
    attach();

    const id = "use_norel";
    fs.appendFileSync(
      transcript,
      `${JSON.stringify({
        timestamp: new Date(1_800_000_600_000).toISOString(),
        message: {
          content: [
            {
              type: "tool_use",
              id,
              name: "Edit",
              input: {
                file_path: "app.ts",
                old_string: "AAA",
                new_string: "BBB",
              },
            },
          ],
        },
      })}\n${JSON.stringify({
        timestamp: new Date(1_800_000_600_001).toISOString(),
        message: {
          content: [{ type: "tool_result", tool_use_id: id, content: "ok" }],
        },
      })}\n`
    );
    watcher!.tick();
    await settle();

    assert.deepEqual(store.registered, []);
  });
});

/** An MCP tool call and its result. */
function mcpCall(name: string, input: unknown, ok = true): string {
  const id = `use_${++sequence}`;
  const at = 1_800_000_000_000 + sequence * 1000;
  return (
    `${JSON.stringify({
      timestamp: new Date(at).toISOString(),
      message: { content: [{ type: "tool_use", id, name, input }] },
    })}\n` +
    `${JSON.stringify({
      timestamp: new Date(at + 1).toISOString(),
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: id,
            is_error: !ok,
            content: ok ? "ok" : "<tool_use_error>nope",
          },
        ],
      },
    })}\n`
  );
}

describe("TranscriptWatcher: MCP tools that write files", () => {
  it("lists a file an MCP tool wrote, with an explanation", async () => {
    // Nothing can be reconstructed — what an MCP server does to a file is its
    // own business — so the file is listed rather than shown against a guess.
    // Silence would be indistinguishable from "Claude changed nothing".
    const target = path.join(cwd, "app.ts");
    fs.writeFileSync(target, "AFTER\n");
    attach();

    fs.appendFileSync(
      transcript,
      mcpCall("mcp__filesystem__write_file", { path: target })
    );
    watcher!.tick();
    await settleUntil(() => store.unreviewable.size > 0);

    assert.match(store.unreviewable.get(target) ?? "", /MCP tool/);
    assert.deepEqual(store.registered, [], "and no baseline is invented");
  });

  it("says nothing about a read-only MCP tool", async () => {
    // The asymmetry that keeps the queue trustworthy: a tool that only read the
    // file must not appear as one that changed it.
    const target = path.join(cwd, "app.ts");
    fs.writeFileSync(target, "AFTER\n");
    attach();

    fs.appendFileSync(
      transcript,
      mcpCall("mcp__filesystem__read_file", { path: target })
    );
    watcher!.tick();
    await settle();

    assert.equal(store.unreviewable.size, 0);
  });

  it("says nothing when the MCP call failed", async () => {
    const target = path.join(cwd, "app.ts");
    fs.writeFileSync(target, "AFTER\n");
    attach();

    fs.appendFileSync(
      transcript,
      mcpCall("mcp__filesystem__write_file", { path: target }, false)
    );
    watcher!.tick();
    await settle();

    assert.equal(store.unreviewable.size, 0);
  });
});
