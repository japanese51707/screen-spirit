# Window context feasibility check

This macOS-only prototype checks whether the OS exposes enough window metadata to estimate which applications occupy a selected screen rectangle. It reads window metadata only; it does not capture pixels, OCR text, or print app names or window titles.

## Result on the current Mac

- `CGWindowListCopyWindowInfo(.optionOnScreenOnly, ...)` returned 37 on-screen window records in this run.
- All 37 records included an owner name, process ID, and bounds.
- The test region on the main display was fully accounted for by one visible owner in this run.
- Synthetic overlap checks passed: a front window covering 60% of a selection produced 60/40 visible-area shares, and an even split produced 50/50.

The live counts vary with the desktop and are evidence that the API works in this environment, not a guarantee for every application or macOS version. Apple documents that `optionOnScreenOnly` returns windows front-to-back and that window records can include owner names and bounds.

## Algorithm and limits

The current rectangle model processes windows front-to-back, clips each window to the selection, and subtracts areas covered by opaque windows above it. It groups the remaining visible area by app owner.

This is a feasibility model, not pixel-accurate compositing. Translucent or irregularly shaped windows, system overlays, separate Spaces, app-owned popovers, and the helper's own overlay need explicit handling. The product should take its window snapshot before showing its own selection overlay. Multi-display coordinate conversion still needs a dedicated check.

## Windows feasibility from official APIs

Windows exposes corresponding building blocks: `EnumWindows` enumerates desktop top-level windows, `GetWindowThreadProcessId` retrieves each owner PID, and DWM can provide extended frame bounds and cloaking state. Z-order is exposed through `GetTopWindow` and `GetWindow`; `IsWindowVisible` alone is insufficient because a window can be fully obscured while still marked visible. These APIs were reviewed from Microsoft documentation but not executed on Windows in this environment.

- [Apple: on-screen window order](https://developer.apple.com/documentation/coregraphics/cgwindowlistoption/optiononscreenonly)
- [Apple: window list metadata](https://developer.apple.com/documentation/coregraphics/cgwindowlistcopywindowinfo%28_%3A_%3A%29)
- [Microsoft: EnumWindows](https://learn.microsoft.com/windows/win32/api/winuser/nf-winuser-enumwindows)
- [Microsoft: process ID for a window](https://learn.microsoft.com/windows/win32/api/winuser/nf-winuser-getwindowthreadprocessid)
- [Microsoft: DWM frame bounds and attributes](https://learn.microsoft.com/windows/win32/dwm/composition-ovw)
- [Microsoft: window z-order](https://learn.microsoft.com/windows/win32/winmsg/window-features)
