import React from "react";
import { AlertTriangle, CheckCircle2, Info } from "lucide-react-native";
import { Toaster, toast } from "sonner-native";

import { useSafeAreaInsets } from "react-native-safe-area-context";

import { resolveToastTopOffset } from "@/lib/native-safe-area";
import {
  type AppToastOptions,
  TOAST_POSITION,
  toastPalette,
  type ToastTheme,
} from "@/lib/toast-theme";

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
  const insets = useSafeAreaInsets();
  return (
    <Toaster
      theme={theme}
      position={TOAST_POSITION}
      offset={resolveToastTopOffset(insets.top)}
      visibleToasts={3}
      // An error shows for eight seconds and can land over a screen's top bar,
      // so it has to be dismissible rather than something to wait out. Web
      // already had this.
      closeButton
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
