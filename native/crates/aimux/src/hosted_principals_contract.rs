use aimux::hosted_lock::lock_path_for;
use aimux::hosted_principals::{
    HOSTED_HASH_PREFIX, HOSTED_TOKEN_PREFIX, HostedGrant, HostedPrincipal, HostedPrincipalsState,
    HostedPrincipalsStore, clear_hosted_principals_cache, hash_hosted_token, principal_has_grant,
};
use aimux::paths::PathResolver;
use serde_json::{Value, json};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub fn run_hosted_principals_contract_case(input: &Value) -> Value {
    let fixture = Fixture::new();
    match str_field(input, "scenario") {
        "empty" => json!(fixture.store.load().expect("load empty principals")),
        "token-hash-only" => token_hash_only(&fixture),
        "store-modes" => store_modes(&fixture),
        "resolve-live-token" => resolve_live_token(&fixture),
        "revoke-token" => revoke_token(&fixture),
        "grant-scope" => grant_scope(&fixture),
        "grant-root-normalization" => grant_root_normalization(&fixture),
        "revoked-grant" => revoked_grant(&fixture),
        "duplicate-partial-grants" => duplicate_partial_grants(&fixture),
        "grant-revoked-principal" => grant_revoked_principal(&fixture),
        "ungrant-session" => ungrant_session(&fixture),
        "separate-principals" => separate_principals(&fixture),
        "last-seen-throttle" => last_seen_throttle(&fixture),
        "count-active" => count_active(&fixture),
        "relative-root-check" => relative_root_check(&fixture),
        "lock-released" => lock_released(&fixture),
        "stale-lock" => stale_lock(&fixture),
        "unreadable-store" => unreadable_store(&fixture),
        "malformed-corrupt-store" => malformed_corrupt_store(&fixture),
        "short-hash" => short_hash(&fixture),
        scenario => panic!("unknown hosted principals scenario: {scenario}"),
    }
}

struct Fixture {
    root: PathBuf,
    store: HostedPrincipalsStore,
}

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "aimux-hosted-principals-contract-{}-{}",
            std::process::id(),
            unix_millis(SystemTime::now())
        ));
        fs::create_dir_all(&root).expect("fixture root");
        let resolver = PathResolver::new(
            "/",
            &root,
            Some(root.join(".aimux").to_string_lossy().into_owned()),
        );
        Self {
            root,
            store: HostedPrincipalsStore::with_resolver(resolver),
        }
    }

    fn grant(&self, root: &str, session_id: &str) -> HostedGrant {
        HostedGrant {
            project_root: root.to_owned(),
            session_id: session_id.to_owned(),
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
        clear_hosted_principals_cache();
    }
}

fn token_hash_only(fixture: &Fixture) -> Value {
    let (_principal, token) = fixture
        .store
        .create_principal("grand")
        .expect("create principal");
    let raw = fs::read_to_string(fixture.store.principals_path()).expect("principals raw");
    let state = fixture.store.load().expect("load created principal");
    let hash = &state.principals[0].token_hash;
    json!({
        "tokenHasPrefix": token.starts_with(HOSTED_TOKEN_PREFIX),
        "hashMatchesToken": *hash == hash_hosted_token(&token),
        "hashHasPrefix": hash.starts_with(HOSTED_HASH_PREFIX),
        "rawContainsToken": raw.contains(&token),
        "rawContainsHash": raw.contains(hash),
    })
}

fn store_modes(fixture: &Fixture) -> Value {
    fixture
        .store
        .create_principal("grand")
        .expect("create principal");
    json!({
        "fileMode": mode_for(&fixture.store.principals_path()),
        "dirMode": mode_for(&fixture.store.hosted_dir()),
    })
}

fn resolve_live_token(fixture: &Fixture) -> Value {
    let (principal, token) = fixture
        .store
        .create_principal("grand")
        .expect("create principal");
    json!({
        "liveMatches": fixture.store.find_principal_by_token(&token).expect("find token").map(|found| found.id) == Some(principal.id),
        "unknown": principal_id(fixture.store.find_principal_by_token("amx_unknown").expect("find unknown")),
        "empty": principal_id(fixture.store.find_principal_by_token("").expect("find empty")),
        "blank": principal_id(fixture.store.find_principal_by_token("   ").expect("find blank")),
    })
}

fn revoke_token(fixture: &Fixture) -> Value {
    let (principal, token) = fixture
        .store
        .create_principal("grand")
        .expect("create principal");
    let first = fixture
        .store
        .revoke_principal(&principal.id)
        .expect("revoke principal");
    json!({
        "first": first,
        "resolvedAfterRevoke": principal_id(fixture.store.find_principal_by_token(&token).expect("find revoked")),
        "second": fixture.store.revoke_principal(&principal.id).expect("revoke again"),
        "missing": fixture.store.revoke_principal("prn_missing").expect("revoke missing"),
    })
}

fn grant_scope(fixture: &Fixture) -> Value {
    let (principal, _token) = fixture
        .store
        .create_principal("grand")
        .expect("create principal");
    let grant = fixture.grant("/srv/grand", "one");
    let granted = fixture
        .store
        .grant_session(&principal.id, grant.clone())
        .expect("grant session");
    let loaded = fixture
        .store
        .find_principal_by_id(&principal.id)
        .expect("find principal")
        .expect("principal exists");
    json!({
        "grant": granted,
        "same": principal_has_grant(&loaded, &grant),
        "differentProject": principal_has_grant(&loaded, &fixture.grant("/srv/other", "one")),
        "differentSession": principal_has_grant(&loaded, &fixture.grant("/srv/grand", "two")),
    })
}

fn grant_root_normalization(fixture: &Fixture) -> Value {
    let (principal, _token) = fixture
        .store
        .create_principal("grand")
        .expect("create principal");
    fixture
        .store
        .grant_session(&principal.id, fixture.grant("/srv/grand/", "one"))
        .expect("grant");
    let loaded = fixture
        .store
        .find_principal_by_id(&principal.id)
        .expect("find principal")
        .expect("principal exists");
    Value::Bool(principal_has_grant(
        &loaded,
        &fixture.grant("/srv/grand", "one"),
    ))
}

fn revoked_grant(fixture: &Fixture) -> Value {
    let (principal, _token) = fixture
        .store
        .create_principal("grand")
        .expect("create principal");
    fixture
        .store
        .grant_session(&principal.id, fixture.grant("/srv/grand", "one"))
        .expect("grant");
    fixture
        .store
        .revoke_principal(&principal.id)
        .expect("revoke");
    let loaded = fixture
        .store
        .find_principal_by_id(&principal.id)
        .expect("find principal")
        .expect("principal exists");
    Value::Bool(principal_has_grant(
        &loaded,
        &fixture.grant("/srv/grand", "one"),
    ))
}

fn duplicate_partial_grants(fixture: &Fixture) -> Value {
    let (principal, _token) = fixture
        .store
        .create_principal("grand")
        .expect("create principal");
    let grant = fixture.grant("/srv/grand", "one");
    fixture
        .store
        .grant_session(&principal.id, grant.clone())
        .expect("first grant");
    fixture
        .store
        .grant_session(&principal.id, grant)
        .expect("duplicate grant");
    let empty_root = fixture
        .store
        .grant_session(&principal.id, fixture.grant("", "one"))
        .expect("empty root");
    let empty_session = fixture
        .store
        .grant_session(&principal.id, fixture.grant("/srv/grand", ""))
        .expect("empty session");
    let loaded = fixture.store.load().expect("load");
    json!({
        "grantsLength": loaded.principals[0].grants.len(),
        "emptyRoot": empty_root,
        "emptySession": empty_session,
    })
}

fn grant_revoked_principal(fixture: &Fixture) -> Value {
    let (principal, _token) = fixture
        .store
        .create_principal("grand")
        .expect("create principal");
    fixture
        .store
        .revoke_principal(&principal.id)
        .expect("revoke");
    Value::Bool(
        fixture
            .store
            .grant_session(&principal.id, fixture.grant("/srv/grand", "one"))
            .expect("grant revoked"),
    )
}

fn ungrant_session(fixture: &Fixture) -> Value {
    let (principal, _token) = fixture
        .store
        .create_principal("grand")
        .expect("create principal");
    fixture
        .store
        .grant_session(&principal.id, fixture.grant("/srv/grand", "one"))
        .expect("grant one");
    fixture
        .store
        .grant_session(&principal.id, fixture.grant("/srv/grand", "two"))
        .expect("grant two");
    let first = fixture
        .store
        .ungrant_session(&principal.id, &fixture.grant("/srv/grand", "one"))
        .expect("ungrant one");
    let second = fixture
        .store
        .ungrant_session(&principal.id, &fixture.grant("/srv/grand", "one"))
        .expect("ungrant missing");
    let loaded = fixture
        .store
        .find_principal_by_id(&principal.id)
        .expect("find principal")
        .expect("principal exists");
    json!({ "first": first, "second": second, "grants": loaded.grants })
}

fn separate_principals(fixture: &Fixture) -> Value {
    let (first, _first_token) = fixture
        .store
        .create_principal("first")
        .expect("create first");
    let (second, second_token) = fixture
        .store
        .create_principal("second")
        .expect("create second");
    fixture
        .store
        .grant_session(&first.id, fixture.grant("/srv/grand", "one"))
        .expect("grant first");
    let resolved_second = fixture
        .store
        .find_principal_by_token(&second_token)
        .expect("find second")
        .map(|found| found.id)
        == Some(second.id.clone());
    let loaded_second = fixture
        .store
        .find_principal_by_id(&second.id)
        .expect("find second by id")
        .expect("second exists");
    json!({
        "resolvedSecond": resolved_second,
        "secondHasFirstGrant": principal_has_grant(&loaded_second, &fixture.grant("/srv/grand", "one")),
        "count": fixture.store.load().expect("load").principals.len(),
    })
}

fn last_seen_throttle(fixture: &Fixture) -> Value {
    let (principal, _token) = fixture
        .store
        .create_principal("a")
        .expect("create principal");
    fixture
        .store
        .mark_principal_seen_at(
            &principal.id,
            1_000_000,
            "1970-01-01T00:16:40.000Z".to_owned(),
        )
        .expect("mark seen");
    let first = fixture
        .store
        .find_principal_by_id(&principal.id)
        .expect("find after mark")
        .expect("principal exists");
    fixture
        .store
        .mark_principal_seen_at(
            &principal.id,
            1_000_001,
            "1970-01-01T00:16:40.001Z".to_owned(),
        )
        .expect("mark throttled");
    let second = fixture
        .store
        .find_principal_by_id(&principal.id)
        .expect("find after throttle")
        .expect("principal exists");
    json!({
        "lastSeenNotNull": first.last_seen_at.is_some(),
        "label": second.label,
        "throttledSame": first.last_seen_at == second.last_seen_at,
    })
}

fn count_active(fixture: &Fixture) -> Value {
    let empty = fixture
        .store
        .count_active_principals()
        .expect("count empty");
    let (first, _token) = fixture.store.create_principal("a").expect("create a");
    fixture.store.create_principal("b").expect("create b");
    let two = fixture.store.count_active_principals().expect("count two");
    fixture
        .store
        .revoke_principal(&first.id)
        .expect("revoke first");
    let one = fixture.store.count_active_principals().expect("count one");
    json!([empty, two, one])
}

fn relative_root_check(fixture: &Fixture) -> Value {
    let (principal, _token) = fixture
        .store
        .create_principal("grand")
        .expect("create principal");
    fixture
        .store
        .grant_session(&principal.id, fixture.grant("/srv/grand", "one"))
        .expect("grant");
    let loaded = fixture
        .store
        .find_principal_by_id(&principal.id)
        .expect("find")
        .expect("principal exists");
    json!({
        "relative": principal_has_grant(&loaded, &fixture.grant("srv/grand", "one")),
        "empty": principal_has_grant(&loaded, &fixture.grant("", "one")),
    })
}

fn lock_released(fixture: &Fixture) -> Value {
    fixture
        .store
        .create_principal("grand")
        .expect("create principal");
    json!({ "lockExists": lock_path_for(fixture.store.principals_path()).exists() })
}

fn stale_lock(fixture: &Fixture) -> Value {
    let lock_path = lock_path_for(fixture.store.principals_path());
    fs::create_dir_all(lock_path.parent().expect("lock parent")).expect("lock parent");
    fs::write(&lock_path, "stale").expect("write stale lock");
    set_mtime(&lock_path, SystemTime::now() - Duration::from_secs(60));
    let (principal, _token) = fixture
        .store
        .create_principal("grand")
        .expect("create after stale lock");
    json!({
        "ids": normalize_ids(&[principal.id]),
        "lockExists": lock_path.exists(),
    })
}

fn unreadable_store(fixture: &Fixture) -> Value {
    fixture.store.create_principal("a").expect("create a");
    set_mode(&fixture.store.principals_path(), 0o000);
    clear_hosted_principals_cache();
    let threw = fixture.store.create_principal("b").is_err();
    set_mode(&fixture.store.principals_path(), 0o600);
    clear_hosted_principals_cache();
    json!({
        "threw": threw,
        "count": fixture.store.load().expect("load after restore").principals.len(),
    })
}

fn malformed_corrupt_store(fixture: &Fixture) -> Value {
    let state = json!({
        "version": 1,
        "principals": [
            { "id": "prn_ok", "label": "ok", "tokenHash": hash_hosted_token("amx_ok"), "role": "owner", "grants": [], "createdAt": "2026-01-01T00:00:00.000Z", "revokedAt": null, "lastSeenAt": null },
            { "id": "", "tokenHash": hash_hosted_token("amx_bad") },
            { "id": "prn_bad", "tokenHash": "md5:nope" }
        ]
    });
    fs::create_dir_all(fixture.store.hosted_dir()).expect("hosted dir");
    fs::write(
        fixture.store.principals_path(),
        serde_json::to_string_pretty(&state).expect("serialize state"),
    )
    .expect("write malformed state");
    clear_hosted_principals_cache();
    let loaded = fixture.store.load().expect("load malformed");
    fs::write(fixture.store.principals_path(), "{not json").expect("write corrupt state");
    clear_hosted_principals_cache();
    let after_corrupt = fixture.store.load().expect("load corrupt");
    let quarantined = fs::read_dir(fixture.store.hosted_dir())
        .expect("read hosted dir")
        .filter_map(Result::ok)
        .any(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with("principals.json.corrupt-")
        });
    json!({
        "loadedIds": loaded.principals.into_iter().map(|principal| principal.id).collect::<Vec<_>>(),
        "afterCorrupt": after_corrupt,
        "quarantined": quarantined,
    })
}

fn short_hash(fixture: &Fixture) -> Value {
    let state = HostedPrincipalsState {
        version: 1,
        principals: vec![HostedPrincipal {
            id: "prn_short".to_owned(),
            label: "short".to_owned(),
            token_hash: "sha256:abc".to_owned(),
            role: "operator".to_owned(),
            grants: Vec::new(),
            created_at: "2026-01-01T00:00:00.000Z".to_owned(),
            revoked_at: None,
            last_seen_at: None,
        }],
    };
    fixture.store.save(&state).expect("save short hash");
    json!(principal_id(
        fixture
            .store
            .find_principal_by_token("amx_short")
            .expect("find short hash")
    ))
}

fn principal_id(principal: Option<HostedPrincipal>) -> Value {
    principal
        .map(|principal| Value::String(principal.id))
        .unwrap_or(Value::Null)
}

fn normalize_ids(ids: &[String]) -> Vec<String> {
    ids.iter()
        .enumerate()
        .map(|(index, _id)| format!("<principal:{}>", index + 1))
        .collect()
}

#[cfg(unix)]
fn mode_for(path: &Path) -> u32 {
    use std::os::unix::fs::MetadataExt;
    fs::metadata(path).expect("metadata").mode() & 0o777
}

#[cfg(not(unix))]
fn mode_for(_path: &Path) -> u32 {
    0
}

#[cfg(unix)]
fn set_mode(path: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).expect("set mode");
}

#[cfg(not(unix))]
fn set_mode(_path: &Path, _mode: u32) {}

#[cfg(unix)]
fn set_mtime(path: &Path, time: SystemTime) {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let duration = time.duration_since(UNIX_EPOCH).unwrap_or_default();
    let times = [
        libc::timespec {
            tv_sec: duration.as_secs() as libc::time_t,
            tv_nsec: duration.subsec_nanos() as libc::c_long,
        },
        libc::timespec {
            tv_sec: duration.as_secs() as libc::time_t,
            tv_nsec: duration.subsec_nanos() as libc::c_long,
        },
    ];
    let c_path = CString::new(path.as_os_str().as_bytes()).expect("path c string");
    let result = unsafe { libc::utimensat(libc::AT_FDCWD, c_path.as_ptr(), times.as_ptr(), 0) };
    assert_eq!(result, 0, "set stale lock mtime");
}

#[cfg(not(unix))]
fn set_mtime(_path: &Path, _time: SystemTime) {}

fn str_field<'a>(value: &'a Value, field: &str) -> &'a str {
    value.get(field).and_then(Value::as_str).unwrap_or_default()
}

fn unix_millis(time: SystemTime) -> u128 {
    time.duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}
