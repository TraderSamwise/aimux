/**
 * The attachment block, recovered from a pane that wrapped it.
 *
 * A message carrying attachments arrives as `Attached files:` followed by one
 * `- name (mime, n bytes): path` line each. tmux wraps at its own width, and
 * when the wrap lands inside the path itself — `.aimux/attach⏎ments/att_…` —
 * the line-based readers see nothing at all. Squashing the whitespace out puts
 * the id back together, and the item's own metadata survives with it, because
 * neither a mime type nor a byte count contains a space.
 *
 * This lives on its own because two parsers read that block — `agent-transcript`
 * here and `transcript-view` in the app — and they carried a copy each. The
 * copies drifted where it could not be seen: one recovered the mime type and
 * one did not, so an image whose path had wrapped came back from that one as a
 * generic file, and a client that draws only images drew nothing.
 *
 * Squashing loses one thing it needs, which is where the spaces were. So the
 * map back to the original is kept and consulted: it is the difference between
 * the hyphen that starts a list item and the one inside `after-css.png`, and
 * between the `.png` that ends a path and the sentence that followed it.
 */

/** Shared so a caller's own item pattern cannot drift from this one. */
export const ATTACHMENT_MIME_PATTERN = "[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+";

/**
 * One attachment, as much of it as survived.
 *
 * `filename` comes back with its spaces gone — squashing is what recovered the
 * id, and it cannot be selective. It is still worth returning: the extension is
 * intact, and that is what tells a client this is a picture when the metadata
 * is missing too.
 */
export interface RecoveredAttachment {
  attachmentId: string;
  filename?: string;
  mimeType?: string;
}

/** What is left of the message once the attachment items are lifted out of it. */
export interface RecoveredAttachmentText {
  attachments: RecoveredAttachment[];
  prose: string;
}

const ATTACHMENT_DIR = ".aimux/attachments/";
const ATTACHMENT_PATH = /\.aimux\/attachments\/(att_[A-Za-z0-9_-]+)/g;
const METADATA = new RegExp(`\\((${ATTACHMENT_MIME_PATTERN}),\\d+bytes\\):`, "g");
const PATH_CHAR = /[A-Za-z0-9_\-./~]/;
const TRAILING_PATH_CHAR = /[A-Za-z0-9.]/;
const BULLET = /[-•]/;
/**
 * How far in front of a path its own metadata may sit — the whole directory
 * prefix, in other words. Bounded so this stays linear in the message length.
 */
const METADATA_WINDOW = 1024;

/**
 * Pull the attachments out of the text that follows an `Attached files:` header.
 *
 * Returns null when there is nothing in it that looks like an attachment path,
 * so a caller can fall back to treating the whole thing as prose.
 */
export function recoverWrappedAttachments(tail: string): RecoveredAttachmentText | null {
  // Squash to find the ids, but keep a map back to the original so each item
  // can be *removed* exactly rather than guessed at. Leaving it in would put
  // `/srv/…/.aimux/attachments/att_….png` in somebody's chat; dropping the
  // whole tail would eat any words that came after it.
  let squashed = "";
  const sourceIndex: number[] = [];
  for (let index = 0; index < tail.length; index += 1) {
    if (/\s/.test(tail[index]!)) continue;
    squashed += tail[index];
    sourceIndex.push(index);
  }

  /** Were these two characters neighbours before the whitespace came out? */
  const adjacent = (index: number) => index > 0 && sourceIndex[index]! === sourceIndex[index - 1]! + 1;

  /**
   * A bullet that opened a list item, rather than a hyphen inside a word.
   *
   * Space on both sides of it. One is not enough: a wrap landing in front of
   * `grand-console` gives that hyphen a space before it, and reading it as a
   * bullet stops the walk mid-path — which is the same lost mime type this
   * function exists to recover.
   */
  const bulletAt = (index: number) => BULLET.test(squashed[index]!) && !adjacent(index) && !adjacent(index + 1);

  const hasBulletIn = (from: number, to: number) => {
    for (let index = from; index < to; index += 1) if (bulletAt(index)) return true;
    return false;
  };

  /** The nearest `(mime, n bytes):` in front of a path, if there is one. */
  const lastMetadataBefore = (text: string, pathStart: number) => {
    const windowStart = Math.max(0, pathStart - METADATA_WINDOW);
    const window = text.slice(windowStart, pathStart);
    let last = null;
    METADATA.lastIndex = 0;
    for (const found of window.matchAll(METADATA)) {
      if (found.index === undefined || !found[1]) continue;
      last = {
        mimeType: found[1],
        start: windowStart + found.index,
        end: windowStart + found.index + found[0].length,
      };
    }
    return last;
  };

  const attachments: RecoveredAttachment[] = [];
  const drop = new Set<number>();

  for (const match of squashed.matchAll(ATTACHMENT_PATH)) {
    if (!match[1] || match.index === undefined) continue;

    // Forward over the extension, but only through characters that were not
    // separated from the id to begin with. Without that, `att_x.png and tell
    // me` squashes to `att_x.pngandtellme` and an extension pattern helps
    // itself to the sentence — the old one took eight characters of it.
    //
    // A wrap landing inside the extension itself leaves its tail in the prose.
    // Two stray characters read as a typo; a swallowed sentence reads as a bug.
    let end = match.index + match[0].length;
    while (end < squashed.length && adjacent(end) && TRAILING_PATH_CHAR.test(squashed[end]!)) end += 1;

    // Back to this item's own `(mime, n bytes):`, and take everything between
    // it and the path with us. Anchoring on the metadata rather than walking
    // back over path-shaped characters is the difference between a directory
    // named `grand-console` and one named `my+proj` or `josé` — a charset can
    // always be wrong about somebody's filesystem, and being wrong here loses
    // the mime type and leaves half a path in the chat.
    const recovered: RecoveredAttachment = { attachmentId: match[1] };
    const metadata = lastMetadataBefore(squashed, match.index);
    // Between the metadata and the path there may be a directory prefix and
    // nothing else. Another item's bullet, or another attachment's path, means
    // the metadata belongs to that item — and a path with none of its own must
    // go without rather than borrow. Borrowing does not just mislabel the
    // kind: the filename it takes is everything in between, so a bare path
    // mentioned in a sentence came back labelled with the whole line above it.
    const ownMetadata =
      metadata &&
      !hasBulletIn(metadata.end, match.index) &&
      !squashed.slice(metadata.end, match.index).includes(ATTACHMENT_DIR)
        ? metadata
        : null;

    let start = match.index;
    if (ownMetadata) {
      recovered.mimeType = ownMetadata.mimeType;
      // Back to the bullet, so the filename comes with the mime type and the
      // whole item leaves the prose together.
      let bullet = ownMetadata.start;
      while (bullet > 0 && !bulletAt(bullet - 1)) bullet -= 1;
      const filename = squashed.slice(bullet, ownMetadata.start);
      if (bullet > 0 && filename) recovered.filename = filename;
      start = bullet > 0 ? bullet - 1 : ownMetadata.start;
    } else {
      // No metadata to anchor to, so fall back to taking what looks like a
      // path. This is the shape `Viewed Image` produces, where there never was
      // any metadata to find.
      while (start > 0 && PATH_CHAR.test(squashed[start - 1]!) && !bulletAt(start - 1)) start -= 1;
    }

    attachments.push(recovered);
    for (let index = start; index < end; index += 1) drop.add(sourceIndex[index]!);
  }

  if (attachments.length === 0) return null;

  const prose = tail
    .split("")
    .filter((_, index) => !drop.has(index))
    .join("")
    // What is left of a list item once the item itself is gone.
    .replace(/[-•]\s*(?=\s|$)/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return { attachments, prose };
}
