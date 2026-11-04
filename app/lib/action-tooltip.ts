import { useEffect, useRef } from "react";
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
 * outside the document, where no ancestor can clip or cover it. The costs are
 * real and accepted -- no styling, and the browser's own delay before it
 * appears -- and in exchange it works on every surface the button appears on
 * without us owning a tooltip layer.
 *
 * react-native-web does not forward `title` (it is not in its forwarded-prop
 * list), hence the ref rather than a prop.
 */
export function useNativeTooltip<T>(label: string) {
  const ref = useRef<T | null>(null);

  useEffect(() => {
    if (!shouldApplyNativeTooltip()) return;
    const node = ref.current as { setAttribute?: (name: string, value: string) => void } | null;
    node?.setAttribute?.("title", label);
  }, [label]);

  return ref;
}
