//! Secure storage of the device token from `POST /devices` (PLAN_V3_SYNC §10.2, D-53).
//!
//! - iOS: data-protection keychain (`apple-native-keyring-store`, module `protected`),
//!   access policy `after-first-unlock` so a notification action can sync while the
//!   device is locked (crate docs, `protected::Store` modifiers).
//! - Android: `android-native-keyring-store` (SharedPreferences encrypted with an
//!   Android Keystore key).
//! - Development machine (`cargo test`, `tauri dev`): in-memory only.
//!
//! The token never reaches logs; errors carry only the keyring error kind.

/// Keychain service / user of the token entry.
#[cfg_attr(not(mobile), allow(dead_code))]
pub const SERVICE: &str = "de.displaybuddy.mobile";
#[cfg_attr(not(mobile), allow(dead_code))]
pub const USER: &str = "sync-token";

/// Minimal secret storage interface (one value).
pub trait SecretBackend: Send + Sync {
    fn get(&self) -> Result<Option<String>, String>;
    fn set(&self, value: &str) -> Result<(), String>;
    fn delete(&self) -> Result<(), String>;
}

/// The token vault managed as Tauri state.
pub struct TokenVault {
    backend: Box<dyn SecretBackend>,
}

impl TokenVault {
    pub fn new(backend: Box<dyn SecretBackend>) -> Self {
        Self { backend }
    }

    /// Platform default: keychain/keystore on mobile, memory elsewhere.
    pub fn platform() -> Self {
        #[cfg(any(target_os = "ios", target_os = "android"))]
        {
            Self::new(Box::new(keyring::KeyringBackend))
        }
        #[cfg(not(any(target_os = "ios", target_os = "android")))]
        {
            Self::new(Box::new(MemoryBackend::default()))
        }
    }

    /// Reads the token. An unreadable entry (e.g. restored from a backup without the
    /// Keystore key) counts as "no token": it is deleted and the user signs in again.
    pub fn get(&self) -> Result<Option<String>, String> {
        match self.backend.get() {
            Ok(Some(t)) if !t.is_empty() => Ok(Some(t)),
            Ok(_) => Ok(None),
            Err(e) => {
                log::warn!("token entry unreadable ({e}), removing it");
                let _ = self.backend.delete();
                Ok(None)
            }
        }
    }

    /// Stores (`Some`) or removes (`None`) the token.
    pub fn set(&self, token: Option<&str>) -> Result<(), String> {
        match token {
            Some(t) if !t.trim().is_empty() => {
                if t.len() > 4096 || t.chars().any(char::is_control) {
                    return Err("invalid token".to_string());
                }
                self.backend.set(t)
            }
            _ => self.backend.delete(),
        }
    }
}

/// In-memory backend (development machine and tests).
#[cfg(any(test, not(any(target_os = "ios", target_os = "android"))))]
#[derive(Default)]
pub struct MemoryBackend(std::sync::Mutex<Option<String>>);

#[cfg(any(test, not(any(target_os = "ios", target_os = "android"))))]
impl SecretBackend for MemoryBackend {
    fn get(&self) -> Result<Option<String>, String> {
        Ok(self.0.lock().map_err(|_| "poisoned")?.clone())
    }
    fn set(&self, value: &str) -> Result<(), String> {
        *self.0.lock().map_err(|_| "poisoned")? = Some(value.to_string());
        Ok(())
    }
    fn delete(&self) -> Result<(), String> {
        *self.0.lock().map_err(|_| "poisoned")? = None;
        Ok(())
    }
}

/// Short, secret-free description of a keyring error.
#[cfg_attr(not(any(target_os = "ios", target_os = "android")), allow(dead_code))]
fn describe(e: &keyring_core::Error) -> String {
    use keyring_core::Error as E;
    match e {
        E::PlatformFailure(_) => "platform failure",
        E::NoStorageAccess(_) => "no storage access",
        E::NoEntry => "no entry",
        E::BadEncoding(_) => "bad encoding",
        E::BadDataFormat(..) => "bad data format",
        E::BadStoreFormat(_) => "bad store format",
        E::TooLong(..) => "too long",
        E::Invalid(..) => "invalid",
        E::Ambiguous(_) => "ambiguous",
        E::NoDefaultStore => "no default store",
        E::NotSupportedByStore(_) => "not supported by store",
        _ => "keyring error",
    }
    .to_string()
}

#[cfg(any(target_os = "ios", target_os = "android"))]
mod keyring {
    use std::sync::{Arc, OnceLock};

    use keyring_core::{CredentialStore, Entry, Error};

    use super::{SERVICE, SecretBackend, USER, describe};

    /// Store instances are unique per name (Android) → create once, on first use (the
    /// Android context is ready by then).
    fn store() -> Result<&'static Arc<CredentialStore>, String> {
        static STORE: OnceLock<Result<Arc<CredentialStore>, String>> = OnceLock::new();
        STORE
            .get_or_init(|| {
                #[cfg(target_os = "ios")]
                let s = apple_native_keyring_store::protected::Store::new()
                    .map(|s| s as Arc<CredentialStore>);
                #[cfg(target_os = "android")]
                let s =
                    android_native_keyring_store::Store::new().map(|s| s as Arc<CredentialStore>);
                s.map_err(|e| describe(&e))
            })
            .as_ref()
            .map_err(Clone::clone)
    }

    fn entry() -> Result<Entry, String> {
        #[cfg(target_os = "ios")]
        let mods = std::collections::HashMap::from([("access-policy", "after-first-unlock")]);
        #[cfg(target_os = "ios")]
        let mods = Some(&mods);
        #[cfg(target_os = "android")]
        let mods = None;
        store()?
            .build(SERVICE, USER, mods)
            .map_err(|e| describe(&e))
    }

    pub struct KeyringBackend;

    impl SecretBackend for KeyringBackend {
        fn get(&self) -> Result<Option<String>, String> {
            match entry()?.get_password() {
                Ok(t) => Ok(Some(t)),
                Err(Error::NoEntry) => Ok(None),
                Err(e) => Err(describe(&e)),
            }
        }
        fn set(&self, value: &str) -> Result<(), String> {
            entry()?.set_password(value).map_err(|e| describe(&e))
        }
        fn delete(&self) -> Result<(), String> {
            match entry()?.delete_credential() {
                Ok(()) | Err(Error::NoEntry) => Ok(()),
                Err(e) => Err(describe(&e)),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Broken;
    impl SecretBackend for Broken {
        fn get(&self) -> Result<Option<String>, String> {
            Err("bad data format".into())
        }
        fn set(&self, _: &str) -> Result<(), String> {
            Err("no storage access".into())
        }
        fn delete(&self) -> Result<(), String> {
            Ok(())
        }
    }

    #[test]
    fn stores_reads_and_removes_the_token() {
        let v = TokenVault::new(Box::new(MemoryBackend::default()));
        assert_eq!(v.get().unwrap(), None);
        v.set(Some("abc.def")).unwrap();
        assert_eq!(v.get().unwrap().as_deref(), Some("abc.def"));
        v.set(None).unwrap();
        assert_eq!(v.get().unwrap(), None);
        v.set(Some("x")).unwrap();
        v.set(Some("  ")).unwrap(); // blank = remove
        assert_eq!(v.get().unwrap(), None);
    }

    #[test]
    fn rejects_garbage_tokens() {
        let v = TokenVault::new(Box::new(MemoryBackend::default()));
        assert!(v.set(Some("a\nb")).is_err());
        assert!(v.set(Some(&"x".repeat(5000))).is_err());
        assert_eq!(v.get().unwrap(), None);
    }

    #[test]
    fn unreadable_entry_counts_as_signed_out() {
        let v = TokenVault::new(Box::new(Broken));
        assert_eq!(v.get().unwrap(), None);
        assert_eq!(v.set(Some("t")).unwrap_err(), "no storage access");
    }

    #[test]
    fn error_descriptions_carry_no_secrets() {
        let d = describe(&keyring_core::Error::BadEncoding(b"secret-token".to_vec()));
        assert_eq!(d, "bad encoding");
    }
}
