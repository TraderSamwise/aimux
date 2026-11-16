//! Which machine owns a checkout, asked of the relay.
//!
//! The record is there and not in a machine's own project registry, because
//! that registry is per machine: an owner written locally is one machine's
//! belief, and both would write themselves first and neither would ever learn
//! it was not the owner.

use crate::machine_identity::MachineIdentity;
use crate::remote::relay_http::{relay_request, response_error};
use serde_json::{Value, json};

/// What a daemon knows about one checkout's owner.
///
/// `Unknown` is not a failure and not an absence: it is "the relay has not
/// told this machine yet", which is the state a daemon is in between starting
/// and its first frame, and after any reconnect. A caller that treats it as
/// `Unowned` routes local input that should have gone to another machine, and
/// one that treats it as an error refuses work it could have done locally.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProjectOwnerLookup {
    Unknown,
    Unowned,
    /// Two rows fold to the same key, so this cannot say which machine owns
    /// it.
    ///
    /// Its own outcome rather than `Unowned`, which it superficially resembles
    /// because both end up routing locally. `Unowned` is a fact about the
    /// table; this is a fact about the question, and a caller that wants to
    /// explain itself needs them apart. The sibling lookup
    /// `resolve_service_target_for_project_root` refuses ambiguity for the
    /// same reason -- picking the first match would aim a peer's keystrokes at
    /// whichever row happened to be ordered first.
    Ambiguous,
    Owned(ProjectOwner),
}

/// Whether to forward an input, and why not when not.
///
/// Pure, and separated from the supervisor for one reason: building a live
/// `RelayRunner` to ask this question is hard enough that the mapping went
/// untested, and "the container is hard to construct" is not a reason for the
/// decision inside it to be unproven. Every one of these reasons is a
/// different thing to tell somebody, so each is reachable from a test.
pub fn peer_owner_decision(
    lookup: ProjectOwnerLookup,
    this_machine_id: &str,
) -> (Option<String>, &'static str) {
    match lookup {
        ProjectOwnerLookup::Unknown => (None, "owner_unknown"),
        ProjectOwnerLookup::Unowned => (None, "owner_none"),
        ProjectOwnerLookup::Ambiguous => (None, "owner_ambiguous"),
        ProjectOwnerLookup::Owned(owner) => {
            // Validity BEFORE the self-comparison, and the order is the point.
            // `unidentified` is the slot every daemon without a persisted
            // identity shares, so a row naming it names no one machine --
            // including this one. Asked the other way round, a daemon with no
            // identity reading such a row answered `owner_is_this_machine`:
            // the right outcome for the wrong reason, which is the kind that
            // gets believed later.
            if !crate::machine_identity::is_valid_machine_id(&owner.machine_id) {
                return (None, "owner_unidentified");
            }
            if owner.machine_id == this_machine_id {
                return (None, "owner_is_this_machine");
            }
            if !owner.online {
                // Refused here rather than discovered at the far end: the
                // relay would answer `peer-target-offline`, and this says the
                // same thing without spending a round trip under the daemon's
                // runtime lock.
                return (None, "owner_offline");
            }
            (Some(owner.machine_id), "owner_elsewhere")
        }
    }
}

/// One row of the owner table, from whichever shape carried it.
///
/// The HTTP read and the pushed frame both produce these, and the parse was
/// copied into both: one trim rule and one set of required fields, or the two
/// disagree about which rows exist. A row naming no checkout or no machine can
/// neither be looked up nor routed to, so it is dropped rather than stored as
/// a row that matches nothing -- and the fields are TRIMMED first, because
/// `"  "` is not a checkout and the relay's own key trims before it folds.
pub fn project_owner_from_row(row: &Value) -> Option<ProjectOwner> {
    let text = |field: &str| {
        row.get(field)
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default()
            .to_owned()
    };
    let project_root = text("projectRoot");
    let machine_id = text("machineId");
    if project_root.is_empty() || machine_id.is_empty() {
        return None;
    }
    Some(ProjectOwner {
        project_root,
        machine_id,
        claimed_at: text("claimedAt"),
        // An unstated liveness is not a promise of one.
        online: row.get("online").and_then(Value::as_bool).unwrap_or(false),
    })
}

/// What the relay says about one checkout's owner.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectOwner {
    pub project_root: String,
    pub machine_id: String,
    pub claimed_at: String,
    /// Whether the owner is connected right now.
    ///
    /// Carried because "owned by a laptop that is shut" is the case the whole
    /// record exists to make visible, and it is the difference between "ask
    /// the owner" and "take it".
    pub online: bool,
}

/// Take ownership of this checkout for this machine.
///
/// Refused by the relay while another machine holds it and is connected, with
/// that machine named; `take` is how the owner overrules that deliberately.
pub fn claim_project_owner(
    project_root: &str,
    machine: &MachineIdentity,
    take: bool,
) -> Result<(ProjectOwner, bool), String> {
    let response = relay_request(
        "/projects/claim",
        "POST",
        Some(json!({
            "projectRoot": project_root,
            "machineId": machine.id,
            "take": take,
        })),
    )?;
    if response.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(response_error(&response, "Could not claim this checkout"));
    }
    let owner = response
        .get("owner")
        .ok_or_else(|| "Could not claim this checkout".to_owned())?;
    let already = response
        .get("alreadyOwned")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    Ok((
        ProjectOwner {
            project_root: project_root.to_owned(),
            machine_id: string_field(owner, "machineId"),
            claimed_at: string_field(owner, "claimedAt"),
            // The machine that just claimed it is the machine asking, so it is
            // connected by construction.
            online: true,
        },
        already,
    ))
}

/// Who owns what, including the checkouts this machine does not own -- which
/// is the half worth printing, because a record that only ever says "yes, you"
/// tells nobody anything.
pub fn list_project_owners() -> Result<Vec<ProjectOwner>, String> {
    let response = relay_request("/projects/owners", "GET", None)?;
    if response.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(response_error(
            &response,
            "Could not read who owns these checkouts",
        ));
    }
    Ok(response
        .get("owners")
        .and_then(Value::as_array)
        .map(|owners| {
            owners
                .iter()
                .map(|owner| ProjectOwner {
                    project_root: string_field(owner, "projectRoot"),
                    machine_id: string_field(owner, "machineId"),
                    claimed_at: string_field(owner, "claimedAt"),
                    online: owner
                        .get("online")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                })
                .filter(|owner| !owner.project_root.is_empty() && !owner.machine_id.is_empty())
                .collect()
        })
        .unwrap_or_default())
}

fn string_field(value: &Value, field: &str) -> String {
    value
        .get(field)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}
