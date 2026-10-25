# chatmind M12 — Making the context visible

Date: 2026-09-25. Builds on M4 (context set, exclusions, "in context" badge). The user asked for a clearer picture of what is in context, "also the connecting lines — be creative".

## Decisions

| Topic | Decision |
|---|---|
| Context thread | Every edge between two cards of the context set is drawn as the *thread*: accent colour, thick, dashes running from parent to child (towards the reply), on a soft highlighter band (the edge's wide interaction path, tinted), above the other edges (`zIndex: 1`). Merge-ghost edges belong to it. Reduced motion: a solid line. In map mode (M10) line and band are thicker. |
| Excluded cards | An edge touching an excluded card of the context is dotted and muted — the thread visibly skips that card. |
| Outside the context | With a context (any cursor or targets), every other card steps back (opacity 0.62, desaturated); hovering brings it back. |
| Token chip | Every context card that is not excluded shows `≈ n tok` (the `estimateTokens` of its body) bottom right — what it adds to the prompt. |
| Minimap | Context cards are tinted in the accent colour. |
| Topic map | Its fade moved further out (0.38 → 0.28, M10 amended): it began over still readable cards. |

## Tests

`toFlowEdges` classes (`ctx`, `ctx-skipped`, none outside), merge-ghost edges in the thread; `toFlowNodes` sets `tokens` on context cards, `outside` on the rest, nothing without a context. The look is checked at the manual gate.
