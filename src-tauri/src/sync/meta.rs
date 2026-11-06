//! `sync/state.json` (PLAN_V3_SYNC §8): device id, cursor, last sync, last error and
//! the clock samples. Contains no secrets (the token lives in [`super::secret`]).

use buddy_core::clock::ClockOffsets;
use buddy_core::sync::Seq;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct SyncMeta {
    /// Assigned by the server on `POST /devices`; `updatedBy` of our records.
    pub device_id: Option<String>,
    /// `seq` up to which all changes are pulled.
    pub cursor: Seq,
    pub last_sync_at: Option<String>,
    pub last_error: Option<String>,
    /// Last clock offset samples (median = offset in use, D-60).
    pub clock_offsets: ClockOffsets,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn camel_case_and_defaults() {
        let mut m = SyncMeta {
            device_id: Some("d1".into()),
            cursor: 7,
            ..Default::default()
        };
        m.clock_offsets.push(1200);
        let v = serde_json::to_value(&m).unwrap();
        assert_eq!(v["deviceId"], "d1");
        assert_eq!(v["clockOffsets"], serde_json::json!([1200]));
        assert_eq!(serde_json::from_value::<SyncMeta>(v).unwrap(), m);
        assert_eq!(
            serde_json::from_str::<SyncMeta>("{}").unwrap(),
            SyncMeta::default()
        );
    }
}
