/** @file Quote untrusted values for shell commands embedded in agent prompts. */

export function shellWord(value: unknown): string {
  return `'${String(value).replace(/'/g, "'\"'\"'")}'`
}
