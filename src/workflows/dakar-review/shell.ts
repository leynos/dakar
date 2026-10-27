/**
 * Quote untrusted values for shell commands embedded in agent prompts.
 *
 * @module
 */

/**
 * Quotes one untrusted value as a single POSIX shell word.
 *
 * @param value - Value to stringify and quote without shell interpretation.
 * @returns A single-quoted shell word with embedded quotes escaped.
 */
export function shellWord(value: string): string {
  return `'${String(value).replaceAll('\'', "'\"'\"'")}'`
}
