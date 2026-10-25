/** CLI 参数解析（零依赖手写：--key value / --flag）。 */
export interface ParsedArgs {
  readonly values: ReadonlyMap<string, string>;
  readonly flags: ReadonlySet<string>;
  readonly unknown: readonly string[];
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const unknown: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (!arg.startsWith('--')) {
      unknown.push(arg);
      continue;
    }
    const eqIndex = arg.indexOf('=');
    if (eqIndex !== -1) {
      values.set(arg.slice(2, eqIndex), arg.slice(eqIndex + 1));
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      values.set(key, next);
      i += 1;
    } else {
      flags.add(key);
    }
  }
  return { values, flags, unknown };
}
