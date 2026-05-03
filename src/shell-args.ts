export function parseShellArgs(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;
  let tokenStarted = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (escaping) {
      current += ch;
      escaping = false;
      tokenStarted = true;
      continue;
    }

    if (ch === "\\" && quote !== "'") {
      escaping = true;
      tokenStarted = true;
      continue;
    }

    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
        tokenStarted = true;
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      tokenStarted = true;
      continue;
    }

    if (/\s/.test(ch)) {
      if (tokenStarted) {
        args.push(current);
        current = "";
        tokenStarted = false;
      }
      continue;
    }

    current += ch;
    tokenStarted = true;
  }

  if (escaping) {
    current += "\\";
  }
  if (quote) {
    throw new Error(`unterminated ${quote === "'" ? "single" : "double"} quote`);
  }
  if (tokenStarted) {
    args.push(current);
  }

  return args;
}
