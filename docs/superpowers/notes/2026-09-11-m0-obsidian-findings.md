# M0 Obsidian findings — 2026-09-11

- Obsidian version: 1.12.7 (macOS). Vault opened via "Open folder as vault" on `~/Documents/chatmind`.
- Canvas rendered: yes — 5 file nodes in one column, connected top-to-bottom in the right order; cards show the message body; clicking a card opens the note with properties `id, canvas, role, model, parents, created, summary, topics`.
- Node cards show body: yes
- Edge direction/order correct: yes
- Re-save diff: formatting is byte-identical to ours — tab indentation, one compact object per line, key order `id,type,file,x,y,width,height` for nodes and `id,fromNode,fromSide,toNode,toSide` for edges, no trailing newline after the closing `}`. The moved node's position snapped back to exactly `x:0,y:560`. The only difference is that Obsidian moved the dragged node (`01M287QBWT1DWEK2Z8B5AZTF9C`) from position 3 to the end of the `nodes` array (Obsidian's z-order: last element renders on top).

  Verbatim diff (`diff m0-before.canvas m0-after-obsidian.canvas`):

  ```diff
  5d4
  < 		{"id":"01M287QBWT1DWEK2Z8B5AZTF9C","type":"file","file":"masterarbeit/nodes/01M287QBWT1DWEK2Z8B5AZTF9C-problem-re-clustering-aendert-zuordnungen.md","x":0,"y":560,"width":400,"height":200},
  7c6,7
  < 		{"id":"01M287QBWT1DWEK2Z8B5AZTF9E","type":"file","file":"masterarbeit/nodes/01M287QBWT1DWEK2Z8B5AZTF9E-zentroid-ansatz-wird-grundlage-fuer-kapitel-4.md","x":0,"y":1120,"width":400,"height":200}
  ---
  > 		{"id":"01M287QBWT1DWEK2Z8B5AZTF9E","type":"file","file":"masterarbeit/nodes/01M287QBWT1DWEK2Z8B5AZTF9E-zentroid-ansatz-wird-grundlage-fuer-kapitel-4.md","x":0,"y":1120,"width":400,"height":200},
  > 		{"id":"01M287QBWT1DWEK2Z8B5AZTF9C","type":"file","file":"masterarbeit/nodes/01M287QBWT1DWEK2Z8B5AZTF9C-problem-re-clustering-aendert-zuordnungen.md","x":0,"y":560,"width":400,"height":200}
  ```

- Serializer changes made: none. `serializeCanvas` in `packages/core/src/canvas.ts` already matches Obsidian's formatting byte-for-byte.
- Writer change made: `writeCanvas` in `packages/core/src/vault/write.ts` iterated `sortedNodes(graph)` (id order) when building the `fileNodes` array, which would have re-sorted the array back to id order on the next write — churning the file and discarding the z-order Obsidian had just set by moving the dragged node to the end. Added an exported helper `canvasOrder(graph): MessageNode[]` that instead orders nodes by the insertion order of `graph.layout` (the order the canvas was read in / the order Obsidian last saved), appending any node with no prior layout entry (sorted by id) at the end. `writeCanvas` now loops over `canvasOrder(graph)` instead of `sortedNodes(graph)` when building `fileNodes`; `sortedNodes` stays exported for other uses. Added a regression test (`preserves canvas node order from graph.layout and appends new nodes by id`) to `packages/core/test/write.test.ts`, and appended a clarifying sentence to §10 of `docs/superpowers/specs/2026-09-11-chatmind-vault-format-design.md`.
- Verdict: format decision validated
