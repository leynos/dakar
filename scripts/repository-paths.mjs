/**
 * Classify repository-relative paths without resolving symlinks.
 *
 * @module
 */

import { isAbsolute } from 'node:path'

/**
 * Classify a lexical path as repository-local without resolving symlinks.
 *
 * @param {string} relativePath - path relative to the reviewed root.
 * @returns {boolean} whether the path stays lexically inside the root.
 */
export function isRepositoryRelativePath(relativePath) {
  if (isAbsolute(relativePath)) return false
  if (relativePath === '..') return false
  if (relativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) return false
  return true
}
