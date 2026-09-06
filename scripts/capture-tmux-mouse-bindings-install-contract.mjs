#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/tmux/mouse-bindings-install.json", ROOT);
const { buildDefaultRootMouseBindingsConfig } = await import(new URL("dist/tmux/runtime-manager.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const writeContractJson = async (url, contract) => {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
};
const shellQuote = (value) => `'${value.replace(/'/g, `'"'"'`)}'`;
const openHyperlinkScript = fileURLToPath(new URL("scripts/tmux-open-hyperlink.sh", ROOT));
const projectStateDir = "/state/mobile";
const openPaneLinkCommand = `AIMUX_HYPERLINK=#{q:mouse_hyperlink} AIMUX_MOUSE_WORD=#{q:mouse_word} AIMUX_MOUSE_LINE=#{q:mouse_line} sh ${shellQuote(openHyperlinkScript)} >/dev/null 2>&1`;
const openStatusPrCommand = `AIMUX_STATUS_LINE=#{q:mouse_status_line} AIMUX_PROJECT_STATE_DIR=${shellQuote(projectStateDir)} AIMUX_CURRENT_WINDOW_ID=#{q:window_id} sh ${shellQuote(openHyperlinkScript)} >/dev/null 2>&1`;
const input = { projectStateDir, openHyperlinkScript: "<OPEN_HYPERLINK_SCRIPT>" };
const output = {
  config: buildDefaultRootMouseBindingsConfig({ openPaneLinkCommand, openStatusPrCommand }).replaceAll(
    openHyperlinkScript,
    "<OPEN_HYPERLINK_SCRIPT>",
  ),
};

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  generatedAt: "2026-09-07T00:00:00.000Z",
  generatedBy: "scripts/capture-tmux-mouse-bindings-install-contract.mjs",
  source: "src/tmux/runtime-manager.ts",
  subject: "src/tmux/runtime-manager.ts",
  description: "tmux root mouse binding install commands captured through the TypeScript renderer.",
  caseCount: 1,
  cases: [
    {
      id: "tmux-mouse-bindings-install-001",
      name: "uses the installed hyperlink helper path in root mouse bindings",
      source: "src/tmux/runtime-manager.ts",
      api: "buildDefaultRootMouseBindingsConfig",
      input,
      output,
      inputSha256: hash(input),
    },
  ],
});
console.log(`${FIXTURE_PATH.pathname}: 1 cases`);
