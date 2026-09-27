import React from "react";
import { AlertTriangle, CheckCircle2, Info } from "lucide-react-native";
import { Toaster, toast } from "sonner";
import "sonner/dist/styles.css";

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
      position="bottom-center"
      offset={28}
      visibleToasts={3}
      closeButton
      toastOptions={{
        style: {
          background: palette.background,
          border: `1px solid ${palette.border}`,
          borderRadius: 12,
          color: palette.foreground,
        },
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
