import { describe, expect, it } from 'vitest';
import { attachmentsIn, attachmentType, IMAGE_TOKENS, isAttachmentName, replaceAttachments, splitAttachments } from '../src/attachments';
import { bodyTokens, estimateTokens, promptTokens } from '../src/tokens';

const P = '01JQ7M2V3X4Y5Z6A7B8C9D0E1F.png';
const J = '01JQ7M2V3X4Y5Z6A7B8C9D0E1G.jpg';

describe('attachments (spec M13)', () => {
  it('recognises only ULID-named images', () => {
    expect(isAttachmentName(P)).toBe(true);
    expect(attachmentType(J)).toBe('image/jpeg');
    expect(isAttachmentName('foo.png')).toBe(false);
    expect(isAttachmentName('01JQ7M2V3X4Y5Z6A7B8C9D0E1F.svg')).toBe(false);
    expect(attachmentType('../x.png')).toBeUndefined();
  });
  it('finds embeds in order and ignores other wiki embeds', () => {
    expect(attachmentsIn(`a ![[${P}]] b ![[note]] ![[${J}]] ![[${P}]]`)).toEqual([P, J, P]);
  });
  it('splits text at embeds into interleaved parts', () => {
    expect(splitAttachments(`Look:\n\n![[${P}]]\n![[${J}]]\n\nwhat is it?`)).toEqual([
      { type: 'text', text: 'Look:' }, { type: 'image', name: P }, { type: 'image', name: J }, { type: 'text', text: 'what is it?' },
    ]);
    expect(splitAttachments(`![[${P}]]`)).toEqual([{ type: 'image', name: P }]);
    expect(splitAttachments('plain')).toEqual([{ type: 'text', text: 'plain' }]);
  });
  it('replaces embeds', () => {
    expect(replaceAttachments(`x ![[${P}]]`, () => '🖼')).toBe('x 🖼');
  });
  it('counts an image as IMAGE_TOKENS instead of its embed text', () => {
    expect(bodyTokens(`abc ![[${P}]]`)).toBe(estimateTokens('abc ') + IMAGE_TOKENS);
    expect(promptTokens({ system: '', messages: [{ content: `![[${P}]]` }] })).toBe(IMAGE_TOKENS + 4);
  });
});
