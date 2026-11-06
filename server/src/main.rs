use clap::Parser;

use buddy_server::cli::{Cli, Command};
use buddy_server::config::Config;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,sqlx=warn,tower_http=warn".into()),
        )
        .with_writer(std::io::stderr)
        .init();
    let cli = Cli::parse();
    match cli.command {
        Command::Serve => buddy_server::serve(Config::from_env(true)?).await,
        cmd => buddy_server::cli::run_admin(cmd, &Config::from_env(false)?).await,
    }
}
