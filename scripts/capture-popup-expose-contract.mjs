#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/expose/popup-options.json", ROOT);
const { toExposeOptions } = await import(new URL("dist/popup-expose.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const cwd = process.cwd();

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function normalizeCwd(value) {
  if (typeof value === "string") return value === cwd ? "<cwd>" : value.replaceAll(`${cwd}/`, "<cwd>/");
  if (Array.isArray(value)) return value.map(normalizeCwd);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, normalizeCwd(child)]));
  }
  return value;
}

const inputs = [
  {
    name: "resolves absolute paths and passes optional fields through",
    options: {
      projectRoot: "/proj",
      projectStateDir: "/proj/.aimux/state",
      currentClientSession: "sess-1",
      clientTty: "/dev/ttys009",
      currentWindow: "dashboard",
      currentWindowId: "@7",
      currentPath: "/proj/sub",
      paneId: "%3",
      aimuxHome: "/home/u/.aimux",
    },
  },
  {
    name: "resolves relative paths against cwd and leaves omitted options absent",
    options: {
      projectRoot: "rel/proj",
      projectStateDir: "rel/state",
    },
  },
  {
    name: "preserves empty optional strings while resolving dot segments",
    options: {
      projectRoot: "./project/../project",
      projectStateDir: "./project/.aimux/../.aimux/state",
      currentClientSession: "",
      clientTty: "",
      currentWindow: "",
      currentWindowId: "",
      currentPath: "",
      paneId: "",
      aimuxHome: "",
    },
  },
];

const cases = inputs.map((input, index) => ({
  id: `popup-expose-${String(index + 1).padStart(3, "0")}`,
  name: input.name,
  source: "src/popup-expose.test.ts",
  input: normalizeCwd(input),
  output: normalizeCwd(toExposeOptions(input.options)),
  inputSha256: hash(input),
}));

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/popup-expose.test.ts",
  generatedBy: "scripts/capture-popup-expose-contract.mjs",
  description:
    "Popup expose CLI option-to-runtime option mapping captured by running TypeScript toExposeOptions, with cwd-dependent paths normalized.",
  normalization: {
    cwd: "<cwd>",
  },
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
