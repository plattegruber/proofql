/**
 * `parseArgs` for the ops scripts in this directory.
 *
 * The documented invocations go through pnpm:
 *
 *     pnpm db:set-plan -- --account <org_…> --plan paid
 *
 * pnpm 10 forwards the literal `--` to the script, so `process.argv` is
 * `["--", "--account", …]`, and `node:util`'s `parseArgs` reads `--` as the
 * end of options: everything after it becomes a positional and the call
 * throws `ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL` (#128). Running the script
 * directly (`pnpm --filter @proofql/db exec tsx scripts/set-plan.ts
 * --account …`) has no `--` and works, so the two forms must parse alike.
 *
 * `parseScriptArgs` drops that one leading `--` and hands the rest to
 * `parseArgs` unchanged. Only the first argument is touched: a `--` later
 * in the line keeps its meaning (end of options), so a script that takes
 * positionals can still receive one that starts with `-`.
 */

import { type ParseArgsConfig, parseArgs } from "node:util";

/** `argv` without the `--` pnpm puts in front of a script's arguments. */
export function stripScriptArgs(argv: readonly string[]): string[] {
  return argv[0] === "--" ? argv.slice(1) : [...argv];
}

/**
 * `parseArgs(config)` over `argv` (default: this process's arguments)
 * with a leading `--` removed. `config.args`, if given, is ignored.
 */
export function parseScriptArgs<T extends ParseArgsConfig>(
  config: T,
  argv: readonly string[] = process.argv.slice(2),
): ReturnType<typeof parseArgs<T>> {
  return parseArgs({
    ...config,
    args: stripScriptArgs(argv),
  }) as ReturnType<typeof parseArgs<T>>;
}
