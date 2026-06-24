import os
import shutil
import subprocess
from configparser import ConfigParser
from pathlib import Path
from typing import Literal

import requests

package_name = "camera-ui-ml"
package_dir_name = "camera_ui_ml"


class Colors:
    HEADER = "\033[95m"
    BLUE = "\033[94m"
    CYAN = "\033[96m"
    GREEN = "\033[92m"
    YELLOW = "\033[93m"
    RED = "\033[91m"
    BOLD = "\033[1m"
    UNDERLINE = "\033[4m"
    END = "\033[0m"


def log(message: str, type: Literal["info", "success", "warning", "error", "cmd"] = "info") -> None:
    prefix = "→"
    if type == "info":
        print(f"{Colors.BLUE}{prefix} {message}{Colors.END}")
    elif type == "success":
        print(f"{Colors.GREEN}{prefix} {message}{Colors.END}")
    elif type == "warning":
        print(f"{Colors.YELLOW}{prefix} {message}{Colors.END}")
    elif type == "error":
        print(f"{Colors.RED}{prefix} {message}{Colors.END}")
    elif type == "cmd":
        print(f"{Colors.CYAN}{prefix} Executing: {message}{Colors.END}")


def run_command(command: str, check: bool = True) -> subprocess.CompletedProcess[bytes]:
    log(command, "cmd")
    result = subprocess.run(command, shell=True, check=check)
    if check and result.returncode != 0:
        raise Exception(f"Command failed with exit code {result.returncode}")
    return result


def get_package_version() -> str:
    with open("pyproject.toml") as f:
        content = f.read()
        for line in content.split("\n"):
            if line.startswith("version"):
                return line.split("=")[1].strip().strip('"').strip("'")
    raise Exception("Version not found in pyproject.toml")


def version_exists_on_pypi(package_name: str, version: str) -> bool:
    url = f"https://pypi.org/pypi/{package_name}/json"
    try:
        response = requests.get(url)
        if response.status_code == 404:
            return False
        data = response.json()
        return version in data["releases"]
    except Exception as e:
        log(f"Error checking PyPI version: {e}", "error")
        return False


def ensure_py_typed() -> None:
    """Ensure py.typed marker file exists."""
    package_dir = Path(package_dir_name)
    typed_file = package_dir / "py.typed"
    if not typed_file.exists():
        typed_file.touch()
        log("Created py.typed file", "success")
    else:
        log("py.typed file exists", "success")


def cleanup_old_pyi_files() -> None:
    """Remove any old .pyi stub files (no longer needed)."""
    package_dir = Path(package_dir_name)
    removed_count = 0
    for pyi_file in package_dir.rglob("*.pyi"):
        try:
            pyi_file.unlink()
            log(f"Removed old stub: {pyi_file.relative_to(package_dir)}", "info")
            removed_count += 1
        except Exception as e:
            log(f"Failed to remove {pyi_file}: {e}", "error")
    if removed_count > 0:
        log(f"Removed {removed_count} old .pyi files", "success")


def main() -> None:
    version = get_package_version()

    print(f"\n{Colors.HEADER}{Colors.BOLD}Building {package_name} v{version}{Colors.END}\n")

    # Cleanup previous builds
    log("Cleaning up previous builds...")
    for dir_name in ["dist", "build", f"{package_dir_name}.egg-info", "stubs", "out"]:
        if os.path.exists(dir_name):
            shutil.rmtree(dir_name)
            log(f"Removed {dir_name}/", "info")

    # Remove old .pyi files (no longer needed with inline types)
    cleanup_old_pyi_files()

    # Ensure py.typed marker exists
    ensure_py_typed()

    # Run mypy type check
    log("Running mypy type check...")
    run_command(f"mypy -p {package_dir_name} --ignore-missing-imports")
    log("Type check passed", "success")

    # Build package
    log("Building package...")
    run_command("python -m build --sdist")
    log("Package built successfully", "success")

    # Check if package is valid
    log("Validating package with twine...")
    run_command("twine check dist/*")
    log("Package is valid", "success")

    # Check if package version already exists
    log("Checking PyPI for existing version...")
    if version_exists_on_pypi(package_name, version):
        log(f"Version {version} already exists on PyPI. Please update the version number.", "error")
        raise Exception("Version already exists")
    log("Version check passed", "success")

    # Setup twine credentials if not exists
    home = Path.home()
    pypirc = home / ".pypirc"

    if not pypirc.exists():
        log("Creating .pypirc file...")
        config = ConfigParser()
        config["pypi"] = {
            "username": "__token__",
            "password": input(f"{Colors.YELLOW}Enter your PyPI token: {Colors.END}"),
        }

        with open(pypirc, "w") as f:
            config.write(f)
        # Secure the file
        os.chmod(pypirc, 0o600)
        log(".pypirc file created", "success")

    # Publish package
    try:
        log("Publishing package to PyPI...")
        run_command("twine upload dist/*")
        log(f"Successfully published version {version} to PyPI!", "success")
    except Exception as e:
        log(f"Failed to upload to PyPI: {e}", "error")
        log("Please check your credentials in ~/.pypirc", "warning")
        return

    print(f"\n{Colors.GREEN}{Colors.BOLD}Build completed successfully!{Colors.END}\n")


def build_local() -> None:
    """Build package locally without publishing to PyPI."""
    version = get_package_version()

    print(f"\n{Colors.HEADER}{Colors.BOLD}Building {package_name} v{version} (local){Colors.END}\n")

    # Cleanup previous builds
    log("Cleaning up previous builds...")
    for dir_name in ["dist", "build", f"{package_dir_name}.egg-info", "stubs", "out"]:
        if os.path.exists(dir_name):
            shutil.rmtree(dir_name)
            log(f"Removed {dir_name}/", "info")

    # Remove old .pyi files
    cleanup_old_pyi_files()

    # Ensure py.typed marker exists
    ensure_py_typed()

    # Run mypy type check
    log("Running mypy type check...")
    run_command(f"mypy -p {package_dir_name} --ignore-missing-imports")
    log("Type check passed", "success")

    # Build package
    log("Building package...")
    run_command("python -m build --sdist")
    log("Package built successfully", "success")

    # Check if package is valid
    log("Validating package with twine...")
    run_command("twine check dist/*")
    log("Package is valid", "success")

    print(f"\n{Colors.GREEN}{Colors.BOLD}Local build completed successfully!{Colors.END}")
    print(f"{Colors.CYAN}Package available at: dist/{Colors.END}\n")


if __name__ == "__main__":
    import sys

    if len(sys.argv) > 1 and sys.argv[1] == "--local":
        build_local()
    else:
        main()
