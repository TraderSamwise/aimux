import React from "react";
import { Pressable, ScrollView, View } from "react-native";
import { usePathname, useRouter } from "expo-router";
import { useAtomValue } from "jotai";
import { ChevronLeft, MessageSquare } from "lucide-react-native";
import { Text } from "@/components/ui/text";
import { mergeActiveSharedSessions } from "@/lib/shared-sessions";
import { sharedChatHref, useRouteShare } from "@/lib/use-route-share";
import { cn } from "@/lib/utils";
import { acceptedSharedSessionsAtom, type ActiveSharedSession } from "@/stores/settings";

const SIDEBAR_WIDTH = 320;

function sharedName(share: ActiveSharedSession): string {
  return share.projectRoot.split("/").filter(Boolean).pop() || "Shared chat";
}

export function SharedSidebar() {
  const router = useRouter();
  const pathname = usePathname();
  const shares = useAtomValue(acceptedSharedSessionsAtom);
  const activeShare = useRouteShare();
  const displayedShares = mergeActiveSharedSessions(shares, activeShare);
  const onSharedIndex = pathname === "/shares";

  return (
    <View
      className="border-r border-[#2a2b31] bg-[#161719]"
      style={{ width: SIDEBAR_WIDTH, height: "100%" }}
    >
      <ScrollView className="flex-1">
        <View className="border-b border-[#2a2b31] px-4 py-4">
          {!onSharedIndex ? (
            <Pressable
              accessibilityLabel="All shared chats"
              onPress={() => router.replace("/shares")}
              className="-ml-1 mb-3 flex-row items-center gap-1.5 self-start rounded-md px-1 py-1 hover:bg-[#232429] active:bg-[#26272d]"
            >
              <ChevronLeft size={14} color="#787a83" />
              <Text className="text-[12.5px] font-medium text-[#787a83]">All shared chats</Text>
            </Pressable>
          ) : null}
          <Text className="text-[10px] font-bold uppercase tracking-widest text-[#787a83]">
            Shared
          </Text>
          <Text className="mt-2 text-[18px] font-semibold text-[#edeef0]">Shared chats</Text>
          <Text className="mt-1 text-[12px] text-[#787a83]">Chats shared with this account</Text>
        </View>

        {displayedShares.length === 0 ? (
          <View className="px-4 py-4">
            <Text className="text-[13px] text-[#787a83]">No shared chats</Text>
          </View>
        ) : (
          <View className="py-2">
            {displayedShares.map((share) => {
              const selected =
                activeShare?.ownerUserId === share.ownerUserId &&
                activeShare.shareId === share.shareId;
              return (
                <Pressable
                  key={`${share.ownerUserId}:${share.shareId}`}
                  onPress={() => router.push(sharedChatHref(share))}
                  className={cn(
                    "px-4 py-3",
                    selected ? "bg-[#26272d]" : "hover:bg-[#232429] active:bg-[#26272d]",
                  )}
                >
                  <View className="flex-row items-center gap-2.5">
                    <MessageSquare size={15} color={selected ? "#38bdf8" : "#787a83"} />
                    <Text
                      className="min-w-0 flex-1 text-[14px] font-medium text-[#edeef0]"
                      numberOfLines={1}
                      ellipsizeMode="tail"
                    >
                      {sharedName(share)}
                    </Text>
                    <Text className="font-mono text-[11px] text-[#38bdf8]">shared</Text>
                  </View>
                  <Text
                    className="ml-[25px] mt-0.5 font-mono text-[12px] text-[#787a83]"
                    numberOfLines={1}
                    ellipsizeMode="middle"
                  >
                    {share.sessionId}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        )}
      </ScrollView>
    </View>
  );
}
