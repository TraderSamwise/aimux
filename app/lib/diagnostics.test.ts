import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import ts from "typescript";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DIAGNOSTIC_THROTTLE_MS,
  captureDiagnostic,
  decideDiagnosticThrottle,
  resetDiagnosticThrottleForTests,
} from "@/lib/diagnostics";
import { buildSentryEnvelope, parseSentryDsn, sentryAuthHeader } from "@/lib/sentry-envelope";
import {
  diagnosticReason,
  DIAGNOSTIC_REASON_MAX_CHARS,
  deliveryTags,
  reportSendFailed,
  reportSendTimeout,
  reportTranscriptRefreshFailed,
} from "@/lib/send-timeout-report";

const DSN = "https://abc123@o456.ingest.sentry.io/789";

describe("reading a Sentry DSN", () => {
  it("pulls out where to post and what proves us", () => {
    expect(parseSentryDsn(DSN)).toEqual({
      envelopeUrl: "https://o456.ingest.sentry.io/api/789/envelope/",
      publicKey: "abc123",
      projectId: "789",
    });
  });

  it("answers null for anything it cannot use, rather than throwing", () => {
    // This runs behind a send. Telemetry that cannot be addressed must never
    // be the reason a message looks like it failed.
    for (const bad of [
      undefined,
      "",
      "   ",
      "not a url",
      "https://o456.ingest.sentry.io/789",
      "https://abc123@o456.ingest.sentry.io/",
      "ftp://abc123@o456.ingest.sentry.io/789",
    ]) {
      expect(parseSentryDsn(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("the envelope", () => {
  const input = {
    eventName: "composer.send.unconfirmed",
    message: "Composer send was never confirmed",
    level: "warning" as const,
    eventId: "0".repeat(32),
    sentAtIso: "2099-01-01T00:00:00.000Z",
    environment: "production",
    release: "1.2.3",
    tags: { relayStatus: "connected" },
    context: { droppedExpiredCount: 2 },
  };

  it("is three newline-delimited json lines", () => {
    const lines = buildSentryEnvelope(input).trimEnd().split("\n");
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0])).toMatchObject({ event_id: input.eventId });
    expect(JSON.parse(lines[1])).toEqual({ type: "event" });
    expect(JSON.parse(lines[2])).toMatchObject({
      level: "warning",
      environment: "production",
      release: "1.2.3",
    });
  });

  it("groups on the diagnostic rather than the message", () => {
    // Without this Sentry groups on the message, and these messages carry
    // varying detail -- one diagnostic would arrive as a scatter of
    // near-identical issues, which is the opposite of being able to ask how
    // often it happens.
    const event = JSON.parse(buildSentryEnvelope(input).trimEnd().split("\n")[2]);
    expect(event.fingerprint).toEqual(["composer.send.unconfirmed"]);
    expect(event.tags.diagnostic).toBe("composer.send.unconfirmed");
  });

  it("names the key and the time in the auth header", () => {
    const header = sentryAuthHeader("abc123", "2099-01-01T00:00:00.000Z");
    expect(header).toContain("sentry_key=abc123");
    expect(header).toContain("sentry_version=7");
  });
});

describe("not flooding", () => {
  beforeEach(() => resetDiagnosticThrottleForTests());

  it("sends one and counts the rest of the burst", () => {
    // The burst this has to survive is a relay evicting its socket every
    // couple of seconds, where every expired echo raises the same thing.
    const first = decideDiagnosticThrottle("composer.send.unconfirmed", 1_000);
    expect(first).toEqual({ send: true, occurrences: 1 });

    for (let i = 0; i < 40; i += 1) {
      const next = decideDiagnosticThrottle("composer.send.unconfirmed", 1_000 + i);
      expect(next.send).toBe(false);
    }

    // The next one out carries the whole burst, so the count is not lost.
    const after = decideDiagnosticThrottle(
      "composer.send.unconfirmed",
      1_000 + DIAGNOSTIC_THROTTLE_MS,
    );
    expect(after.send).toBe(true);
    expect(after.occurrences).toBe(41);
  });

  it("throttles each diagnostic on its own", () => {
    expect(decideDiagnosticThrottle("composer.send.unconfirmed", 0).send).toBe(true);
    expect(decideDiagnosticThrottle("composer.send.failed", 0).send).toBe(true);
  });
});

describe("what a diagnostic carries", () => {
  let warned: unknown[][] = [];

  beforeEach(() => {
    resetDiagnosticThrottleForTests();
    warned = [];
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warned.push(args);
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 200 })),
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const path = {
    sessionId: "claude-psmp2r",
    relayConfigured: true,
    relayStatus: "connected",
    shared: true,
  };

  it("strips the path, query and credentials out of a URL an error quoted", () => {
    // The free-form half. A transport error quotes the request it failed on,
    // and an Aimux request URL carries the session id, the share id and a
    // token in its path and query -- so this is the one place the rest of the
    // module's care could be undone. The host is kept, because "relay or
    // loopback" is the question these events exist to answer.
    const url =
      "https://user:pa55word@relay.aimux.app:8443/shares/user_3E0h/Fozqw2SsTCciooYkzx-XYQ" +
      "/proxy/127.0.0.1/44659/agents/input?sessionId=claude-psmp2r&token=sk-live-abcdef#frag";
    reportSendFailed(path, new Error(`Failed to POST ${url}`));
    reportTranscriptRefreshFailed(path, "input", `GET ${url} timed out`);
    // The one with no free-form field at all, for the contrast.
    reportSendTimeout({ ...path, droppedExpiredCount: 1, parsedMessageCount: 4 });

    const serialized = JSON.stringify(warned);
    // A password with an `@` in it: the userinfo group has to run to the LAST
    // `@`, or it stops at the first and the rest of the password rides
    // through as if it were the host.
    reportSendFailed(path, new Error("POST https://user:p@55w@rd@relay.aimux.app/x refused"));
    // Schemes with no authority carry the content itself, so there is no host
    // to keep and nothing after the scheme that belongs in a diagnostic.
    reportSendFailed(path, new Error("mailto:sam@tealstreet.io bounced"));
    reportSendFailed(path, new Error("data:text/plain;base64,c2VjcmV0 rejected"));

    const opaque = JSON.stringify(warned);
    expect(opaque).not.toContain("55w");
    expect(opaque).not.toContain("rd@");
    expect(opaque).not.toContain("sam@tealstreet.io");
    expect(opaque).not.toContain("c2VjcmV0");
    expect(opaque).toContain("mailto:<redacted>");
    expect(opaque).toContain("data:<redacted>");

    for (const leaked of [
      "pa55word",
      "sk-live-abcdef",
      "Fozqw2SsTCciooYkzx-XYQ",
      "user_3E0h",
      "/agents/input",
      "frag",
    ]) {
      expect(serialized, `${leaked} must not ride in on an error`).not.toContain(leaked);
    }
    // Still useful: which host failed, and the session, from the fields this
    // module assembles itself.
    expect(serialized).toContain("https://relay.aimux.app:8443");
    expect(serialized).toContain("claude-psmp2r");
    expect(serialized).toContain("relayStatus");
  });

  it("is never handed the draft in the first place", () => {
    // What makes "no message text" a fact rather than a hope: the draft is in
    // scope at every reporter call site, so the payload being clean is a fact
    // about the ARGUMENTS. Asserting the built record alone passes while
    // nothing is passed in, which is how this started.
    //
    // Read through the compiler rather than with a regex. The first version
    // of this gate scanned text, and a review defeated it twice over: a `)`
    // inside a string argument ended the scan early, and `\btext\b` did not
    // see `composerDraftTextRef` -- the ref assigned the draft on the line
    // above the call, and so the likeliest name a future change reaches for.
    const banned = ["text", "draft", "attachment", "transcript", "message", "parsed"];
    const calls: Array<{ callee: string; identifiers: string[]; where: string }> = [];
    const references: Array<{ name: string; called: boolean; where: string }> = [];

    for (const file of reporterCallers()) {
      const source = ts.createSourceFile(
        file,
        readFileSync(file, "utf8"),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      );
      const imported = importedReporters(source);
      // Names are not dataflow, and a review proved it: assigning the draft to
      // `composerLine` first and passing THAT was invisible to a gate that
      // only reads argument names. So any local whose initializer mentions
      // the content becomes content itself, and the pass repeats so a chain
      // of renames does not launder it either.
      const tainted = taintedLocals(source, banned);
      const visit = (node: ts.Node): void => {
        if (
          ts.isIdentifier(node) &&
          imported.has(node.text) &&
          !ts.isImportSpecifier(node.parent)
        ) {
          const parent = node.parent;
          references.push({
            name: node.text,
            called: Boolean(parent && ts.isCallExpression(parent) && parent.expression === node),
            where: basename(file),
          });
        }
        if (ts.isCallExpression(node) && /report/i.test(node.expression.getText(source))) {
          const identifiers: string[] = [];
          const collect = (child: ts.Node): void => {
            // A COUNT of the user's content is not the content:
            // `parsedMessages.length` is how far the transcript had got,
            // which is the point of the record. Skipping the whole access
            // skips the thing being counted too, which is the allowance.
            if (
              ts.isPropertyAccessExpression(child) &&
              (child.name.text === "length" || child.name.text === "size")
            ) {
              return;
            }
            // A field NAME is not a value. `parsedMessageCount:` says what
            // the record is called; what it is given is the expression after
            // the colon, which is scanned. Shorthand (`relayStatus,`) is both
            // and so is still scanned.
            if (ts.isPropertyAssignment(child)) {
              collect(child.initializer);
              return;
            }
            if (ts.isIdentifier(child)) {
              identifiers.push(child.text);
              if (tainted.has(child.text)) identifiers.push(`draft-via-${child.text}`);
            }
            ts.forEachChild(child, collect);
          };
          for (const argument of node.arguments) collect(argument);
          calls.push({
            callee: node.expression.getText(source),
            identifiers,
            where: basename(file),
          });
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }

    expect(calls.length, "the reporter call sites must be found at all").toBeGreaterThanOrEqual(5);
    // One production file imports a reporter today. Stated as a number so
    // that a second one appearing is a decision somebody makes, not a file
    // this gate quietly never looked at.
    expect(reporterCallers().map((file) => basename(file))).toEqual(["AgentChatScreen.tsx"]);
    for (const call of calls) {
      for (const identifier of call.identifiers) {
        // By camelCase word, not by substring: `deliveryDiagnosticContext`
        // ends in "text" and is the one argument every reporter is SUPPOSED
        // to take, while `composerDraftTextRef` has "text" as a word of its
        // own. A plural still counts, so the stem matches the start of a word.
        const words = identifier.split(/(?=[A-Z])|[^A-Za-z]+/).map((word) => word.toLowerCase());
        for (const stem of banned) {
          expect(
            words.some((word) => word.startsWith(stem)),
            `${call.where}: ${call.callee} is given ${identifier}`,
          ).toBe(false);
        }
      }
    }
    // And every reporter is called directly, so the gate above cannot be
    // stepped around by handing one to something else first.
    for (const reference of references) {
      expect(reference.called, `${reference.where}: ${reference.name} is used as a value`).toBe(
        true,
      );
    }
  });

  it("caps an error it did not assemble itself", () => {
    const long = "x".repeat(DIAGNOSTIC_REASON_MAX_CHARS * 3);
    expect(diagnosticReason(new Error(long)).length).toBe(DIAGNOSTIC_REASON_MAX_CHARS);
    expect(diagnosticReason(undefined)).toBe("");
    expect(diagnosticReason("plain string")).toBe("plain string");
    // Redacting before the cap spends the 300 characters on the message
    // instead of on a path about to be thrown away. Both orders redact, so
    // this is about what survives, not about what leaks.
    const buried = `${"y".repeat(DIAGNOSTIC_REASON_MAX_CHARS - 30)}https://h/a-very-long-path`;
    const reason = diagnosticReason(new Error(buried));
    expect(reason).not.toContain("a-very-long-path");
    expect(reason).toContain("https://h");
  });

  it("keeps the session id out of the searchable tags", () => {
    // Tags are indexed, so an unbounded value there is a cardinality problem.
    // It stays in the context, where it can still be read.
    const tags = deliveryTags(path);
    expect(Object.values(tags)).not.toContain("claude-psmp2r");
    expect(tags).toMatchObject({ relayStatus: "connected", shared: "true" });
  });

  it("records to the console even with nowhere to send it", () => {
    captureDiagnostic({
      name: "composer.send.failed",
      message: "m",
      level: "error",
      tags: {},
      context: { a: 1 },
    });
    expect(warned.length).toBe(1);
    // No DSN in the test env, so nothing is posted and nothing throws.
    expect((globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(
      0,
    );
  });
});

/** Every app source file that imports a delivery reporter. */
function reporterCallers(): string[] {
  const roots = [join(__dirname, ".."), join(__dirname, "..", "components"), join(__dirname)];
  const seen = new Set<string>();
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        walk(path);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue;
      if (seen.has(path)) continue;
      seen.add(path);
      // By module, not by one spelling of its path: a sibling in `lib/`
      // imports it as `./send-timeout-report`, and a gate that matched only
      // the `@/lib/...` form never looked at that file at all.
      if (/from\s+["'][^"']*send-timeout-report["']/.test(readFileSync(path, "utf8"))) {
        found.push(path);
      }
    }
  };
  for (const root of roots) walk(root);
  return found;
}

/** The reporter names a file imported, so a rename cannot slip the gate. */
function importedReporters(source: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!statement.moduleSpecifier.getText(source).includes("send-timeout-report")) continue;
    const bindings = statement.importClause?.namedBindings;
    // A namespace import (`import * as reports from ...`) gives this nothing
    // to track, so the reference check below would be vacuous. Refuse the
    // shape rather than report a gate that is no longer checking anything.
    if (bindings && ts.isNamespaceImport(bindings)) {
      throw new Error(
        `${source.fileName}: import the reporters by name; a namespace import defeats this gate`,
      );
    }
    if (statement.importClause?.name) {
      throw new Error(
        `${source.fileName}: import the reporters by name; a default import defeats this gate`,
      );
    }
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if (/^report/.test(element.name.text)) names.add(element.name.text);
    }
  }
  return names;
}

/**
 * Locals that hold the user's content, by one step of assignment at a time.
 *
 * A banned NAME is easy to avoid; what matters is whether the value reaches a
 * reporter. `const composerLine = composerDraftTextRef.current` launders the
 * draft past a name check in one line, so every local whose initializer
 * mentions tainted content is tainted too, and the sweep repeats until it
 * stops growing so a chain of renames does not launder it either.
 */
function taintedLocals(source: ts.SourceFile, banned: readonly string[]): Set<string> {
  const declarations: Array<{ name: string; initializer: string }> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      // Aliases and property reads only. A CALL's result is a different
      // value -- `sendLivePaneInput(..., text, ...)` returns the server's
      // answer, not the draft -- and treating it as the draft made this
      // reject `deliveryState.kind`, which is an enum the record needs.
      let callsSomething = false;
      const scan = (child: ts.Node): void => {
        if (ts.isCallExpression(child) || ts.isNewExpression(child)) callsSomething = true;
        ts.forEachChild(child, scan);
      };
      scan(node.initializer);
      if (!callsSomething) {
        declarations.push({ name: node.name.text, initializer: node.initializer.getText(source) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  const isContent = (identifier: string, tainted: ReadonlySet<string>): boolean => {
    if (tainted.has(identifier)) return true;
    const words = identifier.split(/(?=[A-Z])|[^A-Za-z]+/).map((word) => word.toLowerCase());
    return banned.some((stem) => words.some((word) => word.startsWith(stem)));
  };

  const tainted = new Set<string>();
  for (let pass = 0; pass < declarations.length + 1; pass += 1) {
    const before = tainted.size;
    for (const declaration of declarations) {
      if (tainted.has(declaration.name)) continue;
      // `.length` of the content is a count, which is allowed to be reported.
      const initializer = declaration.initializer.replace(
        /\b[A-Za-z]\w*\.(?:length|size)\b/g,
        "COUNT",
      );
      const identifiers = initializer.match(/[A-Za-z_$][\w$]*/g) ?? [];
      if (identifiers.some((identifier) => isContent(identifier, tainted))) {
        tainted.add(declaration.name);
      }
    }
    if (tainted.size === before) break;
  }
  return tainted;
}
