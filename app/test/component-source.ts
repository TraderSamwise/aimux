import { existsSync, readFileSync } from "node:fs";

/**
 * The body of one exported component, with comments removed.
 *
 * Source-level gates exist for route components because no renderer in this
 * app executes them. Reading the WHOLE FILE defeats those gates, and both ways
 * of defeating them have actually happened in review: a reviewer replaced a
 * component's body with `return <Redirect href="/shares" />` and moved the real
 * one into a function nothing called, and a reviewer commented a guard out and
 * added `void theFlag;` to keep the name present. Every `toContain` still
 * matched, while the app did the wrong thing.
 *
 * So a gate reads only what RUNS: the text between the component's own braces,
 * with `//` and block comments gone.
 */
export function componentBody(path: string, declaration: string): string {
  if (!existsSync(path)) throw new Error(`${path} is not readable`);
  const file = stripComments(readFileSync(path, "utf8"));
  const opener = file.indexOf(declaration);
  if (opener < 0) throw new Error(`${path} no longer declares \`${declaration}\``);
  // The body's brace, not the first one: a component with destructured props
  // opens `({ padded = true })` before it opens its body, and matching that
  // pair returns the parameter list -- which every assertion then fails
  // against, loudly rather than silently.
  let parens = 0;
  let body = -1;
  for (let index = opener; index < file.length; index += 1) {
    const character = file[index];
    if (character === "(") parens += 1;
    else if (character === ")") parens -= 1;
    else if (character === "{" && parens === 0) {
      body = index;
      break;
    }
  }
  if (body < 0) throw new Error(`cannot find the body of ${declaration} in ${path}`);

  let depth = 0;
  for (let index = body; index < file.length; index += 1) {
    if (file[index] === "{") depth += 1;
    else if (file[index] === "}") {
      depth -= 1;
      if (depth === 0) return file.slice(opener, index + 1);
    }
  }
  throw new Error(`unbalanced braces in ${declaration}`);
}

/**
 * Comments removed, so commenting code out cannot satisfy a gate.
 *
 * Line comments go first -- trailing ones too, which is the point: a gate that
 * only removed whole lines was satisfied by `const open = null; // the real
 * call`. A `//` inside a string literal is the known limit, and no gate in
 * this repo asserts on one.
 */
export function stripComments(source: string): string {
  return (
    source
      // Trailing comments as well as whole lines: `const open = null; //
      // store.set(...)` satisfied a gate that only removed full-line ones.
      // The negative lookbehind spares `https://`.
      .replace(/(?<!:)\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
  );
}
