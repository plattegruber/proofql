import { describe, expect, it } from "vitest";

import { parseScriptArgs, stripScriptArgs } from "./args.js";

const options = {
  account: { type: "string" },
  plan: { type: "string" },
  sync: { type: "boolean", default: false },
} as const;

describe("stripScriptArgs", () => {
  it("drops a leading `--` (what pnpm 10 forwards)", () => {
    expect(stripScriptArgs(["--", "--account", "org_x"])).toEqual([
      "--account",
      "org_x",
    ]);
  });

  it("leaves argv without one alone", () => {
    expect(stripScriptArgs(["--account", "org_x"])).toEqual([
      "--account",
      "org_x",
    ]);
    expect(stripScriptArgs([])).toEqual([]);
  });

  it("only touches the first argument", () => {
    // A later `--` still ends option parsing for positionals.
    expect(stripScriptArgs(["--", "--all", "--", "-x"])).toEqual([
      "--all",
      "--",
      "-x",
    ]);
  });

  it("does not mutate its input", () => {
    const argv = ["--", "--sync"];
    stripScriptArgs(argv);
    expect(argv).toEqual(["--", "--sync"]);
  });
});

describe("parseScriptArgs", () => {
  it("parses `pnpm db:set-plan -- --account … --plan paid`", () => {
    const { values, positionals } = parseScriptArgs({ options }, [
      "--",
      "--account",
      "org_demo_proofql",
      "--plan",
      "paid",
    ]);
    expect(values).toEqual({
      account: "org_demo_proofql",
      plan: "paid",
      sync: false,
    });
    expect(positionals).toEqual([]);
  });

  it("parses the same line run directly through tsx (no `--`)", () => {
    const { values } = parseScriptArgs({ options }, [
      "--account",
      "org_demo_proofql",
      "--sync",
    ]);
    expect(values).toEqual({
      account: "org_demo_proofql",
      plan: undefined,
      sync: true,
    });
  });

  it("still rejects unknown flags and stray positionals", () => {
    expect(() => parseScriptArgs({ options }, ["--", "--bogus"])).toThrow(
      expect.objectContaining({ code: "ERR_PARSE_ARGS_UNKNOWN_OPTION" }),
    );
    expect(() => parseScriptArgs({ options }, ["--", "paid"])).toThrow(
      expect.objectContaining({ code: "ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL" }),
    );
  });

  it("keeps positionals when the script allows them", () => {
    const { values, positionals } = parseScriptArgs(
      {
        options: { explain: { type: "boolean", default: false } },
        allowPositionals: true,
      },
      ["--", "5000", "--explain"],
    );
    expect(values).toEqual({ explain: true });
    expect(positionals).toEqual(["5000"]);
  });
});
