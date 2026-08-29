/**
 * Tests for the reading of Claude Code's own pre-edit backups.
 *
 * Two of the three decisions in this module turn untrusted text from a JSON file
 * into a path that is about to be opened, so the cases below are as much about
 * what is *refused* as about what is accepted. The third — `null` versus a
 * missing field — is the difference between "Undo deletes this file" and "Undo
 * writes an empty one over it", which is why it is pinned so precisely.
 */
import assert from "node:assert/strict";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
  backupFilePath,
  fileBackupFrom,
  sessionIdForTranscript,
} from "../../detection/fileHistory";

function delta(backup: unknown, trackingPath: unknown = "src/app.ts"): unknown {
  return { type: "file-history-delta", trackingPath, backup };
}

describe("fileBackupFrom", () => {
  it("reads a named backup and composes the path it describes", () => {
    // `realParentDir` supplies the directory and `trackingPath` only the file
    // name: the first is always absolute and already resolved, the second is
    // relative in most records and absolute in others.
    const backup = fileBackupFrom(
      delta({
        backupFileName: "a242946403ba6fa0@v1",
        version: 1,
        realParentDir: path.join(path.sep, "repo", "src"),
      }),
      1_800_000_000_000
    );
    assert.deepEqual(backup, {
      kind: "content",
      path: path.join(path.sep, "repo", "src", "app.ts"),
      name: "a242946403ba6fa0@v1",
      ts: 1_800_000_000_000,
    });
  });

  it("reads an explicit null backup as 'the file did not exist'", () => {
    // Verified against this machine's whole transcript history before the code
    // was written: `backupFileName: null` occurred 236 times and every single
    // one had a `Write` as the first tool to touch that path — never an `Edit`.
    // That is what makes it evidence rather than an absence of it, and it is the
    // authoritative answer to the question `trustWriteSnapshot` can only guess.
    const backup = fileBackupFrom(
      delta({
        backupFileName: null,
        version: 1,
        realParentDir: path.join(path.sep, "repo"),
      }),
      undefined
    );
    assert.deepEqual(backup, {
      kind: "created",
      path: path.join(path.sep, "repo", "app.ts"),
      ts: undefined,
    });
  });

  it("refuses a record whose backupFileName is absent rather than null", () => {
    // The whole point of keeping the two apart. A missing field is a record we do
    // not understand; reading it as `created` would make Undo delete a file that
    // existed, which is the data-loss case this codebase refuses to risk.
    assert.equal(
      fileBackupFrom(
        delta({ version: 1, realParentDir: path.join(path.sep, "repo") }),
        undefined
      ),
      undefined
    );
  });

  it("refuses a backup name that would escape the history directory", () => {
    // The name arrives in a file we do not write and is about to become a path
    // component.
    for (const name of [
      "../../../etc/passwd",
      "a/b",
      "..",
      "",
      ".hidden",
      "a\\b",
    ]) {
      assert.equal(
        fileBackupFrom(
          delta({ backupFileName: name, realParentDir: path.sep }),
          undefined
        ),
        undefined,
        `${JSON.stringify(name)} must not be accepted as a file name`
      );
    }
  });

  it("falls back to an absolute trackingPath when realParentDir is missing", () => {
    // Three records on the development machine had no `realParentDir` at all.
    // Two of them named an absolute `trackingPath`, which is the whole answer —
    // dropping those was a loss for no reason.
    const absolute = path.join(path.sep, "repo", "src", "app.ts");
    for (const dir of ["relative/dir", "", undefined, 42]) {
      assert.deepEqual(
        fileBackupFrom(
          delta({ backupFileName: "abc@v1", realParentDir: dir }, absolute),
          undefined
        ),
        { kind: "content", path: absolute, name: "abc@v1", ts: undefined }
      );
    }
  });

  it("refuses a relative trackingPath with no realParentDir to anchor it", () => {
    // Resolving this would mean inventing a working directory, and the baseline
    // would then be attributed to whatever file that guess happened to name.
    assert.equal(
      fileBackupFrom(
        delta({ backupFileName: "abc@v1" }, "src/app.ts"),
        undefined
      ),
      undefined
    );
  });

  it("prefers realParentDir, which is the resolved location", () => {
    // A probe against /tmp recorded `realParentDir: "/private/tmp"`. The more
    // specific field wins where both are present.
    const backup = fileBackupFrom(
      delta(
        {
          backupFileName: "abc@v1",
          realParentDir: path.join(path.sep, "private", "tmp"),
        },
        path.join(path.sep, "tmp", "probe.txt")
      ),
      undefined
    );
    assert.equal(
      backup?.path,
      path.join(path.sep, "private", "tmp", "probe.txt")
    );
  });

  it("refuses a trackingPath with no usable file name", () => {
    for (const tracking of ["", "..", ".", 7]) {
      assert.equal(
        fileBackupFrom(
          delta(
            { backupFileName: "abc@v1", realParentDir: path.sep },
            tracking
          ),
          undefined
        ),
        undefined,
        `${JSON.stringify(tracking)} names no file`
      );
    }
    // Built by hand rather than through the helper, whose default parameter
    // would otherwise stand in for the very field being omitted.
    assert.equal(
      fileBackupFrom(
        {
          type: "file-history-delta",
          backup: { backupFileName: "abc@v1", realParentDir: path.sep },
        },
        undefined
      ),
      undefined,
      "an absent trackingPath names no file either"
    );
  });

  it("ignores anything that is not a file-history record", () => {
    assert.equal(fileBackupFrom({ type: "assistant" }, undefined), undefined);
    assert.equal(fileBackupFrom(undefined, undefined), undefined);
    assert.equal(fileBackupFrom("file-history-delta", undefined), undefined);
    assert.equal(fileBackupFrom(delta("not-an-object"), undefined), undefined);
  });
});

describe("sessionIdForTranscript", () => {
  const projectDir = path.join(path.sep, "home", ".claude", "projects", "proj");

  it("reads the id off a session's own transcript", () => {
    assert.equal(
      sessionIdForTranscript(projectDir, path.join(projectDir, "abc123.jsonl")),
      "abc123"
    );
  });

  it("reads the parent session's id off a subagent transcript", () => {
    // This is the layout that made the flat sweep miss 90% of the transcripts on
    // disk. A subagent's backups live under the *parent* session's directory, so
    // the id is the first segment, not the file name.
    assert.equal(
      sessionIdForTranscript(
        projectDir,
        path.join(projectDir, "abc123", "subagents", "agent-x.jsonl")
      ),
      "abc123"
    );
    assert.equal(
      sessionIdForTranscript(
        projectDir,
        path.join(
          projectDir,
          "abc123",
          "subagents",
          "workflows",
          "wf_1",
          "agent-y.jsonl"
        )
      ),
      "abc123"
    );
  });

  it("refuses a file outside the project directory", () => {
    assert.equal(
      sessionIdForTranscript(
        projectDir,
        path.join(path.sep, "elsewhere", "other.jsonl")
      ),
      undefined
    );
    assert.equal(sessionIdForTranscript(projectDir, projectDir), undefined);
  });
});

describe("backupFilePath", () => {
  const historyDir = path.join(path.sep, "home", ".claude", "file-history");

  it("joins a session and a name", () => {
    assert.equal(
      backupFilePath(historyDir, "abc123", "d9864d35d6f85fd1@v2"),
      path.join(historyDir, "abc123", "d9864d35d6f85fd1@v2")
    );
  });

  it("re-checks both components even though its callers validated them", () => {
    // The single place that builds a path out of transcript-supplied text. A
    // caller that forgets a check must not be able to turn that into an
    // arbitrary read.
    assert.equal(backupFilePath(historyDir, "..", "abc@v1"), undefined);
    assert.equal(backupFilePath(historyDir, "abc", "../../secret"), undefined);
    assert.equal(backupFilePath(historyDir, "", "abc@v1"), undefined);
  });
});
