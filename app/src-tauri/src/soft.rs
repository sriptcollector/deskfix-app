// Pressing a control without the person's mouse (Orion, 2026-11-20: "it should have its own cursor").
// Windows asks UI Automation for the control under the point and invokes it; a Mac asks Accessibility
// for the element and performs AXPress. Either way the real pointer never moves. When the control
// can't be pressed this way, `input.rs` falls back to a real click and puts the pointer back after.
// Only small controls (a button, a switch, a menu item) are pressed softly: a whole window or a
// big panel under the point means the AI aimed at something that isn't a control, so we fall back.

/// Largest control we press softly (logical points). Bigger means "not a control" to us.
const MAX_W: f64 = 640.0;
const MAX_H: f64 = 200.0;

#[derive(Debug, PartialEq)]
pub struct Found {
    pub name: String,
    pub kind: String,
    pub rect: (f64, f64, f64, f64), // left, top, width, height
    pub pressable: bool,
}

/// Decides, from what the OS told us, whether a soft press is the right thing (pure, so it's tested).
pub fn should_press(f: &Found, x: f64, y: f64) -> bool {
    let (l, t, w, h) = f.rect;
    f.pressable && w > 0.0 && h > 0.0 && w <= MAX_W && h <= MAX_H && x >= l && x <= l + w && y >= t && y <= t + h
}

#[cfg(windows)]
pub fn press(x: f64, y: f64) -> Result<String, String> {
    use uiautomation::controls::ControlType;
    use uiautomation::patterns::{UIExpandCollapsePattern, UIInvokePattern, UISelectionItemPattern, UITogglePattern};
    use uiautomation::types::Point;
    use uiautomation::UIAutomation;
    let s = crate::screen::monitor_scale();
    let a = UIAutomation::new().map_err(|e| e.to_string())?;
    let el = a.element_from_point(Point::new((x * s).round() as i32, (y * s).round() as i32)).map_err(|e| e.to_string())?;
    let r = el.get_bounding_rectangle().map_err(|e| e.to_string())?;
    let kind = el.get_control_type().map_err(|e| e.to_string())?;
    let name = el.get_name().unwrap_or_default();
    let invoke = el.get_pattern::<UIInvokePattern>().ok();
    let toggle = el.get_pattern::<UITogglePattern>().ok();
    let select = el.get_pattern::<UISelectionItemPattern>().ok();
    let expand = el.get_pattern::<UIExpandCollapsePattern>().ok();
    let pressable = matches!(kind, ControlType::Button | ControlType::CheckBox | ControlType::RadioButton | ControlType::MenuItem | ControlType::TabItem | ControlType::ListItem | ControlType::Hyperlink | ControlType::SplitButton | ControlType::TreeItem | ControlType::ComboBox) && (invoke.is_some() || toggle.is_some() || select.is_some() || expand.is_some());
    let f = Found { name: name.clone(), kind: format!("{kind:?}"), rect: (r.get_left() as f64 / s, r.get_top() as f64 / s, (r.get_right() - r.get_left()) as f64 / s, (r.get_bottom() - r.get_top()) as f64 / s), pressable };
    if !should_press(&f, x, y) {
        return Err(format!("not a small control: {} {}", f.kind, f.name));
    }
    let r = if let Some(p) = invoke { p.invoke() } else if let Some(p) = toggle { p.toggle() } else if let Some(p) = select { p.select() } else if let Some(p) = expand { p.expand() } else { unreachable!() };
    r.map_err(|e| e.to_string())?;
    Ok(format!("{} {}", f.kind, f.name))
}

#[cfg(target_os = "macos")]
pub fn press(x: f64, y: f64) -> Result<String, String> {
    use accessibility_sys::*;
    use core_foundation::array::CFArray;
    use core_foundation::base::{CFType, TCFType};
    use core_foundation::string::CFString;
    unsafe {
        if !AXIsProcessTrusted() {
            return Err("no accessibility permission".into());
        }
        let sys = AXUIElementCreateSystemWide();
        let mut el: AXUIElementRef = std::ptr::null_mut();
        if AXUIElementCopyElementAtPosition(sys, x as f32, y as f32, &mut el) != kAXErrorSuccess || el.is_null() {
            core_foundation_sys::base::CFRelease(sys as _);
            return Err("nothing under the point".into());
        }
        core_foundation_sys::base::CFRelease(sys as _);
        let attr = |name: &str| -> Option<CFType> {
            let mut v: core_foundation_sys::base::CFTypeRef = std::ptr::null();
            if AXUIElementCopyAttributeValue(el, CFString::new(name).as_concrete_TypeRef(), &mut v) == kAXErrorSuccess && !v.is_null() {
                Some(CFType::wrap_under_create_rule(v))
            } else {
                None
            }
        };
        let role = attr(kAXRoleAttribute).and_then(|r| r.downcast::<CFString>()).map(|s| s.to_string()).unwrap_or_default();
        let name = attr("AXTitle").or_else(|| attr("AXDescription")).and_then(|r| r.downcast::<CFString>()).map(|s| s.to_string()).unwrap_or_default();
        let mut pos = [0f64; 2];
        let mut size = [0f64; 2];
        if let Some(p) = attr(kAXPositionAttribute) {
            AXValueGetValue(p.as_CFTypeRef() as AXValueRef, kAXValueTypeCGPoint, pos.as_mut_ptr() as _);
        }
        if let Some(sz) = attr(kAXSizeAttribute) {
            AXValueGetValue(sz.as_CFTypeRef() as AXValueRef, kAXValueTypeCGSize, size.as_mut_ptr() as _);
        }
        let mut names: core_foundation_sys::array::CFArrayRef = std::ptr::null();
        let mut can_press = false;
        if AXUIElementCopyActionNames(el, &mut names) == kAXErrorSuccess && !names.is_null() {
            let arr: CFArray<CFString> = CFArray::wrap_under_create_rule(names);
            can_press = arr.iter().any(|s| s.to_string() == kAXPressAction);
        }
        let pressable = can_press && matches!(role.as_str(), "AXButton" | "AXCheckBox" | "AXRadioButton" | "AXMenuItem" | "AXMenuButton" | "AXPopUpButton" | "AXLink" | "AXDisclosureTriangle" | "AXTab" | "AXCell" | "AXRow" | "AXStaticText" | "AXMenuBarItem" | "AXSwitch" | "AXToggle");
        let f = Found { name: name.clone(), kind: role.clone(), rect: (pos[0], pos[1], size[0], size[1]), pressable };
        if !should_press(&f, x, y) {
            core_foundation_sys::base::CFRelease(el as _);
            return Err(format!("not a small control: {role} {name}"));
        }
        let r = AXUIElementPerformAction(el, CFString::new(kAXPressAction).as_concrete_TypeRef());
        core_foundation_sys::base::CFRelease(el as _);
        if r == kAXErrorSuccess { Ok(format!("{role} {name}")) } else { Err(format!("press failed ({r})")) }
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
pub fn press(_x: f64, _y: f64) -> Result<String, String> {
    Err("not supported".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn f(w: f64, h: f64, pressable: bool) -> Found {
        Found { name: "OK".into(), kind: "Button".into(), rect: (100.0, 100.0, w, h), pressable }
    }
    #[test]
    fn presses_small_controls_under_the_point() {
        assert!(should_press(&f(120.0, 40.0, true), 150.0, 120.0));
        assert!(should_press(&f(600.0, 44.0, true), 150.0, 120.0)); // a wide list row
    }
    #[test]
    fn falls_back_for_windows_panels_and_misses() {
        assert!(!should_press(&f(1200.0, 800.0, true), 150.0, 120.0)); // a whole window
        assert!(!should_press(&f(120.0, 40.0, false), 150.0, 120.0)); // nothing to press
        assert!(!should_press(&f(120.0, 40.0, true), 50.0, 50.0)); // the point is outside it
        assert!(!should_press(&f(0.0, 0.0, true), 100.0, 100.0)); // no size reported
    }
}
