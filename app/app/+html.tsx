import { ScrollViewStyleReset } from "expo-router/html";
import type { PropsWithChildren } from "react";

/// The viewport the composer's keyboard detection depends on.
///
/// `interactive-widget=resizes-visual` is the spec default, but which viewport
/// a browser shrinks for a soft keyboard has historically been the UA's choice,
/// and `lib/hardware-keyboard.ts` reads the gap between the visual and layout
/// viewports to find one. Declaring it makes that gap ours rather than the
/// default's: without it, a browser that shrinks the layout viewport too leaves
/// no gap, and Enter would send on a phone and eat the line break.
export const VIEWPORT_CONTENT =
  "width=device-width, initial-scale=1, shrink-to-fit=no, interactive-widget=resizes-visual";

export default function Root({ children }: PropsWithChildren) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta name="viewport" content={VIEWPORT_CONTENT} />
        <ScrollViewStyleReset />
      </head>
      <body>{children}</body>
    </html>
  );
}
