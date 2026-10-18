use std::io::{self, Write};

#[derive(Debug, Clone, Copy)]
pub enum LogLevel {
    Info,
    Warn,
    Error,
}

pub fn is_tty() -> bool {
    use std::io::IsTerminal;
    io::stdout().is_terminal()
}

fn colorize(s: &str, level: LogLevel) -> String {
    if !is_tty() {
        return s.to_string();
    }
    match level {
        LogLevel::Info => format!("\x1b[32m{}\x1b[0m", s),
        LogLevel::Warn => format!("\x1b[33m{}\x1b[0m", s),
        LogLevel::Error => format!("\x1b[31m{}\x1b[0m", s),
    }
}

pub fn log_msg(msg: impl AsRef<str>) {
    let s = msg.as_ref();
    let _ = writeln!(io::stdout(), "{}", colorize(s, LogLevel::Info));
}

pub fn warn_msg(msg: impl AsRef<str>) {
    let s = msg.as_ref();
    let _ = writeln!(io::stderr(), "{}", colorize(s, LogLevel::Warn));
}

pub fn die(msg: impl AsRef<str>) -> ! {
    let s = msg.as_ref();
    let _ = writeln!(io::stderr(), "{}", colorize(s, LogLevel::Error));
    std::process::exit(1)
}
