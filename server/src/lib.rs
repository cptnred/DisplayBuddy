//! buddy-server: accounts, devices, LWW sync and PWA hosting for Display Buddy v3
//! (PLAN_V3_SYNC §5–§7). Phase A = server core without push delivery.
//!
//! Extension points for phase D (scheduler + Web Push):
//! - [`AppState::reminders_changed`] is notified after every `/sync/push` that stored a
//!   reminder change (`notify_one`, so a wake-up is never lost);
//! - [`AppState::clock`] is the injected [`clock::Clock`];
//! - [`AppState::vapid`] holds the loaded key ([`vapid::Vapid::private_pem`]);
//! - `build_app` marks where `push::router()` is merged, `serve` where the scheduler task
//!   is spawned (it gets a clone of the shutdown receiver);
//! - tables `push_subscriptions` and `push_log` already exist (migration 0001).

pub mod api;
pub mod auth;
pub mod cli;
pub mod clock;
pub mod config;
pub mod db;
pub mod error;
pub mod housekeeping;
pub mod sync;
pub mod vapid;
pub mod web;

use std::net::SocketAddr;
use std::sync::Arc;

use anyhow::{Context, Result};
use axum::Router;
use axum::middleware;
use axum::routing::any;
use tokio::sync::Notify;

use crate::auth::throttle::LoginThrottle;
use crate::clock::{Clock, SystemClock};
use crate::config::Config;
use crate::db::Db;
use crate::vapid::Vapid;

#[derive(Clone)]
pub struct AppState {
    pub db: Db,
    pub config: Arc<Config>,
    pub clock: Arc<dyn Clock>,
    pub throttle: Arc<LoginThrottle>,
    pub vapid: Option<Arc<Vapid>>,
    /// Woken after reminder changes (phase-D scheduler).
    pub reminders_changed: Arc<Notify>,
}

impl AppState {
    pub fn new(db: Db, config: Config, clock: Arc<dyn Clock>, vapid: Option<Vapid>) -> Self {
        Self {
            db,
            config: Arc::new(config),
            clock,
            throttle: Arc::new(LoginThrottle::new()),
            vapid: vapid.map(Arc::new),
            reminders_changed: Arc::new(Notify::new()),
        }
    }
}

/// The complete application: `/api/v1/*` (JSON, `no-store`, CSRF) and the PWA (`/`).
pub fn build_app(state: AppState) -> Router {
    let api = api::router(state.clone())
        // Phase D: `.merge(push::router())` (PUT/DELETE /push/subscription, POST /push/test)
        .fallback(api::api_not_found)
        .layer(middleware::from_fn_with_state(
            state.clone(),
            auth::csrf_guard,
        ))
        .layer(middleware::from_fn(web::no_store));
    let web_dir = state.config.web_dir.clone();
    Router::new()
        .nest("/api/v1", api)
        .route(
            "/api",
            any(api::api_not_found).layer(middleware::from_fn(web::no_store)),
        )
        .route(
            "/api/{*rest}",
            any(api::api_not_found).layer(middleware::from_fn(web::no_store)),
        )
        .fallback(move |req| web::serve_static(web_dir.clone(), req))
        .layer(middleware::from_fn(web::security_headers))
        .layer(tower_http::trace::TraceLayer::new_for_http())
        .with_state(state)
}

/// Builds the state from the configuration (opens DB, loads the VAPID key).
pub async fn state_from_config(config: Config) -> Result<AppState> {
    let db = db::open(&config.db_path).await?;
    let vapid = match &config.vapid_private_key_file {
        Some(p) => Some(Vapid::load(p, config.vapid_subject.clone())?),
        None => {
            tracing::warn!("BUDDY_VAPID_PRIVATE_KEY_FILE not set: web push disabled");
            None
        }
    };
    if let Some(dir) = &config.web_dir {
        web::check_web_dir(dir);
    }
    Ok(AppState::new(db, config, Arc::new(SystemClock), vapid))
}

async fn shutdown_signal(tx: tokio::sync::watch::Sender<bool>) {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let term = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut s) => {
                s.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let term = std::future::pending::<()>();
    tokio::select! {
        () = ctrl_c => {},
        () = term => {},
    }
    tracing::info!("shutdown requested");
    let _ = tx.send(true);
}

/// `buddy-server serve`: runs until SIGINT/SIGTERM, then drains connections (graceful
/// shutdown, axum example `graceful-shutdown`), stops background tasks and closes the DB.
pub async fn serve(config: Config) -> Result<()> {
    let listen = config.listen;
    let state = state_from_config(config).await?;
    let (tx, rx) = tokio::sync::watch::channel(false);
    tokio::spawn(shutdown_signal(tx));
    let housekeeping = tokio::spawn(housekeeping::run(state.clone(), rx.clone()));
    // Phase D: `let scheduler = tokio::spawn(reminders::run(state.clone(), rx.clone()));`
    // and `let _ = scheduler.await;` below.

    let listener = tokio::net::TcpListener::bind(listen)
        .await
        .with_context(|| format!("binding {listen}"))?;
    tracing::info!(%listen, "buddy-server listening");
    let mut rx_http = rx.clone();
    axum::serve(
        listener,
        build_app(state.clone()).into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(async move {
        let _ = rx_http.wait_for(|v| *v).await;
    })
    .await
    .context("http server")?;
    let _ = housekeeping.await;
    state.db.close().await;
    tracing::info!("stopped");
    Ok(())
}
