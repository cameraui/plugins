"""Build self-contained hailort wheels for the plugin requirements.

The frigate-nvr wheels expect libhailort.so installed system-wide (Frigate bakes it into its image),
so this puts the library from the matching runtime tarball next to the extension. It also drops the
netifaces dependency: it has no wheels for current Python, needs a compiler, and HailoRT only uses it
for Ethernet devices.

Usage: uv run --with patchelf python scripts/repack-hailort.py 4.24.0 <out dir>
Upload the wheels to the hailort-v<version> release of cameraui/plugins, requirements.txt points there.
The kernel driver built by cameraui-host.sh must have the same version.
"""

from __future__ import annotations

import base64
import hashlib
import io
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
import zipfile
from pathlib import Path

RELEASES = "https://github.com/frigate-nvr/hailort/releases/download"
TARGETS = {"x86_64": "amd64", "aarch64": "arm64"}
PYTHON_TAG = "cp311"


def download(url: str) -> bytes:
    with urllib.request.urlopen(url, timeout=300) as response:
        data: bytes = response.read()
        return data


def record_line(path: Path, root: Path) -> str:
    data = path.read_bytes()
    digest = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode()
    return f"{path.relative_to(root).as_posix()},sha256={digest},{len(data)}"


def repack(version: str, arch: str, debian_arch: str, out: Path) -> Path:
    name = f"hailort-{version}-{PYTHON_TAG}-{PYTHON_TAG}-linux_{arch}.whl"
    wheel = download(f"{RELEASES}/v{version}/{name}")
    runtime = download(f"{RELEASES}/v{version}/hailort-debian12-{debian_arch}.tar.gz")
    lib_name = f"libhailort.so.{version}"

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        zipfile.ZipFile(io.BytesIO(wheel)).extractall(root)

        package = root / "hailo_platform" / "pyhailort"
        with tarfile.open(fileobj=io.BytesIO(runtime)) as tar:
            member = tar.extractfile(f"rootfs/usr/local/lib/{lib_name}")
            if member is None:
                raise RuntimeError(f"{lib_name} missing in the runtime tarball")
            (package / lib_name).write_bytes(member.read())
        extension = next(package.glob("_pyhailort*.so"))
        subprocess.run(["patchelf", "--set-rpath", "$ORIGIN", str(extension)], check=True)

        info = next(root.glob("*.dist-info"))
        metadata = info / "METADATA"
        lines = metadata.read_text().splitlines(keepends=True)
        metadata.write_text(
            "".join(line for line in lines if not line.startswith("Requires-Dist: netifaces"))
        )

        record = info / "RECORD"
        files = sorted(path for path in root.rglob("*") if path.is_file() and path != record)
        record.write_text(
            "\n".join([*(record_line(path, root) for path in files), f"{info.name}/RECORD,,"]) + "\n"
        )

        target = out / name
        with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as archive:
            for path in sorted(path for path in root.rglob("*") if path.is_file()):
                archive.write(path, path.relative_to(root).as_posix())
    return target


def main() -> None:
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    version, out = sys.argv[1], Path(sys.argv[2])
    out.mkdir(parents=True, exist_ok=True)
    for arch, debian_arch in TARGETS.items():
        print(repack(version, arch, debian_arch, out))


if __name__ == "__main__":
    main()
