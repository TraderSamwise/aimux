const fs = require("fs");
const path = require("path");
const { IOSConfig } = require("@expo/config-plugins");

const SOURCE_FILE = "AimuxAttachmentDropView.m";

module.exports = function withAimuxAttachmentDropView(config) {
  const contents = fs.readFileSync(path.join(__dirname, "ios", SOURCE_FILE), "utf8");

  return IOSConfig.XcodeProjectFile.withBuildSourceFile(config, {
    filePath: SOURCE_FILE,
    contents,
    overwrite: true,
  });
};
