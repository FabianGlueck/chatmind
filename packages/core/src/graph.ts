/**
 * Browser-safe entry (`@chatmind/core/graph`): pure graph logic only. Nothing here may import `node:*`
 * or the vault modules — the web app runs this code on a CanvasDto (spec M4 §4.1).
 */
export type { NodeId, Role, Layout, MessageNode, CanvasGraph, Repair, TopicMemory } from './types';
export type { NodeDto, EdgeDto, MemoryDto, CanvasDto, CanvasSummaryDto, LinkDto, LinksDto, ModelDto, SendRequest, Provider } from './dto';
export { type NodeLike, type GraphLike, graphLikeFromDto } from './graph-like';
export { NODE_WIDTH, NODE_HEIGHT, NODE_GAP, placeChild, placeAt, placeNear, densestStrand, childrenOf, rootsOf, subtreeExtentRight, rectsOverlap, moveNodes } from './layout';
export { turnOf, deleteSet, spliceOut } from './delete';
export { compressionSections, subtreeIds, maxCompressedTurns, MIN_COMPRESS_TURNS, FOLD_MAX_TURNS, type Turn, type Section } from './compress';
export { strandOf, rememberPath, type StrandItem } from './strand';
export { nodeTitle } from './title';
export { SYSTEM_PROMPT, PREAMBLE, ROLE_LABELS, NOTE_HEADER, ancestorChain, isAncestor, contextSet, structuralNeighbours, validateTargets, buildContext, blockLabels, systemWithMemories, type ContextMemory, type ContextMessage, type ContextSet, type ContextSegment, type BuiltContext } from './context';
export { detectLanguage, type Language } from './language';
export { OUTPUT_RESERVE, estimateTokens, bodyTokens, promptTokens, budgetFor, formatTokens } from './tokens';
export { ATTACHMENTS_DIR, MAX_IMAGES, MAX_IMAGE_BYTES, IMAGE_TOKENS, IMAGE_TYPES, isAttachmentName, attachmentType, attachmentEmbed, attachmentsIn, splitAttachments, replaceAttachments, type AttachmentPart } from './attachments';
export { topicKey } from './topic-key';
export { MAX_BODY_CHARS, MAX_NOTE_CHARS } from './note';
export { EDIT_HEADER, EDIT_ROLE, MAX_SUMMARY_CHARS, buildEditContext, cleanRewrite, cleanSummaryInput } from './edit';
