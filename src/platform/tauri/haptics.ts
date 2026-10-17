import { invoke, isTauri } from "@tauri-apps/api/core";
import { IS_MAC } from "./platform";

/** AppKit's feedback patterns; `levelChange` suits a control stepping between values. */
export type HapticPattern = "generic" | "alignment" | "levelChange";

/**
 * Plays one trackpad haptic tick. WKWebView ignores `navigator.vibrate`, so
 * the native side performs it; off macOS, or outside Tauri, nothing happens.
 */
export function performHaptic(pattern: HapticPattern = "levelChange"): void {
  if (!IS_MAC || !isTauri()) return;
  void invoke("perform_haptic_feedback", { pattern }).catch(() => undefined);
}
