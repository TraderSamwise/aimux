import { Redirect } from "expo-router";
import { LOCAL_MODE, useAuth } from "@/lib/auth";

export default function RootIndex() {
  const { isSignedIn, isLoaded } = useAuth();
  if (!isLoaded) return null;
  if (isSignedIn || LOCAL_MODE) return <Redirect href="/(main)" />;
  return <Redirect href="/landing" />;
}
