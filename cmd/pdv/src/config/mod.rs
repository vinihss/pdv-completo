use std::env;
use std::fs;
use std::path::{Path, PathBuf};

pub fn find_repo_root() -> PathBuf {
    if let Ok(env_root) = env::var("PDV_ROOT") {
        let p = PathBuf::from(&env_root);
        if is_root(&p) {
            return p;
        }
    }

    if let Ok(exe) = env::current_exe() {
        if let Ok(resolved) = fs::canonicalize(&exe) {
            let mut dir = resolved.parent().unwrap_or(&resolved).to_path_buf();
            if is_root(&dir) {
                return dir;
            }
            // exe pode estar em target/release ou cmd/pdv/target/release
            for _ in 0..4 {
                if let Some(parent) = dir.parent().map(|p| p.to_path_buf()) {
                    if parent == dir {
                        break;
                    }
                    dir = parent;
                    if is_root(&dir) {
                        return dir;
                    }
                } else {
                    break;
                }
            }
        }
    }

    if let Ok(cwd) = env::current_dir() {
        let mut curr = cwd;
        loop {
            if is_root(&curr) {
                return curr;
            }
            if let Some(parent) = curr.parent().map(|p| p.to_path_buf()) {
                if parent == curr || parent == Path::new("/") {
                    break;
                }
                curr = parent;
            } else {
                break;
            }
        }
        return curr;
    }

    PathBuf::from(".")
}

pub fn is_root(dir: &Path) -> bool {
    let backend = dir.join("backend");
    let frontend = dir.join("frontend");
    backend.is_dir() && frontend.is_dir()
}

pub fn root_path() -> PathBuf {
    find_repo_root()
}
