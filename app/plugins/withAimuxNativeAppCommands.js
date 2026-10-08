const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const {
  AndroidConfig,
  IOSConfig,
  withAppDelegate,
  withDangerousMod,
  withMainActivity,
  withMainApplication,
} = require("@expo/config-plugins");

const SWIFT_FILE = "AimuxNativeCommands.swift";
const BRIDGE_FILE = "AimuxNativeCommands.m";
const KOTLIN_FILES = ["AimuxNativeCommandsModule.kt", "AimuxNativeCommandsPackage.kt"];
const PACKAGE_ANCHOR = "// add(MyReactNativePackage())";
const PACKAGE_REGISTRATION = "add(AimuxNativeCommandsPackage())";
const ACTIVITY_ANCHOR = '  override fun getMainComponentName(): String = "main"';

function withNativeCommandSourceFiles(config) {
  const swiftContents = fs.readFileSync(path.join(__dirname, "ios", SWIFT_FILE), "utf8");
  const bridgeContents = fs.readFileSync(path.join(__dirname, "ios", BRIDGE_FILE), "utf8");

  config = IOSConfig.XcodeProjectFile.withBuildSourceFile(config, {
    filePath: SWIFT_FILE,
    contents: swiftContents,
    overwrite: true,
  });

  return IOSConfig.XcodeProjectFile.withBuildSourceFile(config, {
    filePath: BRIDGE_FILE,
    contents: bridgeContents,
    overwrite: true,
  });
}

function patchWindowClass(contents) {
  return contents.replace(
    "window = UIWindow(frame: UIScreen.main.bounds)",
    "window = AimuxWindow(frame: UIScreen.main.bounds)",
  );
}

function patchMenu(contents) {
  const menuMethod = `
  public override func buildMenu(with builder: UIMenuBuilder) {
    super.buildMenu(with: builder)

    let zoomMenu = UIMenu(
      title: "App Zoom",
      options: .displayInline,
      children: [
        UIKeyCommand(
          title: "Zoom In",
          image: nil,
          action: #selector(UIApplication.aimuxDesktopZoomIn(_:)),
          input: "+",
          modifierFlags: .command,
          propertyList: nil
        ),
        UIKeyCommand(
          title: "Zoom Out",
          image: nil,
          action: #selector(UIApplication.aimuxDesktopZoomOut(_:)),
          input: "-",
          modifierFlags: .command,
          propertyList: nil
        ),
        UIKeyCommand(
          title: "Actual Size",
          image: nil,
          action: #selector(UIApplication.aimuxDesktopZoomReset(_:)),
          input: "0",
          modifierFlags: .command,
          propertyList: nil
        ),
      ]
    )
    builder.insertChild(zoomMenu, atStartOfMenu: .view)

    let chatMenu = UIMenu(
      title: "Chat",
      options: .displayInline,
      children: [
        UIKeyCommand(
          title: "Interrupt Agent",
          image: nil,
          action: #selector(UIApplication.aimuxChatInterrupt(_:)),
          input: UIKeyCommand.inputEscape,
          modifierFlags: [],
          propertyList: nil
        ),
      ]
    )
    builder.insertChild(chatMenu, atStartOfMenu: .edit)
  }
`;

  const anchor = "  // Linking API";
  if (!contents.includes(anchor)) {
    throw new Error("Could not find AppDelegate Linking API anchor for Aimux menu patch");
  }
  if (contents.includes("aimuxDesktopZoomIn")) {
    return contents.replace(
      /  public override func buildMenu\(with builder: UIMenuBuilder\) \{[\s\S]*?\n  \}\n\n  \/\/ Linking API/,
      `${menuMethod}\n  // Linking API`,
    );
  }
  return contents.replace(anchor, `${menuMethod}\n${anchor}`);
}

/// The Kotlin lives beside the Swift and is copied into the prebuild, because
/// `android/` is generated and the repo tracks no sources there.
function withKotlinSourceFiles(config) {
  return withDangerousMod(config, [
    "android",
    async (config) => {
      const mainApplication = await AndroidConfig.Paths.getMainApplicationAsync(
        config.modRequest.projectRoot,
      );
      if (mainApplication.language !== "kt") {
        throw new Error(
          `Aimux native commands are Kotlin; MainApplication is ${mainApplication.language}`,
        );
      }
      // Taken from the file we are writing beside rather than from
      // android.package, so the declaration cannot disagree with the directory.
      const declaration = mainApplication.contents.match(/^package .*$/m);
      if (!declaration) {
        throw new Error(`No package declaration in ${mainApplication.path}`);
      }
      const directory = path.dirname(mainApplication.path);
      for (const file of KOTLIN_FILES) {
        const contents = fs.readFileSync(path.join(__dirname, "android", file), "utf8");
        fs.writeFileSync(
          path.join(directory, file),
          contents.replace(/^package .*$/m, declaration[0]),
        );
      }
      return config;
    },
  ]);
}

function patchPackageRegistration(contents) {
  if (contents.includes(PACKAGE_REGISTRATION)) return contents;
  if (!contents.includes(PACKAGE_ANCHOR)) {
    throw new Error("Could not find MainApplication package anchor for Aimux native commands");
  }
  return contents.replace(PACKAGE_ANCHOR, PACKAGE_REGISTRATION);
}

/// Only `true` when the command was delivered, so a key is never swallowed
/// without something having happened: on a dead JS instance it falls through
/// and the text view inserts a newline instead.
const ACTIVITY_OVERRIDES = `  override fun dispatchKeyEvent(event: KeyEvent): Boolean {
    val command = AimuxNativeCommandsModule.commandForKeyEvent(event)
    if (command != null && AimuxNativeCommandsModule.emit(command)) {
      return true
    }
    return super.dispatchKeyEvent(event)
  }

  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    AimuxNativeCommandsModule.emitHardwareKeyboardChanged(newConfig)
  }`;

const GENERATED_REGION =
  /\n  \/\/ @generated begin aimux-native-commands[\s\S]*?\/\/ @generated end aimux-native-commands\n/;

/// Expo's own marker shape, for Expo's own reason: `expo prebuild` reuses an
/// existing `android/`, so a plain re-run re-patches an already-patched file.
/// The hash is what makes a CHANGED block replace the old one instead of a
/// "looks patched already" check declining forever.
function generatedBlock() {
  const hash = crypto.createHash("sha1").update(ACTIVITY_OVERRIDES).digest("hex").slice(0, 40);
  return [
    "",
    `  // @generated begin aimux-native-commands - expo prebuild (DO NOT MODIFY) sync-${hash}`,
    ACTIVITY_OVERRIDES,
    "  // @generated end aimux-native-commands",
    "",
  ].join("\n");
}

function patchKeyDispatch(contents) {
  const block = generatedBlock();
  if (contents.includes(block)) return contents;
  const withImports = AndroidConfig.CodeMod.addImports(
    contents,
    ["android.content.res.Configuration", "android.view.KeyEvent"],
    false,
  );
  if (GENERATED_REGION.test(withImports)) {
    return withImports.replace(GENERATED_REGION, block);
  }
  if (!withImports.includes(ACTIVITY_ANCHOR)) {
    throw new Error("Could not find MainActivity anchor for Aimux native commands");
  }
  return withImports.replace(ACTIVITY_ANCHOR, `${ACTIVITY_ANCHOR}\n${block}`);
}

module.exports = function withAimuxNativeAppCommands(config) {
  config = withNativeCommandSourceFiles(config);
  config = withAppDelegate(config, (config) => {
    config.modResults.contents = patchMenu(patchWindowClass(config.modResults.contents));
    return config;
  });
  config = withKotlinSourceFiles(config);
  config = withMainApplication(config, (config) => {
    config.modResults.contents = patchPackageRegistration(config.modResults.contents);
    return config;
  });
  return withMainActivity(config, (config) => {
    config.modResults.contents = patchKeyDispatch(config.modResults.contents);
    return config;
  });
};

/// Exported so `lib/android-native-patches.test.ts` can run them. Without a
/// test that does, deleting the MainActivity overrides left every gate green
/// while Android silently stopped sending.
module.exports.patchKeyDispatch = patchKeyDispatch;
module.exports.patchPackageRegistration = patchPackageRegistration;
