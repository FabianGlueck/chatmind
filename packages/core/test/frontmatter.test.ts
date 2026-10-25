import fc from 'fast-check';
import { decodeTime } from 'ulid';
import { describe, expect, it } from 'vitest';
import { normalizeBody, normalizeSummary, parseNodeFile, serializeNodeFile } from '../src/frontmatter';
import { isoTimestamp } from '../src/ids';
import type { MessageNode } from '../src/types';

const A = '01JQ8F2H7T4WKD9M3XBQNAAAAA';
const B = '01JQ8F3K2M9XZP4V7NBHRCAAAA';

function node(over: Partial<MessageNode> & { id: string }): MessageNode {
  return { role: 'user', parents: [], created: '2026-03-14T10:42:03Z', summary: '', topics: [], body: 'Body.', ...over };
}

describe('serializeNodeFile', () => {
  it('writes canonical key order with flow arrays and one blank line before the body', () => {
    const text = serializeNodeFile(
      node({ id: B, role: 'assistant', model: 'claude-sonnet-4-6', parents: [A], summary: 'Zentroid-Ansatz skaliert besser', body: 'Full body.' }),
      'masterarbeit',
    );
    expect(text).toBe(
      `---
id: ${B}
canvas: masterarbeit
role: assistant
model: claude-sonnet-4-6
parents: [${A}]
created: 2026-03-14T10:42:03Z
summary: Zentroid-Ansatz skaliert besser
topics: []
---

Full body.
`,
    );
  });

  it('omits model for user role even if set', () => {
    expect(serializeNodeFile(node({ id: A, model: 'x' }), 'c')).not.toContain('model:');
  });

  it('writes an empty summary as an empty single-quoted string', () => {
    expect(serializeNodeFile(node({ id: A }), 'c')).toContain("summary: ''\n");
  });

  it('quotes summaries YAML would otherwise misread', () => {
    expect(serializeNodeFile(node({ id: A, summary: 'Zwei Optionen: A oder B' }), 'c')).toContain("summary: 'Zwei Optionen: A oder B'\n");
    expect(serializeNodeFile(node({ id: A, summary: 'true' }), 'c')).toContain("summary: 'true'\n");
  });

  it('keeps umlauts unescaped', () => {
    expect(serializeNodeFile(node({ id: A, summary: 'Größe zählt' }), 'c')).toContain('summary: Größe zählt\n');
  });

  it('collapses summary whitespace onto one line', () => {
    expect(serializeNodeFile(node({ id: A, summary: '  a  b\nc ' }), 'c')).toContain('summary: a b c\n');
  });

  it('strips leading blank lines and trailing whitespace from the body', () => {
    expect(serializeNodeFile(node({ id: A, body: '\n\n  # Title\n\ntext   \n\n' }), 'c')).toMatch(/---\n\n {2}# Title\n\ntext\n$/);
  });

  it('writes no body section for an empty body', () => {
    const text = serializeNodeFile(node({ id: A, body: '   \n' }), 'c');
    expect(text.endsWith('topics: []\n---\n')).toBe(true);
  });

  it('writes multiple parents and topics in flow style', () => {
    const text = serializeNodeFile(node({ id: A, parents: [A, B], topics: ['eval', 'metrik'] }), 'c');
    expect(text).toContain(`parents: [${A}, ${B}]\n`);
    expect(text).toContain('topics: [eval, metrik]\n');
  });
});

describe('parseNodeFile', () => {
  it('parses canonical output back to the same node', () => {
    const n = node({ id: B, role: 'assistant', model: 'm', parents: [A], summary: 'S', topics: ['t'], body: 'Line 1\n\nLine 2' });
    const r = parseNodeFile(serializeNodeFile(n, 'masterarbeit'));
    expect(r).toEqual({ ok: true, node: n, canvas: 'masterarbeit', defaulted: [] });
  });

  it('accepts CRLF, block-style arrays and a BOM', () => {
    const text = `\uFEFF---\r\nid: ${A}\r\ncanvas: c\r\nrole: user\r\nparents:\r\n  - ${B}\r\ncreated: 2026-01-01T00:00:00Z\r\nsummary: s\r\ntopics:\r\n  - t\r\n---\r\n\r\nBody\r\n`;
    const r = parseNodeFile(text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.node.parents).toEqual([B]);
    expect(r.node.topics).toEqual(['t']);
    expect(r.node.body).toBe('Body');
    expect(r.defaulted).toEqual([]);
  });

  it('keeps a quoted created value as a string', () => {
    const r = parseNodeFile(`---\nid: ${A}\nrole: user\nparents: []\ncreated: "2026-01-01T00:00:00Z"\nsummary: ''\ntopics: []\n---\n`);
    expect(r.ok && r.node.created).toBe('2026-01-01T00:00:00Z');
  });

  it('defaults missing fields and reports them', () => {
    const r = parseNodeFile(`---\nid: ${A}\n---\nHi\n`);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.node).toEqual({ id: A, role: 'user', parents: [], created: isoTimestamp(decodeTime(A)), summary: '', topics: [], body: 'Hi' });
    expect(r.defaulted.sort()).toEqual(['created', 'parents', 'role', 'summary', 'topics']);
    expect(r.canvas).toBeUndefined();
  });

  it('normalises a scalar parents value to an array', () => {
    const r = parseNodeFile(`---\nid: ${A}\nrole: user\nparents: ${B}\ncreated: x\nsummary: s\ntopics: []\n---\n`);
    expect(r.ok && r.node.parents).toEqual([B]);
    expect(r.ok && r.defaulted).toEqual(['parents']);
  });

  it('fails without frontmatter', () => {
    expect(parseNodeFile('# Just a note\n')).toEqual({ ok: false, reason: 'no frontmatter block' });
  });

  it('fails on invalid YAML', () => {
    const r = parseNodeFile('---\nid: [unclosed\n---\n');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/^invalid YAML/);
  });

  it('fails on a missing or invalid id', () => {
    expect(parseNodeFile('---\nrole: user\n---\n')).toEqual({ ok: false, reason: 'missing or invalid id' });
    expect(parseNodeFile('---\nid: nope\n---\n')).toEqual({ ok: false, reason: 'missing or invalid id' });
  });

  it('fails when frontmatter is not a mapping', () => {
    expect(parseNodeFile('---\n- a\n- b\n---\n')).toEqual({ ok: false, reason: 'frontmatter is not a mapping' });
  });
});

describe('normalizers', () => {
  it('normalizeBody', () => {
    expect(normalizeBody('\n \n x \n\n')).toBe(' x');
    expect(normalizeBody('')).toBe('');
  });
  it('normalizeSummary', () => {
    expect(normalizeSummary(' a \n b ')).toBe('a b');
  });
});

// --- property tests -------------------------------------------------------

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ulidArb = fc.array(fc.constantFrom(...CROCKFORD), { minLength: 26, maxLength: 26 }).map((cs) => cs.join(''));
const createdArb = fc.integer({ min: 0, max: 4_102_444_800_000 }).map(isoTimestamp);
const roleModelArb = fc.oneof(
  fc.record({ role: fc.constant<'user'>('user') }),
  fc.record({ role: fc.constant<'assistant'>('assistant'), model: fc.string({ minLength: 1 }) }),
);
const nodeArb: fc.Arbitrary<MessageNode> = fc
  .record({
    id: ulidArb,
    parents: fc.array(ulidArb, { maxLength: 3 }),
    created: createdArb,
    summary: fc.string(),
    topics: fc.array(fc.string({ minLength: 1 }), { maxLength: 3 }),
    body: fc.array(fc.string(), { maxLength: 5 }).map((lines) => lines.join('\n')),
  })
  .chain((base) => roleModelArb.map((rm) => ({ ...base, ...rm })));

function canonical(n: MessageNode): MessageNode {
  return { ...n, summary: normalizeSummary(n.summary), body: normalizeBody(n.body) };
}

describe('round-trip properties', () => {
  it('parse(serialize(n)) equals the canonical form of n', () => {
    fc.assert(
      fc.property(nodeArb, (n) => {
        const r = parseNodeFile(serializeNodeFile(n, 'c'));
        expect(r).toEqual({ ok: true, node: canonical(n), canvas: 'c', defaulted: [] });
      }),
    );
  });

  it('serialize is idempotent under parse', () => {
    fc.assert(
      fc.property(nodeArb, (n) => {
        const once = serializeNodeFile(n, 'c');
        const r = parseNodeFile(once);
        if (!r.ok) throw new Error(r.reason);
        expect(serializeNodeFile(r.node, 'c')).toBe(once);
      }),
    );
  });
});
