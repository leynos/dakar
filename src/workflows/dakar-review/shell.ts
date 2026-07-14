export function shellWord(value: unknown): string {
  return `'${String(value).replace(/'/g, "'\"'\"'")}'`
}
