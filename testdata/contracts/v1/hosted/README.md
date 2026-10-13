# Hosted config contracts

Captured from the Node hosted-config normalizer and used as parity gates for
the Rust one. The generator source (`src/full/hosted-config.test.ts`) was
deleted with the rest of the Node tree, so these files are the record.

## Recorded divergences

`config.json` was re-recorded on 2026-10-13: `maxAttachmentBytes` went from
`14680064` (14 MiB) to `13989208` in all 19 cases.

Node picked 14 MiB for the relay by hand, and the project service it proxies
to allowed an effective 786 KB of image — the relay said yes to an upload the
service behind it then refused. The number is now derived from the service's
own `MAX_ATTACHMENT_BYTES` (`project_service/attachments.rs`) as the base64
expansion plus envelope, so the relay and the service cannot disagree about
how large an attachment may be. It is smaller than Node's figure, so nothing
that was accepted before is refused now except uploads the service was always
going to reject.

This is a deliberate divergence from the Node capture, which recorded a number
nothing else agreed with.
