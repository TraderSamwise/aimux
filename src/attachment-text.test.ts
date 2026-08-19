import { describe, expect, it } from "vitest";

import { recoverWrappedAttachments } from "./attachment-text.js";

/**
 * What reaches this function in production.
 *
 * Both callers flatten the block first — `text.replace(/\s+/g, " ")` — so a
 * wrap arrives as an ordinary space, indistinguishable from one somebody
 * typed. Writing the fixtures any other way tests a shape that cannot happen:
 * a rule that told a newline from a space was written here once and was dead
 * on arrival for exactly that reason.
 *
 * `column` is where the pane ran out of room. tmux does not aim for a token
 * boundary, so neither does this.
 */
const wrapped = (item: string, column: number) => ` ${item.slice(0, column)} ${item.slice(column)}`;

const IMAGE = "- shot.png (image/png, 46624 bytes): /srv/grand-console/.aimux/attachments/att_one.png";
const inTheWord = IMAGE.indexOf("ments/att_one");

describe("an attachment block a wrap broke", () => {
  it("recovers the mime type, which is what makes a picture a picture", () => {
    const recovered = recoverWrappedAttachments(wrapped(IMAGE, inTheWord));

    expect(recovered?.attachments).toEqual([{ attachmentId: "att_one", filename: "shot.png", mimeType: "image/png" }]);
  });

  it("recovers it wherever the wrap fell, not only inside `attachments`", () => {
    // The path prefix is where it used to fail: the walk back stopped at the
    // wrap, the metadata never anchored, and `/srv/grand-cons` was left in the
    // bubble beside a picture that had become a `[file #1]`.
    for (let column = 30; column < IMAGE.length - 4; column += 1) {
      const recovered = recoverWrappedAttachments(`${wrapped(IMAGE, column)} and tell me what you see`);
      expect(recovered?.attachments[0]).toMatchObject({ attachmentId: "att_one", mimeType: "image/png" });
      expect(recovered?.prose).not.toMatch(/srv|aimux|attachments/);
    }
  });

  it("takes the whole item out of the words, metadata and all", () => {
    const recovered = recoverWrappedAttachments(`${wrapped(IMAGE, inTheWord)} and tell me what you see`);

    // The mime belongs in the part, not in the message. It used to be both.
    expect(recovered?.prose).toBe("and tell me what you see");
  });

  it("keeps two attachments' metadata apart", () => {
    const second = "- notes.pdf (application/pdf, 34 bytes): /srv/x/.aimux/attachments/att_b.pdf";
    const recovered = recoverWrappedAttachments(
      wrapped("- a.png (image/png, 12 bytes): /srv/x/.aimux/attachments/att_a.png", 45) +
        wrapped(second, second.indexOf("ments/att_b")),
    );

    expect(recovered?.attachments).toEqual([
      { attachmentId: "att_a", filename: "a.png", mimeType: "image/png" },
      { attachmentId: "att_b", filename: "notes.pdf", mimeType: "application/pdf" },
    ]);
  });

  it("keeps a hyphen inside a filename out of it", () => {
    const item = "- after-css.png (image/png, 9 bytes): /srv/x/.aimux/attachments/att_h.png";
    const recovered = recoverWrappedAttachments(wrapped(item, item.indexOf("ments/att_h")));

    expect(recovered?.attachments[0]).toEqual({
      attachmentId: "att_h",
      filename: "after-css.png",
      mimeType: "image/png",
    });
  });

  it("returns the id alone when the metadata did not survive with it", () => {
    const recovered = recoverWrappedAttachments("look: /srv/x/.aimux/attach ments/att_bare.png");

    expect(recovered?.attachments).toEqual([{ attachmentId: "att_bare" }]);
  });

  it("does not care what the directory is called", () => {
    // The walk back used to be over a character class, so a project directory
    // holding a `+`, an accent or a bracket ended it early — losing the mime
    // and leaving half a path in the bubble. It anchors on the item's own
    // metadata now, which has no opinion about anybody's filesystem.
    for (const dir of ["/srv/grand-console", "/srv/my+proj", "/srv/josé", "/srv/c++", "/srv/proj(v2)", "/srv/a&b"]) {
      const item = `- shot.png (image/png, 46624 bytes): ${dir}/.aimux/attachments/att_one.png`;
      for (let column = 0; column < item.length; column += 1) {
        const recovered = recoverWrappedAttachments(`${wrapped(item, column)} and tell me`);
        expect(recovered?.attachments[0]).toMatchObject({ attachmentId: "att_one", mimeType: "image/png" });
        expect(recovered?.prose).not.toMatch(/srv|aimux|attachments/);
      }
    }
  });

  it("does not lend one item's metadata to a path mentioned in a sentence", () => {
    // No bullet in between, so only the second guard catches this. Borrowing
    // is worse than it sounds: the filename taken is everything in between, so
    // the bare path came back labelled with the whole line above it.
    const item = "- a.png (image/png, 12 bytes): /srv/x/.aimux/attachments/att_a.png";
    const recovered = recoverWrappedAttachments(`${wrapped(item, 45)} compare /srv/x/.aimux/attach ments/att_b.png`);

    expect(recovered?.attachments[1]).toEqual({ attachmentId: "att_b" });
  });

  it("says nothing rather than guessing, when there is no attachment in it", () => {
    expect(recoverWrappedAttachments("just some words about attachments")).toBeNull();
  });

  it("does not read one item's mime onto the item after it", () => {
    const recovered = recoverWrappedAttachments(
      wrapped("- a.png (image/png, 12 bytes): /srv/x/.aimux/attachments/att_a.png", 45) +
        " - /srv/x/.aimux/attach ments/att_b.bin",
    );

    expect(recovered?.attachments[1]).toEqual({ attachmentId: "att_b" });
  });
});
