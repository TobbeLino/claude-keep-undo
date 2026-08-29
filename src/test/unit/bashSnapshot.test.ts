/**
 * Tests for reading git's status and deciding what a shell command changed.
 *
 * The fixtures below are real `git status --porcelain=v2 --branch -z -uall`
 * output, captured from a scratch repository built to contain the cases that
 * break a naive reader: a path with a space, a path with a newline inside it, and
 * a rename — whose record is two NUL-terminated fields, so mis-reading it
 * desynchronises everything after it.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  bashSlotId,
  looksReadOnly,
  bashSlotTtl,
  classify,
  deletedInWorktree,
  isOrdinary,
  parseCheckAttr,
  parseStatusV2,
  REASON_MODIFIED,
  StatusSnapshot,
} from "../../detection/bashSnapshot";

/** Join records the way `-z` does. */
const z = (...records: string[]) => records.join("\0") + "\0";

describe("parseStatusV2", () => {
  it("reads the head oid and the ordinary records", () => {
    const s = parseStatusV2(
      z(
        "# branch.oid 691ddf974e3155a0",
        "# branch.head main",
        "1 .M N... 100644 100644 100644 aaa bbb normal.txt",
        "? untracked.txt"
      )
    );
    assert.equal(s.head, "691ddf974e3155a0");
    assert.equal(s.entries.size, 2);
    assert.deepEqual(s.entries.get("normal.txt"), { xy: ".M", sub: "N..." });
    assert.deepEqual(s.entries.get("untracked.txt"), { xy: "??", sub: "N..." });
  });

  it("keeps a path containing a space intact", () => {
    // Splitting the record on whitespace would truncate this to "with".
    const s = parseStatusV2(
      z("1 .M N... 100644 100644 100644 aaa bbb with space.txt")
    );
    assert.deepEqual([...s.entries.keys()], ["with space.txt"]);
  });

  it("keeps a path containing a newline intact", () => {
    // `-z` exists precisely so this is representable; a line-oriented reader
    // would see two records, neither of them valid.
    const s = parseStatusV2(z("? weird\nnewline.txt"));
    assert.deepEqual([...s.entries.keys()], ["weird\nnewline.txt"]);
  });

  it("consumes a rename's second field so the stream stays aligned", () => {
    // The trap. A `2 ` record is TWO NUL-terminated fields; reading only the
    // first makes the original path be parsed as the next status record, and
    // everything after it is then attributed to the wrong file.
    const s = parseStatusV2(
      z(
        "2 R. N... 100644 100644 100644 aaa bbb R100 renamed.txt",
        "to-rename.txt",
        "1 .M N... 100644 100644 100644 ccc ddd after.txt"
      )
    );
    assert.equal(s.entries.size, 2, "the original path is not a record");
    assert.deepEqual(s.entries.get("renamed.txt"), {
      xy: "R.",
      sub: "N...",
      orig: "to-rename.txt",
    });
    assert.ok(s.entries.has("after.txt"), "the record after it is still read");
  });

  it("has no head on an unborn branch", () => {
    const s = parseStatusV2(z("# branch.oid (initial)", "? first.txt"));
    assert.equal(s.head, undefined);
  });

  it("survives junk without throwing", () => {
    assert.equal(parseStatusV2("").entries.size, 0);
    assert.equal(parseStatusV2(z("1 too few fields")).entries.size, 0);
    assert.equal(parseStatusV2(z("nonsense", "")).entries.size, 0);
  });
});

describe("isOrdinary / deletedInWorktree", () => {
  it("tells a submodule apart from a file", () => {
    assert.equal(isOrdinary({ xy: ".M", sub: "N..." }), true);
    assert.equal(isOrdinary({ xy: ".M", sub: "SC.." }), false);
  });

  it("reads the worktree half of the code", () => {
    assert.equal(deletedInWorktree({ xy: ".D", sub: "N..." }), true);
    assert.equal(deletedInWorktree({ xy: "D.", sub: "N..." }), false);
  });
});

function snapshot(entries: Record<string, string>): StatusSnapshot {
  return {
    head: "post",
    entries: new Map(
      Object.entries(entries).map(([p, xy]) => [p, { xy, sub: "N..." }])
    ),
  };
}

function input(over: Partial<Parameters<typeof classify>[0]> = {}) {
  return {
    mode: "recover" as const,
    pre: {
      head: "pre",
      notClean: new Set<string>(),
      staged: new Set<string>(),
      skipped: new Map<string, string>(),
    },
    post: snapshot({}),
    headMoved: [],
    ...over,
  };
}

describe("classify", () => {
  it("calls an untracked file that was clean before 'created'", () => {
    // Exact by construction: it was not there, so the baseline is empty and Undo
    // deletes it. No file is read to establish this.
    const out = classify(input({ post: snapshot({ "new.txt": "??" }) }));
    assert.deepEqual(out, [{ kind: "created", path: "new.txt" }]);
  });

  it("calls a tracked file that was clean before 'recover'", () => {
    // It matched the commit exactly, so git holds its previous content.
    const out = classify(input({ post: snapshot({ "src/a.ts": ".M" }) }));
    assert.deepEqual(out, [{ kind: "recover", path: "src/a.ts" }]);
  });

  it("recovers a file the command deleted", () => {
    const out = classify(input({ post: snapshot({ "gone.txt": ".D" }) }));
    assert.deepEqual(out, [{ kind: "recover", path: "gone.txt" }]);
  });

  it("recovers a file left clean by a commit made inside the command", () => {
    // `git commit` / `checkout` / `pull` inside the shell command leaves the file
    // clean at Post while it differs from the commit we snapshotted.
    const out = classify(input({ headMoved: ["src/a.ts"] }));
    assert.deepEqual(out, [{ kind: "recover", path: "src/a.ts" }]);
  });

  it("promotes the copy we took for a file that was already dirty", () => {
    const out = classify(
      input({
        pre: {
          head: "pre",
          notClean: new Set(["dirty.ts"]),
          staged: new Set(["dirty.ts"]),
          skipped: new Map(),
        },
        post: snapshot({ "dirty.ts": ".M" }),
      })
    );
    assert.deepEqual(out, [{ kind: "staged", path: "dirty.ts" }]);
  });

  it("lists a file that was dirty and could not be copied", () => {
    // git cannot supply the previous content of a file that already differed
    // from the commit, and no copy was taken — so there is nothing exact to
    // offer, and the file is listed with the reason instead of guessed at.
    const out = classify(
      input({
        pre: {
          head: "pre",
          notClean: new Set(["big.bin"]),
          staged: new Set(),
          skipped: new Map([["big.bin", "it is too large to capture"]]),
        },
        post: snapshot({ "big.bin": ".M" }),
      })
    );
    assert.deepEqual(out, [
      {
        kind: "unreviewable",
        path: "big.bin",
        reason: "it is too large to capture",
      },
    ]);
  });

  it("still detects creations when only creations were asked for", () => {
    // The default tier reads no pre-existing file at all, so a modification has
    // no exact answer and is listed; a creation is unaffected.
    const out = classify(
      input({
        mode: "created",
        post: snapshot({ "new.txt": "??", "src/a.ts": ".M" }),
      })
    );
    assert.deepEqual(
      out.find((b) => b.path === "new.txt"),
      {
        kind: "created",
        path: "new.txt",
      }
    );
    assert.deepEqual(
      out.find((b) => b.path === "src/a.ts"),
      {
        kind: "unreviewable",
        path: "src/a.ts",
        reason: REASON_MODIFIED,
      }
    );
  });

  it("ignores a submodule and a git-ignored path", () => {
    const post: StatusSnapshot = {
      head: "post",
      entries: new Map([
        ["vendor/lib", { xy: ".M", sub: "SC.." }],
        ["build/out.js", { xy: "!!", sub: "N..." }],
      ]),
    };
    assert.deepEqual(classify(input({ post })), []);
  });

  it("says nothing about a file that was clean before and after", () => {
    assert.deepEqual(classify(input()), []);
  });
});

describe("bashSlotTtl", () => {
  it("follows the tool call's own timeout, with a floor and a ceiling", () => {
    // 1.80% of real Bash calls run longer than the 60 s staging TTL, and the
    // tool's default timeout is already 120 s, so a shared TTL would expire
    // mid-command roughly once in fifty-five calls.
    assert.equal(bashSlotTtl(120_000), 180_000);
    assert.equal(bashSlotTtl(600_000), 660_000);
    assert.equal(bashSlotTtl(undefined), 180_000, "the default timeout");
    assert.equal(bashSlotTtl(1_000), 180_000, "never below the floor");
    assert.equal(bashSlotTtl(9_999_999), 1_860_000, "never above the ceiling");
    assert.equal(bashSlotTtl("nonsense"), 180_000);
  });
});

describe("bashSlotId", () => {
  const sha1 = (s: string) => `sha(${s.replace("\0", "|")})`;

  it("prefers an id from the envelope", () => {
    assert.equal(
      bashSlotId({ tool_use_id: "toolu_01ABC" }, sha1),
      "toolu_01ABC"
    );
  });

  it("refuses an id that is not safe as a file name", () => {
    const id = bashSlotId({ tool_use_id: "../../etc/passwd" }, sha1);
    assert.ok(!id.includes("/"), "never a path component from outside");
  });

  it("falls back to the session and the command", () => {
    assert.equal(
      bashSlotId({ session_id: "s1", tool_input: { command: "ls" } }, sha1),
      "sha(s1|ls)".slice(0, 16)
    );
  });
});

describe("parseCheckAttr", () => {
  it("reads path/attribute/value triples", () => {
    const out = parseCheckAttr(
      z("a.txt", "filter", "lfs", "b.txt", "filter", "unspecified")
    );
    assert.equal(out.get("a.txt"), "lfs");
    assert.equal(out.get("b.txt"), "unspecified");
  });

  it("ignores a truncated trailing triple", () => {
    assert.equal(parseCheckAttr(z("a.txt", "filter")).size, 0);
  });
});

describe("looksReadOnly", () => {
  it("skips commands that cannot write", () => {
    for (const command of [
      "ls -la",
      "cat package.json",
      "grep -rn foo src",
      "git status --short",
      "git log --oneline -5",
      "ls && cat a.txt",
      "FOO=1 ls",
      "cd src\nls",
      "wc -l src/*.ts",
    ]) {
      assert.equal(looksReadOnly(command), true, command);
    }
  });

  it("never skips anything that could write", () => {
    // The gate is inverted on purpose: a reader wrongly called a writer costs a
    // snapshot, while a writer wrongly called a reader costs an undetected
    // change — the exact failure this feature exists to remove.
    for (const command of [
      "echo hi > f.txt",
      "echo hi >> f.txt",
      "sed -i '' s/a/b/ f",
      "npm run build",
      "python3 script.py",
      "git checkout .",
      "git stash",
      "cat a | tee b",
      "find . -delete",
      "ls $(pwd)",
      "cat <<EOF",
      "rm -rf x",
      "mv a b",
      "ls; rm x",
      "ls & rm x",
      "make",
      "./build.sh",
      "",
    ]) {
      assert.equal(looksReadOnly(command), false, command);
    }
  });

  it("splits on a newline, not only on shell operators", () => {
    // Found by running the gate over 27,109 recorded commands: a third of real
    // Bash calls are multi-line scripts, and without this `cd somewhere` was the
    // only word examined — so 30 commands that plainly wrote files were being
    // skipped. No synthetic case would have caught it.
    assert.equal(looksReadOnly("cd /repo\nmv a.md b.md"), false);
    assert.equal(looksReadOnly("cd /repo\nrm -f x"), false);
    assert.equal(
      looksReadOnly("cd /repo\nF=x\npython3 -c 'open(F,\"w\")'"),
      false
    );
    assert.equal(looksReadOnly("cd /repo\nls -la\ncat a.txt"), true);
  });

  it("reads a git subcommand rather than trusting the name git", () => {
    assert.equal(looksReadOnly("git diff HEAD"), true);
    assert.equal(looksReadOnly("git apply p.patch"), false);
    assert.equal(looksReadOnly("git"), false, "no subcommand is not a read");
  });
});
