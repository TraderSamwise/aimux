import { isValidMachineId } from "./machines.js";

const SHARING_STATE_KEY = "sharing-state:v1";
const INVITE_TOKEN_BYTES = 32;
const MAX_SHARES = 200;
/// The stored length of a project root. A report has to be folded to the same
/// length before it is compared, or a longer root can never match its share.
const MAX_PROJECT_ROOT_CHARS = 600;
const MAX_INVITES_PER_SHARE = 50;
/// How many machines may have reported roots.
///
/// An account has a handful, but `MachineIdentity::ephemeral` mints a fresh id
/// whenever the identity file cannot be read or written, so ids accumulate
/// without machines accumulating. The ceiling is what stops that growing for
/// ever -- and eviction prefers the ids that are NOT connected, which is
/// exactly what a stale ephemeral id is. A connected machine is only ever
/// dropped when more than this many are connected at once.
///
/// Dropping a machine is not free: it widens the routing candidates, and a
/// share that names no host is REFUSED when there is more than one candidate.
/// So this is a bound on storage paid for with a refusal, and the eviction
/// order is chosen to spend it on machines that cannot be routed to anyway.
const MAX_REPORTING_MACHINES = 100;
/// The floor applied when a stored record is read back.
///
/// Higher than the report-time ceiling on purpose: pruning at report time can
/// see which machines are connected and this cannot, so a record that somehow
/// grew past the ceiling is trimmed here only once it is absurd, and the
/// connectivity-aware rule gets the first say. Both keep the same end of the
/// sorted ids, so which machines survive does not depend on which path ran.
const MAX_STORED_REPORTING_MACHINES = 2 * MAX_REPORTING_MACHINES;
export const SHARE_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type ShareParticipantRole = "owner" | "guest";
export type ShareParticipantStatus = "active" | "removed";
export type ShareInviteStatus = "pending" | "accepted" | "revoked";
export type ShareChatMode = "single" | "multi";

export interface ShareActor {
  userId: string;
  displayName: string;
  email?: string;
  role: ShareParticipantRole;
}

export interface ShareParticipantRecord extends ShareActor {
  status: ShareParticipantStatus;
  joinedAt: string;
  removedAt?: string;
  lastSeenAt?: string;
}

export interface ShareInviteRecord {
  id: string;
  email: string;
  tokenHash: string;
  status: ShareInviteStatus;
  createdAt: string;
  expiresAt: string;
  acceptedAt?: string;
  acceptedByUserId?: string;
  revokedAt?: string;
}

export interface SharedSessionRecord {
  id: string;
  ownerUserId: string;
  projectRoot: string;
  serviceEndpoint?: ShareServiceEndpoint;
  // Which of the owner's machines hosts this session. Absent on shares made
  // before machines existed; the relay then needs there to be only one.
  machineId?: string;
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  participants: Record<string, ShareParticipantRecord>;
  invites: Record<string, ShareInviteRecord>;
  /// When a report last tried to refresh this share's receivers.
  ///
  /// Per share, not a cursor over all of them: a cursor is written by
  /// whichever machine reported last, and each machine's report only contains
  /// its own shares -- so a second machine with one stale share froze the
  /// first machine's window and ten of its shares were never attempted again.
  lastReceiverRefreshAt?: string;
  /// Receivers whose own copy of this share could not be refreshed.
  ///
  /// A guest routes on the copy in ITS object, not this record, so a refresh
  /// that failed leaves that guest on a dead port while this record is right.
  /// Kept so a later report retries them, which the endpoint comparison alone
  /// would never do -- by then this record matches and nothing looks stale.
  staleReceivers?: string[];
}

export interface SharingState {
  version: 1;
  shares: Record<string, SharedSessionRecord>;
  acceptedShares?: Record<string, SharedSessionSummary>;
  /// Which project roots each machine last reported a service for.
  ///
  /// Written by the endpoint report. It exists so a share that names no host
  /// can still be routed: the machine that has the checkout is the machine
  /// that reports it, which is a far better answer than "the only one
  /// connected" and the only one that survives a second daemon starting.
  machineProjectRoots?: Record<string, string[]>;
}

export interface ShareInviteToken {
  token: string;
  share: SharedSessionRecord;
  invite: ShareInviteRecord;
}

export interface SharedSessionSummary {
  id: string;
  ownerUserId: string;
  projectRoot: string;
  serviceEndpoint?: ShareServiceEndpoint;
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  mode: ShareChatMode;
  /**
   * Whether the share names the machine that holds the session.
   *
   * Which machine is never said -- the shape of the account is not a guest's
   * business -- but whether the share can be routed at all is, because a
   * share that names none refuses every request with a message about a
   * disconnected host while the host is sitting right there. The owner needs
   * it to offer the repair; a guest reading `false` learns why it refuses.
   *
   * Absent, not false, on a copy stored before this existed: "nobody knows"
   * and "no host" are different answers, and only the second one is an offer
   * to repair something.
   */
  hostBound?: boolean;
  participants: ShareParticipantRecord[];
  invites: Array<Omit<ShareInviteRecord, "tokenHash">>;
}

export interface CreateShareInviteInput {
  owner: ShareActor;
  projectRoot: string;
  serviceEndpoint?: ShareServiceEndpoint;
  /**
   * Which of the owner's machines hosts the session.
   *
   * Required of every caller that can know it, so a new share is never left
   * for the project-root guess to route -- two machines with the same checkout
   * path both claim it, and the route then refuses a share whose host is
   * sitting right there.
   *
   * Still `| undefined` rather than absent, because a daemon that connected
   * without a usable id is tagged `unidentified` and `sanitizeShareMachineId`
   * folds that to nothing: a hard requirement would take sharing away from
   * such an owner entirely. The relay accepts the absence and refuses the
   * route with its own named reason instead.
   */
  machineId: string | undefined;
  sessionId: string;
  email: string;
  now?: string;
}

export interface ShareServiceEndpoint {
  host: string;
  port: number;
}

export interface AcceptShareInviteInput {
  token: string;
  actor: ShareActor;
  now?: string;
}

export function emptySharingState(): SharingState {
  return { version: 1, shares: {}, acceptedShares: {} };
}

/// Note which roots a machine reported, for routing shares that name no host.
///
/// Replaces that machine's list rather than merging: a project removed from a
/// machine has to stop being attributed to it, or a share would be routed to
/// a host that no longer has the checkout.
export function rememberMachineProjectRoots(
  state: SharingState,
  machineId: string | undefined,
  projectRoots: readonly string[],
  options?: {
    /// The machines connected right now, so eviction can prefer the ids that
    /// cannot be routed to. Omitted means "nothing is known to be connected",
    /// which falls back to the id order alone.
    connectedMachineIds?: readonly string[];
  },
): SharingState {
  const machine = sanitizeShareMachineId(machineId);
  if (!machine) return state;
  const roots = normalizeReportedRoots(projectRoots);
  const current = state.machineProjectRoots ?? {};
  const held = claimedProjectRoots(current, machine);
  if (held.length === roots.length && held.every((root, index) => root === roots[index])) {
    return state;
  }
  const next = { ...current, [machine]: roots };
  const excess = Object.keys(next).length - MAX_REPORTING_MACHINES;
  if (excess > 0) {
    for (const evicted of evictionOrder(Object.keys(next), options?.connectedMachineIds).slice(
      0,
      // One more than the excess, because the reporter may be in this list and
      // is always skipped.
      excess + 1,
    )) {
      if (evicted === machine) continue;
      delete next[evicted];
      if (Object.keys(next).length <= MAX_REPORTING_MACHINES) break;
    }
  }
  return { ...state, machineProjectRoots: next };
}

/// Who to drop first when the report index is full.
///
/// A machine that is not connected cannot be routed to at all, and re-reports
/// within one tick of reconnecting, so it costs nothing to forget. A stale
/// ephemeral id -- the realistic reason this list ever gets long -- is never
/// connected again, so it is always at the front of this order and a live
/// host is never evicted in its place. Ties break on the id, so every object
/// and every load agrees on who went.
function evictionOrder(machines: readonly string[], connected: readonly string[] | undefined): string[] {
  const live = new Set(connected ?? []);
  return [...machines].sort((left, right) => {
    const leftLive = live.has(left) ? 1 : 0;
    const rightLive = live.has(right) ? 1 : 0;
    return leftLive === rightLive ? left.localeCompare(right) : leftLive - rightLive;
  });
}

/// The roots a machine has claimed, for a record that came back from storage.
///
/// `isValidMachineId` admits `constructor`, so a plain property read on this
/// object can return a function rather than a list and `.includes` then throws
/// inside a guest's request. The key has to be the machine's OWN, and the
/// value has to be a list, before either is believed.
function claimedProjectRoots(reported: Record<string, string[]> | undefined, machineId: string): readonly string[] {
  if (!reported || !Object.hasOwn(reported, machineId)) return [];
  const roots = reported[machineId];
  return Array.isArray(roots) ? roots : [];
}

function normalizeReportedRoots(roots: unknown): string[] {
  if (!Array.isArray(roots)) return [];
  return [
    ...new Set(
      roots
        .filter((root): root is string => typeof root === "string")
        .map(shareProjectRootKey)
        .filter(Boolean),
    ),
  ]
    .sort()
    .slice(0, MAX_SHARES);
}

/// What a stored report index is allowed to be.
///
/// It is read back from durable storage and routes guests, so it is not
/// trusted to still be the shape it was written in: a machine id that is no
/// longer valid, a value that is not a list of strings, or a record grown past
/// its ceiling all have to resolve to "nothing reported for that machine",
/// which is the answer that widens the candidates instead of refusing a
/// guest.
function normalizeMachineProjectRoots(
  reported: SharingState["machineProjectRoots"],
): SharingState["machineProjectRoots"] {
  if (!reported || typeof reported !== "object") return undefined;
  const entries = Object.entries(reported)
    .map(([machineId, roots]) => [sanitizeShareMachineId(machineId), normalizeReportedRoots(roots)] as const)
    .filter((entry): entry is readonly [string, string[]] => Boolean(entry[0]) && entry[1].length > 0)
    .sort(([left], [right]) => left.localeCompare(right))
    // The same end the report-time eviction keeps: that drops the lowest ids
    // first, so a record trimmed on load must keep the highest.
    .slice(-MAX_STORED_REPORTING_MACHINES);
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

/// The connected machines that could be hosting this share.
///
/// A share that names a host is that host's, and this does not second-guess
/// it. A share that names none used to route only while exactly ONE machine
/// was connected -- so starting a second daemon anywhere killed it, with an
/// error saying the host was not connected while it was sitting right there.
///
/// Now the reports decide: the machine that has the checkout is the one that
/// reports a service for it. When nothing has been reported yet -- an older
/// daemon, or a relay that has just restarted -- every machine stays a
/// candidate, so this can only ever narrow the old answer, never widen it.
export function machinesHostingShare<T extends { id: string }>(
  state: SharingState,
  share: Pick<SharedSessionRecord, "machineId" | "projectRoot">,
  machines: readonly T[],
): readonly T[] {
  if (sanitizeShareMachineId(share.machineId)) return machines;
  const reported = state.machineProjectRoots ?? {};
  if (Object.keys(reported).length === 0) return machines;
  const wanted = shareProjectRootKey(share.projectRoot);
  if (!wanted) return machines;
  const hosting = machines.filter((machine) => claimedProjectRoots(reported, machine.id).includes(wanted));
  // Nobody has claimed it: say what was said before rather than inventing a
  // refusal out of an absence.
  return hosting.length === 0 ? machines : hosting;
}

/// The shares to refresh next: the ones waiting longest for a turn.
///
/// Least-recently-attempted rather than "the first N", because a permanently
/// unreachable guest would otherwise hold the whole budget for ever and
/// nothing else would be retried. Each share carries its own last-attempted
/// time, so a machine can only ever delay its OWN shares -- a shared cursor
/// let one machine's stale share freeze another machine's window, since every
/// report writes the cursor but each sees only its own candidates.
///
/// Ties break on the share id, so the order is the same on every object and
/// every load.
export function nextShareRefreshBatch(state: SharingState, candidates: Iterable<string>, limit: number): string[] {
  if (limit <= 0) return [];
  return [...new Set(candidates)]
    .filter((id) => state.shares[id])
    .sort((left, right) => {
      const leftAt = state.shares[left].lastReceiverRefreshAt ?? "";
      const rightAt = state.shares[right].lastReceiverRefreshAt ?? "";
      return leftAt === rightAt ? left.localeCompare(right) : leftAt.localeCompare(rightAt);
    })
    .slice(0, limit);
}

export async function loadSharingState(storage: DurableObjectStorage): Promise<SharingState> {
  const stored = await storage.get<SharingState>(SHARING_STATE_KEY);
  if (!stored || stored.version !== 1) return emptySharingState();
  return normalizeSharingState(stored);
}

export async function saveSharingState(storage: DurableObjectStorage, state: SharingState): Promise<void> {
  await storage.put(SHARING_STATE_KEY, normalizeSharingState(state));
}

export function normalizeSharingState(state: SharingState): SharingState {
  const shares = Object.fromEntries(
    Object.values(state.shares ?? {})
      .map(normalizeShare)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .slice(0, MAX_SHARES)
      .map((share) => [share.id, share]),
  );
  const acceptedShares = Object.fromEntries(
    Object.values(state.acceptedShares ?? {})
      .map(normalizeAcceptedShare)
      .filter((share): share is SharedSessionSummary => Boolean(share))
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .slice(0, MAX_SHARES)
      .map((share) => [acceptedShareKey(share.ownerUserId, share.id), share]),
  );
  return {
    version: 1,
    shares,
    acceptedShares,
    ...(() => {
      const machineProjectRoots = normalizeMachineProjectRoots(state.machineProjectRoots);
      return machineProjectRoots ? { machineProjectRoots } : {};
    })(),
  };
}

export function getShareChatMode(share: SharedSessionRecord): ShareChatMode {
  return activeParticipants(share).length >= 2 ? "multi" : "single";
}

export function summarizeShare(share: SharedSessionRecord): SharedSessionSummary {
  return {
    id: share.id,
    ownerUserId: share.ownerUserId,
    projectRoot: share.projectRoot,
    serviceEndpoint: share.serviceEndpoint,
    sessionId: share.sessionId,
    createdAt: share.createdAt,
    updatedAt: share.updatedAt,
    version: share.version,
    mode: getShareChatMode(share),
    hostBound: Boolean(sanitizeShareMachineId(share.machineId)),
    participants: Object.values(share.participants),
    invites: Object.values(share.invites).map(({ tokenHash: _tokenHash, ...invite }) => invite),
  };
}

export function upsertAcceptedShare(state: SharingState, share: SharedSessionSummary): SharingState {
  const current = normalizeSharingState(state);
  const normalized = normalizeAcceptedShare(share);
  if (!normalized) return current;
  current.acceptedShares = {
    ...(current.acceptedShares ?? {}),
    [acceptedShareKey(normalized.ownerUserId, normalized.id)]: normalized,
  };
  return normalizeSharingState(current);
}

export function removeAcceptedShare(state: SharingState, ownerUserId: string, shareId: string): SharingState {
  const current = normalizeSharingState(state);
  delete current.acceptedShares?.[acceptedShareKey(ownerUserId, shareId)];
  return normalizeSharingState(current);
}

export function listAcceptedShares(state: SharingState): SharedSessionSummary[] {
  return Object.values(normalizeSharingState(state).acceptedShares ?? {});
}

export function activeParticipants(share: SharedSessionRecord): ShareParticipantRecord[] {
  return Object.values(share.participants).filter((participant) => participant.status === "active");
}

export function findShareForSession(
  state: SharingState,
  ownerUserId: string,
  sessionId: string,
  machineId?: string,
  projectRoot?: string,
): SharedSessionRecord | undefined {
  const wanted = sanitizeShareMachineId(machineId);
  const forOwnerSession = Object.values(state.shares).filter(
    (share) => share.ownerUserId === ownerUserId && share.sessionId === sessionId,
  );
  // A session id names a session on one host. Matching without the machine
  // would let an invite for strix's `claude-1` rebind the guests of the mbp's
  // share of the same name to strix.
  if (wanted) {
    const sameMachine = forOwnerSession.find((share) => sanitizeShareMachineId(share.machineId) === wanted);
    if (sameMachine) return sameMachine;
  }
  // A share made before machines existed is the same share, and adopting it is
  // what lets a re-invite bind it rather than make a second one and strand its
  // guests on the first. But "unbound" says nothing about WHICH host made it,
  // so the checkout has to match too -- for a caller that names a machine AND
  // for one that cannot.
  //
  // That second case used to skip the checkout entirely, because an unbound
  // caller matched an unbound share on the machine comparison alone. An
  // invite sent from one checkout then adopted another checkout's share and
  // rewrote its `projectRoot`, which moved the guests already on it into a
  // project they were never shared.
  //
  // Two unbound candidates is a question, not an answer, so neither is taken.
  // Folded, not compared raw: `/repo` and `/repo/` are one checkout, and a
  // trailing slash made the re-invite miss its own share, create a second one,
  // and strand the first one's guests -- which is the outcome this adoption
  // exists to prevent.
  const wantedRoot = shareProjectRootKey(projectRoot);
  const adoptable = forOwnerSession.filter(
    (share) => !sanitizeShareMachineId(share.machineId) && shareProjectRootKey(share.projectRoot) === wantedRoot,
  );
  return adoptable.length === 1 ? adoptable[0] : undefined;
}

/// Why an existing share could not be bound to a machine.
///
/// Four ways to be wrong: the share is not the owner's to move, the machine
/// has told the relay nothing about what it holds, it has and this checkout
/// was not in it, or the checkout is being changed on a machine that still
/// has the one the share names -- which is a relocation dressed as a rename.
export type BindShareRefusal =
  | "no-such-share"
  | "machine-has-not-reported-its-checkouts"
  | "machine-does-not-hold-checkout"
  | "machine-still-holds-the-stored-checkout";

export interface BindShareMachineInput {
  owner: ShareActor;
  /// Which share, by id.
  ///
  /// Named rather than looked up from the session and the checkout, which is
  /// how the first draft did it. Two machines with the same path each make
  /// their own share of one session id, so that lookup had to choose -- and
  /// the surface offering the repair is showing ONE share, whose id it
  /// already has. Asking it to describe the share instead of naming it meant
  /// the share displayed and the share moved could differ, and a renamed
  /// checkout made its own share unfindable.
  shareId: string;
  machineId: string;
  /// The checkout the caller is looking at, when it has one.
  ///
  /// A checkout that was renamed or moved leaves the stored root behind, and
  /// the target machine reports the new one -- so checking against the stored
  /// root would refuse the repair for ever, on exactly the share that needs
  /// it. Given, it is what the machine must have reported and what the share
  /// records afterwards; this is the same thing an invite does with the root
  /// it came from, and for the same reason.
  projectRoot?: string;
  now?: string;
}

export type BindShareMachineResult =
  | { ok: true; state: SharingState; share: SharedSessionRecord; alreadyBound: boolean }
  | { ok: false; refusal: BindShareRefusal };

/// Point a share that already exists at the machine holding its session.
///
/// A share made before machines existed names no host, and the route then
/// refuses it -- with the host sitting right there. Re-inviting repairs it,
/// but costs a new token and another email to someone who already accepted.
/// This is that repair without the email.
///
/// It moves a share that already names a machine, rather than refusing: there
/// is no unbind route and a re-invite builds a SECOND share, so a refusal
/// would make one wrong press permanent. What stops a wrong press going
/// somewhere useless is the check below, not a refusal to move.
export function bindShareToMachine(state: SharingState, input: BindShareMachineInput): BindShareMachineResult {
  const now = input.now ?? new Date().toISOString();
  const owner = sanitizeActor(input.owner, "owner");
  const shareId = sanitizeRequiredText(input.shareId, 160, "shareId");
  // Binding to nothing is not a bind. An unusable id here would quietly write
  // `undefined` and report success over a share that still cannot be routed.
  const machineId = sanitizeShareMachineId(input.machineId);
  if (!machineId) throw new Error("machineId is required");

  const current = normalizeSharingState(state);
  const share = current.shares[shareId];
  // One refusal for "no such share" and "not yours", because they are the
  // same answer from here: nothing of the caller's by that id.
  if (!share || share.ownerUserId !== owner.userId) {
    return { ok: false, refusal: "no-such-share" };
  }

  // The machine has to look like it holds the checkout. Without this a bind
  // is a free hand: nothing here says the target has the project at all, so a
  // press from a machine that does not could point a share at a service that
  // has never heard of it.
  //
  // It does NOT establish that the target has that SESSION, and it cannot: a
  // session id is unique within a project service, not across the fleet, so
  // one checkout on two machines can hold two different `claude-1`s and this
  // passes for both. Pointing a share at the wrong one hands its guests the
  // other agent's transcript. Nothing available here tells them apart -- the
  // relay knows machines, roots and ports, never sessions -- so what stands
  // between the owner and that mistake is the button naming the machine it
  // would pick, and the press being repeatable from the right one. Written
  // out because the first version of this comment claimed the check stopped
  // it.
  //
  // The evidence is the endpoint report, which is what the routing already
  // narrows on. Asked per machine, and an absence is its own answer rather
  // than a free pass: a machine that has told the relay nothing has not told
  // it that it holds this checkout either, and a daemon with no projects at
  // all reports nothing, so reading silence as trust would bind a share to a
  // machine that provably cannot serve it -- and report success doing it. A
  // machine that has just connected is in that state for up to its first
  // report; the refusal says which absence it is, and pressing again once it
  // has reported works.
  const storedRoot = shareProjectRootKey(share.projectRoot);
  const wantedRoot = shareProjectRootKey(input.projectRoot?.trim() || share.projectRoot);
  const reported = claimedProjectRoots(current.machineProjectRoots, machineId);
  if (reported.length === 0) {
    return { ok: false, refusal: "machine-has-not-reported-its-checkouts" };
  }
  if (!reported.includes(wantedRoot)) {
    return { ok: false, refusal: "machine-does-not-hold-checkout" };
  }

  // Changing the share's checkout is for one case: the path moved or was
  // renamed, so the machine reports a root the share has never heard of while
  // the one it stores is gone. If the target still HAS the stored root this is
  // not a rename -- it is being told to carry the share's guests into another
  // project on the same machine, which they never accepted and nobody asked
  // for.
  const changingRoot = wantedRoot !== storedRoot;
  if (changingRoot && reported.includes(storedRoot)) {
    return { ok: false, refusal: "machine-still-holds-the-stored-checkout" };
  }
  const movedCheckout = changingRoot ? input.projectRoot?.trim() : undefined;
  // Nothing to write, so nothing is written: a repeated bind must not bump the
  // version every time and hand every guest a pointless refresh.
  if (!movedCheckout && sanitizeShareMachineId(share.machineId) === machineId) {
    return { ok: true, state: current, share, alreadyBound: true };
  }

  if (movedCheckout) {
    share.projectRoot = sanitizeRequiredText(movedCheckout, MAX_PROJECT_ROOT_CHARS, "projectRoot");
  }
  share.machineId = machineId;
  share.updatedAt = now;
  share.version += 1;
  current.shares[share.id] = normalizeShare(share);
  return {
    ok: true,
    state: normalizeSharingState(current),
    share: current.shares[share.id],
    alreadyBound: false,
  };
}

export async function createShareInvite(
  state: SharingState,
  input: CreateShareInviteInput,
): Promise<{ state: SharingState; token: ShareInviteToken }> {
  const now = input.now ?? new Date().toISOString();
  const owner = sanitizeActor(input.owner, "owner");
  const email = normalizeEmail(input.email);
  if (!email) throw new Error("Invite email is required");
  const sessionId = sanitizeRequiredText(input.sessionId, 160, "sessionId");
  const projectRoot = sanitizeRequiredText(input.projectRoot, 600, "projectRoot");
  const serviceEndpoint = sanitizeServiceEndpoint(input.serviceEndpoint);
  // The share is bricked by an endpoint a guest cannot build a proxy path
  // from, so an invite carrying one is refused rather than written: a share
  // created broken refuses every request from the person it was made for, and
  // says nothing about why.
  if (serviceEndpoint && !isRoutableShareHost(serviceEndpoint.host)) {
    throw new Error("serviceEndpoint host is not routable");
  }
  const machineId = sanitizeShareMachineId(input.machineId);
  const current = normalizeSharingState(state);
  const share =
    findShareForSession(current, owner.userId, sessionId, machineId, projectRoot) ??
    createShare({ owner, projectRoot, serviceEndpoint, machineId, sessionId, now });
  if (serviceEndpoint) {
    share.serviceEndpoint = serviceEndpoint;
  }
  if (machineId) {
    share.machineId = machineId;
  }
  // The checkout the share names tracks the one the invite came from. Without
  // this a moved or renamed checkout left the stored root behind, and because
  // adoption of an unbound share requires the root to match, the next invite
  // made a second share and stranded the first one's guests.
  share.projectRoot = projectRoot;

  const token = randomBase64Url(INVITE_TOKEN_BYTES);
  const invite: ShareInviteRecord = {
    id: randomBase64Url(16),
    email,
    tokenHash: await sha256Base64Url(token),
    status: "pending",
    createdAt: now,
    expiresAt: new Date(Date.parse(now) + SHARE_INVITE_TTL_MS).toISOString(),
  };
  share.invites[invite.id] = invite;
  share.updatedAt = now;
  share.version += 1;
  current.shares[share.id] = normalizeShare(share);
  return { state: normalizeSharingState(current), token: { token, share: current.shares[share.id], invite } };
}

export async function acceptShareInvite(
  state: SharingState,
  input: AcceptShareInviteInput,
): Promise<{ state: SharingState; share: SharedSessionRecord; participant: ShareParticipantRecord }> {
  const now = input.now ?? new Date().toISOString();
  const tokenHash = await sha256Base64Url(input.token);
  const current = normalizeSharingState(state);
  const match = findInviteByTokenHash(current, tokenHash);
  if (!match) throw new Error("Invite is invalid, expired, or already used");
  const { share, invite } = match;
  const actor = sanitizeActor(input.actor, "guest");
  const actorEmail = normalizeEmail(actor.email);
  if (actorEmail && actorEmail !== invite.email) {
    throw new Error("Invite email does not match authenticated user");
  }

  const participant: ShareParticipantRecord = {
    ...actor,
    email: actorEmail ?? invite.email,
    role: "guest",
    status: "active",
    joinedAt: now,
    lastSeenAt: now,
  };
  const existing = share.participants[participant.userId];
  if (existing?.role === "owner") {
    throw new Error("Owner cannot accept a guest invite");
  }
  invite.status = "accepted";
  invite.acceptedAt = now;
  invite.acceptedByUserId = actor.userId;
  share.participants[participant.userId] = participant;
  share.updatedAt = now;
  share.version += 1;
  current.shares[share.id] = normalizeShare(share);
  return { state: normalizeSharingState(current), share: current.shares[share.id], participant };
}

export function removeShareParticipant(
  state: SharingState,
  shareId: string,
  userId: string,
  now = new Date().toISOString(),
): { state: SharingState; share?: SharedSessionRecord } {
  const current = normalizeSharingState(state);
  const share = current.shares[shareId];
  if (!share) return { state: current };
  const participant = share.participants[userId];
  if (!participant || participant.role === "owner") return { state: current, share };
  share.participants[userId] = { ...participant, status: "removed", removedAt: now };
  share.updatedAt = now;
  share.version += 1;
  current.shares[share.id] = normalizeShare(share);
  return { state: normalizeSharingState(current), share: current.shares[share.id] };
}

export function revokeShareInvite(
  state: SharingState,
  shareId: string,
  inviteId: string,
  now = new Date().toISOString(),
): { state: SharingState; share?: SharedSessionRecord; invite?: ShareInviteRecord } {
  const current = normalizeSharingState(state);
  const share = current.shares[shareId];
  if (!share) return { state: current };
  const invite = share.invites[inviteId];
  if (!invite) return { state: current, share };
  if (invite.status === "revoked") return { state: current, share, invite };
  share.invites[inviteId] = { ...invite, status: "revoked", revokedAt: now };
  share.updatedAt = now;
  share.version += 1;
  current.shares[share.id] = normalizeShare(share);
  const normalizedShare = current.shares[share.id];
  return {
    state: normalizeSharingState(current),
    share: normalizedShare,
    invite: normalizedShare?.invites[inviteId],
  };
}

export function isSharedRelayRequestAllowed(
  input: { method: string; path: string; sessionId?: string },
  share: SharedSessionRecord,
): boolean {
  const method = input.method.toUpperCase();
  const path = normalizePath(input.path);
  const sessionId = input.sessionId?.trim();

  // `/plans/<sessionId>` names its session in the path, where
  // `sessionIdFromRequest` -- which reads the query and the body -- cannot see
  // it. Compared against the share here rather than falling through to a
  // check that would never find it.
  if (method === "GET") {
    const planSession = planRouteSession(path);
    if (planSession) return planSession === share.sessionId;
  }

  if (!sessionId || sessionId !== share.sessionId) return false;
  if (method === "GET" && /^\/attachments\/[A-Za-z0-9_-]{1,128}\/content$/.test(path)) return true;
  if (
    method === "GET" &&
    (path === "/agents/history" ||
      path === "/agents/output" ||
      // Without the stream a guest's transcript only moves when it re-asks,
      // and the composer's confirmation deadline assumes a stream that pushes.
      path === "/agents/output/stream" ||
      path === "/live-pane/output" ||
      path === "/events")
  ) {
    return true;
  }
  // Sharing is full trust over the shared session: a guest owns the agent they
  // were given, including stopping and killing it. Inviting and revoking are
  // the owner's alone and have no route here. The session check above still
  // holds for every one of these, so this is wider authority over one session,
  // never over the project.
  if (
    method === "POST" &&
    (path === "/live-pane/input" ||
      // Answering the agent's own question, which is the same authority as
      // typing the option's number into the composer.
      path === "/live-pane/select" ||
      path === "/attachments" ||
      path === "/live-pane/interrupt" ||
      path === "/agents/interrupt" ||
      path === "/agents/stop" ||
      path === "/agents/resume" ||
      path === "/agents/kill" ||
      path === "/agents/fork")
  ) {
    return true;
  }
  return false;
}

function planRouteSession(path: string): string | undefined {
  const match = /^\/plans\/([A-Za-z0-9_-]{1,128})$/.exec(path);
  return match?.[1];
}

export function sharedRelayRequestAccess(
  input: { method: string; path: string; body?: unknown },
  share: SharedSessionRecord,
): { allowed: boolean; path: string; sessionId?: string } {
  const path = unwrapProxyPath(input.path);
  const sessionId = sessionIdFromRequest(input.method, path, input.body);
  return {
    allowed: isSharedRelayRequestAllowed({ method: input.method, path, sessionId }, share),
    path,
    sessionId,
  };
}

export function actorDisplayPrefix(actor: ShareActor): string {
  return `[${sanitizeDisplayName(actor.displayName)}]`;
}

export function stripTrustedAimuxHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const safeHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase().startsWith("x-aimux-")) continue;
    safeHeaders[key] = value;
  }
  return safeHeaders;
}

function createShare(input: {
  owner: ShareActor;
  projectRoot: string;
  serviceEndpoint?: ShareServiceEndpoint;
  machineId?: string;
  sessionId: string;
  now: string;
}): SharedSessionRecord {
  const owner: ShareParticipantRecord = {
    ...input.owner,
    role: "owner",
    status: "active",
    joinedAt: input.now,
    lastSeenAt: input.now,
  };
  return {
    id: randomBase64Url(16),
    ownerUserId: owner.userId,
    projectRoot: input.projectRoot,
    serviceEndpoint: input.serviceEndpoint,
    machineId: input.machineId,
    sessionId: input.sessionId,
    createdAt: input.now,
    updatedAt: input.now,
    version: 1,
    participants: { [owner.userId]: owner },
    invites: {},
  };
}

/// The one filter that decides whether a share names a usable host.
///
/// Exported because three things ask that question -- the routing, the
/// summary's `hostBound`, and a guest's host indicator -- and reading the
/// field raw in any of them is how one record came to have three answers.
export function sanitizeShareMachineId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && isValidMachineId(trimmed) ? trimmed : undefined;
}

function normalizeShare(share: SharedSessionRecord): SharedSessionRecord {
  const nowMs = Date.now();
  const serviceEndpoint = sanitizeServiceEndpoint(share.serviceEndpoint);
  const invites = Object.fromEntries(
    Object.values(share.invites ?? {})
      .filter((invite) => {
        if (invite.status !== "pending") return true;
        const expiresAtMs = Date.parse(invite.expiresAt);
        return Number.isFinite(expiresAtMs) && expiresAtMs > nowMs;
      })
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, MAX_INVITES_PER_SHARE)
      .map((invite) => [invite.id, invite]),
  );
  return {
    ...share,
    serviceEndpoint,
    machineId: sanitizeShareMachineId(share.machineId),
    version: Number.isFinite(share.version) ? share.version : 1,
    participants: share.participants ?? {},
    invites,
  };
}

function normalizeAcceptedShare(share: SharedSessionSummary | undefined): SharedSessionSummary | undefined {
  if (!share?.id || !share.ownerUserId || !share.sessionId || !share.projectRoot) return undefined;
  const serviceEndpoint = sanitizeServiceEndpoint(share.serviceEndpoint);
  if (!serviceEndpoint) return undefined;
  return {
    id: sanitizeRequiredText(share.id, 160, "shareId"),
    ownerUserId: sanitizeRequiredText(share.ownerUserId, 160, "ownerUserId"),
    projectRoot: sanitizeRequiredText(share.projectRoot, MAX_PROJECT_ROOT_CHARS, "projectRoot"),
    serviceEndpoint,
    sessionId: sanitizeRequiredText(share.sessionId, 160, "sessionId"),
    createdAt: sanitizeRequiredText(share.createdAt, 80, "createdAt"),
    updatedAt: sanitizeRequiredText(share.updatedAt, 80, "updatedAt"),
    version: Number.isFinite(share.version) ? share.version : 1,
    mode: share.mode === "multi" ? "multi" : "single",
    // Rebuilt field by field, so a field not named here is dropped: a stored
    // copy would go on saying nothing about its host forever.
    ...(typeof share.hostBound === "boolean" ? { hostBound: share.hostBound } : {}),
    participants: Array.isArray(share.participants) ? share.participants : [],
    invites: Array.isArray(share.invites) ? share.invites : [],
  };
}

function acceptedShareKey(ownerUserId: string, shareId: string): string {
  return `${ownerUserId}:${shareId}`;
}

function findInviteByTokenHash(
  state: SharingState,
  tokenHash: string,
): { share: SharedSessionRecord; invite: ShareInviteRecord } | undefined {
  const nowMs = Date.now();
  for (const share of Object.values(state.shares)) {
    for (const invite of Object.values(share.invites)) {
      if (invite.tokenHash !== tokenHash) continue;
      if (invite.status !== "pending") return undefined;
      const expiresAtMs = Date.parse(invite.expiresAt);
      if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) return undefined;
      return { share, invite };
    }
  }
  return undefined;
}

function sanitizeActor(actor: ShareActor, fallbackRole: ShareParticipantRole): ShareActor {
  return {
    userId: sanitizeRequiredText(actor.userId, 160, "userId"),
    displayName: sanitizeDisplayName(actor.displayName),
    email: normalizeEmail(actor.email),
    role: actor.role === "owner" || actor.role === "guest" ? actor.role : fallbackRole,
  };
}

function sanitizeDisplayName(value: string | undefined): string {
  const trimmed = value?.trim().replace(/\s+/g, " ");
  return trimmed ? trimmed.slice(0, 80) : "User";
}

function sanitizeRequiredText(value: string | undefined, maxLength: number, field: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`${field} is required`);
  return trimmed.slice(0, maxLength);
}

function normalizeEmail(value: string | undefined): string | undefined {
  const trimmed = value?.trim().toLowerCase();
  if (!trimmed) return undefined;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) throw new Error("Invalid email address");
  return trimmed.slice(0, 254);
}

/// Point a machine's shares at where its project services are listening NOW.
///
/// A share stored the endpoint once, when the invite was written, and nothing
/// ever moved it. A project service binds a fresh port every time it starts,
/// so the first restart after a share was created left every request from that
/// share going to a port nothing was on -- `Connection refused`, for ever,
/// with the daemon connected and the agent working. The share could only be
/// repaired by issuing another invite, which emails somebody.
///
/// Takes the whole report in one call, because normalizing this state is a
/// pass over every share and every invite: doing it per project turned a
/// fifty-project report into a tenth of a second of blocking work in the one
/// object that answers everything for that account.
export function updateShareServiceEndpoints(
  state: SharingState,
  input: {
    ownerUserId: string;
    machineId?: string;
    /// Whether the reporting machine is the only one the owner has connected.
    ///
    /// Decides what may be done with a share that names no host: see below.
    senderIsOnlyMachine?: boolean;
    endpoints: Array<{ projectRoot: string; serviceEndpoint: ShareServiceEndpoint }>;
    now?: string;
  },
): { state: SharingState; updated: string[]; matched: string[] } {
  const current = normalizeSharingState(state);
  if (!input.ownerUserId) return { state: current, updated: [], matched: [] };
  const byRoot = buildReportIndex(input.endpoints);
  if (byRoot.size === 0) return { state: current, updated: [], matched: [] };
  const machineId = sanitizeShareMachineId(input.machineId);
  const now = input.now ?? new Date().toISOString();
  const updated: string[] = [];
  const matched: string[] = [];
  for (const share of Object.values(current.shares)) {
    if (share.ownerUserId !== input.ownerUserId) continue;
    // A share bound to a host is that host's. The sender must BE it -- not
    // merely fail to say otherwise: a daemon that connected without a usable
    // machine id is tagged `unidentified`, and treating that as "no claim"
    // let it move every machine-bound share onto its own ports.
    if (share.machineId && share.machineId !== machineId) continue;
    // A share that names no host says nothing about WHICH host made it, and
    // the same checkout path on two machines is ordinary here. So the reporter
    // is only allowed to speak for it when it is the owner's only connected
    // machine -- which is exactly when `resolveSharedDaemonTarget` routes such
    // a share, and therefore exactly when this report describes the service
    // the guest would actually reach.
    //
    // With more than one machine connected the share is unroutable anyway
    // (that function refuses it), so moving its endpoint could only be a
    // guess: two machines would take turns overwriting it, every turn a
    // durable write and a push to every guest. Binding it to the first
    // reporter was worse still -- it is permanent, and a wrong guess breaks a
    // share that worked whenever its real host was the only one online.
    if (!share.machineId && input.senderIsOnlyMachine !== true) continue;
    const endpoint = byRoot.get(shareProjectRootKey(share.projectRoot));
    if (!endpoint) continue;
    matched.push(share.id);
    if (share.serviceEndpoint?.host === endpoint.host && share.serviceEndpoint?.port === endpoint.port) {
      continue;
    }
    share.serviceEndpoint = { ...endpoint };
    share.updatedAt = now;
    // A write that changes the record bumps the version, like every other
    // one. It used to move the endpoint and leave the version alone, which
    // made the version blind to this path -- and the report merge decides
    // whose copy of a summary is stale by asking whether the version moved.
    // Two overlapping reports therefore looked identical to one, and the
    // second one's work was saved over: its moved port reverted, and the
    // guest it could not reach left owed nothing.
    share.version += 1;
    updated.push(share.id);
  }
  return { state: current, updated, matched };
}

/// How a project root is compared between a report and a stored share.
///
/// The same function for both sides, and the ORDER matters: the stored copy
/// went through `sanitizeRequiredText(..., 600)` at write time, so truncation
/// happens before anything else. Folding the slash first and truncating after
/// made a root whose 600th character is a slash unmatchable for ever, because
/// the stored copy had already lost that slash to the cap.
///
/// A trailing slash is the same directory, and a non-match here is silent --
/// it looks exactly like "nothing moved" -- so the spellings have to be folded
/// rather than trusted to agree.
function shareProjectRootKey(projectRoot: string | undefined): string {
  const stored = projectRoot?.trim().slice(0, MAX_PROJECT_ROOT_CHARS) ?? "";
  const withoutTrailingSlash = stored.replace(/\/+$/, "");
  return withoutTrailingSlash || stored;
}

/// A report, indexed by exactly what a stored share can be compared against.
///
/// One key per entry, produced by the same function the stored root went
/// through, so the two sides cannot drift: truncate to the stored cap, THEN
/// fold the trailing slash. Doing it in the other order made a root whose
/// 600th character is a slash unmatchable -- the stored copy had already lost
/// the slash to truncation while the report still carried it.
///
/// A key two different endpoints claim is dropped rather than guessed at. The
/// stored root of a long path and the stored root of a shorter path that is
/// its 600-character prefix are the SAME STRING, so nothing in the data can
/// tell those two shares apart; moving either one would move the wrong
/// project's share, which is worse than the no-match it replaced. Reporting
/// one directory twice -- say once with a trailing slash -- is not that case,
/// because both carry the same endpoint.
function buildReportIndex(
  endpoints: Array<{ projectRoot: string; serviceEndpoint: ShareServiceEndpoint }>,
): Map<string, ShareServiceEndpoint> {
  const byKey = new Map<string, ShareServiceEndpoint | "ambiguous">();
  for (const entry of endpoints) {
    const endpoint = sanitizeServiceEndpoint(entry.serviceEndpoint);
    const key = shareProjectRootKey(entry.projectRoot);
    if (!endpoint || !key || !isRoutableShareHost(endpoint.host)) continue;
    const held = byKey.get(key);
    if (!held) {
      byKey.set(key, endpoint);
      continue;
    }
    if (held === "ambiguous") continue;
    if (held.host !== endpoint.host || held.port !== endpoint.port) byKey.set(key, "ambiguous");
  }
  const resolved = new Map<string, ShareServiceEndpoint>();
  for (const [key, endpoint] of byKey) {
    if (endpoint !== "ambiguous") resolved.set(key, endpoint);
  }
  return resolved;
}

function sanitizeServiceEndpoint(endpoint: ShareServiceEndpoint | undefined): ShareServiceEndpoint | undefined {
  const host = endpoint?.host?.trim();
  const port = Number(endpoint?.port);
  if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) return undefined;
  return { host: host.slice(0, 253), port };
}

/// Whether a guest could build its proxy path from this host.
///
/// A guest sends `/proxy/<host>/<port><path>`, matched by
/// `^\/proxy\/[^/]+\/\d+(\/.*)$`. A host carrying a slash produces a path the
/// share's own allowlist does not recognise, so every request from that guest
/// is refused as a route it may not use -- a share bricked by a value the
/// relay accepted. The charset admits every hostname, IPv4 and bracketed IPv6
/// form.
///
/// Deliberately NOT part of `sanitizeServiceEndpoint`: that runs on every read
/// of sharing state, and `normalizeAcceptedShare` drops an entry whose
/// endpoint is undefined -- so applying a new rule there would not refuse an
/// old host, it would delete the share that holds it.
function isRoutableShareHost(host: string): boolean {
  return /^[A-Za-z0-9._:[\]-]+$/.test(host);
}

function normalizePath(path: string): string {
  const pathname = new URL(path, "https://relay.local").pathname;
  return pathname.replace(/\/+$/, "") || "/";
}

function unwrapProxyPath(path: string): string {
  const url = new URL(path, "https://relay.local");
  const pathname = normalizePath(`${url.pathname}${url.search}`);
  const match = pathname.match(/^\/proxy\/[^/]+\/\d+(\/.*)$/);
  const unwrapped = match ? match[1] : pathname;
  return `${unwrapped}${url.search}`;
}

function sessionIdFromRequest(method: string, path: string, body: unknown): string | undefined {
  const bodySessionId =
    body && typeof body === "object" && "sessionId" in body
      ? String((body as { sessionId?: unknown }).sessionId ?? "")
      : "";
  const url = new URL(path, "https://relay.local");
  const querySessionId = url.searchParams.get("sessionId")?.trim() || "";
  if (bodySessionId.trim() && querySessionId && bodySessionId.trim() !== querySessionId) return undefined;
  return method.toUpperCase() === "POST" ? bodySessionId.trim() || undefined : querySessionId || undefined;
}

function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64UrlEncode(new Uint8Array(digest));
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
