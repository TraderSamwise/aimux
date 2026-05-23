import { atom } from "jotai";
import type { RelayStatus } from "@/lib/relay-transport";

// Mirrors the live RelayTransport status so UI can show a connection indicator.
// Set by the relay lifecycle effect in (main)/_layout.tsx.
export const relayStatusAtom = atom<RelayStatus>("disconnected");

// True when the app is running in relay mode, either by production default or
// EXPO_PUBLIC_AIMUX_CONNECTION_MODE=relay.
export const relayConfiguredAtom = atom<boolean>(false);
