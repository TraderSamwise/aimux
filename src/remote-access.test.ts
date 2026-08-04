import { describe, expect, it } from "vitest";

import type { HostedPrincipal } from "./hosted-principals.js";
import { PROJECT_API_ROUTES } from "./project-api-contract.js";
import {
  assertOperatorStreamAllowed,
  assertRemoteAccessAllowed,
  parseRemoteActor,
  type RemoteActor,
} from "./remote-access.js";

const PROJECT_ROOT = "/srv/grand";
const SESSION = "assistant";
const PORT_PATH = (subPath: string) => `/proxy/127.0.0.1/43210${subPath}`;

function principal(grants: Array<{ projectRoot: string; sessionId: string }> = []): HostedPrincipal {
  return {
    id: "prn_test",
    label: "test",
    tokenHash: "sha256:abcd",
    role: "operator",
    grants,
    createdAt: new Date(0).toISOString(),
    revokedAt: null,
    lastSeenAt: null,
  };
}

function operator(grants = [{ projectRoot: PROJECT_ROOT, sessionId: SESSION }]): RemoteActor {
  return { role: "operator", principal: principal(grants) };
}

function allow(
  actor: RemoteActor | null,
  method: string,
  path: string,
  options: { body?: unknown; projectRoot?: string | null; query?: string } = {},
) {
  const url = new URL(`http://127.0.0.1${path}${options.query ?? ""}`);
  return assertRemoteAccessAllowed(actor, method, url.pathname, url.searchParams, {
    body: options.body,
    projectRoot: "projectRoot" in options ? options.projectRoot : PROJECT_ROOT,
  });
}

describe("operator route allowlist", () => {
  it("allows a granted session on each permitted route", () => {
    expect(
      allow(operator(), "GET", PORT_PATH(PROJECT_API_ROUTES.agents.output), { query: `?sessionId=${SESSION}` }),
    ).toEqual({ ok: true });
    expect(
      allow(operator(), "POST", PORT_PATH(PROJECT_API_ROUTES.agents.input), {
        body: { sessionId: SESSION, text: "hi" },
      }),
    ).toEqual({ ok: true });
    expect(
      allow(operator(), "POST", PORT_PATH(PROJECT_API_ROUTES.agents.interrupt), { body: { sessionId: SESSION } }),
    ).toEqual({ ok: true });
  });

  it("denies every route not on the allowlist", () => {
    // outputStream stays denied HERE even though operators may stream: this
    // gate governs the buffered proxy, which reads the whole response before
    // replying, and an SSE body never ends. Streaming has its own entry point.
    const denied = [
      PROJECT_API_ROUTES.agents.list,
      PROJECT_API_ROUTES.agents.outputStream,
      PROJECT_API_ROUTES.agents.history,
      PROJECT_API_ROUTES.events,
      PROJECT_API_ROUTES.agents.spawn,
      PROJECT_API_ROUTES.agents.kill,
      PROJECT_API_ROUTES.agents.stop,
      PROJECT_API_ROUTES.agents.fork,
      PROJECT_API_ROUTES.livePane.input,
      PROJECT_API_ROUTES.threads.send,
      PROJECT_API_ROUTES.worktreeActions.create,
      PROJECT_API_ROUTES.desktopState,
    ];
    for (const route of denied) {
      const result = allow(operator(), "GET", PORT_PATH(route), { query: `?sessionId=${SESSION}` });
      expect(result.ok, `GET ${route}`).toBe(false);
      const posted = allow(operator(), "POST", PORT_PATH(route), { body: { sessionId: SESSION } });
      expect(posted.ok, `POST ${route}`).toBe(false);
    }
  });

  it("denies daemon routes outside the proxy form", () => {
    expect(allow(operator(), "GET", "/health").ok).toBe(false);
    expect(allow(operator(), "GET", PROJECT_API_ROUTES.agents.output).ok).toBe(false);
    expect(allow(operator(), "POST", "/projects/stop", { body: { sessionId: SESSION } }).ok).toBe(false);
  });

  it("enforces the method each route accepts", () => {
    expect(
      allow(operator(), "POST", PORT_PATH(PROJECT_API_ROUTES.agents.output), { body: { sessionId: SESSION } }).ok,
    ).toBe(false);
    expect(
      allow(operator(), "GET", PORT_PATH(PROJECT_API_ROUTES.agents.input), { query: `?sessionId=${SESSION}` }).ok,
    ).toBe(false);
    expect(
      allow(operator(), "DELETE", PORT_PATH(PROJECT_API_ROUTES.agents.input), { body: { sessionId: SESSION } }).ok,
    ).toBe(false);
  });
});

describe("operator session binding", () => {
  it("requires a session id", () => {
    expect(allow(operator(), "GET", PORT_PATH(PROJECT_API_ROUTES.agents.output)).ok).toBe(false);
    expect(allow(operator(), "POST", PORT_PATH(PROJECT_API_ROUTES.agents.input), { body: { text: "hi" } }).ok).toBe(
      false,
    );
  });

  it("refuses a session the principal was not granted", () => {
    expect(
      allow(operator(), "GET", PORT_PATH(PROJECT_API_ROUTES.agents.output), { query: "?sessionId=someone-else" }).ok,
    ).toBe(false);
  });

  it("refuses a granted session id in a different project", () => {
    // The whole reason grants name a project: session ids collide across them.
    expect(
      allow(operator(), "GET", PORT_PATH(PROJECT_API_ROUTES.agents.output), {
        query: `?sessionId=${SESSION}`,
        projectRoot: "/srv/other",
      }).ok,
    ).toBe(false);
  });

  it("refuses when the port could not be bound to a project", () => {
    expect(
      allow(operator(), "GET", PORT_PATH(PROJECT_API_ROUTES.agents.output), {
        query: `?sessionId=${SESSION}`,
        projectRoot: null,
      }).ok,
    ).toBe(false);
  });

  it("reads the session id from the source the service will use", () => {
    // POST: body is authoritative, a query value alone must not authorize.
    expect(
      allow(operator(), "POST", PORT_PATH(PROJECT_API_ROUTES.agents.input), { query: `?sessionId=${SESSION}` }).ok,
    ).toBe(false);
    // GET: query is authoritative, a body value alone must not authorize.
    expect(
      allow(operator(), "GET", PORT_PATH(PROJECT_API_ROUTES.agents.output), { body: { sessionId: SESSION } }).ok,
    ).toBe(false);
  });

  it("refuses conflicting session ids across body and query", () => {
    // Authorizing one and acting on the other is the bug this prevents.
    expect(
      allow(operator(), "POST", PORT_PATH(PROJECT_API_ROUTES.agents.input), {
        body: { sessionId: SESSION },
        query: "?sessionId=someone-else",
      }).ok,
    ).toBe(false);
    expect(
      allow(operator(), "GET", PORT_PATH(PROJECT_API_ROUTES.agents.output), {
        body: { sessionId: "someone-else" },
        query: `?sessionId=${SESSION}`,
      }).ok,
    ).toBe(false);
  });

  it("refuses an operator with no principal attached", () => {
    expect(
      allow({ role: "operator" }, "GET", PORT_PATH(PROJECT_API_ROUTES.agents.output), {
        query: `?sessionId=${SESSION}`,
      }).ok,
    ).toBe(false);
  });

  it("refuses a revoked principal even with a matching grant", () => {
    const revoked: RemoteActor = {
      role: "operator",
      principal: {
        ...principal([{ projectRoot: PROJECT_ROOT, sessionId: SESSION }]),
        revokedAt: "2020-01-01T00:00:00Z",
      },
    };
    expect(
      allow(revoked, "GET", PORT_PATH(PROJECT_API_ROUTES.agents.output), { query: `?sessionId=${SESSION}` }).ok,
    ).toBe(false);
  });

  it("refuses a principal with no grants at all", () => {
    expect(
      allow(operator([]), "GET", PORT_PATH(PROJECT_API_ROUTES.agents.output), { query: `?sessionId=${SESSION}` }).ok,
    ).toBe(false);
  });
});

describe("operator cannot be minted from headers", () => {
  it("degrades a forged operator role to guest", () => {
    const actor = parseRemoteActor({ "x-aimux-actor-role": "operator" });
    expect(actor?.role).toBe("guest");
    expect(actor?.principal).toBeUndefined();
  });

  it("degrades a forged operator role supplied as actor json", () => {
    const actor = parseRemoteActor({ "x-aimux-actor": JSON.stringify({ role: "operator", userId: "u" }) });
    expect(actor?.role).toBe("guest");
  });

  it("ignores a principal-shaped header entirely", () => {
    const actor = parseRemoteActor({
      "x-aimux-actor-role": "operator",
      "x-aimux-principal": JSON.stringify(principal([{ projectRoot: PROJECT_ROOT, sessionId: SESSION }])),
    });
    expect(actor?.principal).toBeUndefined();
    expect(
      allow(actor, "GET", PORT_PATH(PROJECT_API_ROUTES.agents.output), { query: `?sessionId=${SESSION}` }).ok,
    ).toBe(false);
  });
});

describe("existing roles are unaffected", () => {
  it("still lets an owner and a headerless caller through", () => {
    expect(allow({ role: "owner" }, "POST", PORT_PATH(PROJECT_API_ROUTES.agents.spawn)).ok).toBe(true);
    expect(allow(null, "POST", PORT_PATH(PROJECT_API_ROUTES.agents.spawn)).ok).toBe(true);
  });

  it("still scopes a shared guest to reads of its own session", () => {
    const guest: RemoteActor = { role: "guest", shareId: "s1", shareSessionId: SESSION };
    expect(
      allow(guest, "GET", PORT_PATH(PROJECT_API_ROUTES.agents.output), { query: `?sessionId=${SESSION}` }).ok,
    ).toBe(true);
    expect(allow(guest, "GET", PORT_PATH(PROJECT_API_ROUTES.agents.output), { query: "?sessionId=other" }).ok).toBe(
      false,
    );
    expect(allow(guest, "POST", PORT_PATH(PROJECT_API_ROUTES.agents.input), { body: { sessionId: SESSION } }).ok).toBe(
      false,
    );
  });

  it("still denies an unknown role", () => {
    expect(allow({ role: "nonsense" } as unknown as RemoteActor, "GET", PORT_PATH("/health")).ok).toBe(false);
  });
});

describe("operator stream allowlist", () => {
  const streamPath = PORT_PATH(PROJECT_API_ROUTES.agents.outputStream);

  function allowStream(
    actor: RemoteActor | null,
    method: string,
    path: string,
    options: { projectRoot?: string | null; query?: string } = {},
  ) {
    const url = new URL(`http://127.0.0.1${path}${options.query ?? ""}`);
    return assertOperatorStreamAllowed(actor, method, url.pathname, url.searchParams, {
      projectRoot: "projectRoot" in options ? options.projectRoot : PROJECT_ROOT,
    });
  }

  it("allows a granted session to stream its own output", () => {
    expect(allowStream(operator(), "GET", streamPath, { query: `?sessionId=${SESSION}` })).toEqual({ ok: true });
  });

  it("refuses a session the principal was not granted", () => {
    expect(allowStream(operator(), "GET", streamPath, { query: "?sessionId=someone-else" }).ok).toBe(false);
  });

  it("refuses the same session name granted in a different project", () => {
    const result = allowStream(operator([{ projectRoot: "/srv/other", sessionId: SESSION }]), "GET", streamPath, {
      query: `?sessionId=${SESSION}`,
    });
    expect(result.ok).toBe(false);
  });

  it("refuses when the port could not be bound to a project", () => {
    expect(allowStream(operator(), "GET", streamPath, { query: `?sessionId=${SESSION}`, projectRoot: null }).ok).toBe(
      false,
    );
  });

  it("streams nothing but the output stream — /events stays denied", () => {
    for (const route of [
      PROJECT_API_ROUTES.events,
      PROJECT_API_ROUTES.agents.output,
      PROJECT_API_ROUTES.agents.interactionStream,
      PROJECT_API_ROUTES.agents.list,
    ]) {
      const result = allowStream(operator(), "GET", PORT_PATH(route), { query: `?sessionId=${SESSION}` });
      expect(result.ok, route).toBe(false);
    }
  });

  it("refuses a non-GET and a non-operator", () => {
    expect(allowStream(operator(), "POST", streamPath, { query: `?sessionId=${SESSION}` }).ok).toBe(false);
    expect(
      allowStream({ role: "guest" } as RemoteActor, "GET", streamPath, { query: `?sessionId=${SESSION}` }).ok,
    ).toBe(false);
    expect(allowStream(null, "GET", streamPath, { query: `?sessionId=${SESSION}` }).ok).toBe(false);
  });

  it("refuses a daemon route outside the proxy form", () => {
    expect(allowStream(operator(), "GET", "/events", { query: `?sessionId=${SESSION}` }).ok).toBe(false);
  });

  it("requires a session id", () => {
    expect(allowStream(operator(), "GET", streamPath).ok).toBe(false);
  });
});
