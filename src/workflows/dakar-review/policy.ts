/** @file Match normalized review policy to bounded workflow evidence packs. */

import type { NormalizedReviewPolicy, PolicyPathInstruction } from './types.ts'

/** Escapes one literal character for safe insertion into a regular expression. */
function escapeRegex(character: string): string {
  return /[\\^$.*+?()[\]{}|]/u.test(character) ? `\\${character}` : character
}

/**
 * Expand comma-separated braces in one glob pattern.
 *
 * Nested braces are intentionally unsupported; the loader preserves the source
 * pattern and this deterministic expansion covers common recursive
 * extension-set globs without runtime dependencies.
 *
 * @param pattern - normalized path glob from trusted policy.
 * @returns Brace-expanded patterns in source order.
 */
function expandBraces(pattern: string): string[] {
  const match = pattern.match(/\{([^{}]+)\}/u)
  if (!match || match.index === undefined) return [pattern]
  const before = pattern.slice(0, match.index)
  const after = pattern.slice(match.index + match[0].length)
  return (match[1] || '').split(',').flatMap((choice) => expandBraces(`${before}${choice}${after}`))
}

/**
 * Compile one path glob into an anchored deterministic regular expression.
 *
 * A single star and `?` do not cross path separators; a double star does. A
 * recursive-directory segment also matches zero directories so root files are
 * included.
 *
 * @param pattern - one brace-expanded policy path pattern.
 * @returns Regular expression matching complete repository-relative paths.
 */
function globRegex(pattern: string): RegExp {
  let expression = '^'
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern.charAt(index)
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        index += 1
        if (pattern[index + 1] === '/') {
          index += 1
          expression += '(?:.*/)?'
        } else {
          expression += '.*'
        }
      } else {
        expression += '[^/]*'
      }
    } else if (character === '?') {
      expression += '[^/]'
    } else {
      expression += escapeRegex(character)
    }
  }
  return new RegExp(`${expression}$`, 'u')
}

/**
 * Test one changed path against a normalized policy glob.
 *
 * @param path - repository-relative changed path.
 * @param pattern - CodeRabbit-compatible glob pattern.
 * @returns Whether any deterministic brace expansion matches the whole path.
 */
export function policyPathMatches(path: string, pattern: string): boolean {
  const normalizedPath = path.replaceAll('\\', '/').replace(/^\.\//u, '')
  const normalizedPattern = pattern.replaceAll('\\', '/').replace(/^\.\//u, '')
  return expandBraces(normalizedPattern).some((expanded) => globRegex(expanded).test(normalizedPath))
}

/**
 * Select only path instructions applicable to one evidence pack.
 *
 * @param policy - validated normalized policy supplied by the CLI.
 * @param paths - changed paths assigned to the current prompt.
 * @returns Matching instructions in configuration order with matching paths.
 */
export function pathInstructionsFor(
  policy: NormalizedReviewPolicy,
  paths: string[],
): Array<PolicyPathInstruction & { matchingPaths: string[] }> {
  return policy.pathInstructions.flatMap((instruction) => {
    const matchingPaths = paths.filter((path) => policyPathMatches(path, instruction.path))
    return matchingPaths.length === 0 ? [] : [{ ...instruction, matchingPaths }]
  })
}

/**
 * Render model-mediated policy guidance for a bounded set of paths.
 *
 * Executable commands and ignored unsupported keys are deliberately omitted:
 * commands already ran at the host boundary, while unsupported keys must have
 * no semantic effect.
 *
 * @param policy - validated normalized policy supplied by the CLI.
 * @param paths - paths whose evidence the receiving model may inspect.
 * @returns Stable prompt block containing only applicable model guidance.
 */
export function policyGuidanceBlock(policy: NormalizedReviewPolicy, paths: string[]): string {
  const lines = ['Normalized review policy guidance:']
  if (policy.language) lines.push(`- language: ${policy.language}`)
  if (policy.toneInstructions) lines.push(`- tone_instructions: ${policy.toneInstructions}`)
  if (policy.profile) lines.push(`- reviews.profile: ${policy.profile}`)
  for (const check of policy.customChecks) {
    if (check.instructions) {
      lines.push(`- ${check.gateId} (${check.name}): ${check.instructions}`)
    }
  }
  for (const instruction of pathInstructionsFor(policy, paths)) {
    lines.push(
      `- ${instruction.policyRef} (${instruction.path}; matching paths: ${instruction.matchingPaths.join(', ')}): ${instruction.instructions}`,
    )
  }
  if (lines.length === 1) lines.push('- none')
  return lines.join('\n')
}
