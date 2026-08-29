import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  editEventFor,
  filePathOf,
  isErrorResult,
  parseTranscriptLine,
  trustWriteSnapshot,
  WriteSnapshotFacts,
} from "../../detection/transcriptEvents";

const TTL = 60_000;

function assistantLine(
  blocks: unknown[],
  timestamp = "2026-07-13T14:51:02.847Z"
): string {
  return JSON.stringify({ timestamp, message: { content: blocks } });
}

describe("parseTranscriptLine", () => {
  it("reads a tool call with its id and the line's timestamp", () => {
    // The id is what lets a result be matched to its call, and the timestamp is
    // what proves a pre-Write snapshot was taken before the write landed. Neither
    // was read at all before.
    const parsed = parseTranscriptLine(
      assistantLine([
        {
          type: "tool_use",
          id: "toolu_01ABC",
          name: "Edit",
          input: { file_path: "/p/a.ts", old_string: "a", new_string: "b" },
        },
      ])
    );
    assert.ok(parsed);
    assert.equal(parsed.uses.length, 1);
    assert.equal(parsed.uses[0].id, "toolu_01ABC");
    assert.equal(parsed.uses[0].name, "Edit");
    assert.equal(parsed.timestamp, Date.parse("2026-07-13T14:51:02.847Z"));
  });

  it("reads tool results out of a user message", () => {
    // These live in a *user* message. Not looking at them is what made a refused
    // edit indistinguishable from one that landed.
    const parsed = parseTranscriptLine(
      JSON.stringify({
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_01ABC",
              content: "The file has been updated.",
            },
          ],
        },
      })
    );
    assert.ok(parsed);
    assert.deepEqual(parsed.results, [
      { toolUseId: "toolu_01ABC", failed: false },
    ]);
  });

  it("reports a tool call with no id, rather than inventing one", () => {
    const parsed = parseTranscriptLine(
      assistantLine([
        { type: "tool_use", name: "Write", input: { file_path: "/p/a.ts" } },
      ])
    );
    assert.equal(parsed?.uses[0].id, undefined);
  });

  it("ignores lines that are not JSON, or carry no content array", () => {
    assert.equal(parseTranscriptLine("{ not json"), undefined);
    assert.equal(parseTranscriptLine(JSON.stringify({ hello: 1 })), undefined);
    assert.equal(
      parseTranscriptLine(JSON.stringify({ message: { content: "text" } })),
      undefined
    );
  });

  it("leaves the timestamp undefined when it cannot be parsed", () => {
    // A snapshot with no tool-call time is refused rather than trusted, so this
    // has to stay distinguishable from a real value.
    assert.equal(
      parseTranscriptLine(assistantLine([], "not a date"))?.timestamp,
      undefined
    );
  });
});

describe("isErrorResult", () => {
  it("recognises the documented is_error flag", () => {
    assert.equal(isErrorResult({ is_error: true, content: "" }), true);
  });

  it("recognises a failure carried as a <tool_use_error> prefix", () => {
    // `is_error` is sometimes absent and the failure is in the text instead. Only
    // checking the flag reads "String to replace not found in file" as a success
    // and reverse-applies an edit that never happened.
    assert.equal(
      isErrorResult({
        content: "<tool_use_error>String to replace not found in file",
      }),
      true
    );
    assert.equal(
      isErrorResult({
        content: [
          { type: "text", text: "<tool_use_error>File has not been read yet." },
        ],
      }),
      true
    );
  });

  it("treats an ordinary result as a success", () => {
    assert.equal(
      isErrorResult({ content: "All occurrences were replaced." }),
      false
    );
  });
});

describe("editEventFor", () => {
  it("carries replace_all through, so reconstruction can refuse it", () => {
    assert.deepEqual(
      editEventFor("Edit", {
        old_string: "let ",
        new_string: "const ",
        replace_all: true,
      }),
      { kind: "edit", oldString: "let ", newString: "const ", replaceAll: true }
    );
  });

  it("flattens a MultiEdit in order", () => {
    assert.deepEqual(
      editEventFor("MultiEdit", {
        edits: [
          { old_string: "a", new_string: "A" },
          { old_string: "b", new_string: "B", replace_all: true },
        ],
      }),
      {
        kind: "multiedit",
        edits: [
          { oldString: "a", newString: "A", replaceAll: false },
          { oldString: "b", newString: "B", replaceAll: true },
        ],
      }
    );
  });

  it("ignores tools that do not change a file", () => {
    assert.equal(editEventFor("Bash", { command: "ls" }), undefined);
    assert.equal(editEventFor("Read", { file_path: "/p/a.ts" }), undefined);
  });
});

describe("filePathOf", () => {
  it("accepts either spelling the hook payload uses", () => {
    assert.equal(filePathOf({ file_path: "/p/a.ts" }), "/p/a.ts");
    assert.equal(filePathOf({ filePath: "/p/b.ts" }), "/p/b.ts");
    assert.equal(filePathOf({ file_path: "" }), undefined);
    assert.equal(filePathOf({}), undefined);
  });
});

describe("trustWriteSnapshot", () => {
  const facts = (
    over: Partial<WriteSnapshotFacts> = {}
  ): WriteSnapshotFacts => ({
    content: "USER v0\n",
    ts: 1_000,
    mtimeMs: 500,
    toolTs: 900,
    ...over,
  });

  it("accepts a snapshot whose file predates the tool call", () => {
    assert.deepEqual(trustWriteSnapshot(facts(), "CLAUDE v1\n", 1_100, TTL), {
      kind: "baseline",
      baseline: "USER v0\n",
      created: false,
    });
  });

  it("refuses a snapshot read after the write had already landed", () => {
    // The failure the review reproduced. A fresh project has no directory watcher
    // and the poll has backed off to 30 s, so the tool_use line is parsed 22 s
    // late and the "pre-write" content read is Claude's own first output. A
    // follow-up edit in the same burst then makes it differ from `current`, which
    // used to be the only test — and Claude's draft was registered as the user's
    // 200-line original.
    const verdict = trustWriteSnapshot(
      facts({ content: "CLAUDE v1\n", mtimeMs: 950 }),
      "CLAUDE v1 + edit\n",
      1_100,
      TTL
    );
    assert.equal(verdict.kind, "reject");
    assert.match(
      verdict.kind === "reject" ? verdict.reason : "",
      /already modified/
    );
  });

  it("refuses when there is no timing evidence at all", () => {
    assert.equal(
      trustWriteSnapshot(facts({ mtimeMs: undefined }), "x", 1_100, TTL).kind,
      "reject"
    );
    assert.equal(
      trustWriteSnapshot(facts({ toolTs: undefined }), "x", 1_100, TTL).kind,
      "reject"
    );
  });

  it("treats an absent file as proof the Write created it", () => {
    // Claude's output cannot be an absent file, so this case needs no timing
    // proof — and `created` is what makes Undo remove the file rather than leave
    // an empty one behind.
    assert.deepEqual(
      trustWriteSnapshot(
        facts({ content: undefined, mtimeMs: undefined }),
        "CLAUDE CREATED\n",
        1_100,
        TTL
      ),
      { kind: "baseline", baseline: "", created: true }
    );
  });

  it("refuses a created-file snapshot while the file is still empty", () => {
    assert.equal(
      trustWriteSnapshot(facts({ content: undefined }), "", 1_100, TTL).kind,
      "reject"
    );
  });

  it("refuses a snapshot the file has not moved away from", () => {
    // "The write has not landed yet" and "we looked after it landed" are the same
    // observation; guessing means offering an Undo that empties the file.
    assert.equal(
      trustWriteSnapshot(facts(), "USER v0\n", 1_100, TTL).kind,
      "reject"
    );
  });

  it("refuses a snapshot that outlived its tool call", () => {
    const verdict = trustWriteSnapshot(facts(), "anything", 70_000, TTL);
    assert.equal(verdict.kind, "reject");
    assert.match(verdict.kind === "reject" ? verdict.reason : "", /outlived/);
  });
});

describe("parseTranscriptLine: file-history records", () => {
  it("reads a backup announcement, which has no message at all", () => {
    // The parser used to return as soon as `message.content` was not an array,
    // and a file-history record has no `message` — so the single most faithful
    // baseline available anywhere was discarded on every line that carried one.
    const parsed = parseTranscriptLine(
      JSON.stringify({
        type: "file-history-delta",
        trackingPath: "src/app.ts",
        backup: {
          backupFileName: "a242946403ba6fa0@v1",
          version: 1,
          realParentDir: "/repo/src",
        },
        timestamp: "2026-07-13T14:51:02.847Z",
      })
    );
    assert.ok(parsed);
    assert.equal(parsed.backups.length, 1);
    assert.deepEqual(parsed.backups[0], {
      kind: "content",
      path: "/repo/src/app.ts",
      name: "a242946403ba6fa0@v1",
      ts: Date.parse("2026-07-13T14:51:02.847Z"),
    });
    assert.deepEqual(parsed.uses, []);
    assert.deepEqual(parsed.results, []);
  });

  it("leaves an ordinary line's backups empty", () => {
    const parsed = parseTranscriptLine(
      assistantLine([{ type: "text", text: "hello" }])
    );
    assert.ok(parsed);
    assert.deepEqual(parsed.backups, []);
  });
});

describe("filePathOf: notebooks", () => {
  it("reads a NotebookEdit's notebook_path", () => {
    // Its absence dropped every notebook edit before any other decision.
    assert.equal(
      filePathOf({ notebook_path: "/repo/analysis.ipynb" }),
      "/repo/analysis.ipynb"
    );
  });

  it("still prefers file_path when both are present", () => {
    assert.equal(
      filePathOf({ file_path: "/a.ts", notebook_path: "/b.ipynb" }),
      "/a.ts"
    );
  });
});

describe("editEventFor: NotebookEdit", () => {
  it("treats a cell edit as a whole-file write", () => {
    // `new_source` is one cell's source; the file on disk wraps it in JSON with
    // its own escaping and `outputs`. Modelling it as a string edit would hand
    // reverseApply an `old_string` that does not occur in the file — or, worse,
    // one that occurs by coincidence. As a write it takes the retrieval path.
    assert.deepEqual(
      editEventFor("NotebookEdit", {
        notebook_path: "/repo/a.ipynb",
        cell_id: "c1",
        new_source: "print(1)",
        edit_mode: "replace",
      }),
      { kind: "write" }
    );
  });
});
