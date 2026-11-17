import type { ViewStyle } from "react-native";

/**
 * The layer the top chrome occupies above the page content.
 *
 * Every react-native-web View is `position: relative; z-index: 0`, so each one
 * is its own stacking context and a child's z-index only competes inside its
 * parent. The chrome branch and the content branch are siblings, so whichever
 * carries the higher z-index wins -- and at equal z-index the later sibling in
 * DOM order does, which is the content.
 *
 * `TopBar`'s own `z-30` cannot settle this: it sits one level too deep, inside
 * the branch that is being out-painted.
 */
export const TOP_CHROME_Z_INDEX = 60;

/**
 * Where the top chrome sits, overlaid or not.
 *
 * Both answers carry the layer. Only the overlaid one used to: on a chat the
 * chrome was absolutely positioned with a z-index and the account menu opened
 * over the page, while on the project overview the chrome fell back to a bare
 * `flexShrink` with no z-index and the body painted straight over the open
 * menu. Same chrome, same menu, two different answers about which layer it
 * lives on -- so the layer is stated once here and the overlay decision only
 * chooses the positioning.
 */
export function topChromeLayerStyle(overlaid: boolean): ViewStyle {
  return overlaid
    ? { left: 0, position: "absolute", right: 0, top: 0, zIndex: TOP_CHROME_Z_INDEX }
    : { flexShrink: 0, zIndex: TOP_CHROME_Z_INDEX };
}

/**
 * The layer an open drawer takes, above the chrome.
 *
 * The drawer and its scrim are children of the content branch, and that
 * branch is a stacking context, so their own z-indexes (80 and 90) cannot
 * reach past it. Once the chrome claimed 60 the whole content subtree sat
 * underneath, and the scrim's top 56px went dead: with the drawer open, a tap
 * where the top bar is opened the account menu instead of dismissing the
 * drawer, leaving the drawer over whatever you navigated to next.
 *
 * An open drawer is modal -- it owns the screen until dismissed -- so the
 * branch holding it goes above the chrome for as long as it is open, and
 * drops back the moment it closes. Only while open: this is the same
 * z-index that painted the page body over the account menu.
 */
export const DRAWER_LAYER_Z_INDEX = TOP_CHROME_Z_INDEX + 10;

export function contentLayerStyle(drawerOpen: boolean): ViewStyle {
  return drawerOpen ? { zIndex: DRAWER_LAYER_Z_INDEX } : {};
}
