/**
 * How large an attachment may be, as the project service defines it.
 *
 * This number is `MAX_ATTACHMENT_BYTES` in
 * `native/crates/aimux-core/src/attachment_uploader.rs`, and
 * `attachment-limits.cross-surface.test.ts` reads it out of that file and
 * fails if the two drift. It is duplicated rather than fetched because the
 * check has to run before the upload — asking the service how large a file
 * may be, by making a request, is the round trip this exists to avoid.
 *
 * Nothing used to check it. A photo was uploaded whole and the service
 * answered `body exceeds 1048576 bytes`, which is a byte count rather than an
 * answer, and the limit it named was not the limit the service meant: the
 * policy said 10 MB and a flat body cap rejected at about 786 KB of image,
 * under any phone photo.
 */
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

function formatMegabytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  // One decimal below 10 MB, none above: "0.8 MB" is useful, "12.0 MB" is not.
  return mb < 10 ? `${mb.toFixed(1)} MB` : `${Math.round(mb)} MB`;
}

export function attachmentExceedsLimit(sizeBytes: number | undefined): boolean {
  return typeof sizeBytes === "number" && sizeBytes > ATTACHMENT_MAX_BYTES;
}

/**
 * What to say about a file that is too large.
 *
 * Names the file, its size and the limit, because "too large" without a
 * number is the guessing this is meant to remove.
 */
export function attachmentTooLargeMessage(input: { filename: string; sizeBytes: number }): string {
  return `${input.filename} is ${formatMegabytes(input.sizeBytes)}. Attachments can be up to ${formatMegabytes(
    ATTACHMENT_MAX_BYTES,
  )}.`;
}

/**
 * The first attachment that is too large, or null when they all fit.
 *
 * Checked over the whole set before any upload starts: the send loop uploads
 * one at a time inside the send's `try`, so a rejection partway through
 * abandons the send with some files already on the service.
 */
export function firstOversizedAttachment<T extends { filename: string; sizeBytes?: number }>(
  attachments: readonly T[],
): T | null {
  return attachments.find((attachment) => attachmentExceedsLimit(attachment.sizeBytes)) ?? null;
}
