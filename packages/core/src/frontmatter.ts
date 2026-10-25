import { DEFAULT_SCALAR_STYLE_RULES, dump, JSON_SCHEMA, load, SCALAR_STYLE, type DumpOptions, type ScalarStyleRule } from 'js-yaml';
import { decodeTime } from 'ulid';
import { isUlid, isoTimestamp } from './ids';
import type { MessageNode, NodeId, Role } from './types';

export type ParseResult =
  | { ok: true; node: MessageNode; canvas: string | undefined; defaulted: string[] }
  | { ok: false; reason: string };

/** Strip leading blank lines and trailing whitespace; the body never carries either. */
export function normalizeBody(body: string): string {
  return body.replace(/^(?:[ \t]*\n)+/, '').replace(/\s+$/, '');
}

/** A summary is one line: collapse all whitespace runs to a single space. */
export function normalizeSummary(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * js-yaml 5's default rules render an empty string as a bare (blank) scalar
 * rather than `''`. It still round-trips (JSON_SCHEMA's fallback resolves a
 * blank plain scalar back to `''`, not `null`), but an explicitly empty
 * summary should stay visibly quoted in the file. Append a rule that quotes
 * only the empty string, leaving every other plain-scalar decision alone.
 */
const quoteEmptyString: ScalarStyleRule = (layout) => {
  if (layout.style === SCALAR_STYLE.PLAIN && layout.node.value === '') {
    layout.style = SCALAR_STYLE.SINGLE_QUOTED;
  }
};

const DUMP_OPTIONS: DumpOptions = {
  schema: JSON_SCHEMA,
  flowLevel: 1, // top-level mapping in block style, arrays inside it in flow style
  lineWidth: -1, // never fold long strings
  noRefs: true,
  scalarStyleRules: [...Object.values(DEFAULT_SCALAR_STYLE_RULES), quoteEmptyString],
};

export function serializeNodeFile(node: MessageNode, canvasSlug: string): string {
  // Insertion order is the canonical key order (spec §8.1).
  const data: Record<string, unknown> = { id: node.id, canvas: canvasSlug, role: node.role };
  if (node.role === 'assistant' && node.model !== undefined) data.model = node.model;
  data.parents = node.parents;
  data.created = node.created;
  data.summary = normalizeSummary(node.summary);
  data.topics = node.topics;

  const body = normalizeBody(node.body);
  const header = `---\n${dump(data, DUMP_OPTIONS)}---\n`;
  return body === '' ? header : `${header}\n${body}\n`;
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---(?:\n|$)/;

export function parseNodeFile(rawText: string): ParseResult {
  const text = rawText.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const match = FRONTMATTER_RE.exec(text);
  if (!match) return { ok: false, reason: 'no frontmatter block' };

  let data: unknown;
  try {
    data = load(match[1] ?? '', { schema: JSON_SCHEMA });
  } catch (err) {
    return { ok: false, reason: `invalid YAML: ${(err as Error).message}` };
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { ok: false, reason: 'frontmatter is not a mapping' };
  }
  const fm = data as Record<string, unknown>;
  if (!isUlid(fm.id)) return { ok: false, reason: 'missing or invalid id' };
  const id = fm.id;
  const defaulted: string[] = [];

  let role: Role = 'user';
  if (fm.role === 'user' || fm.role === 'assistant' || fm.role === 'note') role = fm.role;
  else defaulted.push('role');

  let parents: NodeId[];
  if (Array.isArray(fm.parents)) parents = fm.parents.map(String);
  else {
    parents = fm.parents == null ? [] : [String(fm.parents)];
    defaulted.push('parents');
  }

  let created: string;
  if (typeof fm.created === 'string') created = fm.created;
  else {
    created = isoTimestamp(decodeTime(id));
    defaulted.push('created');
  }

  let summary: string;
  if (typeof fm.summary === 'string') summary = fm.summary;
  else if (fm.summary == null) {
    summary = '';
    defaulted.push('summary');
  } else summary = String(fm.summary);

  let topics: string[];
  if (Array.isArray(fm.topics)) topics = fm.topics.map(String);
  else {
    topics = [];
    defaulted.push('topics');
  }

  const node: MessageNode = { id, role, parents, created, summary, topics, body: normalizeBody(text.slice(match[0].length)) };
  if (typeof fm.model === 'string') node.model = fm.model;
  const canvas = typeof fm.canvas === 'string' ? fm.canvas : undefined;
  return { ok: true, node, canvas, defaulted };
}
