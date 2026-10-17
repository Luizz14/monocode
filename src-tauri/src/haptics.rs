//! Trackpad haptics for controls that move in steps, such as the composer's
//! model slider.
//!
//! WKWebView has no vibration API, so the page asks for each tick here.
//! AppKit's default performer only plays while a finger rests on a Force Touch
//! trackpad and follows the system's haptic feedback setting, so a Mac without
//! one, or with haptics turned off, simply feels nothing.

use objc2_app_kit::{
    NSHapticFeedbackManager, NSHapticFeedbackPattern, NSHapticFeedbackPerformanceTime,
    NSHapticFeedbackPerformer,
};
use tauri::AppHandle;

fn pattern_from(name: &str) -> NSHapticFeedbackPattern {
    match name {
        "alignment" => NSHapticFeedbackPattern::Alignment,
        "levelChange" => NSHapticFeedbackPattern::LevelChange,
        _ => NSHapticFeedbackPattern::Generic,
    }
}

pub fn perform(app: &AppHandle, pattern: &str) {
    let pattern = pattern_from(pattern);
    // AppKit feedback belongs on the main thread, like the rest of AppKit.
    let _ = app.run_on_main_thread(move || {
        NSHapticFeedbackManager::defaultPerformer()
            .performFeedbackPattern_performanceTime(pattern, NSHapticFeedbackPerformanceTime::Now);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_pattern_names() {
        assert_eq!(
            pattern_from("alignment"),
            NSHapticFeedbackPattern::Alignment
        );
        assert_eq!(
            pattern_from("levelChange"),
            NSHapticFeedbackPattern::LevelChange
        );
        assert_eq!(pattern_from("generic"), NSHapticFeedbackPattern::Generic);
        assert_eq!(pattern_from("unknown"), NSHapticFeedbackPattern::Generic);
    }
}
