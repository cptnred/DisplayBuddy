//! API errors: `{error, message}` (`buddy_core::sync::ApiError`) with the codes from
//! `buddy_core::sync::error_codes` (PLAN_V3_SYNC §6, D-63). Messages are English and
//! technical; the clients show German texts per code/status.

use axum::Json;
use axum::extract::rejection::{JsonRejection, QueryRejection};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use buddy_core::sync::{ApiError, error_codes as codes};

#[derive(Debug)]
pub struct AppError {
    pub status: StatusCode,
    pub code: &'static str,
    pub message: String,
    /// Seconds for `Retry-After` (login brake).
    pub retry_after: Option<u64>,
}

pub type ApiResult<T> = Result<T, AppError>;

impl AppError {
    pub fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
            retry_after: None,
        }
    }

    pub fn unauthorized() -> Self {
        Self::new(
            StatusCode::UNAUTHORIZED,
            codes::UNAUTHORIZED,
            "not signed in",
        )
    }

    pub fn bad_credentials() -> Self {
        Self::new(
            StatusCode::UNAUTHORIZED,
            codes::UNAUTHORIZED,
            "wrong username or password",
        )
    }

    pub fn forbidden(message: impl Into<String>) -> Self {
        Self::new(StatusCode::FORBIDDEN, codes::FORBIDDEN, message)
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, codes::BAD_REQUEST, message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, codes::NOT_FOUND, message)
    }

    pub fn too_many(retry_after_secs: u64) -> Self {
        Self::rate_limited(
            retry_after_secs,
            "too many failed sign-in attempts, try again later",
        )
    }

    /// `429` + `Retry-After` for every limit of PLAN_V4 §8.2.
    pub fn rate_limited(retry_after_secs: u64, message: &str) -> Self {
        Self {
            retry_after: Some(retry_after_secs.max(1)),
            ..Self::new(
                StatusCode::TOO_MANY_REQUESTS,
                codes::TOO_MANY_REQUESTS,
                message,
            )
        }
    }

    /// Admin lock (`users.disabled_at`, D-95).
    pub fn account_disabled() -> Self {
        Self::new(
            StatusCode::FORBIDDEN,
            codes::ACCOUNT_DISABLED,
            "this account is disabled",
        )
    }

    pub fn full_resync() -> Self {
        Self::new(
            StatusCode::GONE,
            codes::FULL_RESYNC_REQUIRED,
            "cursor too old, full re-sync required",
        )
    }

    pub fn internal() -> Self {
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            codes::INTERNAL,
            "internal server error",
        )
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let body = ApiError {
            error: self.code.to_string(),
            message: self.message,
        };
        let mut res = (self.status, Json(body)).into_response();
        if let Some(s) = self.retry_after
            && let Ok(v) = HeaderValue::from_str(&s.to_string())
        {
            res.headers_mut().insert(header::RETRY_AFTER, v);
        }
        res
    }
}

/// Database and other unexpected errors: logged without details that could contain user
/// data (sqlx errors never include bound values), answered with a generic 500.
impl From<sqlx::Error> for AppError {
    fn from(e: sqlx::Error) -> Self {
        tracing::error!(error = %e, "database error");
        Self::internal()
    }
}

impl From<anyhow::Error> for AppError {
    fn from(e: anyhow::Error) -> Self {
        tracing::error!(error = %e, "internal error");
        Self::internal()
    }
}

impl From<JsonRejection> for AppError {
    fn from(r: JsonRejection) -> Self {
        // Answered to the sender only, never logged (serde messages may quote values).
        Self::new(r.status(), codes::BAD_REQUEST, r.body_text())
    }
}

impl From<QueryRejection> for AppError {
    fn from(r: QueryRejection) -> Self {
        Self::bad_request(r.body_text())
    }
}
