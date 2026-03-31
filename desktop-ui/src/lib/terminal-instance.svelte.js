// Shared terminal instance — created once, referenced by multiple components
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

let terminal = $state(null);
let fitAddon = $state(null);

export function getTerminal() {
  return {
    get terminal() { return terminal; },
    get fitAddon() { return fitAddon; },
  };
}

export function createTerminal(container) {
  const term = new Terminal({
    cursorBlink: true,
    scrollback: 5000,
    fontFamily: '"Iosevka Term", "SF Mono", Menlo, monospace',
    fontSize: 13,
    lineHeight: 1.2,
    theme: {
      background: "#0d1117",
      foreground: "#e6edf3",
      cursor: "#7dd3fc",
      selectionBackground: "rgba(125, 211, 252, 0.2)",
      black: "#0d1117",
      brightBlack: "#5a6a7e",
    },
  });

  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(container);
  fit.fit();

  terminal = term;
  fitAddon = fit;

  return { terminal: term, fitAddon: fit };
}
