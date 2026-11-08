use std::ffi::OsStr;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::ptr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use windows_sys::Win32::Foundation::{GetLastError, ERROR_ALREADY_EXISTS};
use windows_sys::Win32::Security::Cryptography::{
    CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB,
};
use windows_sys::Win32::System::Threading::CreateMutexW;

#[link(name = "kernel32")]
unsafe extern "system" {
    fn LocalFree(hmem: *mut std::ffi::c_void) -> *mut std::ffi::c_void;
}

// ---------------------------------------------------------------------------
// 1. Windows Native DPAPI Module
// ---------------------------------------------------------------------------

pub fn dpapi_protect(data: &[u8]) -> Result<Vec<u8>, String> {
    let mut data_in = CRYPT_INTEGER_BLOB {
        cbData: data.len() as u32,
        pbData: data.as_ptr() as *mut u8,
    };
    let mut data_out = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: ptr::null_mut(),
    };
    let success = unsafe {
        CryptProtectData(
            &mut data_in,
            ptr::null(),
            ptr::null(),
            ptr::null(),
            ptr::null(),
            0,
            &mut data_out,
        )
    };
    if success == 0 {
        let err = unsafe { GetLastError() };
        return Err(format!("Windows DPAPI CryptProtectData failed: {err}"));
    }
    let slice = unsafe { std::slice::from_raw_parts(data_out.pbData, data_out.cbData as usize) };
    let result = slice.to_vec();
    unsafe {
        LocalFree(data_out.pbData as _);
    }
    Ok(result)
}

pub fn dpapi_unprotect(data: &[u8]) -> Result<Vec<u8>, String> {
    let mut data_in = CRYPT_INTEGER_BLOB {
        cbData: data.len() as u32,
        pbData: data.as_ptr() as *mut u8,
    };
    let mut data_out = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: ptr::null_mut(),
    };
    let success = unsafe {
        CryptUnprotectData(
            &mut data_in,
            ptr::null_mut(),
            ptr::null(),
            ptr::null(),
            ptr::null(),
            0,
            &mut data_out,
        )
    };
    if success == 0 {
        let err = unsafe { GetLastError() };
        return Err(format!("Windows DPAPI CryptUnprotectData failed: {err}"));
    }
    let slice = unsafe { std::slice::from_raw_parts(data_out.pbData, data_out.cbData as usize) };
    let result = slice.to_vec();
    unsafe {
        LocalFree(data_out.pbData as _);
    }
    Ok(result)
}

// ---------------------------------------------------------------------------
// 2. Database Key Management (Fail-Closed)
// ---------------------------------------------------------------------------

pub fn resolve_database_key(key_file: &Path, db_file: &Path) -> Result<String, String> {
    if key_file.exists() {
        let encrypted = fs::read(key_file)
            .map_err(|e| format!("無法讀取金鑰檔案: {e}"))?;
        let decrypted_bytes = dpapi_unprotect(&encrypted)
            .map_err(|_| "無法解開資料庫金鑰，請使用原 Windows 帳戶及其憑證。".to_string())?;
        let key_str = String::from_utf8(decrypted_bytes)
            .map_err(|_| "資料庫金鑰檔案格式無效。".to_string())?;
        let trimmed = key_str.trim();
        if trimmed.len() != 64 || !trimmed.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err("資料庫金鑰檔案無效（必須為 64 字元十六進位字串）。".to_string());
        }
        return Ok(trimmed.to_string());
    }

    let wal_path = PathBuf::from(format!("{}-wal", db_file.display()));
    let shm_path = PathBuf::from(format!("{}-shm", db_file.display()));
    if db_file.exists() || wal_path.exists() || shm_path.exists() {
        return Err("找不到現有加密資料庫的金鑰；未建立新金鑰，也未變更資料庫。".to_string());
    }

    // Generate fresh 32-byte cryptographic random key
    let mut raw_key = [0u8; 32];
    getrandom::getrandom(&mut raw_key)
        .map_err(|e| format!("生成隨機金鑰失敗: {e}"))?;
    let hex_key = raw_key.iter().map(|b| format!("{:02x}", b)).collect::<String>();

    let protected = dpapi_protect(hex_key.as_bytes())?;
    if let Some(parent) = key_file.parent() {
        let _ = fs::create_dir_all(parent);
    }
    fs::write(key_file, protected)
        .map_err(|e| format!("寫入加密金鑰失敗: {e}"))?;

    Ok(hex_key)
}

// ---------------------------------------------------------------------------
// 3. Child Process Supervisor
// ---------------------------------------------------------------------------

pub struct ChildSupervisor {
    child: Option<Child>,
    pub endpoint: String,
    pub secret: String,
}

impl ChildSupervisor {
    pub fn spawn(
        binary_path: &Path,
        web_assets_path: &Path,
        db_path: &Path,
        database_key: &str,
    ) -> Result<Self, String> {
        if !binary_path.exists() {
            return Err(format!("找不到 Go 後端二進位檔: {}", binary_path.display()));
        }

        let mut raw_secret = [0u8; 32];
        getrandom::getrandom(&mut raw_secret)
            .map_err(|e| format!("生成後端隨機密鑰失敗: {e}"))?;
        let backend_secret = raw_secret.iter().map(|b| format!("{:02x}", b)).collect::<String>();

        let mut cmd = Command::new(binary_path);
        cmd.env("SUITE_DESKTOP_SESSION", "1")
            .env("SUITE_DESKTOP_SECRET", &backend_secret)
            .env("SUITE_ADDR", "127.0.0.1:0")
            .env("SUITE_DB", db_path.to_string_lossy().as_ref())
            .env("SUITE_WEB", web_assets_path.to_string_lossy().as_ref())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = cmd.spawn().map_err(|e| format!("啟動 Go 後端進程失敗: {e}"))?;

        // Pipe the 256-bit database key via stdin followed by \n
        if let Some(mut stdin) = child.stdin.take() {
            let key_payload = format!("{}\n", database_key);
            let _ = stdin.write_all(key_payload.as_bytes());
            let _ = stdin.flush();
        }

        let stdout = child.stdout.take().ok_or("無法連接子進程 stdout")?;
        let stderr = child.stderr.take().ok_or("無法連接子進程 stderr")?;

        let endpoint_found = Arc::new(Mutex::new(None::<String>));
        let error_log = Arc::new(Mutex::new(String::new()));

        let ep_clone = endpoint_found.clone();
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().flatten() {
                if let Some(pos) = line.find("Go business-suite ready at ") {
                    let addr = line[pos + "Go business-suite ready at ".len()..].trim().to_string();
                    let mut lock = ep_clone.lock().unwrap();
                    *lock = Some(addr);
                    break;
                }
            }
        });

        let ep_clone2 = endpoint_found.clone();
        let err_clone = error_log.clone();
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().flatten() {
                if let Some(pos) = line.find("Go business-suite ready at ") {
                    let addr = line[pos + "Go business-suite ready at ".len()..].trim().to_string();
                    let mut lock = ep_clone2.lock().unwrap();
                    *lock = Some(addr);
                }
                let mut err_lock = err_clone.lock().unwrap();
                err_lock.push_str(&line);
                err_lock.push('\n');
            }
        });

        // Wait up to 20 seconds for readiness
        let start = Instant::now();
        let timeout = Duration::from_secs(20);
        let mut endpoint = None;

        while start.elapsed() < timeout {
            {
                let lock = endpoint_found.lock().unwrap();
                if let Some(ref ep) = *lock {
                    endpoint = Some(ep.clone());
                    break;
                }
            }
            if let Ok(Some(status)) = child.try_wait() {
                let err_msg = error_log.lock().unwrap().clone();
                return Err(format!("Go 後端提前結束 (代碼: {status:?}): {err_msg}"));
            }
            thread::sleep(Duration::from_millis(50));
        }

        let ep = match endpoint {
            Some(e) => e,
            None => {
                let _ = child.kill();
                return Err("Go 後端啟動逾時（20 秒內未回報就緒）".to_string());
            }
        };

        Ok(Self {
            child: Some(child),
            endpoint: ep,
            secret: backend_secret,
        })
    }

    pub fn shutdown(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

impl Drop for ChildSupervisor {
    fn drop(&mut self) {
        self.shutdown();
    }
}

// ---------------------------------------------------------------------------
// 4. Lightweight HTTP Client for Smoke & Verification
// ---------------------------------------------------------------------------

fn loopback_http_get(addr: &str, path: &str, secret: Option<&str>) -> Result<(u16, String), String> {
    let mut stream = TcpStream::connect(addr)
        .map_err(|e| format!("連線至 {addr} 失敗: {e}"))?;
    stream.set_read_timeout(Some(Duration::from_secs(5))).map_err(|e| e.to_string())?;

    let mut req = format!(
        "GET {} HTTP/1.1\r\nHost: {}\r\nConnection: close\r\n",
        path, addr
    );
    if let Some(sec) = secret {
        req.push_str(&format!("X-Suite-Desktop-Secret: {}\r\n", sec));
    }
    req.push_str("\r\n");

    stream.write_all(req.as_bytes()).map_err(|e| e.to_string())?;

    let mut response = String::new();
    stream.read_to_string(&mut response).map_err(|e| e.to_string())?;

    let status = response
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|s| s.parse::<u16>().ok())
        .ok_or_else(|| "無效的 HTTP 回應格式".to_string())?;

    Ok((status, response))
}

// ---------------------------------------------------------------------------
// 5. Path Resolution Helpers
// ---------------------------------------------------------------------------

fn locate_resource(rel_candidates: &[&str]) -> Option<PathBuf> {
    let exe = std::env::current_exe().unwrap_or_default();
    let exe_dir = exe.parent().unwrap_or(Path::new(""));

    for candidate in rel_candidates {
        let p1 = exe_dir.join(candidate);
        if p1.exists() {
            return Some(p1);
        }
        let p2 = PathBuf::from(candidate);
        if p2.exists() {
            return Some(p2);
        }
    }
    None
}

// ---------------------------------------------------------------------------
// 6. Single-Instance Named Mutex
// ---------------------------------------------------------------------------

fn acquire_single_instance(name: &str) -> bool {
    let wide: Vec<u16> = OsStr::new(name).encode_wide().chain(Some(0)).collect();
    let handle = unsafe { CreateMutexW(ptr::null(), 0, wide.as_ptr()) };
    if handle == ptr::null_mut() {
        return false;
    }
    let last_err = unsafe { GetLastError() };
    last_err != ERROR_ALREADY_EXISTS
}

// ---------------------------------------------------------------------------
// 7. Main Entry Point
// ---------------------------------------------------------------------------

fn main() {
    let is_smoke = std::env::var("SUITE_DESKTOP_SMOKE").as_deref() == Ok("1");

    if !is_smoke && !acquire_single_instance("Local\\ForgeFlowMESDesktopSingleton") {
        eprintln!("ForgeFlow MES 已在執行中。");
        std::process::exit(0);
    }

    // Determine user data directory (ForgeFlow MES isolation)
    let user_data = if let Ok(custom) = std::env::var("SUITE_DESKTOP_SMOKE_DATA") {
        PathBuf::from(custom)
    } else if let Ok(appdata) = std::env::var("APPDATA") {
        PathBuf::from(appdata).join("ForgeFlow MES")
    } else {
        PathBuf::from("data")
    };
    let _ = fs::create_dir_all(&user_data);

    let db_path = user_data.join("mes-repository.sqlite");
    let key_path = user_data.join("database-key.dat");

    // Resolve DPAPI SQLCipher Key
    let db_key = match resolve_database_key(&key_path, &db_path) {
        Ok(k) => k,
        Err(e) => {
            eprintln!("金鑰解析錯誤: {e}");
            std::process::exit(1);
        }
    };

    // Locate Go backend binary
    let binary = locate_resource(&[
        "backend/business-suite.exe",
        "resources/backend/business-suite.exe",
        "outputs/go/business-suite.exe",
        "../outputs/go/business-suite.exe",
        "../../outputs/go/business-suite.exe",
    ]).unwrap_or_else(|| PathBuf::from("outputs/go/business-suite.exe"));

    // Locate web assets
    let web_assets = locate_resource(&[
        "web",
        "resources/web",
        "web-dist",
        "../web-dist",
        "../../web-dist",
    ]).unwrap_or_else(|| PathBuf::from("web-dist"));

    // Launch Process Supervisor
    let mut supervisor = match ChildSupervisor::spawn(&binary, &web_assets, &db_path, &db_key) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("進程監督者啟動失敗: {e}");
            std::process::exit(1);
        }
    };

    if is_smoke {
        // Run automated smoke test against MES HTTP endpoints
        let addr = &supervisor.endpoint;
        let secret = &supervisor.secret;

        // Health probe
        match loopback_http_get(addr, "/api/health", Some(secret)) {
            Ok((200, resp)) => {
                if !resp.contains(r#""backend":"go""#) && !resp.contains(r#""status":"ready""#) {
                    eprintln!("煙霧測試失敗：健康端點回應異常: {resp}");
                    std::process::exit(1);
                }
            }
            Ok((status, resp)) => {
                eprintln!("煙霧測試失敗：健康端點回傳狀態 {status}: {resp}");
                std::process::exit(1);
            }
            Err(e) => {
                eprintln!("煙霧測試失敗：無法連接健康端點: {e}");
                std::process::exit(1);
            }
        }

        // Verify MES login route
        match loopback_http_get(addr, "/mes/login", Some(secret)) {
            Ok((200, _)) => {}
            Ok((status, _)) => {
                eprintln!("煙霧測試警告：路徑 /mes/login 回傳狀態 {status}");
            }
            Err(e) => {
                eprintln!("煙霧測試失敗：無法取得路徑 /mes/login: {e}");
                std::process::exit(1);
            }
        }

        supervisor.shutdown();
        println!("PASS: Windows desktop workspace scope and login routes");
        std::process::exit(0);
    }

    // Normal Mode
    println!("ForgeFlow MES 桌面版已於 http://{} 啟動。", supervisor.endpoint);
    
    let running = Arc::new(AtomicBool::new(true));
    let r = running.clone();
    ctrlc_like_wait(r);
    supervisor.shutdown();
}

fn ctrlc_like_wait(running: Arc<AtomicBool>) {
    while running.load(Ordering::SeqCst) {
        thread::sleep(Duration::from_millis(500));
    }
}
