import { LOCAL_MODE, type useUser } from "@/lib/auth";

export type AimuxUser = ReturnType<typeof useUser>["user"];

export function primaryEmailFromUser(user: AimuxUser): string {
  if (!user) return LOCAL_MODE ? "local" : "Signed in";
  return (
    user.primaryEmailAddress?.emailAddress ?? user.emailAddresses?.[0]?.emailAddress ?? "Signed in"
  );
}
