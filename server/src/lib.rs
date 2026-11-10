//! buddy-server: accounts, devices, LWW sync and PWA hosting for Display Buddy v3
//! (PLAN_V3_SYNC §5–§7). Phase A = server core, phase D = reminder scheduler and push.
//! v4 (PLAN_V4_ACCOUNTS): [`accounts`] (registration, recovery, `/me/*`, quotas) and
//! [`auth::limits`] ([`AppState::limits`]); proof-of-work challenges in
//! [`AppState::challenges`].
//!
//! - [`AppState::reminders_changed`] is notified after every `/sync/push` that stored a
//!   reminder change and after a new push subscription (`notify_one`, so a wake-up is
//!   never lost); [`reminders::run`] waits on it;
//! - [`AppState::clock`] is the injected [`clock::Clock`];
//! - [`AppState::vapid`] holds the loaded key, [`AppState::push`] the push channels
//!   ([`push::PushService`]: Web Push, native FCM channel of phase N2 when
//!   `BUDDY_FCM_SERVICE_ACCOUNT_FILE` is set);
//! - `build_app` merges [`push::router`], `serve` spawns the scheduler with a clone of the
//!   shutdown receiver.

pub mod accounts;
pub mod api;
pub mod auth;
pub mod cli;
pub mod clock;
pub mod config;
pub mod db;
pub mod error;
pub mod housekeeping;
pub mod push;
pub mod reminders;
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

use crate::auth::limits::Limits;
use crate::auth::throttle::LoginThrottle;
use crate::clock::{Clock, SystemClock};
use crate::config::Config;
use crate::db::Db;
use crate::push::PushService;
use crate::vapid::Vapid;

#[derive(Clone)]
pub struct AppState {
    pub db: Db,
    pub config: Arc<Config>,
    pub clock: Arc<dyn Clock>,
    pub throttle: Arc<LoginThrottle>,
    /// Rate limits of PLAN_V4 §8.2 (IP-wide failures, registration, pairing, export).
    pub limits: Arc<Limits>,
    /// Open registration challenges (proof-of-work, in memory, PLAN_V4 §6.1).
    pub challenges: Arc<accounts::ChallengeStore>,
    /// Caps parallel Argon2 checks (19 MiB each) so a login flood cannot exhaust memory.
    pub password_checks: Arc<tokio::sync::Semaphore>,
    pub vapid: Option<Arc<Vapid>>,
    /// Woken after reminder changes (phase-D scheduler).
    pub reminders_changed: Arc<Notify>,
    /// Web Push + native channel (phase D, `push`).
    pub push: Arc<PushService>,
}

impl AppState {
    pub fn new(db: Db, config: Config, clock: Arc<dyn Clock>, vapid: Option<Vapid>) -> Self {
        let vapid = vapid.map(Arc::new);
        let push = Arc::new(PushService::new(&config, vapid.clone()));
        let limits = Arc::new(Limits::new(config.registration_daily_limit));
        Self {
            db,
            config: Arc::new(config),
            clock,
            throttle: Arc::new(LoginThrottle::new()),
            limits,
            challenges: Arc::new(accounts::ChallengeStore::new()),
            password_checks: Arc::new(tokio::sync::Semaphore::new(
                auth::MAX_PARALLEL_PASSWORD_CHECKS,
            )),
            vapid,
            reminders_changed: Arc::new(Notify::new()),
            push,
        }
    }

    /// Replaces the push channels (tests: fake push service, fake native channel).
    pub fn with_push(mut self, opts: push::PushOptions) -> Self {
        self.push = Arc::new(PushService::with_options(
            &self.config,
            self.vapid.clone(),
            opts,
        ));
        self
    }
}

/// The complete application: `/api/v1/*` (JSON, `no-store`, CSRF) and the PWA (`/`).
pub fn build_app(state: AppState) -> Router {
    let api = api::router(state.clone())
        .merge(push::router(state.clone()))
        .merge(accounts::router())
        // Phase P: `.merge(pairing::router(state.clone()))` goes here (PLAN_V4 §5.1/§5.2).
        .fallback(api::api_not_found)
        .layer(middleware::from_fn_with_state(
            state.clone(),
            auth::csrf_guard,
        ))
        .layer(middleware::from_fn(web::no_store));
    let web_dir = state.config.web_dir.clone();
    Router::new()
        .nest("/api/v1", api)
        // Unrouted API paths land here, not in the nested fallback: they get the CSRF guard
        // too, so e.g. a cross-site POST /api/v1/session/<new> is a 403, never a 404 (D-104).
        .route(
            "/api",
            any(api::api_not_found)
                .layer(middleware::from_fn_with_state(
                    state.clone(),
                    auth::csrf_guard,
                ))
                .layer(middleware::from_fn(web::no_store)),
        )
        .route(
            "/api/{*rest}",
            any(api::api_not_found)
                .layer(middleware::from_fn_with_state(
                    state.clone(),
                    auth::csrf_guard,
                ))
                .layer(middleware::from_fn(web::no_store)),
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
    let clock: Arc<dyn Clock> = Arc::new(SystemClock);
    let fcm = match &config.fcm_service_account_file {
        Some(p) => Some(push::native_fcm::FcmChannel::from_file(p, clock.clone())?),
        None => {
            tracing::info!("BUDDY_FCM_SERVICE_ACCOUNT_FILE not set: no native push (Android)");
            None
        }
    };
    let state = AppState::new(db, config, clock, vapid);
    Ok(match fcm {
        Some(channel) => state.with_push(push::PushOptions {
            native: Arc::new(channel),
            ..Default::default()
        }),
        None => state,
    })
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
    let scheduler = tokio::spawn(reminders::run(state.clone(), rx.clone()));

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
    let _ = scheduler.await;
    state.db.close().await;
    tracing::info!("stopped");
    Ok(())
}
