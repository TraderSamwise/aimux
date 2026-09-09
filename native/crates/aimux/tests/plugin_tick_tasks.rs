use aimux::plugin_project_service_host::builtin_plugin_tick_tasks;
use aimux::plugin_registry::{NativePluginRegistry, builtin_native_plugins};

#[test]
fn every_builtin_plugin_gets_a_tick_task() {
    let registered = NativePluginRegistry::builtins().plugin_names();
    let mut ticked = builtin_plugin_tick_tasks()
        .iter()
        .map(|task| task.name().to_owned())
        .collect::<Vec<_>>();
    let mut registered = registered;
    registered.sort();
    ticked.sort();

    assert_eq!(
        registered, ticked,
        "a plugin with a startup status but no tick would silently never run"
    );
}

#[test]
fn the_gh_plugin_polls_far_less_often_than_the_transcript_plugin() {
    let intervals = builtin_native_plugins()
        .into_iter()
        .map(|(interval_ms, plugin)| (plugin.manifest().name, interval_ms))
        .collect::<std::collections::BTreeMap<_, _>>();

    let gh = intervals
        .iter()
        .find(|(name, _)| name.contains("pr"))
        .map(|(_, interval)| *interval)
        .expect("gh pr context plugin");
    let transcript = intervals
        .iter()
        .find(|(name, _)| name.contains("transcript"))
        .map(|(_, interval)| *interval)
        .expect("transcript length plugin");

    // it shells out to `gh` per session; ticking it at the transcript cadence
    // would spawn processes continuously
    assert!(gh >= transcript * 10, "gh={gh} transcript={transcript}");
}
