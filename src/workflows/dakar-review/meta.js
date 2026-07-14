/**
 * @file Route Dakar incremental review work through ODW agents.
 *
 * The workflow computes the unreviewed range, fans scoped review tasks out to
 * Codex agents, verifies candidate findings, synthesizes the accepted review,
 * and records completed heads in Dakar's XDG state history.
 */

export const meta = {
  name: 'dakar-review',
  description:
    'Review only previously unreviewed commits using review-policy YAML guidance, routed Codex review tasks, verification, synthesis, and XDG review history.',
  whenToUse:
    'Use on a git branch when a CodeRabbit-compatible YAML file should drive an incremental AI code review and reviews.toml should prevent duplicate commit coverage.',
  phases: [
    { title: 'Resolve Config' },
    { title: 'Prepare' },
    { title: 'Plan' },
    { title: 'Review' },
    { title: 'Verify' },
    { title: 'Synthesize' },
    { title: 'Record' },
  ],
}
