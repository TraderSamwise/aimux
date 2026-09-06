pub fn command_arg_value_matches(args: &str, flag: &str, expected: &str) -> bool {
    let tokens = args.split_whitespace().collect::<Vec<_>>();
    for index in 0..tokens.len() {
        if tokens[index] != flag {
            continue;
        }
        let value_start = index + 1;
        if value_start >= tokens.len() {
            continue;
        }
        let mut value_end = tokens.len();
        for (offset, token) in tokens[value_start..].iter().enumerate() {
            if token.starts_with("--") {
                value_end = value_start + offset;
                break;
            }
        }
        if trim_shell_quotes(&tokens[value_start..value_end].join(" ")) == expected {
            return true;
        }
    }
    false
}

fn trim_shell_quotes(value: &str) -> &str {
    if value.len() >= 2
        && ((value.starts_with('"') && value.ends_with('"'))
            || (value.starts_with('\'') && value.ends_with('\'')))
    {
        &value[1..value.len() - 1]
    } else {
        value
    }
}
