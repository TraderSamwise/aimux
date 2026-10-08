import { describe, expect, it } from "vitest";

import * as plugin from "@/plugins/withAimuxNativeAppCommands";

const { patchKeyDispatch, patchPackageRegistration } = plugin as {
  patchKeyDispatch: (contents: string) => string;
  patchPackageRegistration: (contents: string) => string;
};

/// Approximations of the anchors Expo's templates carry. These fixtures pin the
/// PATCHES, not the anchors: `yarn verify:android-native` prebuilds for real and
/// the patches throw when an anchor moves, which is what pins those.
const MAIN_ACTIVITY = `package app.aimux.mobile

import com.facebook.react.ReactActivity

class MainActivity : ReactActivity() {
  override fun getMainComponentName(): String = "main"
}
`;

const MAIN_APPLICATION = `package app.aimux.mobile

class MainApplication : Application() {
  override fun getPackages(): List<ReactPackage> =
      PackageList(this).packages.apply {
        // add(MyReactNativePackage())
      }
}
`;

describe("android native patches", () => {
  it("gives MainActivity the key dispatch that sends", () => {
    // Nothing else can catch this. The Kotlin compiles and every app test
    // passes with these overrides absent, and Android just stops sending.
    const patched = patchKeyDispatch(MAIN_ACTIVITY);
    expect(patched).toContain("override fun dispatchKeyEvent(event: KeyEvent): Boolean");
    expect(patched).toContain("AimuxNativeCommandsModule.commandForKeyEvent(event)");
    // `&& emit(...)`: a key is never swallowed unless something was told.
    expect(patched).toContain("command != null && AimuxNativeCommandsModule.emit(command)");
    expect(patched).toContain("return super.dispatchKeyEvent(event)");
    expect(patched).toContain("import android.view.KeyEvent");
  });

  it("gives MainActivity the attach notice", () => {
    const patched = patchKeyDispatch(MAIN_ACTIVITY);
    expect(patched).toContain("override fun onConfigurationChanged(newConfig: Configuration)");
    expect(patched).toContain("super.onConfigurationChanged(newConfig)");
    expect(patched).toContain("emitHardwareKeyboardChanged(newConfig)");
    expect(patched).toContain("import android.content.res.Configuration");
  });

  it("registers the package", () => {
    expect(patchPackageRegistration(MAIN_APPLICATION)).toContain(
      "add(AimuxNativeCommandsPackage())",
    );
  });

  it("replaces its own older block rather than declining forever", () => {
    // `expo prebuild` reuses an existing `android/`, so a plain re-run patches
    // an already-patched file. A "looks patched" check would then make every
    // later edit to these overrides apply silently never; the generated
    // region's hash is what lets a changed block replace the old one.
    const stale = patchKeyDispatch(MAIN_ACTIVITY).replace(
      "return super.dispatchKeyEvent(event)",
      "return false // from an older version of this plugin",
    );
    const fresh = patchKeyDispatch(stale);
    expect(fresh).toContain("return super.dispatchKeyEvent(event)");
    expect(fresh).not.toContain("from an older version of this plugin");
    expect(fresh.split("override fun dispatchKeyEvent").length - 1).toBe(1);
  });

  it("patches once, because prebuild reuses an existing android directory", () => {
    const twice = patchKeyDispatch(patchKeyDispatch(MAIN_ACTIVITY));
    expect(twice.split("override fun dispatchKeyEvent").length - 1).toBe(1);
    expect(twice.split("import android.view.KeyEvent").length - 1).toBe(1);
    expect(twice.split("@generated begin aimux-native-commands").length - 1).toBe(1);
    const appTwice = patchPackageRegistration(patchPackageRegistration(MAIN_APPLICATION));
    expect(appTwice.split("add(AimuxNativeCommandsPackage())").length - 1).toBe(1);
  });

  it("refuses to patch a template whose anchor moved", () => {
    // A silent skip would compile and never load, so these must throw.
    expect(() => patchKeyDispatch("class MainActivity : ReactActivity() {\n}\n")).toThrow(
      /MainActivity anchor/,
    );
    expect(() => patchPackageRegistration("class MainApplication {\n}\n")).toThrow(
      /MainApplication package anchor/,
    );
  });
});
