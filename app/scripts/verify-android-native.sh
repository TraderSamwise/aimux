#!/usr/bin/env bash
# Compiles the Android native half against the real React Native classpath.
#
# The repo tracks no .kt files: `app/plugins/android` sources reach a build only
# through the config plugin, which runs at prebuild. So the only honest gate is
# to prebuild and compile, and `android/` is gitignored output either way.
set -euo pipefail

cd "$(dirname "$0")/.."

# Gradle 8.14 supports JDK 17-24; Android Studio's bundled JBR is 25.
JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@21}"
ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export JAVA_HOME ANDROID_HOME

for required in "$JAVA_HOME/bin/javac" "$ANDROID_HOME/platform-tools"; do
  if [ ! -e "$required" ]; then
    echo "verify-android-native: missing $required" >&2
    echo "A JDK 17-24 and the Android SDK are both needed to compile the" >&2
    echo "Android native half. Set JAVA_HOME / ANDROID_HOME to override." >&2
    exit 1
  fi
done

# An inherited JAVA_HOME outside Gradle 8.14's range fails deep in the build
# with "Unable to locate a Java Runtime", which names neither the version nor
# this file. Say it here instead.
java_major="$("$JAVA_HOME/bin/javac" -version 2>&1 | sed -n 's/^javac \([0-9]*\).*/\1/p')"
if [ -z "$java_major" ] || [ "$java_major" -lt 17 ] || [ "$java_major" -gt 24 ]; then
  echo "verify-android-native: JAVA_HOME is JDK ${java_major:-unknown}" >&2
  echo "Gradle 8.14 supports 17-24. Android Studio's bundled JBR is 25, so it" >&2
  echo "cannot run this build; /opt/homebrew/opt/openjdk@21 can." >&2
  exit 1
fi

echo "verify-android-native: prebuilding android (generated, gitignored)"
yarn expo prebuild -p android --no-install

# Debug rather than release: the Kotlin is identical across variants and this
# skips R8. Compile only -- packaging would want a signing config we do not have.
echo "verify-android-native: compiling kotlin"
cd android
./gradlew :app:compileDebugKotlin --console=plain "$@"
