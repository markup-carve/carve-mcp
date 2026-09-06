use std::{env, fs, path::Path};

fn main() {
    let manifest = env::var("CARGO_MANIFEST_DIR").expect("Cargo sets CARGO_MANIFEST_DIR");
    let lock_path = Path::new(&manifest).join("Cargo.lock");
    let lock = fs::read_to_string(&lock_path).expect("Cargo.lock must be readable");
    let version = lock
        .split("[[package]]")
        .find(|package| {
            package
                .lines()
                .any(|line| line.trim() == "name = \"carve-lang\"")
        })
        .and_then(|package| {
            package.lines().find_map(|line| {
                line.trim()
                    .strip_prefix("version = \"")
                    .and_then(|value| value.strip_suffix('"'))
            })
        })
        .expect("Cargo.lock must contain carve-lang");
    println!("cargo:rustc-env=CARVE_LANG_VERSION={version}");
    println!("cargo:rerun-if-changed={}", lock_path.display());
}
