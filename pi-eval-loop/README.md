# pi-eval-loop

Quality-first autonomous harness optimization loop for `orche` (pi-orche). It adapts the Pareto-guided promotion of
ParetoSaddler (arXiv 2611.02079) to quality objectives (Q_overall, Q_hard, Q_consistency). It is NOT a reproduction of the paper:
the paper optimizes quality and cost (gamma .7, eps_Q .1); here cost and time are only recorded. The defaults are a screening
support of .80 at execution level, adoption support of .95 at task level, an exploratory overall loss of at most 3 percentage
points and 10,000 paired, task-clustered Bayesian bootstrap draws.

## Commands (from the umbrella root)

    npm run eval:loop -- --once | --resume | --daemon | --status | --doctor | --rollback | --ablation | --selftest
    npm run eval:report

State defaults to `pi-eval-loop/state/default` (git-ignored). Missing prerequisites end in a recorded BLOCKED state.

## Reused assets

orche `experiments/witness-replay/{sandbox.ts,proxy.mjs,bridge.mjs}` (bwrap isolation, pinned-route proxy),
`experiments/ultra-ab/protocol.ts` (integrity checks), and `fixtures/suite` (train/dev tasks, already exposed). `datasets/holdout-v1`
holds seven fresh tasks, sealed before any search (commit 2edcef1). The implementer wrote them, which is a limitation.

## Limitations

- It is an in-umbrella directory, not a submodule. Creating a remote repository was not authorized, and a gitlink without a
  remote would not be portable.
- The Pi extension entry and the compat/install gate wiring are not done yet.
- No real-model optimization cycle or A/B/C measurement has been recorded yet. Only `--selftest` (faux upstream, labelled
  simulated) and single real smoke runs exist.
