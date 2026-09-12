import os
from pathlib import Path
import re
import stat
import time


# Two scopes per runner, four runners: at most 16 GiB of retained task entries
# between jobs. Active builds can temporarily exceed this; this is not a quota.
# Three days keeps recent rebuilds without retaining old branch/toolchain outputs.
MAX_BYTES_PER_SCOPE = 2 * 1024**3
MAX_AGE_SECONDS = 3 * 24 * 60 * 60
ENTRY_NAME = re.compile(r"[0-9a-f]{32}(?:\.failed|-[0-9]+\.part)?")


def trim_cache(root: Path) -> None:
    if root.is_symlink():
        raise ValueError(f"Refusing symlink cache root: {root}")
    cutoff = time.time() - MAX_AGE_SECONDS
    for scope in ("ci", "release"):
        directory = root / scope
        if directory.is_symlink():
            raise ValueError(f"Refusing symlink cache directory: {directory}")
        if not directory.exists():
            continue

        entries = []
        for entry in directory.iterdir():
            info = entry.lstat()
            if ENTRY_NAME.fullmatch(entry.name) and stat.S_ISREG(info.st_mode):
                entries.append((info.st_mtime, entry, info.st_size))

        total = sum(size for _, _, size in entries)
        for modified, entry, size in sorted(entries):
            if modified < cutoff or total > MAX_BYTES_PER_SCOPE:
                entry.unlink()
                total -= size
        print(f"Gradle {scope} task cache retained: {total} bytes")


if __name__ == "__main__":
    trim_cache(Path(os.environ["GRADLE_BUILD_CACHE_ROOT"]))
