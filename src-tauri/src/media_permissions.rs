//! Answer the webview when it asks to use the camera, the microphone or the screen.
//!
//! WebView2 raises `PermissionRequested` and, with no handler attached, denies. Nothing asks the
//! user and nothing is logged, so a capture that was never permitted looks exactly like a capture
//! that silently failed — which is how an extension can hold `media:capture`, be granted it by the
//! user at install time, and still get `NotAllowedError` forever.
//!
//! The consent already happened: l8db asks before granting `media:capture` to an extension, and
//! refuses the RPC without it. This only stops the second, invisible gate from overriding the
//! first one. It grants those three kinds and nothing else — geolocation, notifications and the
//! rest keep WebView2's deny-by-default.

#[cfg(not(windows))]
pub fn allow_capture(_window: &tauri::WebviewWindow) {}

#[cfg(windows)]
pub fn allow_capture(window: &tauri::WebviewWindow) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_PERMISSION_KIND_CAMERA, COREWEBVIEW2_PERMISSION_KIND_MICROPHONE,
        COREWEBVIEW2_PERMISSION_STATE_ALLOW,
    };
    use webview2_com::PermissionRequestedEventHandler;

    let attached = window.with_webview(|webview| unsafe {
        let core = match webview.controller().CoreWebView2() {
            Ok(core) => core,
            Err(error) => {
                eprintln!("l8db: no CoreWebView2 to attach media permissions to: {error}");
                return;
            }
        };
        let mut token = Default::default();
        let handler = PermissionRequestedEventHandler::create(Box::new(|_sender, args| {
            let Some(args) = args else {
                return Ok(());
            };
            let mut kind = Default::default();
            args.PermissionKind(&mut kind)?;
            if kind == COREWEBVIEW2_PERMISSION_KIND_CAMERA
                || kind == COREWEBVIEW2_PERMISSION_KIND_MICROPHONE
            {
                args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)?;
            }
            Ok(())
        }));
        if let Err(error) = core.add_PermissionRequested(&handler, &mut token) {
            eprintln!("l8db: could not answer webview permission requests: {error}");
        }
    });
    if let Err(error) = attached {
        eprintln!("l8db: webview unavailable for media permissions: {error}");
    }
}
