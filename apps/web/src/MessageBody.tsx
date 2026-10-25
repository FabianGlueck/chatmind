import { isAttachmentName, replaceAttachments } from '@chatmind/core/graph';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { attachmentUrl } from './api';

const ATTACHMENT_SRC = /^\/api\/canvases\/[^/]+\/attachments\/([^/]+)$/;

/**
 * A message body as GFM Markdown. LLM output is untrusted: an image never pulls a remote URL — its alt text shows
 * instead. Only chatmind's own attachment embeds (`![[<ULID>.png]]`, spec M13) render as images.
 */
export function MessageBody({ text, slug }: { text: string; slug: string }) {
  const md = replaceAttachments(text, (name) => `![${name}](${attachmentUrl(slug, name)})`);
  return (
    <Markdown remarkPlugins={[remarkGfm]} components={{
      img: ({ alt, src }) => {
        const name = typeof src === 'string' ? ATTACHMENT_SRC.exec(src)?.[1] : undefined;
        return name !== undefined && isAttachmentName(name) ? <a href={src} target="_blank" rel="noreferrer"><img className="attachment" src={src} alt={alt ?? ''} loading="lazy" /></a> : <>{alt}</>;
      },
    }}>{md}</Markdown>
  );
}
