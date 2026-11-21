//! Quota headroom across every machine in this account.
//!
//! One machine asking the others what their Claude and Codex accounts have
//! left. It is the first fleet read, and the fact the rest depend on: before
//! anything decides where work should go, or whether a stalled agent is
//! stalled because its account ran out, somebody has to be able to ask.
//!
//! The shape here is deliberately split. `build_fleet_usage_report` is pure,
//! so the thing worth proving -- that a machine which did not answer is still
//! in the report, carrying why -- is provable without a relay, a socket or a
//! second machine. A gate that needs a live fleet is a gate that does not run.

use serde_json::{Value, json};

/// What one machine said, or did not.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FleetPeerUsage {
    /// The peer answered. Its own `status` is kept rather than flattened to a
    /// boolean: a peer that replied `500` did answer, and that is a different
    /// fact from never having been asked.
    Answered {
        machine_id: String,
        status: u16,
        body: Value,
    },
    /// The peer did not answer. `reason` comes from `PeerRequestError::message`
    /// rather than from a sentence written here, because that type is what
    /// draws the distinction between a frame that never left and one that did
    /// -- and whoever writes the sentence twice eventually swaps them. The
    /// comment in `daemon_relay.rs` records that happening.
    Unanswered { machine_id: String, reason: String },
}

impl FleetPeerUsage {
    pub fn machine_id(&self) -> &str {
        match self {
            Self::Answered { machine_id, .. } | Self::Unanswered { machine_id, .. } => machine_id,
        }
    }
}

/// Fold the answers into one report in which every machine asked appears.
///
/// The invariant is that nothing drops out. A fleet view that silently omits
/// the machine it could not reach reads as a fleet where that machine has
/// nothing to report, which is the same mistake as a scan that cannot tell an
/// absent store from an unreadable one.
pub fn build_fleet_usage_report(peers: &[FleetPeerUsage]) -> Value {
    let machines: Vec<Value> = peers
        .iter()
        .map(|peer| match peer {
            FleetPeerUsage::Answered {
                machine_id,
                status,
                body,
            } => json!({
                "machineId": machine_id,
                // `ok` is about this read, not about the machine. A peer that
                // answered 500 is reachable and still did not give an answer
                // worth showing as headroom.
                "ok": *status == 200,
                "status": status,
                "usage": body,
            }),
            FleetPeerUsage::Unanswered { machine_id, reason } => json!({
                "machineId": machine_id,
                "ok": false,
                // No `status`: there was no reply to take one from, and
                // inventing a 0 or a 503 would read as something the peer
                // said.
                "error": reason,
            }),
        })
        .collect();
    // ORDERED HERE, NOT IN A RENDERER. Anything that is not a clean answer
    // comes first: a fleet read that buries the broken machine under the
    // healthy ones has not answered the question that made somebody run it.
    //
    // This used to live in the daemon's text renderer, which sorted its own
    // formatted strings. That left the CLI ordered and every JSON caller --
    // the app, the phone -- holding raw fan-out order, so the two surfaces
    // answered differently and the app would have had to re-derive the rule
    // next to its own renderer. Deriving it once here is what AGENTS.md's
    // "One Answer, Many Surfaces" asks for; a surface may filter or truncate
    // this order, but it must not compute a different one.
    //
    // The sort is stable and `false < true`, so failures keep the machine
    // order `fleet_machines` already established within each group.
    let mut machines = machines;
    machines.sort_by_key(|machine| machine.get("ok").and_then(Value::as_bool) == Some(true));
    json!({
        "ok": true,
        // The envelope's own `ok` says the fan-out ran, not that every machine
        // answered. `asked` is here so a caller can see at a glance that the
        // list is complete without counting it.
        "asked": peers.len(),
        "machines": machines,
    })
}

/// Put back any machine that produced no outcome at all.
///
/// A fan-out task that panicked returns no `FleetPeerUsage`, and the
/// `JoinError` it produces instead does not say which machine it was for. So
/// the list that came back is diffed against the list that was asked, and
/// anything missing is named rather than left out -- otherwise a panic is the
/// one failure that makes a machine vanish from the report instead of
/// appearing with a reason, which is exactly the hole the report exists to
/// close.
pub fn with_machines_that_produced_nothing(
    asked: &[String],
    mut peers: Vec<FleetPeerUsage>,
    reason: &str,
) -> Vec<FleetPeerUsage> {
    for machine_id in asked {
        if peers.iter().any(|peer| peer.machine_id() == machine_id) {
            continue;
        }
        peers.push(FleetPeerUsage::Unanswered {
            machine_id: machine_id.clone(),
            reason: reason.to_owned(),
        });
    }
    peers
}

/// Which machines there are to ask, or the fact that we cannot say.
///
/// `Unknown` is not an empty fleet. The relay pushes the owner table as a
/// snapshot, so before the first one arrives -- or if the lock holding it is
/// poisoned -- this machine genuinely does not know who else is out there.
/// Reporting that as "nobody" would render as a healthy fleet of one, which
/// is the same mistake as a scan that cannot tell an absent store from an
/// unreadable one. `project_owner_for` already answers its own question this
/// way, with `Unknown` separate from `Unowned`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FleetMachines {
    /// No snapshot has arrived, or it could not be read.
    Unknown(String),
    /// The relay said who is out there. Possibly nobody, which is an answer.
    Known(Vec<String>),
}

/// The answer when the machine list itself is what could not be had.
///
/// `ok: false` and no `machines` key at all, so it cannot be mistaken for a
/// successful read of an empty fleet. The two look identical if this returns
/// `machines: []`, and they mean opposite things.
pub fn unknown_machines_report(reason: &str) -> Value {
    json!({
        "ok": false,
        "error": reason,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn answered(machine: &str, status: u16) -> FleetPeerUsage {
        FleetPeerUsage::Answered {
            machine_id: machine.to_owned(),
            status,
            body: json!({ "windows": [{ "id": "claude-5h", "usedPercent": 41.0 }] }),
        }
    }

    #[test]
    fn a_machine_whose_task_produced_nothing_is_named_not_dropped() {
        let asked = vec!["mbp".to_owned(), "strix".to_owned(), "mini".to_owned()];
        // `strix` is absent the way a panicked task leaves it absent: no
        // outcome at all, and no error that says whose it was.
        let came_back = vec![answered("mbp", 200), answered("mini", 200)];

        let peers =
            with_machines_that_produced_nothing(&asked, came_back, "fan-out task did not finish");
        let report = build_fleet_usage_report(&peers);
        let machines = report["machines"].as_array().expect("machines");

        assert_eq!(machines.len(), 3, "a panicked machine vanished");
        let strix = machines
            .iter()
            .find(|machine| machine["machineId"] == "strix")
            .expect("strix is missing");
        assert_eq!(strix["ok"], false);
        assert_eq!(strix["error"], "fan-out task did not finish");
    }

    /// What needs attention comes first, and the report is where that is
    /// decided -- not in any one surface's renderer.
    ///
    /// A machine that answered 500 is as unhelpful as one that never answered,
    /// so both sort ahead of a healthy one. Within a group the order
    /// `fleet_machines` established survives, because the sort is stable.
    #[test]
    fn the_machines_that_need_attention_come_first() {
        let report = build_fleet_usage_report(&[
            FleetPeerUsage::Answered {
                machine_id: "aaa-healthy".to_owned(),
                status: 200,
                body: json!({}),
            },
            FleetPeerUsage::Unanswered {
                machine_id: "zzz-silent".to_owned(),
                reason: "peer was never asked, so it did not answer".to_owned(),
            },
            FleetPeerUsage::Answered {
                machine_id: "mmm-errored".to_owned(),
                status: 500,
                body: json!({}),
            },
            FleetPeerUsage::Answered {
                machine_id: "bbb-healthy".to_owned(),
                status: 200,
                body: json!({}),
            },
        ]);

        let order: Vec<&str> = report["machines"]
            .as_array()
            .expect("machines array")
            .iter()
            .map(|machine| machine["machineId"].as_str().expect("machineId"))
            .collect();

        assert_eq!(
            order,
            vec!["zzz-silent", "mmm-errored", "aaa-healthy", "bbb-healthy"],
            "the report did not put what needs attention first, or did not keep the given order within a group"
        );
    }

    #[test]
    fn not_knowing_the_machines_is_not_an_empty_fleet() {
        let unknown = unknown_machines_report("the relay has not sent the owner table yet");
        let empty_but_known = build_fleet_usage_report(&[]);

        // The distinction the whole enum exists for. These two must not be
        // confusable: one says "I could not find out", the other says "I
        // found out, and there is nobody".
        assert_eq!(unknown["ok"], false);
        assert_eq!(empty_but_known["ok"], true);
        assert!(
            unknown.get("machines").is_none(),
            "an unknown fleet offered a machine list: {unknown:?}"
        );
        assert_eq!(empty_but_known["asked"], 0);
        assert!(
            unknown["error"]
                .as_str()
                .is_some_and(|error| error.contains("owner table")),
            "{:?}",
            unknown["error"]
        );
    }

    #[test]
    fn a_machine_that_did_not_answer_is_still_in_the_report() {
        let report = build_fleet_usage_report(&[
            answered("mbp", 200),
            FleetPeerUsage::Unanswered {
                machine_id: "strix".to_owned(),
                reason: "peer was asked and did not answer in time; whether it acted is unknown"
                    .to_owned(),
            },
        ]);

        let machines = report["machines"].as_array().expect("machines");
        assert_eq!(machines.len(), 2, "a machine dropped out of the report");
        assert_eq!(report["asked"], 2);

        let strix = machines
            .iter()
            .find(|machine| machine["machineId"] == "strix")
            .expect("the unanswered machine is missing");
        assert_eq!(strix["ok"], false);
        // The reason is carried through rather than replaced by "unreachable",
        // because which of the four ways it failed is the part a person acts
        // on -- above all whether the read may have happened anyway.
        assert!(
            strix["error"]
                .as_str()
                .is_some_and(|error| error.contains("whether it acted is unknown")),
            "{:?}",
            strix["error"]
        );
        // And no invented status, because the peer said nothing to take one
        // from.
        assert!(strix.get("status").is_none(), "{strix:?}");
    }

    #[test]
    fn a_peer_that_answered_an_error_is_not_a_successful_read() {
        let report = build_fleet_usage_report(&[answered("mbp2", 500)]);
        let machine = &report["machines"][0];
        assert_eq!(machine["ok"], false, "a 500 counted as headroom");
        // Reachable, and the status proves it. This is the direction that
        // separates "answered badly" from "never answered", and collapsing
        // them would send someone to check a network that is fine.
        assert_eq!(machine["status"], 500);
        assert!(machine.get("error").is_none(), "{machine:?}");
    }

    #[test]
    fn every_machine_asked_appears_exactly_once() {
        let peers = [
            answered("mbp", 200),
            FleetPeerUsage::Unanswered {
                machine_id: "mini".to_owned(),
                reason: "peer request was not sent: socket is down".to_owned(),
            },
            answered("strix", 503),
        ];
        let report = build_fleet_usage_report(&peers);
        let machines = report["machines"].as_array().expect("machines");

        assert_eq!(machines.len(), peers.len());
        assert_eq!(report["asked"], peers.len());
        for peer in &peers {
            let found = machines
                .iter()
                .filter(|machine| machine["machineId"] == peer.machine_id())
                .count();
            assert_eq!(found, 1, "{} appeared {found} times", peer.machine_id());
        }
    }
}
