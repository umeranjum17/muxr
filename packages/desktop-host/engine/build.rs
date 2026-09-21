//! Native dependencies of the engine.
//!
//! Two permissive C libraries, both built or linked from this machine's own
//! sources — no prebuilt binary is fetched, and nothing is installed:
//!
//! * libvpx (BSD-3-Clause) — VP9 encode, through `native/vpx_shim.c` so the
//!   versioned encoder config struct is laid out by a C compiler.
//! * inputtino (MIT, vendored under `vendor/`) — virtual mouse and keyboard
//!   over `uinput`/`libevdev`, built by its own CMake project into a static
//!   library and called through its documented C API.
//!
//! inputtino is optional: when it cannot be built the engine still captures and
//! reports its input backend as unavailable rather than failing to start.

use std::path::{Path, PathBuf};

fn main() {
    println!("cargo:rerun-if-changed=native/vpx_shim.c");
    println!("cargo:rerun-if-changed=vendor/inputtino/include/inputtino/input.h");
    println!("cargo:rerun-if-changed=vendor/inputtino/CMakeLists.txt");

    cc::Build::new()
        .file("native/vpx_shim.c")
        .flag_if_supported("-Wno-unused-parameter")
        .compile("dlvpx");
    println!("cargo:rustc-link-lib=vpx");

    if build_inputtino(&PathBuf::from(std::env::var("OUT_DIR").unwrap())) {
        println!("cargo:rustc-cfg=inputtino");
    }
}

fn build_inputtino(out: &Path) -> bool {
    let source = Path::new("vendor/inputtino");
    if !source.join("CMakeLists.txt").exists() {
        println!("cargo:warning=inputtino source is not vendored; the engine will report no input backend");
        return false;
    }
    let destination = out.join("inputtino-build");
    let configured = std::process::Command::new("cmake")
        .args([
            "-S",
            &source.display().to_string(),
            "-B",
            &destination.display().to_string(),
            "-DCMAKE_BUILD_TYPE=Release",
            "-DBUILD_SHARED_LIBS=OFF",
            "-DBUILD_C_BINDINGS=ON",
            "-DBUILD_TESTING=OFF",
            "-DUSE_UHID=OFF",
            "-DCMAKE_POSITION_INDEPENDENT_CODE=ON",
        ])
        .status()
        .is_ok_and(|s| s.success());
    let compiled = configured
        && std::process::Command::new("cmake")
            .args([
                "--build",
                &destination.display().to_string(),
                "--target",
                "libinputtino",
            ])
            .status()
            .is_ok_and(|s| s.success());
    if !compiled {
        println!("cargo:warning=inputtino failed to build; the engine will report no input backend");
        return false;
    }
    println!("cargo:rustc-link-search=native={}", destination.display());
    println!("cargo:rustc-link-lib=static=libinputtino");
    println!("cargo:rustc-link-lib=dylib=stdc++");
    // inputtino statically embeds its own code but not libevdev, which it calls
    // into for uinput device management.
    println!("cargo:rustc-link-lib=dylib=evdev");
    true
}
