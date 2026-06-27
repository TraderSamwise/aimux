function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function trimShellQuotes(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

export function commandArgValueMatches(args: string, flag: string, expected: string): boolean {
  const pattern = new RegExp(`(?:^|\\s)${escapeRegExp(flag)}\\s+(.+?)(?=\\s--|\\s*$)`, "g");
  for (const match of args.matchAll(pattern)) {
    if (trimShellQuotes((match[1] ?? "").trim()) === expected) return true;
  }
  return false;
}
