//! Sync: LWW with the shared vectors, late offline edits, clamp, tombstones, pagination,
//! 410, revisions, idempotency, deviceState/synced_seq, scheduler wake-up.

mod common;

use axum::http::{Method, StatusCode};
use buddy_server::clock::Clock;
use chrono::Duration;
use common::*;
use serde_json::{Value, json};

const VECTORS: &str = include_str!("../../crates/buddy-core/tests/fixtures/lww_vectors.json");

fn side_note(id: &str, s: &Value) -> Value {
    let at = s["updatedAt"].as_str().unwrap();
    let by = s["updatedBy"].as_str().unwrap();
    if s["deleted"].as_bool().unwrap_or(false) {
        tombstone(id, at, by)
    } else {
        // payload stamp is a valid instant even when the record stamp is garbage
        json!({"id": id, "updatedAt": at, "updatedBy": by, "deleted": false,
               "note": note_json(id, &format!("{by}@{at}"), "2026-11-06T09:00:00.000Z")})
    }
}

fn side_reminder(id: &str, s: &Value) -> Value {
    let at = s["updatedAt"].as_str().unwrap();
    let by = s["updatedBy"].as_str().unwrap();
    if s["deleted"].as_bool().unwrap_or(false) {
        json!({"noteId": id, "updatedAt": at, "updatedBy": by, "deleted": true, "reminder": null})
    } else {
        reminder_rec(
            id,
            at,
            by,
            s["state"].as_str().unwrap_or("scheduled"),
            Some("Europe/Berlin"),
        )
    }
}

fn identical(local: &Value, remote: &Value) -> bool {
    let inst = |v: &Value| buddy_core::zoned::parse_instant(v["updatedAt"].as_str().unwrap());
    inst(local).is_some()
        && inst(local) == inst(remote)
        && local["updatedBy"] == remote["updatedBy"]
        && local.get("state") == remote.get("state")
        && local.get("deleted") == remote.get("deleted")
}

/// Server copy = "local", incoming push = "remote" (D-58).
#[tokio::test]
async fn shared_lww_vectors_through_the_api() {
    let t = TestApp::new().await;
    t.clock
        .set(buddy_core::zoned::parse_instant("2026-11-08T00:00:00Z").unwrap());
    let (_, token) = t.device("desktop").await;
    let v: Value = serde_json::from_str(VECTORS).unwrap();
    let mut n = 0;
    for kind in ["notes", "reminders", "order"] {
        for c in v[kind].as_array().unwrap() {
            n += 1;
            let id = nid(n);
            let name = c["name"].as_str().unwrap();
            let (local, remote) = (&c["local"], &c["remote"]);
            let (field, first, second) = match kind {
                "notes" => (
                    "notes",
                    vec![side_note(&id, local)],
                    vec![side_note(&id, remote)],
                ),
                "reminders" => (
                    "reminders",
                    vec![side_reminder(&id, local)],
                    vec![side_reminder(&id, remote)],
                ),
                _ => ("order", vec![], vec![]),
            };
            let order = |s: &Value| json!({"updatedAt": s["updatedAt"], "updatedBy": s["updatedBy"], "ids": [id.clone()]});
            let body = |recs: Vec<Value>, s: &Value| {
                if kind == "order" {
                    json!({"order": order(s)})
                } else {
                    json!({field: recs})
                }
            };
            let r1 = t.push(&token, body(first, local)).await;
            assert_eq!(r1.body["results"][0]["status"], "applied", "{name}: seed");
            let r2 = t.push(&token, body(second, remote)).await;
            let res = &r2.body["results"][0];
            let remote_valid =
                buddy_core::zoned::parse_instant(remote["updatedAt"].as_str().unwrap()).is_some();
            let expected = match (c["winner"].as_str().unwrap(), remote_valid) {
                (_, false) => "invalid",
                ("remote", _) => "applied",
                _ if identical(local, remote) => "applied",
                _ => "stale",
            };
            assert_eq!(res["status"], expected, "{kind}/{name}: {res}");
            let winner = if c["winner"] == "remote" {
                remote
            } else {
                local
            };
            if expected == "stale" {
                let sub = &res[&kind[..kind.len() - usize::from(kind != "order")]];
                assert_eq!(
                    sub["updatedAt"], winner["updatedAt"],
                    "{name}: stale carries winner"
                );
            }
            // stored copy is the winner
            let stored: (String, String) = match kind {
                "notes" => sqlx::query_as("SELECT updated_at, updated_by FROM notes WHERE id = ?")
                    .bind(&id)
                    .fetch_one(&t.state.db)
                    .await
                    .unwrap(),
                "reminders" => {
                    sqlx::query_as("SELECT updated_at, updated_by FROM reminders WHERE note_id = ?")
                        .bind(&id)
                        .fetch_one(&t.state.db)
                        .await
                        .unwrap()
                }
                _ => sqlx::query_as("SELECT updated_at, updated_by FROM note_order")
                    .fetch_one(&t.state.db)
                    .await
                    .unwrap(),
            };
            assert_eq!(
                stored.0,
                winner["updatedAt"].as_str().unwrap(),
                "{kind}/{name}"
            );
            assert_eq!(
                stored.1,
                winner["updatedBy"].as_str().unwrap(),
                "{kind}/{name}"
            );
            if kind == "order" {
                // reset for the next order case
                sqlx::query("DELETE FROM note_order")
                    .execute(&t.state.db)
                    .await
                    .unwrap();
            }
        }
    }
    let total: usize = ["notes", "reminders", "order"]
        .iter()
        .map(|k| v[*k].as_array().unwrap().len())
        .sum();
    assert_eq!(n, u32::try_from(total).unwrap());
    assert!(total >= 20, "all vectors exercised");
}

#[tokio::test]
async fn clamp_vectors_through_the_api() {
    let t = TestApp::new().await;
    let (_, token) = t.device("desktop").await;
    let v: Value = serde_json::from_str(VECTORS).unwrap();
    for (i, c) in v["clamp"].as_array().unwrap().iter().enumerate() {
        let name = c["name"].as_str().unwrap();
        t.clock
            .set(buddy_core::zoned::parse_instant(c["serverNow"].as_str().unwrap()).unwrap());
        let id = nid(100 + u32::try_from(i).unwrap());
        let ts = c["ts"].as_str().unwrap();
        let rec = json!({"id": id, "updatedAt": ts, "updatedBy": "phone", "deleted": false,
                         "note": note_json(&id, "x", "2026-11-06T09:00:00.000Z")});
        let r = t.push(&token, json!({"notes": [rec]})).await;
        let res = &r.body["results"][0];
        match c["expected"].as_str() {
            None => assert_eq!(res["status"], "invalid", "{name}"),
            Some(exp) => {
                assert_eq!(res["status"], "applied", "{name}");
                let stored: String =
                    sqlx::query_scalar("SELECT updated_at FROM notes WHERE id = ?")
                        .bind(&id)
                        .fetch_one(&t.state.db)
                        .await
                        .unwrap();
                assert_eq!(stored, exp, "{name}: stored verbatim or clamped");
                if exp == ts {
                    assert!(res.get("clampedUpdatedAt").is_none(), "{name}");
                } else {
                    assert_eq!(res["clampedUpdatedAt"], exp, "{name}");
                }
            }
        }
    }
}

#[tokio::test]
async fn late_offline_edits_and_revisions() {
    let t = TestApp::new().await;
    t.clock
        .set(buddy_core::zoned::parse_instant("2026-11-06T18:00:00Z").unwrap());
    let (pc, pc_tok) = t.device("desktop").await;
    let (phone, phone_tok) = t.device("mobile").await;

    // 16a: phone edited offline at 09:00, PC at 12:00 (synced first) → PC wins, phone rejected
    t.push(
        &pc_tok,
        json!({"notes": [note_rec(NOTE_A, "PC", "2026-11-06T12:00:00.000Z", &pc)]}),
    )
    .await;
    let r = t
        .push(
            &phone_tok,
            json!({"notes": [note_rec(NOTE_A, "Handy", "2026-11-06T09:00:00.000Z", &phone)]}),
        )
        .await;
    let res = &r.body["results"][0];
    assert_eq!(res["status"], "stale");
    assert_eq!(res["note"]["note"]["title"], "PC");
    let (reason, by): (String, String) =
        sqlx::query_as("SELECT reason, updated_by FROM note_revisions WHERE note_id = ?")
            .bind(NOTE_A)
            .fetch_one(&t.state.db)
            .await
            .unwrap();
    assert_eq!((reason.as_str(), by.as_str()), ("rejected", phone.as_str()));

    // 16b: PC at 13:00 synced, phone offline edit at 14:00 arrives hours later → phone wins
    t.push(
        &pc_tok,
        json!({"notes": [note_rec(NOTE_A, "PC 2", "2026-11-06T13:00:00.000Z", &pc)]}),
    )
    .await;
    t.clock.advance(Duration::hours(4));
    let r = t
        .push(
            &phone_tok,
            json!({"notes": [note_rec(NOTE_A, "Handy 2", "2026-11-06T14:00:00.000Z", &phone)]}),
        )
        .await;
    assert_eq!(r.body["results"][0]["status"], "applied");
    let stored: String = sqlx::query_scalar("SELECT updated_at FROM notes WHERE id = ?")
        .bind(NOTE_A)
        .fetch_one(&t.state.db)
        .await
        .unwrap();
    assert_eq!(
        stored, "2026-11-06T14:00:00.000Z",
        "device stamp kept, not server time"
    );
    let reasons: Vec<String> =
        sqlx::query_scalar("SELECT reason FROM note_revisions WHERE note_id = ? ORDER BY id")
            .bind(NOTE_A)
            .fetch_all(&t.state.db)
            .await
            .unwrap();
    // "PC" replaced by "PC 2" and "PC 2" replaced by "Handy 2"
    assert_eq!(reasons, ["rejected", "replaced", "replaced"]);

    // restore the rejected phone copy via CLI
    let rows = buddy_server::cli::revisions(&t.state.db, Some(NOTE_A), 10)
        .await
        .unwrap();
    let rejected = rows.iter().find(|r| r.reason == "rejected").unwrap();
    assert_eq!(rejected.title(), "Handy");
    let now = t.clock.now();
    buddy_server::cli::restore(&t.state.db, now, rejected.id)
        .await
        .unwrap();
    let r = t.changes(&pc_tok, 0, 100).await;
    let n = &r.body["notes"][0];
    assert_eq!(n["note"]["title"], "Handy");
    assert_eq!(n["updatedBy"], buddy_server::cli::RESTORE_DEVICE);
    assert_eq!(n["updatedAt"], buddy_core::zoned::format_utc(&now));
}

#[tokio::test]
async fn idempotent_resend() {
    let t = TestApp::new().await;
    let (dev, tok) = t.device("desktop").await;
    let body = json!({
        "notes": [note_rec(NOTE_A, "A", START, &dev)],
        "reminders": [reminder_rec(NOTE_A, START, &dev, "scheduled", Some("Europe/Berlin"))],
        "order": {"updatedAt": START, "updatedBy": dev, "ids": [NOTE_A]}
    });
    let r1 = t.push(&tok, body.clone()).await;
    let seq1 = t.scalar_i64("SELECT seq FROM users").await;
    assert_eq!(seq1, 3);
    assert_eq!(r1.body["cursor"], 3);
    let r2 = t.push(&tok, body).await;
    assert_eq!(r1.body["results"], r2.body["results"]);
    for res in r2.body["results"].as_array().unwrap() {
        assert_eq!(res["status"], "applied");
    }
    assert_eq!(
        t.scalar_i64("SELECT seq FROM users").await,
        seq1,
        "no new versions"
    );
    assert_eq!(t.scalar_i64("SELECT COUNT(*) FROM note_revisions").await, 0);
}

#[tokio::test]
async fn tombstones_and_resurrection() {
    let t = TestApp::new().await;
    let (pc, pc_tok) = t.device("desktop").await;
    let (_, web_tok) = t.device("mobile").await;
    t.push(
        &pc_tok,
        json!({"notes": [note_rec(NOTE_A, "A", "2026-11-06T09:00:00.000Z", &pc)]}),
    )
    .await;
    let cursor = t.changes(&web_tok, 0, 100).await.body["cursor"]
        .as_i64()
        .unwrap();
    t.push(
        &pc_tok,
        json!({"notes": [tombstone(NOTE_A, "2026-11-06T09:30:00.000Z", &pc)]}),
    )
    .await;
    let r = t.changes(&web_tok, cursor, 100).await;
    let n = &r.body["notes"][0];
    assert_eq!(n["deleted"], true);
    assert!(n["note"].is_null());
    let payload: Option<String> = sqlx::query_scalar("SELECT payload FROM notes")
        .fetch_one(&t.state.db)
        .await
        .unwrap();
    assert!(payload.is_none(), "tombstone stores no content");
    // a later edit brings the note back
    t.push(
        &pc_tok,
        json!({"notes": [note_rec(NOTE_A, "B", "2026-11-06T09:45:00.000Z", &pc)]}),
    )
    .await;
    let r = t.changes(&web_tok, cursor, 100).await;
    assert_eq!(r.body["notes"][0]["deleted"], false);
    assert_eq!(r.body["notes"][0]["note"]["title"], "B");
    // invalid records are reported, not stored
    let r = t
        .push(&pc_tok, json!({"notes": [
            {"id": "../x", "updatedAt": START, "updatedBy": pc, "deleted": true},
            {"id": NOTE_A, "updatedAt": START, "updatedBy": pc, "deleted": false, "note": null},
            {"id": NOTE_A, "updatedAt": START, "updatedBy": pc, "deleted": false, "note": note_json(&nid(9), "x", START)}
        ], "reminders": [reminder_rec(NOTE_A, START, &pc, "scheduled", Some("Mars/Olympus"))]}))
        .await;
    let statuses: Vec<&str> = r.body["results"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["status"].as_str().unwrap())
        .collect();
    assert_eq!(statuses, ["invalid"; 4]);
    assert_eq!(r.body["results"][0]["message"], "invalid note id");
}

#[tokio::test]
async fn pagination_and_synced_seq() {
    let t = TestApp::new().await;
    let (pc, pc_tok) = t.device("desktop").await;
    let (phone, phone_tok) = t.device("mobile").await;
    let notes: Vec<Value> = (1..=5)
        .map(|i| note_rec(&nid(i), "n", START, &pc))
        .collect();
    let reminders = vec![reminder_rec(&nid(1), START, &pc, "scheduled", None)];
    t.push(
        &pc_tok,
        json!({"notes": notes, "reminders": reminders,
        "order": {"updatedAt": START, "updatedBy": pc, "ids": [nid(1)]}}),
    )
    .await;
    // re-edit note 1 → its seq moves to the end; the old seq leaves a gap
    t.push(
        &pc_tok,
        json!({"notes": [note_rec(&nid(1), "n2", "2026-11-06T10:00:01.000Z", &pc)]}),
    )
    .await;
    assert_eq!(t.scalar_i64("SELECT seq FROM users").await, 8);

    let mut since = 0;
    let mut seen_notes = vec![];
    let mut seen_rem = 0;
    let mut seen_order = 0;
    let mut pages = 0;
    loop {
        let r = t.changes(&phone_tok, since, 3).await;
        assert_eq!(r.status, StatusCode::OK);
        pages += 1;
        let b = &r.body;
        let count = b["notes"].as_array().unwrap().len()
            + b["reminders"].as_array().unwrap().len()
            + usize::from(!b["order"].is_null());
        assert!(count <= 3);
        seen_notes.extend(
            b["notes"]
                .as_array()
                .unwrap()
                .iter()
                .map(|n| n["id"].clone()),
        );
        seen_rem += b["reminders"].as_array().unwrap().len();
        seen_order += usize::from(!b["order"].is_null());
        let synced: i64 = sqlx::query_scalar("SELECT synced_seq FROM devices WHERE id = ?")
            .bind(&phone)
            .fetch_one(&t.state.db)
            .await
            .unwrap();
        since = b["cursor"].as_i64().unwrap();
        if b["hasMore"] == false {
            assert_eq!(synced, 8, "synced_seq set when the pull completes");
            break;
        }
        assert_eq!(synced, 0, "not set while hasMore");
    }
    assert_eq!(pages, 3);
    assert_eq!(seen_notes.len(), 5, "each note once (latest version)");
    assert_eq!((seen_rem, seen_order), (1, 1));
    assert_eq!(since, 8);
    // nothing new: empty page, same cursor
    let r = t.changes(&phone_tok, 8, 3).await;
    assert_eq!(r.body["cursor"], 8);
    assert_eq!(r.body["hasMore"], false);
    assert!(r.body["notes"].as_array().unwrap().is_empty());
    // limit is clamped, default works
    let r = t
        .call(
            Method::GET,
            "/api/v1/sync/changes",
            Cred::Bearer(&phone_tok),
            None,
        )
        .await;
    assert_eq!(r.body["cursor"], 8);
    let r = t
        .call(
            Method::GET,
            "/api/v1/sync/changes?since=abc",
            Cred::Bearer(&phone_tok),
            None,
        )
        .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn gone_after_tombstone_purge_and_for_unknown_cursor() {
    let t = TestApp::new().await;
    let (pc, tok) = t.device("desktop").await;
    t.push(
        &tok,
        json!({"notes": [note_rec(NOTE_A, "A", START, &pc), note_rec(&nid(2), "B", START, &pc)]}),
    )
    .await;
    t.push(
        &tok,
        json!({"notes": [tombstone(NOTE_A, "2026-11-06T10:01:00.000Z", &pc)]}),
    )
    .await;
    assert_eq!(t.scalar_i64("SELECT seq FROM users").await, 3);

    // cursor beyond the server state (e.g. restored database) → 410
    let r = t.changes(&tok, 99, 10).await;
    assert_eq!(r.status, StatusCode::GONE);
    assert_eq!(r.body["error"], "full_resync_required");

    // 179 days: nothing purged
    t.clock.advance(Duration::days(179));
    let s = buddy_server::housekeeping::purge(&t.state.db, t.clock.now())
        .await
        .unwrap();
    assert_eq!(s.tombstones, 0);
    t.clock.advance(Duration::days(2));
    let s = buddy_server::housekeeping::purge(&t.state.db, t.clock.now())
        .await
        .unwrap();
    assert_eq!(s.tombstones, 1);
    assert_eq!(t.scalar_i64("SELECT min_cursor FROM users").await, 3);
    for since in [1, 2] {
        assert_eq!(
            t.changes(&tok, since, 10).await.status,
            StatusCode::GONE,
            "since {since}"
        );
    }
    // full re-sync from 0 and the current cursor work
    let r = t.changes(&tok, 0, 10).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.body["notes"].as_array().unwrap().len(), 1);
    assert_eq!(t.changes(&tok, 3, 10).await.status, StatusCode::OK);
}

#[tokio::test]
async fn revisions_expire_after_30_days() {
    let t = TestApp::new().await;
    let (pc, tok) = t.device("desktop").await;
    t.push(&tok, json!({"notes": [note_rec(NOTE_A, "A", START, &pc)]}))
        .await;
    t.push(
        &tok,
        json!({"notes": [note_rec(NOTE_A, "B", "2026-11-06T10:00:01.000Z", &pc)]}),
    )
    .await;
    assert_eq!(t.scalar_i64("SELECT COUNT(*) FROM note_revisions").await, 1);
    t.clock.advance(Duration::days(30) + Duration::seconds(1));
    let s = buddy_server::housekeeping::purge(&t.state.db, t.clock.now())
        .await
        .unwrap();
    assert_eq!(s.revisions, 1);
}

#[tokio::test]
async fn device_state_only_from_native_shell() {
    let t = TestApp::new().await;
    let (mob, mob_tok) = t.device("mobile").await;
    let (desk, desk_tok) = t.device("desktop").await;
    let ds = json!({"deviceState": {"scheduledSeq": 41, "localNotifications": "denied"}});
    t.push(&mob_tok, ds.clone()).await;
    t.push(&desk_tok, ds).await;
    let row = |id: String| {
        let db = t.state.db.clone();
        async move {
            sqlx::query_as::<_, (Option<i64>, Option<String>)>(
                "SELECT scheduled_seq, local_notifications FROM devices WHERE id = ?",
            )
            .bind(id)
            .fetch_one(&db)
            .await
            .unwrap()
        }
    };
    assert_eq!(row(mob).await, (Some(41), Some("denied".into())));
    assert_eq!(row(desk).await, (None, None));
    assert_eq!(
        t.scalar_i64("SELECT seq FROM users").await,
        0,
        "deviceState is no record"
    );
}

#[tokio::test]
async fn reminder_push_wakes_scheduler_and_keeps_zone_as_sent() {
    let t = TestApp::new().await;
    let (pc, tok) = t.device("desktop").await;
    let notify = t.state.reminders_changed.clone();
    t.push(&tok, json!({"notes": [note_rec(NOTE_A, "A", START, &pc)]}))
        .await;
    let woke = tokio::time::timeout(std::time::Duration::from_millis(50), notify.notified()).await;
    assert!(woke.is_err(), "note-only push does not wake the scheduler");

    // legacy reminder without timeZone: stored as sent, account zone used for computing
    t.push(
        &tok,
        json!({"reminders": [reminder_rec(NOTE_A, START, &pc, "scheduled", None)]}),
    )
    .await;
    tokio::time::timeout(std::time::Duration::from_secs(1), notify.notified())
        .await
        .expect("woken after reminder change");
    let payload: String = sqlx::query_scalar("SELECT payload FROM reminders")
        .fetch_one(&t.state.db)
        .await
        .unwrap();
    let r: buddy_core::model::Reminder = serde_json::from_str(&payload).unwrap();
    assert_eq!(r.time_zone, None);
    let zone = buddy_server::sync::user_time_zone(&t.state.db, t.user_id)
        .await
        .unwrap();
    assert_eq!(
        buddy_server::sync::effective_zone(&r, &zone).name(),
        "Europe/Berlin"
    );
}

#[tokio::test]
async fn cookie_client_syncs_too_and_batch_limit() {
    let t = TestApp::new().await;
    let (dev, sid, _) = t.web_login(None).await;
    let r = t
        .call(
            Method::POST,
            "/api/v1/sync/push",
            Cred::Cookie(&sid),
            Some(json!({"notes": [note_rec(NOTE_A, "Web", START, &dev)]})),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.body["serverTime"], START);
    let notes: Vec<Value> = (0..201)
        .map(|i| note_rec(&nid(i), "n", START, &dev))
        .collect();
    let r = t
        .call(
            Method::POST,
            "/api/v1/sync/push",
            Cred::Cookie(&sid),
            Some(json!({"notes": notes})),
        )
        .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    let r = t
        .call(
            Method::POST,
            "/api/v1/sync/push",
            Cred::Cookie(&sid),
            Some(json!({"notes": "nope"})),
        )
        .await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(r.body["error"], "bad_request");
    assert_eq!(r.header("cache-control"), Some("no-store"));
}
