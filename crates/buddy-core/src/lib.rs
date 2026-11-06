//! Display Buddy core: pure logic shared by the desktop app (`src-tauri`), the sync
//! server (`server`) and the native shell (`mobile/src-tauri`). No Tauri, no axum,
//! no I/O. TypeScript mirrors live in `src/lib/{sync,clock.ts,zoned.ts,schedule.ts}`
//! and pass the same fixtures in `tests/fixtures/`.

pub mod clock;
pub mod lww;
pub mod model;
pub mod schedule;
pub mod sync;
pub mod text;
pub mod zoned;
