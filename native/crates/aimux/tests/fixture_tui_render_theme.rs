use aimux::tui_render::text::strip_ansi;
use aimux::tui_render::theme::{
    CardSpec, ChipTone, Column, FooterHint, KeyTone, StatusKind, Tone, card, chip, cols, divider,
    footer_hints, keycap, keycap_hint, keycap_hint_lines, keycap_hints, pad_visible, pill, recede,
    render_footer_hints, status_dot, status_tone, style, tmux_invert, tmux_style, visible_width,
};
use serde::Deserialize;
use serde_json::{Map, Value, json};

const FIXTURE: &str = include_str!("../../../../testdata/contracts/v1/tui/render-theme.json");

#[derive(Debug, Deserialize)]
struct Contract {
    cases: Vec<Case>,
}

#[derive(Debug, Deserialize)]
struct Case {
    id: String,
    name: String,
    input: Value,
    output: Value,
}

#[test]
fn tui_render_theme_contract_matches_typescript() {
    let contract: Contract =
        serde_json::from_str(FIXTURE).expect("tui render theme fixture parses");
    assert_eq!(contract.cases.len(), 36);

    let mut failures = Vec::new();
    for case in contract.cases {
        let actual = run_case(&case.input);
        if actual != case.output {
            failures.push(format!(
                "{} ({})\nexpected: {}\nactual:   {}",
                case.id, case.name, case.output, actual
            ));
        }
    }

    assert!(failures.is_empty(), "{}", failures.join("\n\n"));
}

fn run_case(input: &Value) -> Value {
    match input["api"].as_str().unwrap_or_default() {
        "style" => json!(style(
            string(input, "text").as_str(),
            tone(input["tone"].as_str())
        )),
        "statusDot" => json!(status_dot(status_kind(input["kind"].as_str()))),
        "statusTone" => json!(tone_name(status_tone(status_kind(input["kind"].as_str())))),
        "visibleWidth" => json!(visible_width(string(input, "text").as_str())),
        "pill" => json!(pill(
            string(input, "label").as_str(),
            tone(input["tone"].as_str())
        )),
        "chip" => json!(chip(
            string(input, "label").as_str(),
            chip_tone(input["tone"].as_str())
        )),
        "keycap" => json!(keycap(
            string(input, "key").as_str(),
            key_tone(input["tone"].as_str())
        )),
        "keycapHint" => json!(keycap_hint(
            string(input, "key").as_str(),
            input.get("label").and_then(Value::as_str).unwrap_or(""),
            key_tone(input["tone"].as_str())
        )),
        "keycapHints" => json!(keycap_hints(string(input, "line").as_str())),
        "footerHints" => json!(footer_hints(string(input, "line").as_str())),
        "keycapHintLines" => json!(keycap_hint_lines(
            string(input, "line").as_str(),
            input["width"].as_u64().unwrap_or_default() as usize
        )),
        "renderFooterHints" => json!(render_footer_hints(
            &footer_hint_array(&input["hints"]),
            input["width"].as_u64().unwrap_or_default() as usize
        )),
        "padVisible" => json!(pad_visible(
            string(input, "text").as_str(),
            input["width"].as_u64().unwrap_or_default() as usize
        )),
        "cols" => {
            let column_values = input["columns"].as_array().cloned().unwrap_or_default();
            let contents = column_values
                .iter()
                .map(|column| string(column, "content"))
                .collect::<Vec<_>>();
            let columns = column_values
                .iter()
                .zip(contents.iter())
                .map(|(column, content)| Column {
                    content,
                    width: column["width"].as_u64().unwrap_or_default() as usize,
                })
                .collect::<Vec<_>>();
            json!(cols(&columns))
        }
        "divider" => json!(divider(
            input["width"].as_u64().unwrap_or_default() as usize,
            input
                .get("tone")
                .and_then(Value::as_str)
                .map_or(Tone::Muted, |tone_value| tone(Some(tone_value)))
        )),
        "recede" => json!(recede(string(input, "text").as_str())),
        "tmuxStyle" => json!(tmux_style(
            string(input, "text").as_str(),
            tone(input["tone"].as_str())
        )),
        "tmuxInvert" => json!(tmux_invert(
            string(input, "text").as_str(),
            tone(input["tone"].as_str())
        )),
        "card" => json!(card_from_input(&input["spec"])),
        "stripAnsi" => json!(strip_ansi(string(input, "text").as_str())),
        "visibleWidthsForStyles" => {
            let mut out = Map::new();
            for tone_value in input["tones"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
            {
                out.insert(
                    tone_value.to_owned(),
                    json!(visible_width(&style(
                        string(input, "text").as_str(),
                        tone(Some(tone_value))
                    ))),
                );
            }
            Value::Object(out)
        }
        "visibleWidthsForStatusDots" => {
            let mut out = Map::new();
            for kind in input["statusKinds"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
            {
                out.insert(
                    kind.to_owned(),
                    json!(visible_width(&status_dot(status_kind(Some(kind))))),
                );
            }
            Value::Object(out)
        }
        api => panic!("unknown tui render theme api: {api}"),
    }
}

fn card_from_input(spec: &Value) -> Vec<String> {
    let rows = spec["rows"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
    card(&CardSpec {
        tone: tone(spec["tone"].as_str()),
        title: string(spec, "title").as_str(),
        summary: spec.get("summary").and_then(Value::as_str),
        rows: &rows,
        width: spec["width"].as_u64().unwrap_or_default() as usize,
    })
}

fn footer_hint_array(value: &Value) -> Vec<FooterHint<'_>> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let values = entry.as_array()?;
            Some(FooterHint {
                key: values.first().and_then(Value::as_str).unwrap_or(""),
                label: values.get(1).and_then(Value::as_str).unwrap_or(""),
                tone: key_tone(values.get(2).and_then(Value::as_str)),
            })
        })
        .collect()
}

fn string(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn tone(value: Option<&str>) -> Tone {
    match value.unwrap_or("text") {
        "muted" => Tone::Muted,
        "strong" => Tone::Strong,
        "accent" => Tone::Accent,
        "work" => Tone::Work,
        "attn" => Tone::Attention,
        "done" => Tone::Done,
        "danger" => Tone::Danger,
        "blocked" => Tone::Blocked,
        "info" => Tone::Info,
        "ready" => Tone::Ready,
        "idle" => Tone::Idle,
        "sleep" => Tone::Sleep,
        _ => Tone::Text,
    }
}

fn tone_name(value: Tone) -> &'static str {
    match value {
        Tone::Text => "text",
        Tone::Muted => "muted",
        Tone::Strong => "strong",
        Tone::Accent => "accent",
        Tone::Work => "work",
        Tone::Attention => "attn",
        Tone::Done => "done",
        Tone::Danger => "danger",
        Tone::Blocked => "blocked",
        Tone::Info => "info",
        Tone::Ready => "ready",
        Tone::Idle => "idle",
        Tone::Sleep => "sleep",
    }
}

fn chip_tone(value: Option<&str>) -> ChipTone {
    match value.unwrap_or("info") {
        "work" => ChipTone::Work,
        "attn" => ChipTone::Attention,
        "muted" => ChipTone::Muted,
        "danger" => ChipTone::Danger,
        _ => ChipTone::Info,
    }
}

fn key_tone(value: Option<&str>) -> Option<KeyTone> {
    (value == Some("danger")).then_some(KeyTone::Danger)
}

fn status_kind(value: Option<&str>) -> StatusKind {
    match value.unwrap_or("working") {
        "ready" => StatusKind::Ready,
        "idle" => StatusKind::Idle,
        "offline" => StatusKind::Offline,
        "needs" => StatusKind::Needs,
        "error" => StatusKind::Error,
        "done" => StatusKind::Done,
        "blocked" => StatusKind::Blocked,
        "service" => StatusKind::Service,
        "serviceOff" => StatusKind::ServiceOff,
        _ => StatusKind::Working,
    }
}
