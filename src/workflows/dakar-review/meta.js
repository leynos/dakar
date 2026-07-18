/**
 * @file Route Dakar incremental review work through ODW agents.
 *
 * The workflow computes the unreviewed range, fans scoped review tasks out to
 * Codex agents, verifies candidate findings, and renders the accepted review
 * deterministically host-side. The installable CLI records completed heads in
 * Dakar's XDG state history after the workflow returns.
 */

export const meta = {
  name: 'dakar-review',
  description:
    'Review only previously unreviewed commits using review-policy YAML guidance, routed Codex review tasks, verification, deterministic rendering, and XDG review history.',
  whenToUse:
    'Use on a git branch when a CodeRabbit-compatible YAML file should drive an incremental AI code review and reviews.toml should prevent duplicate commit coverage.',
  phases: [
    { title: 'Plan' },
    { title: 'Review' },
    { title: 'Verify' },
  ],
}
