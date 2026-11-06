//! Sync token storage (PLAN_V3_SYNC §8, D-53). The bearer token never touches
//! `settings.json` or `state.json`; on Windows it lives in the Credential Manager
//! (`keyring-core` + `windows-native-keyring-store`), elsewhere (Linux tests, smoke
//! test) in memory only. Callers only see the [`TokenStore`] trait.
//!
//! The keyring store docs warn that one entry must not be used from several threads
//! at once, so every implementation serialises access with a mutex.

use std::sync::Mutex;

use crate::state::lock;

/// Credential Manager target: "<service>.<user>" with the store's default divider.
pub const KEYRING_SERVICE: &str = "de.displaybuddy.desktop";
pub const KEYRING_USER: &str = "sync-token";

pub trait TokenStore: Send + Sync {
    /// The stored token, `None` if there is none.
    fn get(&self) -> Result<Option<String>, String>;
    fn set(&self, token: &str) -> Result<(), String>;
    /// Removes the token; a missing token is not an error.
    fn delete(&self) -> Result<(), String>;
}

/// In-memory store (tests; non-Windows builds).
#[derive(Default)]
pub struct MemoryTokenStore {
    token: Mutex<Option<String>>,
}

impl TokenStore for MemoryTokenStore {
    fn get(&self) -> Result<Option<String>, String> {
        Ok(lock(&self.token).clone())
    }
    fn set(&self, token: &str) -> Result<(), String> {
        *lock(&self.token) = Some(token.to_string());
        Ok(())
    }
    fn delete(&self) -> Result<(), String> {
        *lock(&self.token) = None;
        Ok(())
    }
}

#[cfg(windows)]
mod windows_store {
    use std::sync::Mutex;

    use keyring_core::api::CredentialStoreApi;
    use keyring_core::{Entry, Error};

    use super::{KEYRING_SERVICE, KEYRING_USER, TokenStore};
    use crate::state::lock;

    /// Windows Credential Manager (generic credential, local machine persistence of the
    /// store's default).
    pub struct KeyringTokenStore {
        entry: Mutex<Entry>,
    }

    impl KeyringTokenStore {
        pub fn new() -> Result<Self, String> {
            let store = windows_native_keyring_store::Store::new().map_err(|e| e.to_string())?;
            let entry = store
                .build(KEYRING_SERVICE, KEYRING_USER, None)
                .map_err(|e| e.to_string())?;
            Ok(Self {
                entry: Mutex::new(entry),
            })
        }
    }

    impl TokenStore for KeyringTokenStore {
        fn get(&self) -> Result<Option<String>, String> {
            match lock(&self.entry).get_password() {
                Ok(t) => Ok(Some(t)),
                Err(Error::NoEntry) => Ok(None),
                Err(e) => Err(e.to_string()),
            }
        }
        fn set(&self, token: &str) -> Result<(), String> {
            lock(&self.entry)
                .set_password(token)
                .map_err(|e| e.to_string())
        }
        fn delete(&self) -> Result<(), String> {
            match lock(&self.entry).delete_credential() {
                Ok(()) | Err(Error::NoEntry) => Ok(()),
                Err(e) => Err(e.to_string()),
            }
        }
    }
}

/// The token store of this platform.
pub fn platform_store() -> Box<dyn TokenStore> {
    #[cfg(windows)]
    {
        match windows_store::KeyringTokenStore::new() {
            Ok(s) => return Box::new(s),
            Err(e) => log::error!("credential manager unavailable, token kept in memory: {e}"),
        }
    }
    Box::new(MemoryTokenStore::default())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_store_round_trip() {
        let s = MemoryTokenStore::default();
        assert_eq!(s.get().unwrap(), None);
        s.set("t1").unwrap();
        assert_eq!(s.get().unwrap().as_deref(), Some("t1"));
        s.delete().unwrap();
        s.delete().unwrap();
        assert_eq!(s.get().unwrap(), None);
    }
}
