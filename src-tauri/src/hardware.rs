use serde::Serialize;
use std::{fs, process::Command};

const BYTES_PER_GIB: u64 = 1024 * 1024 * 1024;
const LIGHTWEIGHT_DEFAULT_MODEL: &str = "llama3.2:3b";
const BALANCED_DEFAULT_MODEL: &str = "qwen2.5:7b";
const BALANCED_LOCAL_RAM_GB: u64 = 16;
pub const CLOUD_BRIDGE_RAM_GB: u64 = 32;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HardwareProfile {
    pub total_ram_bytes: u64,
    pub total_ram_gb: u64,
    pub ram_source: String,
    pub tier: String,
    pub default_local_model: String,
    pub cloud_bridge_recommended_below_gb: u64,
}

#[tauri::command]
pub fn scan_hardware_profile() -> HardwareProfile {
    build_hardware_profile()
}

pub fn build_hardware_profile() -> HardwareProfile {
    let (total_ram_bytes, ram_source) = detect_total_ram_bytes()
        .map(|(bytes, source)| (bytes, source.to_string()))
        .unwrap_or_else(|| (0, "unknown".to_string()));
    let total_ram_gb = total_ram_bytes / BYTES_PER_GIB;
    let tier = classify_tier(total_ram_gb).to_string();
    let default_local_model = if total_ram_gb >= BALANCED_LOCAL_RAM_GB {
        BALANCED_DEFAULT_MODEL
    } else {
        LIGHTWEIGHT_DEFAULT_MODEL
    }
    .to_string();

    HardwareProfile {
        total_ram_bytes,
        total_ram_gb,
        ram_source,
        tier,
        default_local_model,
        cloud_bridge_recommended_below_gb: CLOUD_BRIDGE_RAM_GB,
    }
}

fn classify_tier(total_ram_gb: u64) -> &'static str {
    if total_ram_gb == 0 || total_ram_gb < BALANCED_LOCAL_RAM_GB {
        "tier1-fallback"
    } else if total_ram_gb < CLOUD_BRIDGE_RAM_GB {
        "local-balanced"
    } else {
        "local-heavy"
    }
}

#[cfg(target_os = "windows")]
fn detect_total_ram_bytes() -> Option<(u64, &'static str)> {
    let output = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            "(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory",
        ])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    parse_first_u64(&String::from_utf8_lossy(&output.stdout))
        .map(|bytes| (bytes, "windows-cim"))
}

#[cfg(target_os = "macos")]
fn detect_total_ram_bytes() -> Option<(u64, &'static str)> {
    let output = Command::new("sysctl")
        .args(["-n", "hw.memsize"])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    parse_first_u64(&String::from_utf8_lossy(&output.stdout)).map(|bytes| (bytes, "macos-sysctl"))
}

#[cfg(target_os = "linux")]
fn detect_total_ram_bytes() -> Option<(u64, &'static str)> {
    let body = fs::read_to_string("/proc/meminfo").ok()?;
    let mem_total_line = body
        .lines()
        .find(|line| line.trim_start().starts_with("MemTotal:"))?;
    let kib = parse_first_u64(mem_total_line)?;

    kib.checked_mul(1024)
        .map(|bytes| (bytes, "linux-proc-meminfo"))
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
fn detect_total_ram_bytes() -> Option<(u64, &'static str)> {
    None
}

fn parse_first_u64(input: &str) -> Option<u64> {
    input
        .split(|character: char| !character.is_ascii_digit())
        .find(|part| !part.is_empty())
        .and_then(|part| part.parse::<u64>().ok())
}
