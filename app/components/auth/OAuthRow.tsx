import React from "react";
import { Pressable, View } from "react-native";
import { Apple, Github, Mail } from "lucide-react-native";
import { Text } from "@/components/ui/text";

// Flip to true to enable OAuth. Day-one ships disabled with "Coming soon" copy.
export const OAUTH_ENABLED = false;

type Provider = {
  key: "oauth_apple" | "oauth_google" | "oauth_github";
  label: string;
  Icon: typeof Apple;
};

const PROVIDERS: Provider[] = [
  { key: "oauth_apple", label: "Continue with Apple", Icon: Apple },
  { key: "oauth_google", label: "Continue with Google", Icon: Mail },
  { key: "oauth_github", label: "Continue with GitHub", Icon: Github },
];

export function OAuthRow() {
  return (
    <View className="gap-2">
      {PROVIDERS.map(({ key, label, Icon }) => (
        <Pressable
          key={key}
          disabled={!OAUTH_ENABLED}
          onPress={() => {
            // TODO: when OAUTH_ENABLED, call useSSO().startSSOFlow({ strategy: key }).
            // WebBrowser.maybeCompleteAuthSession() must be called once at the route module top.
          }}
          className="h-11 flex-row items-center justify-center rounded-lg border border-border bg-background opacity-50"
        >
          <Icon size={16} color="hsl(var(--foreground))" />
          <Text className="ml-2 text-sm font-medium text-foreground">{label}</Text>
          {!OAUTH_ENABLED ? (
            <Text className="ml-2 text-[11px] uppercase tracking-wider text-muted-foreground">
              soon
            </Text>
          ) : null}
        </Pressable>
      ))}
    </View>
  );
}
