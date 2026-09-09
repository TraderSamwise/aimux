use aimux::tmux_expose::{
    DrawTileInput, GridLayout, TileContext, TmuxExposeOptions, build_tile_header, draw_tile,
    fit_header_rows,
};
use serde_json::{Value, json};
use std::path::PathBuf;

const TMUX_EXPOSE_RENDER: &str =
    include_str!("../../../../testdata/contracts/v1/tmux/expose-render.json");

#[test]
fn fixture_tmux_expose_render_matches_typescript_contract() {
    let contract: Value =
        serde_json::from_str(TMUX_EXPOSE_RENDER).expect("valid expose render fixture");
    let cases = contract["cases"].as_array().expect("expose render cases");
    assert_eq!(cases.len(), 7, "unexpected expose render case count");

    let mut failures = Vec::new();
    for case in cases {
        let actual = run_case(case);
        if actual != case["output"] {
            failures.push(json!({
                "id": case["id"],
                "name": case["name"],
                "expected": case["output"],
                "actual": actual,
            }));
        }
    }

    assert!(
        failures.is_empty(),
        "{} tmux-expose-render parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

fn run_case(case: &Value) -> Value {
    match case["api"].as_str().expect("api") {
        "buildTileHeader" => json!({
            "header": build_tile_header(
                case["input"]["textW"].as_i64().expect("text width"),
                case["input"]["width"].as_i64().expect("width"),
                case["input"]["titleLeft"].as_str().expect("title left"),
                case["input"]["context"].as_str().expect("context"),
                case["input"]["pillStr"].as_str().expect("pill string"),
                case["input"]["detail"].as_str().expect("detail"),
                case["input"]["inset"].as_i64().expect("inset"),
            )
        }),
        "fitHeaderRows" => json!({
            "rows": fit_header_rows(
                &string_array(&case["input"]["rows"]),
                case["input"]["capacity"].as_i64().expect("capacity"),
                case["input"]["hasPill"].as_bool().expect("has pill"),
            )
        }),
        "drawTile" => {
            let input = &case["input"];
            let layout: GridLayout =
                serde_json::from_value(input["layout"].clone()).expect("grid layout");
            let context: TileContext =
                serde_json::from_value(input["context"].clone()).expect("tile context");
            let options = TmuxExposeOptions {
                project_root: PathBuf::from(
                    input["options"]["projectRoot"]
                        .as_str()
                        .expect("project root"),
                ),
                project_state_dir: PathBuf::from(
                    input["options"]["projectStateDir"]
                        .as_str()
                        .expect("project state dir"),
                ),
                current_window_id: input["options"]
                    .get("currentWindowId")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                ..TmuxExposeOptions::default()
            };
            json!({
                "text": draw_tile(DrawTileInput {
                    item: &input["item"],
                    preview: &string_array(&input["preview"]),
                    badge: input["badge"].as_i64().expect("badge"),
                    selected: input["selected"].as_bool().expect("selected"),
                    top: input["top"].as_i64().expect("top"),
                    left: input["left"].as_i64().expect("left"),
                    width: input["width"].as_i64().expect("width"),
                    layout: &layout,
                    context: &context,
                    options: &options,
                })
            })
        }
        unexpected => panic!("unexpected api {unexpected}"),
    }
}

fn string_array(value: &Value) -> Vec<String> {
    value
        .as_array()
        .expect("string array")
        .iter()
        .map(|entry| entry.as_str().expect("string entry").to_owned())
        .collect()
}
