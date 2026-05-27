import { Redirect } from "expo-router";
import { LOCAL_MODE, useAuth } from "@/lib/auth";
import { MAIN_TAB_ROUTES } from "@/lib/main-tabs";

export default function RootIndex() {
  const { isSignedIn, isLoaded } = useAuth();
  if (!isLoaded) return null;
  if (isSignedIn || LOCAL_MODE) return <Redirect href={MAIN_TAB_ROUTES.dashboard.internalHref} />;
  return <Redirect href="/landing" />;
}
