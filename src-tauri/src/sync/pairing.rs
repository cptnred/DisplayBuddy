//! v4 QR pairing on the PC (PLAN_V4 §6.2): `POST /pairing` → QR as SVG (`qrcode` 0.14.1,
//! error correction M, docs.rs `qrcode::render::svg`), `GET /pairing/{id}` (the settings
//! window polls every 2 s), `DELETE /pairing/{id}`. The code is never logged.

use buddy_core::pairing::{PairingStart, PairingStatus, parse_pairing_url};
use qrcode::render::svg;
use qrcode::{EcLevel, QrCode};
use tauri::AppHandle;

use super::account::{SERVER_TOO_OLD, check_path_id, error_text};
use super::client::Client;
use crate::model::PairingInfo;

/// Minimum edge of the QR image in px (readable at 100/150/200 % scaling).
pub const QR_MIN_PX: u32 = 220;

/// SVG markup of the QR code: dark on white, with the standard quiet zone (light border).
pub fn qr_svg(content: &str) -> Result<String, String> {
    let code = QrCode::with_error_correction_level(content.as_bytes(), EcLevel::M)
        .map_err(|e| format!("internal: qr {e}"))?;
    Ok(code
        .render::<svg::Color<'_>>()
        .min_dimensions(QR_MIN_PX, QR_MIN_PX)
        .dark_color(svg::Color("#000000"))
        .light_color(svg::Color("#ffffff"))
        .quiet_zone(true)
        .build())
}

/// The QR must carry exactly the code shown as text (strict URL rule, D-110).
fn to_info(start: PairingStart) -> Result<PairingInfo, String> {
    let target = parse_pairing_url(&start.url).ok_or("protocol: pairing url")?;
    if target.code != start.code {
        return Err("protocol: pairing url and code differ".into());
    }
    Ok(PairingInfo {
        qr_svg: qr_svg(&start.url)?,
        pairing_id: start.pairing_id,
        code: start.code,
        expires_at: start.expires_at,
    })
}

pub async fn start(client: &Client) -> Result<PairingInfo, String> {
    let req = client
        .post_json("/pairing", &serde_json::json!({}))
        .map_err(|e| error_text(e, None))?;
    let start: PairingStart = client
        .json(req, super::client::TIMEOUT)
        .await
        .map_err(|e| error_text(e, Some(SERVER_TOO_OLD)))?
        .value;
    log::info!("pairing: started {}", start.pairing_id);
    to_info(start)
}

/// Unknown ids (also after a server restart) answer 404 → `pairing_invalid`.
pub async fn status(client: &Client, pairing_id: &str) -> Result<PairingStatus, String> {
    let id = check_path_id(pairing_id)?;
    Ok(client
        .json(
            client.get(&format!("/pairing/{id}")),
            super::client::TIMEOUT,
        )
        .await
        .map_err(|e| error_text(e, Some("pairing_invalid")))?
        .value)
}

pub async fn cancel(client: &Client, pairing_id: &str) -> Result<(), String> {
    let id = check_path_id(pairing_id)?;
    client
        .send::<serde_json::Value>(
            client.delete(&format!("/pairing/{id}")),
            super::client::TIMEOUT,
            false,
        )
        .await
        .map(|_| ())
        .map_err(|e| error_text(e, Some("pairing_invalid")))
}

pub async fn app_start(app: &AppHandle) -> Result<PairingInfo, String> {
    start(&super::signed_in_client(app)?).await
}

pub async fn app_status(app: &AppHandle, pairing_id: &str) -> Result<PairingStatus, String> {
    status(&super::signed_in_client(app)?, pairing_id).await
}

pub async fn app_cancel(app: &AppHandle, pairing_id: &str) -> Result<(), String> {
    cancel(&super::signed_in_client(app)?, pairing_id).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::account::tests::{assert_not_logged, block, capture_logs, client};
    use crate::sync::client::tests::{MockServer, Seen};
    use buddy_core::pairing::PairingState;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicU32, Ordering};

    const CODE: &str = "ABCDEFGHJKMN";

    #[test]
    fn start_returns_qr_and_code() {
        capture_logs();
        let server = MockServer::start(Arc::new(|_: &Seen| {
            (
                201,
                format!(
                    r#"{{"pairingId":"p-1","code":"{CODE}","url":"https://buddy.example.org/pair#c={CODE}","expiresAt":"2026-11-10T10:03:00.000Z","serverTime":"2026-11-10T10:00:00.000Z"}}"#
                ),
            )
        }));
        let info = block(start(&client(&server.url, Some("tok")))).unwrap();
        assert_eq!(info.pairing_id, "p-1");
        assert_eq!(info.code, CODE);
        assert!(info.qr_svg.contains("<svg"));
        assert!(info.qr_svg.contains("#ffffff"));
        let seen = server.seen.lock().unwrap();
        assert_eq!(
            (seen[0].method.as_str(), seen[0].path.as_str()),
            ("POST", "/api/v1/pairing")
        );
        drop(seen);
        assert_not_logged(&[CODE]);
    }

    #[test]
    fn mismatching_url_is_rejected() {
        let server = MockServer::start(Arc::new(|_: &Seen| {
            (
                201,
                r#"{"pairingId":"p-1","code":"ABCDEFGHJKMN","url":"http://evil.example/pair#c=ABCDEFGHJKMN","expiresAt":"x","serverTime":"2026-11-10T10:00:00.000Z"}"#
                    .into(),
            )
        }));
        let e = block(start(&client(&server.url, Some("t")))).unwrap_err();
        assert!(e.starts_with("protocol:"), "{e}");
    }

    #[test]
    fn qr_has_a_minimum_size() {
        let svg = qr_svg("https://buddy.pev-point.de/pair#c=ABCDEFGHJKMN").unwrap();
        let width: u32 = svg
            .split("width=\"")
            .nth(1)
            .and_then(|r| r.split('"').next())
            .and_then(|w| w.parse().ok())
            .unwrap();
        assert!(width >= QR_MIN_PX, "{width}");
    }

    #[test]
    fn polling_states_and_cancel() {
        let calls = Arc::new(AtomicU32::new(0));
        let c2 = calls.clone();
        let server = MockServer::start(Arc::new(move |req: &Seen| {
            if req.method == "DELETE" {
                return (204, String::new());
            }
            if req.path == "/api/v1/pairing/unknown" {
                return (404, r#"{"error":"not_found","message":"x"}"#.into());
            }
            let n = c2.fetch_add(1, Ordering::SeqCst);
            let body = match n {
                0 => {
                    r#"{"pairingId":"p-1","state":"pending","expiresAt":"2026-11-10T10:03:00.000Z","device":null,"redeemedAt":null,"serverTime":"2026-11-10T10:00:00.000Z"}"#
                }
                1 => {
                    r#"{"pairingId":"p-1","state":"redeemed","expiresAt":"2026-11-10T10:03:00.000Z","device":{"id":"m1","name":"Pixel 8","kind":"mobile"},"redeemedAt":"2026-11-10T10:01:00.000Z","serverTime":"2026-11-10T10:01:00.000Z"}"#
                }
                _ => {
                    r#"{"pairingId":"p-1","state":"expired","expiresAt":"2026-11-10T10:03:00.000Z","device":null,"redeemedAt":null,"serverTime":"2026-11-10T10:04:00.000Z"}"#
                }
            };
            (200, body.into())
        }));
        let c = client(&server.url, Some("t"));
        assert_eq!(
            block(status(&c, "p-1")).unwrap().state,
            PairingState::Pending
        );
        let redeemed = block(status(&c, "p-1")).unwrap();
        assert_eq!(redeemed.state, PairingState::Redeemed);
        assert_eq!(redeemed.device.unwrap().name, "Pixel 8");
        assert_eq!(
            block(status(&c, "p-1")).unwrap().state,
            PairingState::Expired
        );
        assert_eq!(
            block(status(&c, "unknown")).unwrap_err(),
            "pairing_invalid: HTTP 404"
        );
        assert!(
            block(status(&c, "a/b"))
                .unwrap_err()
                .starts_with("invalid_input")
        );
        block(cancel(&c, "p-1")).unwrap();
        let seen = server.seen.lock().unwrap();
        assert_eq!(seen.last().unwrap().path, "/api/v1/pairing/p-1");
        assert_eq!(seen.last().unwrap().method, "DELETE");
    }
}
