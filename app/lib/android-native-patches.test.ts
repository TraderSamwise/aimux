import { describe, expect, it } from "vitest";

import * as plugin from "@/plugins/withAimuxNativeAppCommands";

const { patchKeyDispatch, patchPackageRegistration } = plugin as {
  patchKeyDispatch: (contents: string) => string;
  patchPackageRegistration: (contents: string) => string;
};

/// The anchors Expo's own templates carry, which is what these patch.
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
    expect(patched).toContain("AimuxNativeCommandsModule.emit(command)");
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

  it("patches once, because prebuild reuses an existing android directory", () => {
    const twice = patchKeyDispatch(patchKeyDispatch(MAIN_ACTIVITY));
    expect(twice.split("override fun dispatchKeyEvent").length - 1).toBe(1);
    expect(twice.split("import android.view.KeyEvent").length - 1).toBe(1);
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
