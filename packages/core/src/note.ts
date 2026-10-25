/** Spec M16 §1, M17 §4: the longest node body the server accepts (≈ 100k tokens), for every role. */
export const MAX_BODY_CHARS = 400_000;
/** Spec M17 §4: the M16 name, kept as an alias. */
export const MAX_NOTE_CHARS = MAX_BODY_CHARS;
