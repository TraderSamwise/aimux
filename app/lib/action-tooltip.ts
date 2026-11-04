import { Platform } from "react-native";

/**
 * Whether this build should put a hover label on a control at all.
 *
 * Hover is a pointer idea. On a touch build the accessibility label is
 * already the whole story, and a tooltip there would have no way to be
 * dismissed.
 */
export function shouldApplyNativeTooltip(platform: string = Platform.OS): boolean {
  return platform === "web";
}

/**
 * A hover label the BROWSER draws, not us.
 *
 * A tooltip rendered inside the tree cannot be made to work here. Measured on
 * the agent action row: the buttons sit under an ancestor with
 * `overflow: auto hidden`, which clips on the vertical axis, so a label
 * placed above or below is cut off whatever z-index it carries -- and that
 * same ancestor is transformed, which makes it the containing block for
 * `position: fixed`, so escaping that way does not work either. Every
 * react-native-web View is its own stacking context, so the tooltip's own
 * z-index never reaches past its button.
 *
 * `title` sidesteps all of it: the browser paints it in its own chrome,
 * outside the document, where no ancestor can clip or cover it. The costs
 * are real and accepted -- no styling, and the browser's own delay before it
 * appears. react-native-web does not forward `title`, hence the ref.
 *
 * A REF CALLBACK, deliberately, not a hook. The first version used `useRef`
 * and `useEffect`, which broke nine tests in `agent-start.test.tsx`: that
 * suite calls components as plain functions, so there is no React dispatcher
 * and any hook throws. A callback is an ordinary prop and needs none. It also
 * runs at the moment the node is attached, which is exactly when the
 * attribute can be set.
 */
export function nativeTooltipRef(label: string) {
  return (node: unknown) => {
    if (!shouldApplyNativeTooltip()) return;
    const element = node as { setAttribute?: (name: string, value: string) => void } | null;
    element?.setAttribute?.("title", label);
  };
}
