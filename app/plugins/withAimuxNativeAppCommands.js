const fs = require("fs");
const path = require("path");
const { IOSConfig, withAppDelegate } = require("@expo/config-plugins");

const SWIFT_FILE = "AimuxNativeCommands.swift";
const BRIDGE_FILE = "AimuxNativeCommands.m";

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

module.exports = function withAimuxNativeAppCommands(config) {
  config = withNativeCommandSourceFiles(config);
  return withAppDelegate(config, (config) => {
    config.modResults.contents = patchMenu(patchWindowClass(config.modResults.contents));
    return config;
  });
};
