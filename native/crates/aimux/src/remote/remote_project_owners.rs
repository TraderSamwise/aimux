//! Which machine owns a checkout, asked of the relay.
//!
//! The record is there and not in a machine's own project registry, because
//! that registry is per machine: an owner written locally is one machine's
//! belief, and both would write themselves first and neither would ever learn
//! it was not the owner.

use crate::machine_identity::MachineIdentity;
use crate::remote::relay_http::{relay_request, response_error};
use serde_json::{Value, json};

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
