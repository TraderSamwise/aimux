import React from "react";
import { AlertTriangle, CheckCircle2, Info } from "lucide-react-native";
import { Toaster, toast } from "sonner-native";

import { type AppToastOptions, toastPalette, type ToastTheme } from "@/lib/toast-theme";

export const appToast = {
  success(title: string, options?: AppToastOptions) {
    return toast.success(title, options);
  },
  error(title: string, options?: AppToastOptions) {
    return toast.error(title, { duration: 8000, ...options });
  },
  info(title: string, options?: AppToastOptions) {
    return toast.info(title, options);
  },
  warning(title: string, options?: AppToastOptions) {
    return toast.warning(title, options);
  },
  dismiss(id?: string | number) {
    return toast.dismiss(id);
  },
};

export function AppToaster({ theme }: { theme: ToastTheme }) {
  const palette = toastPalette(theme);
  return (
    <Toaster
      theme={theme}
      // Top, not bottom: at the bottom these sit over the agent transcript
      // you are reading, and an error about a project list covered the
      // sentence you were mid-way through. Nothing at the top is content.
      position="top-center"
      offset={28}
      visibleToasts={3}
      toastOptions={{
        style: {
          backgroundColor: palette.background,
          borderColor: palette.border,
          borderWidth: 1,
          borderRadius: 12,
        },
        titleStyle: { color: palette.foreground, fontSize: 14, fontWeight: "600" },
        descriptionStyle: { color: palette.muted, fontSize: 12, lineHeight: 17 },
        error: { borderColor: palette.error },
        warning: { borderColor: palette.warning },
        info: { borderColor: palette.info },
        success: { borderColor: palette.success },
      }}
      icons={{
        success: <CheckCircle2 size={18} color={palette.success} />,
        error: <AlertTriangle size={18} color={palette.error} />,
        warning: <AlertTriangle size={18} color={palette.warning} />,
        info: <Info size={18} color={palette.info} />,
      }}
    />
  );
}
