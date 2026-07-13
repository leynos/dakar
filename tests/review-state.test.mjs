/**
 * @file Exercise Dakar's review-history preparation and recording helper.
 *
 * The tests build small git repositories to verify incremental range
 * calculation, XDG state path construction, TOML recording, and CLI argument
 * validation around the helper used by the ODW workflow.
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { appendReview, prepare, resolveReachableHead } from '../scripts/review-state.mjs'

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

function createRepoWithAdvancedBase() {
  const repo = mkdtempSync(join(tmpdir(), 'dakar-state-repo-'))
  git(repo, ['init', '-b', 'main'])
  git(repo, ['remote', 'add', 'origin', 'git@github.com:Acme/Widget.git'])
  writeFileSync(join(repo, 'README.md'), '# Test\n')
  git(repo, ['add', 'README.md'])
  git(repo, ['commit', '-m', 'initial'])
  const initial = git(repo, ['rev-parse', 'HEAD'])
  writeFileSync(join(repo, 'base.txt'), 'base\n')
  git(repo, ['add', 'base.txt'])
  git(repo, ['commit', '-m', 'base'])
  const mergeBase = git(repo, ['rev-parse', 'HEAD'])
  git(repo, ['checkout', '-b', 'feature/advanced-base'])
  writeFileSync(join(repo, 'feature.txt'), 'feature\n')
  git(repo, ['add', 'feature.txt'])
  git(repo, ['commit', '-m', 'feature'])
  return { initial, mergeBase, repo }
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

test('record rejects completed entries without a valid head commit', () => {
  const stateFile = join(mkdtempSync(join(tmpdir(), 'dakar-state-')), 'reviews.toml')

  assert.throws(() => appendReview({ stateFile, commitCount: 1, findingsTotal: 0 }), /headCommit/u)
  assert.throws(
    () => appendReview({ stateFile, headCommit: 'not-a-sha', commitCount: 1, findingsTotal: 0 }),
    /headCommit/u,
  )
})

test('record rejects completed entries with invalid counters', () => {
  const stateFile = join(mkdtempSync(join(tmpdir(), 'dakar-state-')), 'reviews.toml')
  const headCommit = 'a'.repeat(40)

  assert.throws(() => appendReview({ stateFile, headCommit, findingsTotal: 0 }), /commitCount/u)
  assert.throws(() => appendReview({ stateFile, headCommit, commitCount: 'many', findingsTotal: 0 }), /commitCount/u)
  assert.throws(() => appendReview({ stateFile, headCommit, commitCount: 1, findingsTotal: 1.5 }), /findingsTotal/u)
})

test('prepare rejects raw missing option values', () => {
  const repo = createRepo()
  assert.throws(() => prepare({ 'repo-root': repo, base: true }), /--base requires a value/u)
})

test('prepare fails closed when the merge base cannot be resolved', () => {
  const repo = createRepo()
  const stateRoot = mkdtempSync(join(tmpdir(), 'dakar-state-'))

  assert.throws(
    () => prepare({ 'repo-root': repo, 'state-root': stateRoot, base: 'missing/base', head: 'HEAD' }),
    /could not determine merge base/u,
  )
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

test('prepare resolves a unique recorded prefix to its canonical commit', () => {
  const repo = createRepo()
  const stateRoot = mkdtempSync(join(tmpdir(), 'dakar-state-'))
  const first = prepare({ 'repo-root': repo, 'state-root': stateRoot, base: 'main', head: 'HEAD~1' })
  mkdirSync(dirname(first.stateFile), { recursive: true })
  writeFileSync(
    first.stateFile,
    `[[reviews]]\nhead_commit = "${first.headCommit.slice(0, 12)}"\nstatus = "completed"\n`,
  )

  const second = prepare({ 'repo-root': repo, 'state-root': stateRoot, base: 'main', head: 'HEAD' })

  assert.equal(second.reviewBase, first.headCommit)
  assert.equal(second.lastReviewedHead, first.headCommit)
  assert.equal(second.commitCount, 1)
})

test('resolveReachableHead rejects an ambiguous recorded prefix', () => {
  const reachable = new Map([
    [`${'a'.repeat(39)}1`, 0],
    [`${'a'.repeat(39)}2`, 1],
  ])

  assert.equal(resolveReachableHead(reachable, 'aaaaaaa'), null)
})

test('resolveReachableHead rejects non-canonical prefix syntax', () => {
  const reachable = new Map([[`${'a'.repeat(39)}1`, 0]])

  for (const recordedHead of ['', 'aaaaaa', 'not-a-sha', 'a'.repeat(41)]) {
    assert.equal(resolveReachableHead(reachable, recordedHead), null)
  }
})

test('prepare ignores recorded heads older than the current merge base', () => {
  const { initial, mergeBase, repo } = createRepoWithAdvancedBase()
  const stateRoot = mkdtempSync(join(tmpdir(), 'dakar-state-'))
  const first = prepare({ 'repo-root': repo, 'state-root': stateRoot, base: 'main', head: 'HEAD' })

  appendReview({
    stateFile: first.stateFile,
    reviewId: 'stale',
    baseCommit: initial,
    headCommit: initial,
    commitCount: 1,
    changedFiles: ['README.md'],
    models: ['gpt-5.5-low'],
    findingsTotal: 0,
    summary: 'stale review',
  })

  const second = prepare({ 'repo-root': repo, 'state-root': stateRoot, base: 'main', head: 'HEAD' })
  assert.equal(second.reviewBase, mergeBase)
  assert.equal(second.lastReviewedHead, '')
  assert.equal(second.commitCount, 1)
  assert.deepEqual(second.changedFiles, ['feature.txt'])
  assert.match(second.warnings[0], /current merge base/u)
})

function createLinearFeatureRepo(count) {
  const repo = mkdtempSync(join(tmpdir(), 'dakar-state-repo-'))
  git(repo, ['init', '-b', 'main'])
  git(repo, ['remote', 'add', 'origin', 'git@github.com:Acme/Widget.git'])
  writeFileSync(join(repo, 'README.md'), '# Test\n')
  git(repo, ['add', 'README.md'])
  git(repo, ['commit', '-m', 'initial'])
  git(repo, ['checkout', '-b', 'feature/linear'])
  const commits = []
  for (let index = 0; index < count; index += 1) {
    writeFileSync(join(repo, `change-${index}.txt`), `change ${index}\n`)
    git(repo, ['add', `change-${index}.txt`])
    git(repo, ['commit', '-m', `change ${index}`])
    commits.push(git(repo, ['rev-parse', 'HEAD']))
  }
  return { repo, commits }
}

test('prepare advances to the furthest reachable head even when recorded out of order', () => {
  const { repo, commits } = createLinearFeatureRepo(5)
  const stateRoot = mkdtempSync(join(tmpdir(), 'dakar-state-'))
  const first = prepare({ 'repo-root': repo, 'state-root': stateRoot, base: 'main', head: 'HEAD' })

  // Record a further-along head (commits[3]) BEFORE a nearer one (commits[1]);
  // selection must rank by ancestry, not by recording order.
  for (const index of [3, 1]) {
    appendReview({
      stateFile: first.stateFile,
      reviewId: `review-${index}`,
      baseCommit: first.mergeBase,
      headCommit: commits[index],
      commitCount: 1,
      findingsTotal: 0,
      summary: `recorded ${index}`,
    })
  }

  const second = prepare({ 'repo-root': repo, 'state-root': stateRoot, base: 'main', head: 'HEAD' })
  assert.equal(second.reviewBase, commits[3])
  assert.equal(second.lastReviewedHead, commits[3])
  assert.equal(second.commitCount, 1)
  assert.deepEqual(second.changedFiles, ['change-4.txt'])
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
