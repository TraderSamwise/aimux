import { readdirSync, readFileSync } from "node:fs";
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
const STORES = dirname(fileURLToPath(import.meta.url));

// The helpers a persisted atom may be handed to. `unwrap` is jotai's own and
// is what the helpers are built on; the rest of the app should prefer them.
const READERS = ["storedValueAtom", "storageReadStateAtom", "unwrap"];

function sourceFiles(): { name: string; text: string }[] {
  return readdirSync(STORES)
    .filter((entry) => entry.endsWith(".ts") && !entry.endsWith(".test.ts"))
    .map((name) => ({ name, text: readFileSync(join(STORES, name), "utf8") }));
}

function persistedAtomNames(text: string): string[] {
  // `const <name> = atomWithStorage...`, which is how all five are declared.
  return [...text.matchAll(/(?:const|let)\s+(\w+)\s*=\s*atomWithStorage/g)].map(
    (match) => match[1],
  );
}

describe("every persisted atom", () => {
  const files = sourceFiles().filter((file) => file.text.includes("atomWithStorage"));

  it("is declared somewhere this audit can see", () => {
    // The audit is worthless if the pattern stops matching. Five today.
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

  it("is never read directly, only through the storage helpers", () => {
    const offences: string[] = [];
    for (const file of files) {
      for (const name of persistedAtomNames(file.text)) {
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
