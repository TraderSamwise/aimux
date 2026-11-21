//! Which machine hosts the swarm overseer.
//!
//! The swarm overseer is pinned to ONE machine, chosen deliberately, and the
//! default is the machine it was started from. That is the same shape as
//! project ownership: deliberate, moved by hand, and a machine that does not
//! hold it refuses by NAMING the one that does rather than quietly running a
//! second copy.
//!
//! Two swarm overseers would be worse than none. Each would be talking to the
//! same overseers on the same machines, and nothing downstream could tell
//! whose instruction it was answering -- so the decision below has no
//! "whichever is online" arm, and an unreadable config refuses rather than
//! guessing.
//!
//! Parsing is separate from the file I/O for the reason `fleet_usage.rs` gives:
//! these rules are the part worth proving and they are provable without a disk.

use serde_json::{Value, json};

/// Whether this machine should host the swarm overseer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SwarmHostDecision {
    /// This machine holds it.
    Host,
    /// Another machine holds it, named so the refusal can say where to look.
    Elsewhere(String),
    /// Nobody holds it yet. Starting here would claim it.
    Unclaimed,
    /// The config could not be understood, with the reason.
    ///
    /// Distinct from `Unclaimed` on purpose: an unreadable config may already
    /// name a host, and treating it as unclaimed is how a second swarm
    /// overseer starts.
    Unreadable(String),
}

/// Read the pinned host out of an already-loaded config.
///
/// `this_machine` is compared rather than trusted: a machine id that is not a
/// valid identity is not evidence of a machine, which is the rule
/// `assert_peer_allowed` already applies to a peer stamp. A config naming an
/// invalid host is `Unreadable`, because somebody meant something by it and we
/// cannot tell which machine.
pub fn swarm_host_decision(config: &Value, this_machine: &str) -> SwarmHostDecision {
    let Some(block) = config.get("swarm") else {
        return SwarmHostDecision::Unclaimed;
    };
    let Some(block) = block.as_object() else {
        return SwarmHostDecision::Unreadable(
            "swarm is not an object in the Aimux config".to_owned(),
        );
    };
    let Some(host) = block.get("host") else {
        return SwarmHostDecision::Unclaimed;
    };
    let Some(host) = host.as_str().map(str::trim) else {
        return SwarmHostDecision::Unreadable(
            "swarm.host is not a string in the Aimux config".to_owned(),
        );
    };
    if host.is_empty() {
        // An empty host is nobody, which is the same as never having chosen.
        // Said here rather than refused, because clearing the choice writes no
        // key at all and an empty string is what a hand edit leaves behind.
        return SwarmHostDecision::Unclaimed;
    }
    if !crate::machine_identity::is_valid_machine_id(host) {
        return SwarmHostDecision::Unreadable(format!(
            "swarm.host is {host:?}, which is not a machine id"
        ));
    }
    if host == this_machine {
        SwarmHostDecision::Host
    } else {
        SwarmHostDecision::Elsewhere(host.to_owned())
    }
}

/// Why this machine may not start a swarm overseer, if it may not.
///
/// `Ok(())` when it holds the pin or nothing does. The error NAMES the holder,
/// because "already running somewhere" without saying where leaves somebody
/// checking five machines by hand -- and the point of the swarm overseer is to
/// stop doing that.
pub fn refuse_unless_swarm_host(config: &Value, this_machine: &str) -> Result<(), String> {
    match swarm_host_decision(config, this_machine) {
        SwarmHostDecision::Host | SwarmHostDecision::Unclaimed => Ok(()),
        SwarmHostDecision::Elsewhere(host) => Err(format!(
            "the swarm overseer is pinned to {host}; move it with `aimux swarm host {this_machine}` before starting one here"
        )),
        SwarmHostDecision::Unreadable(reason) => Err(format!(
            "the swarm host on this machine could not be read, so no swarm overseer was started: {reason}"
        )),
    }
}

/// Pin the swarm overseer to a machine, or clear the pin.
///
/// `None` clears it, which means "nobody holds it" -- a real instruction,
/// distinct from pinning to this machine, and the only way to hand the swarm
/// to a machine that is currently off.
///
/// Refuses an id that is not a machine identity: storing one would produce a
/// config that `swarm_host_decision` then calls unreadable, which by design
/// refuses to start a swarm overseer anywhere. Caught here, where the person
/// is still looking at what they typed.
///
/// Everything outside the `swarm` block survives, because other features own
/// the rest of the file.
pub fn with_swarm_host(config: &Value, machine_id: Option<&str>) -> Result<Value, String> {
    if let Some(machine_id) = machine_id
        && !crate::machine_identity::is_valid_machine_id(machine_id)
    {
        return Err(format!("{machine_id:?} is not a machine id"));
    }
    let mut next = config.clone();
    let root = next
        .as_object_mut()
        .ok_or_else(|| "the Aimux config is not an object".to_owned())?;
    let block = root
        .entry("swarm")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or_else(|| "swarm is not an object in the Aimux config".to_owned())?;
    match machine_id {
        Some(machine_id) => {
            block.insert("host".to_owned(), Value::String(machine_id.to_owned()));
        }
        // Removed rather than nulled, so a cleared pin leaves a config that
        // reads the same as one where nobody ever chose.
        None => {
            block.remove("host");
        }
    }
    Ok(next)
}

/// What the pin is, for a route to report.
pub fn swarm_host_report(decision: &SwarmHostDecision) -> Value {
    match decision {
        SwarmHostDecision::Host => json!({ "ok": true, "host": null, "thisMachine": true }),
        SwarmHostDecision::Elsewhere(host) => {
            json!({ "ok": true, "host": host, "thisMachine": false })
        }
        SwarmHostDecision::Unclaimed => {
            json!({ "ok": true, "host": null, "thisMachine": false })
        }
        // No `host` key at all, for the reason `unknown_machines_report` omits
        // `machines`: a null host would read as unclaimed, which is the
        // opposite of what an unreadable config means.
        SwarmHostDecision::Unreadable(reason) => json!({ "ok": false, "error": reason }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_config_with_no_swarm_block_is_unclaimed() {
        assert_eq!(
            swarm_host_decision(&json!({ "somethingElse": true }), "mbp"),
            SwarmHostDecision::Unclaimed
        );
        assert!(refuse_unless_swarm_host(&json!({}), "mbp").is_ok());
    }

    #[test]
    fn this_machine_holding_the_pin_may_start_one() {
        let config = json!({ "swarm": { "host": "mbp" } });
        assert_eq!(swarm_host_decision(&config, "mbp"), SwarmHostDecision::Host);
        assert!(refuse_unless_swarm_host(&config, "mbp").is_ok());
    }

    /// The invariant the module exists for. Two swarm overseers would each be
    /// talking to the same overseers on the same machines, and nothing
    /// downstream could tell whose instruction it was answering.
    #[test]
    fn another_machine_holding_the_pin_refuses_and_names_it() {
        let config = json!({ "swarm": { "host": "mini" } });
        assert_eq!(
            swarm_host_decision(&config, "mbp"),
            SwarmHostDecision::Elsewhere("mini".to_owned())
        );
        let error = refuse_unless_swarm_host(&config, "mbp")
            .expect_err("a machine that does not hold the pin must refuse");
        assert!(error.contains("pinned to mini"), "{error}");
        assert!(
            error.contains("aimux swarm host mbp"),
            "the refusal did not say how to move it: {error}"
        );
    }

    /// Unreadable is not unclaimed. An unreadable config may already name a
    /// host, so treating it as unclaimed is exactly how a second swarm
    /// overseer starts.
    #[test]
    fn an_unreadable_block_refuses_rather_than_reading_as_unclaimed() {
        for config in [
            json!({ "swarm": "mini" }),
            json!({ "swarm": { "host": 7 } }),
            json!({ "swarm": { "host": "Not A Machine" } }),
        ] {
            match swarm_host_decision(&config, "mbp") {
                SwarmHostDecision::Unreadable(_) => {}
                other => panic!("{config} parsed as {other:?}"),
            }
            let error = refuse_unless_swarm_host(&config, "mbp")
                .expect_err("an unreadable swarm block must refuse");
            assert!(error.contains("could not be read"), "{error}");
            assert!(
                error.contains("no swarm overseer was started"),
                "the refusal did not say nothing happened: {error}"
            );
        }
    }

    /// A hand edit leaves an empty string behind, and nobody is a real answer.
    #[test]
    fn an_empty_host_is_unclaimed_rather_than_unreadable() {
        assert_eq!(
            swarm_host_decision(&json!({ "swarm": { "host": "   " } }), "mbp"),
            SwarmHostDecision::Unclaimed
        );
    }

    #[test]
    fn pinning_records_the_machine_and_keeps_the_rest_of_the_config() {
        let config = json!({ "somethingElse": { "keep": true } });
        let next = with_swarm_host(&config, Some("mini")).expect("mini is a machine id");
        assert_eq!(next["swarm"]["host"], json!("mini"));
        assert_eq!(next["somethingElse"], json!({ "keep": true }));
        assert_eq!(
            swarm_host_decision(&next, "mbp"),
            SwarmHostDecision::Elsewhere("mini".to_owned())
        );
    }

    /// A typo must not be storable: it would produce a config that refuses to
    /// start a swarm overseer ANYWHERE, and the error would point at the config
    /// rather than at the command that broke it.
    #[test]
    fn pinning_to_something_that_is_not_a_machine_id_is_refused() {
        let error = with_swarm_host(&json!({}), Some("Sam's Laptop"))
            .expect_err("that is not a machine id");
        assert!(error.contains("is not a machine id"), "{error}");
    }

    #[test]
    fn clearing_the_pin_removes_the_key_rather_than_nulling_it() {
        let config = json!({ "swarm": { "host": "mini" } });
        let next = with_swarm_host(&config, None).expect("clearing always works");
        assert!(
            next["swarm"].get("host").is_none(),
            "host was nulled rather than removed: {next}"
        );
        assert_eq!(
            swarm_host_decision(&next, "mbp"),
            SwarmHostDecision::Unclaimed
        );
    }

    /// The report keeps the three outcomes apart, including the one that must
    /// not look like an answer.
    #[test]
    fn an_unreadable_report_carries_no_host_key() {
        let report = swarm_host_report(&SwarmHostDecision::Unreadable("broken".to_owned()));
        assert_eq!(report["ok"], json!(false));
        assert!(
            report.get("host").is_none(),
            "an unreadable config reported a host: {report}"
        );
    }
}
