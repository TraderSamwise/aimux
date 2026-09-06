use std::collections::BTreeMap;

pub fn parse_env_assignments(input: &str) -> Result<BTreeMap<String, String>, String> {
    let mut env = BTreeMap::new();
    for token in parse_shell_args(input)? {
        let Some((name, value)) = token.split_once('=') else {
            return Err(format!(
                r#"invalid env var "{token}" (expected NAME=VALUE)"#
            ));
        };
        if !valid_env_name(name) {
            return Err(format!(
                r#"invalid env var "{token}" (expected NAME=VALUE)"#
            ));
        }
        env.insert(name.to_owned(), value.to_owned());
    }
    Ok(env)
}

pub fn parse_shell_args(input: &str) -> Result<Vec<String>, String> {
    let mut args = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut escaping = false;
    let mut token_started = false;

    for ch in input.chars() {
        if escaping {
            current.push(ch);
            escaping = false;
            token_started = true;
            continue;
        }
        if ch == '\\' && quote != Some('\'') {
            escaping = true;
            token_started = true;
            continue;
        }
        if let Some(active_quote) = quote {
            if ch == active_quote {
                quote = None;
            } else {
                current.push(ch);
                token_started = true;
            }
            continue;
        }
        if ch == '\'' || ch == '"' {
            quote = Some(ch);
            token_started = true;
            continue;
        }
        if ch.is_whitespace() {
            if token_started {
                args.push(std::mem::take(&mut current));
                token_started = false;
            }
            continue;
        }
        current.push(ch);
        token_started = true;
    }

    if escaping {
        current.push('\\');
    }
    if let Some(active_quote) = quote {
        let name = if active_quote == '\'' {
            "single"
        } else {
            "double"
        };
        return Err(format!("unterminated {name} quote"));
    }
    if token_started {
        args.push(current);
    }
    Ok(args)
}

fn valid_env_name(name: &str) -> bool {
    let mut chars = name.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    (first.is_ascii_alphabetic() || first == '_')
        && chars.all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
}
