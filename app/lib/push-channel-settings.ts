import type { NotificationSettings } from "@/lib/notification-settings";
import {
  registerSecurityPushToken,
  type PushRegistrationResult,
  type PushRegistrationOptions,
} from "@/lib/push-registration";
import { getErrorMessage } from "@/lib/request-errors";

export interface PushChannelDisableInput {
  notificationSettings: NotificationSettings;
  relayUrl?: string;
  getToken: () => Promise<string | null>;
  ownerUserId?: string;
  shareId?: string;
  registerPushToken?: typeof registerSecurityPushToken;
}

export type PushChannelDisableResult =
  | { status: "disabled"; notificationSettings: NotificationSettings; message: "Off" }
  | { status: "failed"; notificationSettings: null; message: string };

export async function resolvePushChannelDisable({
  notificationSettings,
  relayUrl,
  getToken,
  ownerUserId,
  shareId,
  registerPushToken = registerSecurityPushToken,
}: PushChannelDisableInput): Promise<PushChannelDisableResult> {
  if (relayUrl) {
    let result: PushRegistrationResult;
    try {
      result = await registerPushToken(relayUrl, getToken, {
        ownerUserId,
        shareId,
        agentAlerts: false,
      } satisfies PushRegistrationOptions);
    } catch (err) {
      return {
        status: "failed",
        notificationSettings: null,
        message: `Could not turn push off: ${getErrorMessage(err)}`,
      };
    }
    if (result.status !== "registered") {
      return {
        status: "failed",
        notificationSettings: null,
        message: pushDisableFailureMessage(result),
      };
    }
  }

  return {
    status: "disabled",
    notificationSettings: {
      ...notificationSettings,
      channels: {
        ...notificationSettings.channels,
        push: false,
      },
    },
    message: "Off",
  };
}

function pushDisableFailureMessage(
  result: Exclude<PushRegistrationResult, { status: "registered" }>,
) {
  switch (result.status) {
    case "missing_auth":
      return "Sign in required to turn push off";
    case "permission_denied":
      return "Permission required to turn push off";
    case "unsupported":
      return "Push is not supported on this device";
  }
}
