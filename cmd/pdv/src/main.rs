mod cli;
mod config;
mod ops;
mod runner;
mod tui;
mod ui;

use clap::Parser;

fn main() {
    let cli = cli::Cli::parse();
    std::process::exit(cli::handle(cli));
}
