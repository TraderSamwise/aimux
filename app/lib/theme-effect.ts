import { useEffect } from "react";
import { Appearance, Platform } from "react-native";
import { useAtomValue } from "jotai";
import { colorScheme } from "nativewind";
import { themePreferenceAtom } from "@/stores/settings";

// NativeWind manages the dark class on its own styled components, but the HTML
// root needs explicit toggling so global.css's :root / .dark CSS-variable
// cascade swaps on web.
function applyDocumentClass(scheme: "light" | "dark") {
  if (Platform.OS !== "web") return;
  document.documentElement.classList.toggle("dark", scheme === "dark");
}

export function useThemeEffect() {
  const pref = useAtomValue(themePreferenceAtom);

  useEffect(() => {
    if (pref === "system") {
      const resolved = (Appearance.getColorScheme() ?? "light") as "light" | "dark";
      colorScheme.set(resolved);
      applyDocumentClass(resolved);

      const listener = Appearance.addChangeListener(({ colorScheme: s }) => {
        const next = (s ?? "light") as "light" | "dark";
        colorScheme.set(next);
        applyDocumentClass(next);
      });
      return () => listener.remove();
    } else {
      colorScheme.set(pref);
      applyDocumentClass(pref);
    }
  }, [pref]);
}
