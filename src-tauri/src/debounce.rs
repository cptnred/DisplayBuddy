//! Trailing-edge debouncer on a dedicated thread (no async runtime needed).

use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::thread;
use std::time::Duration;

/// Calls `f` with the latest pushed value once no new value arrived for `delay`.
/// The worker thread ends when the `Debouncer` is dropped (pending value is flushed).
pub struct Debouncer<T: Send + 'static> {
    tx: Sender<T>,
}

impl<T: Send + 'static> Debouncer<T> {
    pub fn new<F>(delay: Duration, f: F) -> Self
    where
        F: Fn(T) + Send + 'static,
    {
        let (tx, rx) = mpsc::channel::<T>();
        thread::Builder::new()
            .name("debouncer".into())
            .spawn(move || {
                while let Ok(mut latest) = rx.recv() {
                    loop {
                        match rx.recv_timeout(delay) {
                            Ok(v) => latest = v,
                            Err(RecvTimeoutError::Timeout) => break,
                            Err(RecvTimeoutError::Disconnected) => {
                                f(latest);
                                return;
                            }
                        }
                    }
                    f(latest);
                }
            })
            .expect("failed to spawn debouncer thread");
        Self { tx }
    }

    pub fn push(&self, value: T) {
        let _ = self.tx.send(value);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[test]
    fn coalesces_bursts_and_delivers_latest() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let s = seen.clone();
        let d = Debouncer::new(Duration::from_millis(60), move |v: i32| {
            s.lock().unwrap().push(v)
        });
        for i in 0..5 {
            d.push(i);
            thread::sleep(Duration::from_millis(5));
        }
        thread::sleep(Duration::from_millis(200));
        assert_eq!(*seen.lock().unwrap(), vec![4]);

        d.push(10);
        thread::sleep(Duration::from_millis(200));
        assert_eq!(*seen.lock().unwrap(), vec![4, 10]);
    }

    #[test]
    fn flushes_pending_value_on_drop() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let s = seen.clone();
        let d = Debouncer::new(Duration::from_secs(10), move |v: i32| {
            s.lock().unwrap().push(v)
        });
        d.push(7);
        drop(d);
        for _ in 0..100 {
            if !seen.lock().unwrap().is_empty() {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(*seen.lock().unwrap(), vec![7]);
    }
}
