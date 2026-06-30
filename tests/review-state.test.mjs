/**
 * @file Exercise Dakar's review-history preparation and recording helper.
 *
 * The tests build small git repositories to verify incremental range
 * calculation, XDG state path construction, TOML recording, and CLI argument
 * validation around the helper used by the ODW workflow.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { appendReview, prepare } from '../scripts/review-state.mjs'

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

function createRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'dakar-state-repo-'))
  git(repo, ['init', '-b', 'main'])
  git(repo, ['remote', 'add', 'origin', 'git@github.com:Acme/Widget.git'])
  writeFileSync(join(repo, 'README.md'), '# Test\n')
  git(repo, ['add', 'README.md'])
  git(repo, ['commit', '-m', 'initial'])
  git(repo, ['checkout', '-b', 'feature/review-history'])
  writeFileSync(join(repo, 'one.txt'), 'one\n')
  git(repo, ['add', 'one.txt'])
  git(repo, ['commit', '-m', 'one'])
  writeFileSync(join(repo, 'two.txt'), 'two\n')
  git(repo, ['add', 'two.txt'])
  git(repo, ['commit', '-m', 'two'])
  return repo
}

test('prepare uses the merge base when no review history exists', () => {
  const repo = createRepo()
  const stateRoot = mkdtempSync(join(tmpdir(), 'dakar-state-'))
  const result = prepare({ 'repo-root': repo, 'state-root': stateRoot, base: 'main', head: 'HEAD' })

  assert.equal(result.ok, true)
  assert.equal(result.repo.owner, 'acme')
  assert.equal(result.repo.name, 'widget')
  assert.equal(result.repo.branchSlug, 'feature-review-history')
  assert.equal(result.commitCount, 2)
  assert.deepEqual(result.changedFiles, ['one.txt', 'two.txt'])
  assert.match(result.stateFile, /dakar\/acme\/widget\/feature-review-history\/reviews\.toml$/u)
})

test('record rejects input without a state file', () => {
  assert.throws(() => appendReview({ headCommit: 'abc123' }), /stateFile/u)
})

test('prepare rejects raw missing option values', () => {
  const repo = createRepo()
  assert.throws(() => prepare({ 'repo-root': repo, base: true }), /--base requires a value/u)
})

test('CLI parser rejects missing option values', () => {
  const repo = createRepo()
  assert.throws(
    () =>
      execFileSync(process.execPath, [resolve('scripts/review-state.mjs'), 'prepare', '--repo-root', repo, '--base'], {
        cwd: resolve(new URL('..', import.meta.url).pathname),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    /--base requires a value/u,
  )
})

test('prepare skips commits already recorded in reviews.toml', () => {
  const repo = createRepo()
  const stateRoot = mkdtempSync(join(tmpdir(), 'dakar-state-'))
  const first = prepare({ 'repo-root': repo, 'state-root': stateRoot, base: 'main', head: 'HEAD~1' })

  appendReview({
    stateFile: first.stateFile,
    reviewId: 'first',
    baseCommit: first.reviewBase,
    headCommit: first.headCommit,
    commitCount: first.commitCount,
    changedFiles: first.changedFiles,
    models: ['gpt-5.5-low'],
    findingsTotal: 0,
    summary: 'first review',
  })

  const second = prepare({ 'repo-root': repo, 'state-root': stateRoot, base: 'main', head: 'HEAD' })
  assert.equal(second.lastReviewedHead, first.headCommit)
  assert.equal(second.reviewBase, first.headCommit)
  assert.equal(second.commitCount, 1)
  assert.deepEqual(second.changedFiles, ['two.txt'])
})

test('prepare reports alreadyReviewed at a recorded head', () => {
  const repo = createRepo()
  const stateRoot = mkdtempSync(join(tmpdir(), 'dakar-state-'))
  const first = prepare({ 'repo-root': repo, 'state-root': stateRoot, base: 'main', head: 'HEAD' })
  appendReview({
    stateFile: first.stateFile,
    reviewId: 'complete',
    baseCommit: first.reviewBase,
    headCommit: first.headCommit,
    commitCount: first.commitCount,
    changedFiles: first.changedFiles,
    models: ['gpt-5.5-low'],
    findingsTotal: 0,
    summary: 'complete review',
  })

  const second = prepare({ 'repo-root': repo, 'state-root': stateRoot, base: 'main', head: 'HEAD' })
  assert.equal(second.alreadyReviewed, true)
  assert.equal(second.commitCount, 0)
})
