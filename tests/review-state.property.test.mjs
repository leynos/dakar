/**
 * @file Property-based coverage for review-range selection and pure helpers.
 *
 * `prepare` must always advance the review base to the most recent recorded
 * head that still lies on the current merge-base-to-HEAD ancestry path, for any
 * subset of previously recorded commits. These properties drive that invariant
 * across randomised recorded subsets over a fixed linear history, and pin the
 * sanitising helpers that derive owner/name and slugs from untrusted input.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import fc from 'fast-check'

import { appendReview, prepare, remoteOwnerName, slug } from '../scripts/review-state.mjs'

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Dakar Test',
      GIT_AUTHOR_EMAIL: 'dakar@example.test',
      GIT_COMMITTER_NAME: 'Dakar Test',
      GIT_COMMITTER_EMAIL: 'dakar@example.test',
    },
  }).trim()
}

// A linear feature history off `main`, with N commits after the merge base.
function createLinearRepo(commitCount) {
  const repo = mkdtempSync(join(tmpdir(), 'dakar-prop-repo-'))
  git(repo, ['init', '-b', 'main'])
  git(repo, ['remote', 'add', 'origin', 'git@github.com:Acme/Widget.git'])
  writeFileSync(join(repo, 'README.md'), '# Test\n')
  git(repo, ['add', 'README.md'])
  git(repo, ['commit', '-m', 'initial'])
  writeFileSync(join(repo, 'base.txt'), 'base\n')
  git(repo, ['add', 'base.txt'])
  git(repo, ['commit', '-m', 'base'])
  const mergeBase = git(repo, ['rev-parse', 'HEAD'])
  git(repo, ['checkout', '-b', 'feature/linear'])
  const commits = []
  for (let index = 0; index < commitCount; index += 1) {
    writeFileSync(join(repo, `change-${index}.txt`), `change ${index}\n`)
    git(repo, ['add', `change-${index}.txt`])
    git(repo, ['commit', '-m', `change ${index}`])
    commits.push(git(repo, ['rev-parse', 'HEAD']))
  }
  return { repo, mergeBase, commits }
}

test('prepare selects the furthest recorded head on the ancestry path', () => {
  const N = 6
  const { repo, mergeBase, commits } = createLinearRepo(N)

  fc.assert(
    fc.property(fc.subarray([0, 1, 2, 3, 4, 5]), (indices) => {
      const stateFile = join(mkdtempSync(join(tmpdir(), 'dakar-prop-state-')), 'reviews.toml')
      for (const index of indices) {
        appendReview({
          stateFile,
          reviewId: `review-${index}`,
          baseCommit: mergeBase,
          headCommit: commits[index],
          commitCount: 1,
          findingsTotal: 0,
          summary: `recorded ${index}`,
        })
      }

      const result = prepare({
        'repo-root': repo,
        'state-file': stateFile,
        base: 'main',
        head: 'HEAD',
      })

      if (indices.length === 0) {
        assert.equal(result.reviewBase, mergeBase)
        assert.equal(result.lastReviewedHead, '')
        assert.equal(result.commitCount, N)
        return
      }

      const maxIndex = Math.max(...indices)
      assert.equal(result.reviewBase, commits[maxIndex])
      assert.equal(result.lastReviewedHead, commits[maxIndex])
      assert.equal(result.commitCount, N - 1 - maxIndex)
      assert.equal(result.alreadyReviewed, maxIndex === N - 1)
    }),
    { numRuns: 32 },
  )
})

test('slug always yields a non-empty, filesystem-safe segment', () => {
  fc.assert(
    fc.property(fc.string(), (input) => {
      const value = slug(input)
      assert.match(value, /^[a-z0-9]+(?:-[a-z0-9]+)*$/u)
      assert.ok(!value.startsWith('-') && !value.endsWith('-'))
      assert.ok(value.length >= 1)
    }),
  )
})

test('remoteOwnerName extracts slugged owner and name from remote URLs', () => {
  const segment = fc
    .string({ minLength: 1, maxLength: 12 })
    .filter((value) => /[a-z0-9]/iu.test(value) && !/[/:]/u.test(value))

  fc.assert(
    fc.property(
      fc.constantFrom('git@github.com:', 'https://github.com/', 'ssh://git@example.com/'),
      segment,
      segment,
      fc.boolean(),
      (prefix, owner, name, withSuffix) => {
        const url = `${prefix}${owner}/${name}${withSuffix ? '.git' : ''}`
        const parsed = remoteOwnerName(url)
        assert.equal(parsed.owner, slug(owner))
        assert.equal(parsed.name, slug(name))
      },
    ),
  )
})

test('remoteOwnerName never throws and always yields slug-shaped fields', () => {
  fc.assert(
    fc.property(fc.string(), (input) => {
      const parsed = remoteOwnerName(input)
      // Every branch (including the unparseable fallback) must return non-empty,
      // filesystem-safe owner and name segments.
      assert.match(parsed.owner, /^[a-z0-9]+(?:-[a-z0-9]+)*$/u)
      assert.match(parsed.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/u)
    }),
  )
})
