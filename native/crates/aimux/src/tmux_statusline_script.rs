use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TmuxStatuslineOptions {
    pub line: String,
    pub project_state_dir: String,
    pub current_session: String,
    pub current_window: String,
    pub current_window_id: String,
}

pub fn parse_tmux_statusline_args(args: &[String]) -> TmuxStatuslineOptions {
    let mut options = TmuxStatuslineOptions::default();
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--line" => {
                options.line = args.get(index + 1).cloned().unwrap_or_default();
                index += 2;
            }
            "--project-state-dir" => {
                options.project_state_dir = args.get(index + 1).cloned().unwrap_or_default();
                index += 2;
            }
            "--current-session" => {
                options.current_session = args.get(index + 1).cloned().unwrap_or_default();
                index += 2;
            }
            "--current-window" => {
                options.current_window = args.get(index + 1).cloned().unwrap_or_default();
                index += 2;
            }
            "--current-window-id" => {
                options.current_window_id = args.get(index + 1).cloned().unwrap_or_default();
                index += 2;
            }
            _ => index += 1,
        }
    }
    options
}

pub fn run_tmux_statusline(options: TmuxStatuslineOptions, output: &mut impl Write) -> i32 {
    let mut runner = TmuxStatuslineRunner::new(options);
    let _ = runner.run(output);
    0
}

struct TmuxStatuslineRunner {
    options: TmuxStatuslineOptions,
    status_dir: Option<PathBuf>,
    log_file: Option<PathBuf>,
}

impl TmuxStatuslineRunner {
    fn new(options: TmuxStatuslineOptions) -> Self {
        Self {
            options,
            status_dir: None,
            log_file: None,
        }
    }

    fn run(&mut self, output: &mut impl Write) -> std::io::Result<()> {
        if self.options.line.is_empty() {
            return self.fail_silent(output, "missing --line");
        }
        if self.options.project_state_dir.is_empty() {
            return self.fail_silent(output, "missing --project-state-dir");
        }
        let project_state_dir = Path::new(&self.options.project_state_dir);
        self.status_dir = Some(project_state_dir.join("tmux-statusline"));
        self.log_file = Some(project_state_dir.join("logs").join("tmux-statusline.log"));

        match self.options.line.as_str() {
            "top" => self.run_top(output),
            "bottom" => self.run_bottom(output),
            _ => self.fail_silent(output, &format!("unsupported line={}", self.options.line)),
        }
    }

    fn run_top(&mut self, output: &mut impl Write) -> std::io::Result<()> {
        if !self.options.current_window_id.is_empty()
            && self.cat_if_exists(
                &format!("top-{}.txt", self.options.current_window_id),
                output,
            )?
        {
            return Ok(());
        }
        if self.cat_if_exists("top-dashboard.txt", output)? {
            return Ok(());
        }
        writeln!(output)?;
        self.log_error(&format!(
            "top render missing file current_window_id={} current_window={} current_session={}",
            self.options.current_window_id,
            self.options.current_window,
            self.options.current_session
        ));
        Ok(())
    }

    fn run_bottom(&mut self, output: &mut impl Write) -> std::io::Result<()> {
        if self.options.current_window.starts_with("dashboard") {
            if !self.options.current_session.is_empty()
                && self.cat_if_exists(
                    &format!("bottom-dashboard-{}.txt", self.options.current_session),
                    output,
                )?
            {
                return Ok(());
            }
            if self.cat_if_exists("bottom-dashboard.txt", output)? {
                return Ok(());
            }
            writeln!(output)?;
            self.log_error(&format!(
                "dashboard bottom render missing file current_session={} current_window_id={}",
                self.options.current_session, self.options.current_window_id
            ));
            return Ok(());
        }

        if !self.options.current_window_id.is_empty()
            && self.cat_if_exists(
                &format!("bottom-{}.txt", self.options.current_window_id),
                output,
            )?
        {
            return Ok(());
        }
        writeln!(output)?;
        self.log_error(&format!(
            "window bottom render missing file current_window_id={} current_window={} current_session={}",
            self.options.current_window_id,
            self.options.current_window,
            self.options.current_session
        ));
        Ok(())
    }

    fn cat_if_exists(&self, name: &str, output: &mut impl Write) -> std::io::Result<bool> {
        let Some(status_dir) = self.status_dir.as_ref() else {
            return Ok(false);
        };
        let path = status_dir.join(name);
        if !path.is_file() {
            return Ok(false);
        }
        output.write_all(&fs::read(path)?)?;
        Ok(true)
    }

    fn fail_silent(&mut self, output: &mut impl Write, message: &str) -> std::io::Result<()> {
        self.log_error(message);
        writeln!(output)
    }

    fn log_error(&self, message: &str) {
        let Some(log_file) = self.log_file.as_ref() else {
            return;
        };
        if let Some(parent) = log_file.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let line = format!("{} {message}\n", log_timestamp());
        let _ = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(log_file)
            .and_then(|mut file| file.write_all(line.as_bytes()));
    }
}

fn log_timestamp() -> String {
    let Ok(description) = time::format_description::parse_borrowed::<3>(
        "[year]-[month]-[day]T[hour]:[minute]:[second]+0000",
    ) else {
        return "1970-01-01T00:00:00+0000".to_owned();
    };
    time::OffsetDateTime::now_utc()
        .format(&description)
        .unwrap_or_else(|_| "1970-01-01T00:00:00+0000".to_owned())
}
