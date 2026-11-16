import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { USAGE, UsageError, firstLine, parseArgs } from "../../../src/server/cli/args.js";

describe("parseArgs", () => {
  it("takes a username", () => {
    assert.deepEqual(parseArgs(["alice"]), { username: "alice", force: false, help: false });
  });

  it("reads the password from --password, -p and --password=", () => {
    assert.equal(parseArgs(["alice", "--password", "s3cret!!"]).password, "s3cret!!");
    assert.equal(parseArgs(["alice", "-p", "s3cret!!"]).password, "s3cret!!");
    assert.equal(parseArgs(["alice", "--password=s3cret!!"]).password, "s3cret!!");
    assert.equal(parseArgs(["--password=a=b=c", "alice"]).password, "a=b=c", "keeps '=' in the value");
    assert.equal(parseArgs(["alice", "--password="]).password, "", "explicit empty (rejected later by length check)");
  });

  it("treats the value after -p literally, even if it looks like an option", () => {
    assert.equal(parseArgs(["alice", "-p", "--force"]).password, "--force");
    assert.equal(parseArgs(["alice", "-p", "-f"]).force, false);
  });

  it("supports --force/-f and --help/-h in any position", () => {
    assert.equal(parseArgs(["-f", "alice"]).force, true);
    assert.equal(parseArgs(["alice", "--force"]).force, true);
    assert.equal(parseArgs(["--help"]).help, true);
    assert.equal(parseArgs(["-h", "alice"]).help, true);
  });

  it("help does not require a username", () => {
    assert.doesNotThrow(() => parseArgs(["--help"]));
  });

  it("ignores a bare --", () => {
    assert.equal(parseArgs(["--", "alice"]).username, "alice");
  });

  const errors: [string, string[], RegExp][] = [
    ["no arguments", [], /Usage/],
    ["only options", ["--force"], /Usage/],
    // Regression: `-p` as the last argument silently fell back to a prompt.
    ["-p without a value", ["alice", "-p"], /-p requires a value/],
    ["--password without a value", ["alice", "--password"], /--password requires a value/],
    ["unknown long option", ["alice", "--admin"], /Unknown option: --admin/],
    ["unknown short option", ["alice", "-x"], /Unknown option: -x/],
    ["second positional", ["alice", "bob"], /Unexpected argument: bob/],
  ];
  for (const [name, argv, message] of errors) {
    it(`rejects ${name}`, () => {
      assert.throws(
        () => parseArgs(argv),
        (err: unknown) => err instanceof UsageError && message.test(err.message),
      );
    });
  }

  it("includes the usage text in errors", () => {
    assert.throws(() => parseArgs(["alice", "--nope"]), (err: Error) => err.message.includes(USAGE));
  });
});

describe("firstLine (piped password)", () => {
  it("strips only the line ending", () => {
    assert.equal(firstLine("secret123\n"), "secret123");
    assert.equal(firstLine("secret123\r\n"), "secret123");
    assert.equal(firstLine("secret123"), "secret123");
  });

  // Regression: .trim() used to drop leading/trailing spaces, silently setting a different password.
  it("keeps leading and trailing spaces", () => {
    assert.equal(firstLine("  spaced out  \n"), "  spaced out  ");
  });

  it("ignores anything after the first line", () => {
    assert.equal(firstLine("first\nsecond\n"), "first");
  });

  it("returns an empty string for empty input", () => {
    assert.equal(firstLine(""), "");
    assert.equal(firstLine("\n"), "");
  });
});
