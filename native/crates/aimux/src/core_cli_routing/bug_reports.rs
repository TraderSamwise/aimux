//! `aimux bug report` and `aimux bug list`.
//!
//! The flags are the whole of what a report may say. There is deliberately no
//! `--context`, `--log` or `--file`: the schema is the redaction, and
//! `docs/agent-bug-reports.md` says why.

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CoreBugReportArgs {
    pub what: Option<String>,
    pub surface: Option<String>,
    pub expected: Option<String>,
    pub observed: Option<String>,
    pub repro: Option<String>,
    pub evidence: Option<String>,
    pub json: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CoreBugListArgs {
    pub json: bool,
}

/// Every flag `bug report` takes, so the parser and the help cannot drift.
const REPORT_FLAGS: [&str; 6] = [
    "--what",
    "--surface",
    "--expected",
    "--observed",
    "--repro",
    "--evidence",
];

pub fn parse_core_bug_report_args<S: AsRef<str>>(args: &[S]) -> Option<CoreBugReportArgs> {
    if args.first().map(AsRef::as_ref) != Some("bug")
        || args.get(1).map(AsRef::as_ref) != Some("report")
    {
        return None;
    }
    let mut parsed = CoreBugReportArgs::default();
    let mut index = 2;
    while index < args.len() {
        let arg = args[index].as_ref();
        if arg == "--json" {
            parsed.json = true;
            index += 1;
            continue;
        }
        let mut matched = false;
        for flag in REPORT_FLAGS {
            if arg == flag {
                let value = args.get(index + 1)?.as_ref();
                // A flag whose value is the next flag is a missing value, not
                // a value that happens to look like one.
                if value.starts_with("--") {
                    return None;
                }
                assign(&mut parsed, flag, value.to_owned());
                index += 2;
                matched = true;
                break;
            }
            let inline = format!("{flag}=");
            if let Some(value) = arg.strip_prefix(inline.as_str()) {
                if value.is_empty() {
                    return None;
                }
                assign(&mut parsed, flag, value.to_owned());
                index += 1;
                matched = true;
                break;
            }
        }
        if !matched {
            return None;
        }
    }
    Some(parsed)
}

fn assign(parsed: &mut CoreBugReportArgs, flag: &str, value: String) {
    match flag {
        "--what" => parsed.what = Some(value),
        "--surface" => parsed.surface = Some(value),
        "--expected" => parsed.expected = Some(value),
        "--observed" => parsed.observed = Some(value),
        "--repro" => parsed.repro = Some(value),
        "--evidence" => parsed.evidence = Some(value),
        // Unreachable: `flag` only ever comes from REPORT_FLAGS, and leaving a
        // new flag unassigned would silently drop what an agent reported.
        other => unreachable!("unhandled bug report flag {other}"),
    }
}

pub fn parse_core_bug_list_args<S: AsRef<str>>(args: &[S]) -> Option<CoreBugListArgs> {
    if args.first().map(AsRef::as_ref) != Some("bug")
        || args.get(1).map(AsRef::as_ref) != Some("list")
    {
        return None;
    }
    let mut parsed = CoreBugListArgs::default();
    for arg in args.iter().skip(2) {
        if arg.as_ref() == "--json" {
            parsed.json = true;
            continue;
        }
        return None;
    }
    Some(parsed)
}
