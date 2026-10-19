use std::io::{self, IsTerminal, Write};

pub fn is_tty() -> bool {
  io::stdout().is_terminal()
}

/// Imprime uma mensagem de erro (colorida em TTY) e sai com código 1.
pub fn die(msg: impl AsRef<str>) -> ! {
  let s = msg.as_ref();
  if is_tty() {
    let _ = writeln!(io::stderr(), "\x1b[31m{s}\x1b[0m");
  } else {
    let _ = writeln!(io::stderr(), "{s}");
  }
  std::process::exit(1)
}
