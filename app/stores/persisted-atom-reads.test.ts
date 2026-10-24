import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Every persisted atom must be READ through the storage helpers.
 *
 * The bug this prevents cost two features silently. `atomWithStorage` over an
 * async storage puts the read itself in the atom and never replaces it: jotai
 * does not unwrap a promise a plain atom happens to hold, and `onMount` sets
 * another one. So `get(<the storage atom>)` returns a `Promise` forever, and a
 * reader that guards for the value's shape reads every launch as "nothing
 * stored" -- the value is written faithfully and read back never. Nothing
 * fails, nothing logs; the feature just does not work.
 *
 * It is spelled as a source audit because no type and no runtime check can
 * see it: `get` returning `Value | Promise<Value>` is exactly what the guard
 * the defect wears is testing for.
 */
const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Everywhere the app could declare one, not just `stores/`: an atom added
// beside a screen would have escaped this entirely.
const SEARCHED = ["stores", "lib", "components", "app", "hooks"];

// The helpers a persisted atom may be handed to. `unwrap` is jotai's own and
// is what the helpers are built on; the rest of the app should prefer them.
const READERS = ["storedValueAtom", "storageReadStateAtom", "readBeforeWriteAtom", "unwrap"];

// A persisted atom whose writes REPLACE the value outright, with something the
// caller already holds, rather than modifying what is stored. Those lose
// nothing by landing before the read and must not be held up -- the user
// picking a project while storage is still answering has to work.
//
// An allowlist because the distinction is a judgement about the writer, not a
// pattern in the text: everything else is a read-modify-write, where a write
// that lands early stores the FALLBACK plus its one change and destroys the
// rest. Adding a name here has to be a deliberate decision.
const REPLACED_WHOLESALE = new Set(["selectedProjectKeyAtom"]);

function sourceFiles(): { name: string; text: string }[] {
  const found: { name: string; text: string }[] = [];
  const walk = (directory: string, label: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const name = label ? `${label}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        walk(path, name);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue;
      found.push({ name, text: readFileSync(path, "utf8") });
    }
  };
  for (const directory of SEARCHED) {
    const root = join(APP_ROOT, directory);
    if (!existsSync(root)) continue;
    walk(root, directory);
  }
  return found;
}

function persistedAtomNames(text: string): string[] {
  // `const <name> = atomWithStorage...`, which is how all five are declared.
  return [...text.matchAll(/(?:const|let)\s+(\w+)\s*=\s*atomWithStorage/g)].map(
    (match) => match[1],
  );
}

describe("every persisted atom", () => {
  const everyFile = sourceFiles();
  const files = everyFile.filter((file) => file.text.includes("atomWithStorage"));
  // Checked across the whole tree, not per file: `selectedProjectKeyAtom` is
  // exported, so another file could read or write it and a per-file scan would
  // never look.
  const allPersistedAtomNames = files.flatMap((file) => persistedAtomNames(file.text));

  it("is declared in a shape this audit can see", () => {
    // Not a floor: every `atomWithStorage` in the tree must match the
    // declaration pattern, or one spelled through a factory or an
    // `atomFamily` would escape the whole audit while the count still looked
    // healthy.
    for (const file of files) {
      const uses = file.text.match(/atomWithStorage[<(]/g)?.length ?? 0;
      const named = persistedAtomNames(file.text).length;
      expect(
        named,
        `${file.name} creates ${uses} persisted atom(s) but this audit can only name ${named}; declare it as \`const <name> = atomWithStorage\``,
      ).toBe(uses);
    }
    const declared = files.flatMap((file) => persistedAtomNames(file.text));
    expect(declared.length, `found ${JSON.stringify(declared)}`).toBeGreaterThanOrEqual(5);
  });

  // Counted per atom, not per file: two of them live in `projects.ts`, and
  // asserting the file merely CONTAINS the option let one of the two lose it.
  it("starts its read at launch, every one of them", () => {
    for (const file of files) {
      const atoms = persistedAtomNames(file.text).length;
      const asking = file.text.match(/getOnInit: true/g)?.length ?? 0;
      expect(
        asking,
        `${file.name} declares ${atoms} persisted atom(s) but ${asking} pass getOnInit; without it the read does not start until the atom is mounted`,
      ).toBe(atoms);
    }
  });

  it("is never written directly, so a read-modify-write cannot land early", () => {
    const offences: string[] = [];
    for (const file of everyFile) {
      for (const name of allPersistedAtomNames) {
        if (REPLACED_WHOLESALE.has(name)) continue;
        for (const [index, line] of file.text.split("\n").entries()) {
          if (!new RegExp(`\\bset\\(\\s*${name}\\b`).test(line)) continue;
          offences.push(`${file.name}:${index + 1} writes ${name} directly`);
        }
      }
    }
    expect(
      offences,
      "route the write through `readBeforeWriteAtom`, or allowlist it as replaced wholesale",
    ).toEqual([]);
  });

  it("is never read directly, only through the storage helpers", () => {
    const offences: string[] = [];
    for (const file of everyFile) {
      for (const name of allPersistedAtomNames) {
        for (const [index, line] of file.text.split("\n").entries()) {
          if (!line.includes(name)) continue;
          // A write is fine: `set(<name>, value)` is how a value is stored.
          if (new RegExp(`\\bset\\(\\s*${name}\\b`).test(line)) continue;
          // Being handed to a helper is the point.
          if (READERS.some((reader) => line.includes(`${reader}(${name}`))) continue;
          if (new RegExp(`\\b${name}\\s*=\\s*atomWithStorage`).test(line)) continue;
          // A reader is what this audit is looking for.
          if (new RegExp(`\\bget\\(\\s*${name}\\b`).test(line)) {
            offences.push(`${file.name}:${index + 1} reads ${name} directly`);
          }
        }
      }
    }
    expect(
      offences,
      "a persisted atom read directly holds the pending promise, not the value",
    ).toEqual([]);
  });
});
