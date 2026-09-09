use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::{Value, json};

use crate::runtime_topology::{
    read_runtime_topology, update_runtime_topology, write_runtime_topology,
};

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub fn runtime_topology_store_contract(case: &Value) -> Value {
    match case["api"].as_str().unwrap_or_default() {
        "teamClone" => team_clone_contract(case),
        "readIsolation" => read_isolation_contract(case),
        "rewrittenFile" => rewritten_file_contract(case),
        "writeRead" => write_read_contract(case),
        "readYaml" => read_yaml_contract(case),
        "updateLock" => update_lock_contract(case),
        "staleLock" => stale_lock_contract(),
        api => json!({ "ok": false, "error": format!("unknown topology-store api: {api}") }),
    }
}

fn team_clone_contract(case: &Value) -> Value {
    with_topology_path(|path| {
        let topology = case["input"]["topology"].clone();
        write_runtime_topology(&path, &topology).expect("write topology");
        let written = read_runtime_topology(&path).expect("read written topology");
        let mut first = read_runtime_topology(&path).expect("read topology");
        if let Some(team) = first
            .get_mut("sessions")
            .and_then(Value::as_array_mut)
            .and_then(|sessions| sessions.first_mut())
            .and_then(|session| session.get_mut("team"))
            .and_then(Value::as_object_mut)
        {
            team.insert("name".into(), Value::String("read-mutated".into()));
            if let Some(members) = team.get_mut("members").and_then(Value::as_array_mut) {
                members.push(Value::String("injected".into()));
            }
        }
        let reread = read_runtime_topology(&path).expect("reread topology");
        json!({
            "writtenTeam": written["sessions"][0]["team"],
            "firstTeamBeforeMutation": case["input"]["topology"]["sessions"][0]["team"],
            "rereadTeam": reread["sessions"][0]["team"],
        })
    })
}

fn read_isolation_contract(case: &Value) -> Value {
    with_topology_path(|path| {
        write_runtime_topology(&path, &case["input"]["topology"]).expect("write topology");
        let pristine = read_runtime_topology(&path).expect("read pristine topology");
        let mut mutated = read_runtime_topology(&path).expect("read mutable topology");
        mutated["sessions"][0]["args"]
            .as_array_mut()
            .expect("session args")
            .push(Value::String("injected".into()));
        mutated["sessions"][0]["command"] = Value::String("clobbered".into());
        mutated["services"][0]["args"]
            .as_array_mut()
            .expect("service args")
            .push(Value::String("injected".into()));
        mutated["worktrees"][0]["path"] = Value::String("/clobbered".into());
        mutated["nodes"][0]["cwd"] = Value::String("/clobbered".into());
        mutated["rigs"][0]["name"] = Value::String("clobbered".into());
        mutated["bindings"][0]["tmuxSession"] = Value::String("clobbered".into());
        mutated["lifecycleOperations"][0]["targetId"] = Value::String("clobbered".into());
        mutated["exchangeRefs"][0]["exchangeId"] = Value::String("clobbered".into());
        let reread = read_runtime_topology(&path).expect("reread topology");
        json!({ "pristine": pristine, "reread": reread, "equal": reread == pristine })
    })
}

fn rewritten_file_contract(case: &Value) -> Value {
    with_topology_path(|path| {
        write_runtime_topology(&path, &case["input"]["topology"]).expect("write topology");
        let first = read_runtime_topology(&path).expect("read first");
        let before = fs::read_to_string(&path).expect("read raw yaml");
        let after = before.replace("name: aimux", "name: aimuz");
        fs::write(&path, &after).expect("rewrite yaml");
        let second = read_runtime_topology(&path).expect("read second");
        let _ = fs::remove_file(&path);
        let deleted = read_runtime_topology(&path).expect("read missing topology");
        json!({
            "firstName": first["rigs"][0]["name"],
            "secondName": second["rigs"][0]["name"],
            "afterDeleteRigCount": deleted["rigs"].as_array().map_or(0, Vec::len),
            "sameLength": before.len() == after.len(),
        })
    })
}

fn write_read_contract(case: &Value) -> Value {
    with_topology_path(|path| {
        let result = write_runtime_topology(&path, &case["input"]["topology"])
            .map_err(|error| error.to_string())
            .and_then(|_| read_runtime_topology(&path));
        match result {
            Ok(value) => json!({ "ok": true, "value": value }),
            Err(error) => json!({ "ok": false, "error": error }),
        }
    })
}

fn read_yaml_contract(case: &Value) -> Value {
    with_topology_path(|path| {
        fs::write(&path, case["input"]["yaml"].as_str().unwrap_or_default()).expect("write yaml");
        match read_runtime_topology(&path) {
            Ok(value) => json!({ "ok": true, "value": value }),
            Err(error) => json!({ "ok": false, "error": normalize_error(&error) }),
        }
    })
}

fn update_lock_contract(case: &Value) -> Value {
    with_topology_path(|path| {
        let topology = case["input"]["topology"].clone();
        let updated = update_runtime_topology(&path, |_| topology).expect("update topology");
        json!({
            "lockExists": lock_path(&path).exists(),
            "sessions": updated["sessions"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|session| session.get("id").and_then(Value::as_str))
                .collect::<Vec<_>>(),
        })
    })
}

fn stale_lock_contract() -> Value {
    with_topology_path(|path| {
        let lock = lock_path(&path);
        fs::create_dir_all(&lock).expect("mkdir lock");
        fs::write(lock.join("owner"), "2147483647\n").expect("write owner");
        std::thread::sleep(std::time::Duration::from_millis(1100));
        let updated = update_runtime_topology(&path, |topology| topology).expect("update topology");
        json!({ "lockExists": lock.exists(), "version": updated["version"] })
    })
}

fn with_topology_path(run: impl FnOnce(PathBuf) -> Value) -> Value {
    let dir = std::env::temp_dir().join(format!(
        "aimux-runtime-topology-store-fixture-{}-{}",
        std::process::id(),
        TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("mkdir temp topology dir");
    let output = run(dir.join("runtime-topology.yaml"));
    let _ = fs::remove_dir_all(dir);
    output
}

fn lock_path(path: &std::path::Path) -> PathBuf {
    PathBuf::from(format!("{}.lock", path.display()))
}

fn normalize_error(error: &str) -> String {
    if error.starts_with("invalid runtime topology:") {
        error.to_owned()
    } else if let Some(rest) = error.strip_prefix("unsupported runtime topology version: ") {
        format!("unsupported runtime topology version: {rest}")
    } else {
        error.to_owned()
    }
}
