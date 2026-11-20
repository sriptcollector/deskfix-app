// System checks (Orion, 2026-11-20: "it should probably be able to check the cpu gpu"). All read-only:
// CPU load and the busiest programs, graphics card, memory, disk space, battery, temperatures where the
// computer reports them, network, and what starts with the computer. Numbers come back as JSON for the
// AI and as a plain-words `report` the person can be shown as is.
use serde::Serialize;
use serde_json::{json, Value};
use std::process::Command;
use sysinfo::{Components, Disks, Networks, ProcessRefreshKind, ProcessesToUpdate, RefreshKind, System};

#[derive(Serialize)]
pub struct Check {
    pub what: String,
    pub data: Value,
    pub report: String,
}

fn run(cmd: &str, args: &[&str]) -> Option<String> {
    let mut c = Command::new(cmd);
    c.args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000);
    }
    let out = c.output().ok()?;
    let t = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if t.is_empty() { None } else { Some(t) }
}

fn ps(script: &str) -> Option<String> {
    run("powershell", &["-NoProfile", "-NonInteractive", "-Command", &format!("$ProgressPreference='SilentlyContinue'; {script}")])
}

pub fn gb(bytes: u64) -> String {
    let g = bytes as f64 / 1e9;
    if g >= 100.0 { format!("{g:.0} GB") } else if g >= 10.0 { format!("{g:.0} GB") } else { format!("{g:.1} GB") }
}

/// Plain words for a load percentage.
pub fn load_words(pct: f32) -> &'static str {
    if pct >= 85.0 { "very busy" } else if pct >= 50.0 { "busy" } else if pct >= 20.0 { "working normally" } else { "mostly idle" }
}

fn cpu() -> (Value, String) {
    let mut s = System::new_with_specifics(RefreshKind::nothing().with_cpu(sysinfo::CpuRefreshKind::everything()).with_processes(ProcessRefreshKind::nothing().with_cpu().with_memory()));
    std::thread::sleep(sysinfo::MINIMUM_CPU_UPDATE_INTERVAL.max(std::time::Duration::from_millis(600)));
    s.refresh_cpu_usage();
    s.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing().with_cpu().with_memory());
    let cores = s.cpus().len().max(1);
    let load = s.global_cpu_usage();
    let name = s.cpus().first().map(|c| c.brand().trim().to_string()).unwrap_or_default();
    // Group by program name (a browser is many processes).
    let mut by: std::collections::HashMap<String, (f32, u64)> = Default::default();
    for p in s.processes().values() {
        let n = p.name().to_string_lossy().trim_end_matches(".exe").to_string();
        let e = by.entry(n).or_default();
        e.0 += p.cpu_usage() / cores as f32;
        e.1 += p.memory();
    }
    let mut top: Vec<_> = by.into_iter().filter(|(n, _)| !n.is_empty() && n != "Idle" && n != "System Idle Process" && n != "kernel_task" && n != "deskfix").collect();
    top.sort_by(|a, b| b.1 .0.partial_cmp(&a.1 .0).unwrap_or(std::cmp::Ordering::Equal));
    let top: Vec<Value> = top.iter().take(5).map(|(n, (c, m))| json!({ "name": n, "cpu_pct": (c * 10.0).round() / 10.0, "memory": gb(*m) })).collect();
    let uptime = System::uptime();
    let busiest = top.iter().filter(|t| t["cpu_pct"].as_f64().unwrap_or(0.0) >= 5.0).map(|t| format!("{} ({}%)", t["name"].as_str().unwrap_or(""), t["cpu_pct"])).collect::<Vec<_>>();
    let mut report = format!("The processor is {} ({:.0}% in use, {} cores).", load_words(load), load, cores);
    if !busiest.is_empty() {
        report.push_str(&format!(" The busiest programs: {}.", busiest.join(", ")));
    }
    if uptime > 7 * 86400 {
        report.push_str(&format!(" The computer has not been restarted for {} days.", uptime / 86400));
    }
    (json!({ "name": name, "cores": cores, "load_pct": (load * 10.0).round() / 10.0, "uptime_hours": uptime / 3600, "top": top }), report)
}

fn gpu() -> (Value, String) {
    let mut cards: Vec<Value> = vec![];
    if cfg!(windows) {
        if let Some(t) = ps("Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name + '|' + $_.DriverVersion + '|' + $_.DriverDate + '|' + $_.AdapterRAM + '|' + $_.Status }") {
            for l in t.lines() {
                let p: Vec<&str> = l.split('|').collect();
                if p.len() >= 5 {
                    cards.push(json!({ "name": p[0].trim(), "driver": p[1].trim(), "driver_date": p[2].trim().chars().take(10).collect::<String>(), "memory": p[3].trim().parse::<u64>().ok().filter(|v| *v > 0).map(gb), "status": p[4].trim() }));
                }
            }
        }
        if let Some(t) = run("nvidia-smi", &["--query-gpu=name,utilization.gpu,temperature.gpu,memory.used,memory.total", "--format=csv,noheader,nounits"]) {
            for l in t.lines() {
                let p: Vec<&str> = l.split(',').map(|x| x.trim()).collect();
                if p.len() >= 5 {
                    if let Some(c) = cards.iter_mut().find(|c| c["name"].as_str().map_or(false, |n| n.contains(p[0]) || p[0].contains(n))) {
                        c["load_pct"] = json!(p[1].parse::<f64>().ok());
                        c["temperature_c"] = json!(p[2].parse::<f64>().ok());
                        c["memory_used"] = json!(format!("{} of {} MB", p[3], p[4]));
                    }
                }
            }
        } else if let Some(t) = ps("(Get-Counter '\\GPU Engine(*engtype_3D)\\Utilization Percentage' -ErrorAction SilentlyContinue).CounterSamples | Measure-Object CookedValue -Sum | Select-Object -ExpandProperty Sum") {
            if let (Ok(v), Some(c)) = (t.trim().parse::<f64>(), cards.first_mut()) {
                c["load_pct"] = json!((v.min(100.0) * 10.0).round() / 10.0);
            }
        }
    } else if let Some(t) = run("system_profiler", &["SPDisplaysDataType", "-json"]) {
        if let Ok(v) = serde_json::from_str::<Value>(&t) {
            for g in v["SPDisplaysDataType"].as_array().cloned().unwrap_or_default() {
                cards.push(json!({ "name": g["sppci_model"].as_str().unwrap_or("Graphics"), "cores": g["sppci_cores"].as_str(), "memory": g["spdisplays_vram"].as_str().or(g["spdisplays_vram_shared"].as_str()), "metal": g["spdisplays_mtlgpufamilysupport"].as_str(), "driver": "built into macOS" }));
            }
        }
    }
    let report = if cards.is_empty() {
        "I could not read the graphics card details on this computer.".to_string()
    } else {
        cards.iter().map(|c| {
            let mut s = format!("Graphics: {}", c["name"].as_str().unwrap_or("unknown"));
            if let Some(l) = c["load_pct"].as_f64() { s.push_str(&format!(", {l:.0}% in use")); }
            if let Some(t) = c["temperature_c"].as_f64() { s.push_str(&format!(", {t:.0}°C")); }
            if let Some(d) = c["driver"].as_str() { if !d.is_empty() { s.push_str(&format!(", driver {d}")); } }
            if let Some(d) = c["driver_date"].as_str() { if !d.is_empty() { s.push_str(&format!(" from {d}")); } }
            if let Some(st) = c["status"].as_str() { if st != "OK" && !st.is_empty() { s.push_str(&format!(". Windows reports its status as {st}")); } }
            s + "."
        }).collect::<Vec<_>>().join(" ")
    };
    (json!(cards), report)
}

fn memory() -> (Value, String) {
    let mut s = System::new_with_specifics(RefreshKind::nothing().with_memory(sysinfo::MemoryRefreshKind::everything()));
    s.refresh_memory();
    let (total, used, avail) = (s.total_memory(), s.used_memory(), s.available_memory());
    let pct = if total > 0 { used as f64 * 100.0 / total as f64 } else { 0.0 };
    let swap = s.used_swap();
    let mut report = format!("Memory: {} of {} in use ({pct:.0}%).", gb(used), gb(total));
    if pct >= 90.0 {
        report.push_str(" That is nearly full, which makes everything slow. Closing programs or browser tabs frees it.");
    } else if pct >= 75.0 {
        report.push_str(" That is getting full.");
    } else {
        report.push_str(" There is room.");
    }
    if swap > 2_000_000_000 {
        report.push_str(&format!(" The computer is also using {} of slower disk memory.", gb(swap)));
    }
    (json!({ "total": gb(total), "used": gb(used), "available": gb(avail), "used_pct": pct.round(), "swap_used": gb(swap) }), report)
}

fn disk() -> (Value, String) {
    let disks = Disks::new_with_refreshed_list();
    let mut rows: Vec<Value> = vec![];
    let mut lines: Vec<String> = vec![];
    for d in disks.list() {
        let mount = d.mount_point().to_string_lossy().to_string();
        if d.total_space() == 0 || mount.contains("/System/Volumes/") && !mount.ends_with("/Data") || mount.starts_with("/private") || mount.starts_with("/dev") {
            continue;
        }
        let (total, free) = (d.total_space(), d.available_space());
        let pct = (total - free) as f64 * 100.0 / total as f64;
        let name = if mount == "/" || mount.ends_with("/Data") { "Main disk".to_string() } else if mount.starts_with("C:") { "Main disk (C:)".to_string() } else { format!("Disk {}", mount.trim_end_matches('\\')) };
        rows.push(json!({ "name": name, "mount": mount, "total": gb(total), "free": gb(free), "used_pct": pct.round(), "kind": format!("{:?}", d.kind()), "removable": d.is_removable() }));
        let mut l = format!("{name}: {} free of {} ({pct:.0}% full)", gb(free), gb(total));
        if free < 10_000_000_000 {
            l.push_str(". That is very low: the computer needs about 10 GB free to run well");
        } else if pct >= 90.0 {
            l.push_str(". Getting full");
        }
        lines.push(l + ".");
    }
    if lines.is_empty() {
        lines.push("I could not read the disk space.".into());
    }
    (json!(rows), lines.join(" "))
}

fn battery() -> (Value, String) {
    if cfg!(windows) {
        let t = ps("$b = Get-CimInstance Win32_Battery; if ($b) { $b.EstimatedChargeRemaining.ToString() + '|' + $b.BatteryStatus + '|' + $b.EstimatedRunTime } else { 'none' }").unwrap_or_default();
        if t.trim() == "none" || t.is_empty() {
            return (json!({ "present": false }), "This computer has no battery (it is plugged in, like a desktop).".into());
        }
        let p: Vec<&str> = t.split('|').collect();
        let pct = p.first().and_then(|x| x.trim().parse::<u32>().ok());
        let status = p.get(1).and_then(|x| x.trim().parse::<u32>().ok()).unwrap_or(0);
        let charging = matches!(status, 2 | 6 | 7 | 8 | 9);
        let mins = p.get(2).and_then(|x| x.trim().parse::<u64>().ok()).filter(|m| *m < 71_000);
        let mut report = format!("Battery: {}%{}", pct.map_or("?".to_string(), |x| x.to_string()), if charging { ", charging" } else { "" });
        if let (Some(m), false) = (mins, charging) {
            report.push_str(&format!(", about {} left", if m >= 60 { format!("{} h {} min", m / 60, m % 60) } else { format!("{m} min") }));
        }
        (json!({ "present": true, "percent": pct, "charging": charging, "minutes_left": mins }), report + ".")
    } else {
        let t = run("pmset", &["-g", "batt"]).unwrap_or_default();
        if !t.contains('%') {
            return (json!({ "present": false }), "This computer has no battery (it is plugged in, like a desktop).".into());
        }
        let pct = t.split('%').next().and_then(|s| s.rsplit(|c: char| !c.is_ascii_digit()).next()).and_then(|s| s.parse::<u32>().ok());
        let charging = t.contains("charging") && !t.contains("discharging");
        let left = t.split(';').nth(2).map(|s| s.trim().replace(" remaining present: true", "").replace("(no estimate)", "")).filter(|s| s.contains(':'));
        let cond = run("system_profiler", &["SPPowerDataType"]).and_then(|s| s.lines().find(|l| l.contains("Condition:")).map(|l| l.split(':').nth(1).unwrap_or("").trim().to_string()));
        let mut report = format!("Battery: {}%{}", pct.map_or("?".to_string(), |x| x.to_string()), if charging { ", charging" } else { "" });
        if let Some(l) = &left {
            report.push_str(&format!(", about {} (hours:minutes) left", l.split(' ').next().unwrap_or("")));
        }
        if let Some(c) = &cond {
            if c != "Normal" {
                report.push_str(&format!(". The battery's condition is: {c}"));
            }
        }
        (json!({ "present": true, "percent": pct, "charging": charging, "time_left": left, "condition": cond }), report + ".")
    }
}

fn temperature() -> (Value, String) {
    let comps = Components::new_with_refreshed_list();
    let mut rows: Vec<Value> = vec![];
    for c in comps.list() {
        if let Some(t) = c.temperature() {
            if t > 0.0 {
                rows.push(json!({ "name": c.label(), "c": (t * 10.0).round() / 10.0 }));
            }
        }
    }
    if rows.is_empty() && cfg!(windows) {
        if let Some(t) = ps("(Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature -ErrorAction SilentlyContinue | Select-Object -First 1).CurrentTemperature") {
            if let Ok(k) = t.trim().parse::<f64>() {
                rows.push(json!({ "name": "System", "c": ((k / 10.0 - 273.15) * 10.0).round() / 10.0 }));
            }
        }
    }
    if rows.is_empty() {
        return (json!([]), "This computer does not report its temperature to programs. If the fan is loud or the case is hot, the CPU check shows what is working it hard.".into());
    }
    let hot = rows.iter().filter_map(|r| r["c"].as_f64()).fold(0.0_f64, f64::max);
    let mut report = format!("Temperatures: {}.", rows.iter().take(4).map(|r| format!("{} {}°C", r["name"].as_str().unwrap_or(""), r["c"])).collect::<Vec<_>>().join(", "));
    if hot >= 90.0 {
        report.push_str(" That is hot. The computer may slow itself down to cool off; check the vents are clear.");
    } else if hot >= 75.0 {
        report.push_str(" That is warm but normal under load.");
    } else {
        report.push_str(" That is fine.");
    }
    (json!(rows), report)
}

fn network() -> (Value, String) {
    let nets = Networks::new_with_refreshed_list();
    let mut ifaces: Vec<Value> = vec![];
    for (name, n) in nets.list() {
        if n.ip_networks().iter().any(|ip| !ip.addr.is_loopback() && ip.addr.is_ipv4()) {
            ifaces.push(json!({ "name": name, "ip": n.ip_networks().iter().filter(|ip| ip.addr.is_ipv4()).map(|ip| ip.addr.to_string()).collect::<Vec<_>>(), "received": gb(n.total_received()), "sent": gb(n.total_transmitted()) }));
        }
    }
    let wifi = if cfg!(windows) {
        run("netsh", &["wlan", "show", "interfaces"]).map(|t| {
            let get = |k: &str| t.lines().find(|l| l.trim_start().starts_with(k)).and_then(|l| l.split_once(':')).map(|x| x.1.trim().to_string());
            json!({ "name": get("SSID"), "signal": get("Signal"), "state": get("State"), "speed": get("Receive rate (Mbps)") })
        })
    } else {
        let dev = run("networksetup", &["-listallhardwareports"]).and_then(|t| {
            let mut next = false;
            for l in t.lines() {
                if l.contains("Hardware Port: Wi-Fi") { next = true } else if next && l.starts_with("Device:") { return Some(l.trim_start_matches("Device:").trim().to_string()) }
            }
            None
        }).unwrap_or("en0".into());
        run("networksetup", &["-getairportnetwork", &dev]).map(|t| json!({ "name": t.split(':').nth(1).map(|s| s.trim()), "state": if t.contains("not associated") || t.contains("off") { "off or not connected" } else { "connected" } }))
    };
    // One quick reach test (2 s cap): can we get to the internet?
    let ping_ok = if cfg!(windows) { run("ping", &["-n", "1", "-w", "1500", "1.1.1.1"]).map_or(false, |t| t.contains("TTL=")) } else { run("ping", &["-c", "1", "-W", "1500", "1.1.1.1"]).map_or(false, |t| t.contains("1 packets received") || t.contains("1 received")) };
    let dns_ok = std::net::ToSocketAddrs::to_socket_addrs(&("www.apple.com", 443)).map_or(false, |mut a| a.next().is_some());
    let mut report = String::new();
    if let Some(w) = &wifi {
        match w["name"].as_str().filter(|n| !n.is_empty() && *n != "null") {
            Some(n) => {
                report.push_str(&format!("Wi-Fi: connected to {n}"));
                if let Some(s) = w["signal"].as_str() { report.push_str(&format!(", signal {s}")); }
                report.push_str(". ");
            }
            None => report.push_str("Wi-Fi: not connected. "),
        }
    }
    if ifaces.is_empty() {
        report.push_str("No network connection at all. ");
    }
    report.push_str(if ping_ok && dns_ok { "The internet is reachable." } else if ping_ok { "The internet answers, but website names do not resolve (a DNS problem)." } else if !ifaces.is_empty() { "Connected to the network, but the internet does not answer: the router or the internet line may be down." } else { "" });
    (json!({ "interfaces": ifaces, "wifi": wifi, "internet": ping_ok, "dns": dns_ok }), report.trim().to_string())
}

fn startup() -> (Value, String) {
    let mut items: Vec<Value> = vec![];
    if cfg!(windows) {
        if let Some(t) = ps("Get-CimInstance Win32_StartupCommand | ForEach-Object { $_.Name + '|' + $_.Location + '|' + $_.Command }") {
            for l in t.lines() {
                let p: Vec<&str> = l.splitn(3, '|').collect();
                if p.len() == 3 {
                    items.push(json!({ "name": p[0].trim(), "where": p[1].trim(), "command": p[2].trim().chars().take(160).collect::<String>() }));
                }
            }
        }
        // Items the person turned off in Task Manager are not loading; drop them from the list.
        if let Some(t) = ps("Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run' -ErrorAction SilentlyContinue | Select-Object * -ExcludeProperty PS* | ForEach-Object { $_.PSObject.Properties | ForEach-Object { $_.Name + '|' + (($_.Value | ForEach-Object { $_ }) -join ',') } }") {
            let off: Vec<String> = t.lines().filter(|l| l.contains("|3,") || l.contains("|3")).filter_map(|l| l.split('|').next().map(|s| s.to_lowercase())).collect();
            items.retain(|i| !off.contains(&i["name"].as_str().unwrap_or("").to_lowercase()));
        }
    } else {
        if let Some(t) = run("osascript", &["-e", "tell application \"System Events\" to get the name of every login item"]) {
            for n in t.split(',').map(|s| s.trim()).filter(|s| !s.is_empty()) {
                items.push(json!({ "name": n, "where": "Login Items" }));
            }
        }
        for dir in ["Library/LaunchAgents"] {
            let p = std::path::PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(dir);
            if let Ok(rd) = std::fs::read_dir(p) {
                for e in rd.flatten() {
                    let n = e.file_name().to_string_lossy().trim_end_matches(".plist").to_string();
                    if !n.starts_with("com.apple") {
                        items.push(json!({ "name": n, "where": "Background items" }));
                    }
                }
            }
        }
    }
    let report = if items.is_empty() {
        "Nothing extra starts with the computer.".to_string()
    } else {
        let names: Vec<&str> = items.iter().filter_map(|i| i["name"].as_str()).collect();
        format!("{} program{} start{} with the computer: {}.{}", names.len(), if names.len() == 1 { "" } else { "s" }, if names.len() == 1 { "s" } else { "" }, names.join(", "), if names.len() >= 6 { " That many slows down starting up." } else { "" })
    };
    (json!(items), report)
}

fn one(what: &str) -> Option<(Value, String)> {
    Some(match what {
        "cpu" => cpu(),
        "gpu" => gpu(),
        "memory" => memory(),
        "disk" => disk(),
        "battery" => battery(),
        "temperature" => temperature(),
        "network" => network(),
        "startup" => startup(),
        "system" => {
            let os = System::long_os_version().unwrap_or_default();
            let host = System::host_name().unwrap_or_default();
            (json!({ "os": os, "computer": host, "uptime_hours": System::uptime() / 3600 }), format!("This is {os}."))
        }
        _ => return None,
    })
}

/// `what`: cpu | gpu | memory | disk | battery | temperature | network | startup | system | all
#[tauri::command]
pub async fn syscheck(what: String) -> Result<Check, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if what == "all" {
            let mut data = serde_json::Map::new();
            let mut lines = vec![];
            for w in ["system", "cpu", "memory", "disk", "gpu", "temperature", "battery", "network", "startup"] {
                let (d, r) = one(w).unwrap();
                data.insert(w.into(), d);
                lines.push(r);
            }
            return Ok(Check { what, data: Value::Object(data), report: lines.join("\n") });
        }
        let (data, report) = one(&what).ok_or("unknown check")?;
        Ok(Check { what, data, report })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn plain_numbers() {
        assert_eq!(gb(512_000_000_000), "512 GB");
        assert_eq!(gb(15_900_000_000), "16 GB");
        assert_eq!(gb(2_450_000_000), "2.5 GB");
        assert_eq!(load_words(3.0), "mostly idle");
        assert_eq!(load_words(60.0), "busy");
        assert_eq!(load_words(95.0), "very busy");
    }
    #[test]
    fn checks_run_read_only_and_say_something() {
        // Every check on this machine returns a plain sentence (no numbers-only output, nothing blank).
        for w in ["cpu", "memory", "disk", "battery", "temperature", "network", "startup", "system", "gpu"] {
            let (_, r) = one(w).unwrap();
            assert!(r.ends_with('.'), "{w}: {r}");
            assert!(r.len() > 10, "{w}: {r}");
        }
        assert!(one("nope").is_none());
    }
}
