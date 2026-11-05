//! Shell icons as PNG data URLs (Windows only; elsewhere `None`).

/// Converts a 32-bit top-down BGRA DIB to RGBA.
///
/// Icons without an alpha channel (every alpha byte 0) take their transparency
/// from the AND mask, read as a 32-bit DIB as well: a black mask pixel is
/// opaque, a white one transparent. Without a mask such icons become opaque.
/// Returns `None` if the buffer sizes don't match `width * height * 4`.
pub fn bgra_to_rgba(
    color: &[u8],
    mask: Option<&[u8]>,
    width: usize,
    height: usize,
) -> Option<Vec<u8>> {
    let len = width.checked_mul(height)?.checked_mul(4)?;
    if color.len() != len || mask.is_some_and(|m| m.len() != len) {
        return None;
    }
    let has_alpha = color.chunks_exact(4).any(|px| px[3] != 0);
    let mut out = Vec::with_capacity(len);
    for (i, px) in color.chunks_exact(4).enumerate() {
        let alpha = if has_alpha {
            px[3]
        } else {
            match mask {
                // mask pixel 0 (black) = draw the colour pixel
                Some(m) if m[i * 4..i * 4 + 3].iter().all(|&b| b == 0) => 255,
                Some(_) => 0,
                None => 255,
            }
        };
        out.extend_from_slice(&[px[2], px[1], px[0], alpha]);
    }
    Some(out)
}

#[cfg(windows)]
pub use win::icon_data_url;

#[cfg(not(windows))]
pub fn icon_data_url(_path: &str) -> Option<String> {
    None
}

#[cfg(windows)]
mod win {
    use std::ffi::c_void;
    use std::mem::{size_of, zeroed};
    use std::os::windows::ffi::OsStrExt;
    use std::ptr::null_mut;

    use base64::Engine;
    use windows_sys::Win32::Graphics::Gdi::{
        BI_RGB, BITMAP, BITMAPINFO, BITMAPINFOHEADER, DIB_RGB_COLORS, DeleteObject, GetDC,
        GetDIBits, GetObjectW, HBITMAP, HDC, ReleaseDC,
    };
    use windows_sys::Win32::UI::Shell::{SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON, SHGetFileInfoW};
    use windows_sys::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, ICONINFO};

    use super::bgra_to_rgba;

    // SHGetFileInfoW requires COM on the calling thread.
    use windows_sys::Win32::System::Com::{
        COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE, CoInitializeEx, CoUninitialize,
    };
    /// Largest edge accepted from the shell (sanity bound for buffer sizes).
    const MAX_EDGE: i32 = 256;

    /// Shell icon of `path` as `data:image/png;base64,…`. Runs on its own
    /// short-lived thread so COM can be initialised without touching the
    /// caller's (async runtime) thread.
    pub fn icon_data_url(path: &str) -> Option<String> {
        let path = path.to_string();
        std::thread::spawn(move || {
            // SAFETY: plain COM init/uninit pairing on a thread we own.
            let hr = unsafe {
                CoInitializeEx(
                    null_mut(),
                    (COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) as u32,
                )
            };
            let result = extract(&path);
            if hr >= 0 {
                unsafe { CoUninitialize() };
            }
            result
        })
        .join()
        .ok()
        .flatten()
    }

    fn extract(path: &str) -> Option<String> {
        let wide: Vec<u16> = std::ffi::OsStr::new(path)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        // SAFETY: zeroed POD out-struct; `wide` is NUL-terminated and outlives the call.
        let mut info: SHFILEINFOW = unsafe { zeroed() };
        let ok = unsafe {
            SHGetFileInfoW(
                wide.as_ptr(),
                0,
                &mut info,
                size_of::<SHFILEINFOW>() as u32,
                SHGFI_ICON | SHGFI_LARGEICON,
            )
        };
        if ok == 0 || info.hIcon.is_null() {
            return None;
        }
        let rgba = icon_rgba(info.hIcon);
        // SAFETY: we own the icon returned by SHGFI_ICON.
        unsafe { DestroyIcon(info.hIcon) };
        let (w, h, rgba) = rgba?;
        let png = encode_png(w, h, &rgba)?;
        Some(format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(png)
        ))
    }

    /// Releases the bitmaps of an `ICONINFO` on drop.
    struct IconBitmaps(ICONINFO);
    impl Drop for IconBitmaps {
        fn drop(&mut self) {
            // SAFETY: GetIconInfo hands ownership of both bitmaps to the caller.
            unsafe {
                if !self.0.hbmColor.is_null() {
                    DeleteObject(self.0.hbmColor);
                }
                if !self.0.hbmMask.is_null() {
                    DeleteObject(self.0.hbmMask);
                }
            }
        }
    }

    /// Screen DC, released on drop.
    struct ScreenDc(HDC);
    impl Drop for ScreenDc {
        fn drop(&mut self) {
            // SAFETY: obtained from GetDC(NULL).
            unsafe { ReleaseDC(null_mut(), self.0) };
        }
    }

    fn icon_rgba(icon: *mut c_void) -> Option<(u32, u32, Vec<u8>)> {
        // SAFETY: zeroed POD out-struct, valid icon handle.
        let mut ii: ICONINFO = unsafe { zeroed() };
        if unsafe { GetIconInfo(icon, &mut ii) } == 0 {
            return None;
        }
        let bitmaps = IconBitmaps(ii);
        // Monochrome icons (no colour bitmap) are not supported → frontend fallback.
        if bitmaps.0.hbmColor.is_null() {
            return None;
        }
        let mut bm: BITMAP = unsafe { zeroed() };
        // SAFETY: BITMAP-sized out buffer for a bitmap handle.
        let n = unsafe {
            GetObjectW(
                bitmaps.0.hbmColor,
                size_of::<BITMAP>() as i32,
                (&mut bm as *mut BITMAP).cast(),
            )
        };
        if n == 0
            || bm.bmWidth <= 0
            || bm.bmHeight <= 0
            || bm.bmWidth > MAX_EDGE
            || bm.bmHeight > MAX_EDGE
        {
            return None;
        }
        let (w, h) = (bm.bmWidth, bm.bmHeight);
        // SAFETY: GetDC(NULL) = screen DC, released by the guard.
        let dc = ScreenDc(unsafe { GetDC(null_mut()) });
        if dc.0.is_null() {
            return None;
        }
        let color = dib_bits(dc.0, bitmaps.0.hbmColor, w, h)?;
        let mask = if bitmaps.0.hbmMask.is_null() {
            None
        } else {
            dib_bits(dc.0, bitmaps.0.hbmMask, w, h)
        };
        let rgba = bgra_to_rgba(&color, mask.as_deref(), w as usize, h as usize)?;
        Some((w as u32, h as u32, rgba))
    }

    /// The first `h` rows of `bitmap` as 32-bit top-down BGRA.
    fn dib_bits(dc: HDC, bitmap: HBITMAP, w: i32, h: i32) -> Option<Vec<u8>> {
        // SAFETY: zeroed POD; header filled below.
        let mut bmi: BITMAPINFO = unsafe { zeroed() };
        bmi.bmiHeader = BITMAPINFOHEADER {
            biSize: size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: w,
            biHeight: -h, // top-down
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB,
            ..unsafe { zeroed() }
        };
        let mut buf = vec![0u8; w as usize * h as usize * 4];
        // SAFETY: `buf` holds exactly h rows of w 32-bit pixels.
        let lines = unsafe {
            GetDIBits(
                dc,
                bitmap,
                0,
                h as u32,
                buf.as_mut_ptr().cast(),
                &mut bmi,
                DIB_RGB_COLORS,
            )
        };
        (lines == h).then_some(buf)
    }

    fn encode_png(w: u32, h: u32, rgba: &[u8]) -> Option<Vec<u8>> {
        let mut out = Vec::new();
        let mut enc = png::Encoder::new(&mut out, w, h);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        let mut writer = enc.write_header().ok()?;
        writer.write_image_data(rgba).ok()?;
        writer.finish().ok()?;
        Some(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn alpha_icons_keep_their_alpha() {
        // two pixels: blue opaque, red half transparent (BGRA)
        let color = [255, 0, 0, 255, 0, 0, 255, 128];
        let out = bgra_to_rgba(&color, Some(&[255; 8]), 2, 1).unwrap();
        assert_eq!(out, [0, 0, 255, 255, 255, 0, 0, 128]);
    }

    #[test]
    fn icons_without_alpha_use_the_mask() {
        let color = [10, 20, 30, 0, 40, 50, 60, 0];
        // first pixel mask black (opaque), second white (transparent)
        let mask = [0, 0, 0, 0, 255, 255, 255, 0];
        let out = bgra_to_rgba(&color, Some(&mask), 2, 1).unwrap();
        assert_eq!(out, [30, 20, 10, 255, 60, 50, 40, 0]);
    }

    #[test]
    fn icons_without_alpha_or_mask_are_opaque() {
        let out = bgra_to_rgba(&[1, 2, 3, 0], None, 1, 1).unwrap();
        assert_eq!(out, [3, 2, 1, 255]);
    }

    #[test]
    fn size_mismatch_is_rejected() {
        assert!(bgra_to_rgba(&[0; 7], None, 2, 1).is_none());
        assert!(bgra_to_rgba(&[0; 8], Some(&[0; 4]), 2, 1).is_none());
        assert!(bgra_to_rgba(&[], None, usize::MAX, 2).is_none());
    }

    #[cfg(not(windows))]
    #[test]
    fn no_icons_off_windows() {
        assert_eq!(icon_data_url("/bin/sh"), None);
    }
}
