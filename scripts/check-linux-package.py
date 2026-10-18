#!/usr/bin/env python3
import argparse
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import subprocess
import sys
import tarfile
import tempfile


RUNTIME_SCRIPTS = (
    "scripts/cargo-sweep-stale-targets.sh",
    "scripts/install-cargo-sweep-schedule.sh",
    "scripts/tmux-control.sh",
    "scripts/tmux-open-hyperlink.sh",
)


def require(condition, cause):
    if not condition:
        raise ValueError(cause)


def verifier():
    sys.dont_write_bytecode = True
    path = Path(__file__).with_name("verify-linux-binary.py")
    spec = importlib.util.spec_from_file_location("verify_linux_binary", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def check_package(archive, arch, run=False):
    binary_name = f"native/linux-{arch}/aimux"
    required = (binary_name, "bin/aimux", "package.json", "BUILD_STAMP", "BUILD_VARIANT", "PACKAGE_PROFILE", *RUNTIME_SCRIPTS)
    executables = {binary_name, "bin/aimux", *RUNTIME_SCRIPTS}
    contents = {}
    modes = {}
    with tarfile.open(archive, "r:gz") as package:
        members = {}
        for member in package:
            path = PurePosixPath(member.name)
            require(not path.is_absolute() and ".." not in path.parts, f"unsafe archive member {member.name!r}")
            require(path.parts and path.parts[0] == "aimux", f"archive member outside aimux root: {member.name!r}")
            name = str(path)
            require(name not in members, f"duplicate archive member {name}")
            members[name] = member
        for name in required:
            member = members.get(f"aimux/{name}")
            require(member is not None and member.isfile(), f"missing regular runtime file aimux/{name}")
            require(name not in executables or member.mode & 0o100, f"runtime file is not executable by its owner: aimux/{name}")
            limit = 512 * 1024 * 1024 if name == binary_name else 8 * 1024 * 1024
            require(0 < member.size <= limit, f"invalid runtime file size: aimux/{name} ({member.size})")
            source = package.extractfile(member)
            require(source is not None, f"could not read aimux/{name}")
            with source:
                contents[name] = source.read()
            require(len(contents[name]) == member.size, f"truncated runtime file aimux/{name}")
            modes[name] = member.mode & 0o777
    metadata = {}
    for name in ("BUILD_STAMP", "BUILD_VARIANT", "PACKAGE_PROFILE"):
        value = contents[name].decode("ascii").strip()
        require(value and re.fullmatch(r"[!-~]+", value), f"invalid {name}: expected one nonempty value")
        metadata[name] = value
    require(metadata["BUILD_VARIANT"] in ("full", "local"), f"invalid BUILD_VARIANT: {metadata['BUILD_VARIANT']}")
    require(metadata["PACKAGE_PROFILE"] in ("full", "minimal"), f"invalid PACKAGE_PROFILE: {metadata['PACKAGE_PROFILE']}")
    manifest = json.loads(contents["package.json"])
    require(isinstance(manifest, dict) and isinstance(manifest.get("name"), str) and manifest["name"], "invalid package.json name")
    require(isinstance(manifest.get("version"), str) and manifest["version"], "invalid package.json version")
    witnesses = set(re.findall(rb"AIMUX_EMBEDDED_BUILD_STAMP=([\x21-\x7e]+)\x00", contents[binary_name]))
    require(witnesses, f"binary missing embedded build stamp witness: {binary_name}")
    expected = metadata["BUILD_STAMP"].encode("ascii")
    require(witnesses == {expected}, f"build stamp mismatch: archive {metadata['BUILD_STAMP']}, binary {sorted(w.decode('ascii') for w in witnesses)}")
    with tempfile.TemporaryDirectory(prefix="aimux-linux-package-") as temporary:
        root = Path(temporary) / "aimux"
        for name, data in contents.items():
            destination = root / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(data)
            destination.chmod(modes[name])
        binary = root / binary_name
        verifier().verify_binary(binary, arch)
        if run:
            host_arch = {"x86_64": "x64", "amd64": "x64", "aarch64": "arm64", "arm64": "arm64"}.get(platform.machine().lower())
            require(platform.system() == "Linux" and host_arch == arch, f"--run requires native Linux {arch}; host is {platform.system()} {platform.machine()}")
            home = Path(temporary) / "home"
            aimux_home = home / ".aimux"
            aimux_home.mkdir(parents=True)
            (aimux_home / "test-isolation.json").write_text(json.dumps({"ownerPid": os.getpid(), "kind": "linux-package-gate"}))
            environment = {key: value for key, value in os.environ.items() if not key.startswith("AIMUX_") and key not in ("TMUX", "TMUX_PANE")}
            environment.update(HOME=str(home), AIMUX_HOME=str(aimux_home), AIMUX_ROOT=str(root))
            child = subprocess.run([str(binary), "--version"], cwd=temporary, env=environment, capture_output=True, text=True, timeout=20)
            require(child.returncode == 0, f"packaged binary --version exited {child.returncode}: stdout={child.stdout.strip()!r}, stderr={child.stderr.strip()!r}")
            require(child.stdout.strip() == manifest["version"], f"packaged binary --version returned unexpected output: expected {manifest['version']!r}, received {child.stdout.strip()!r}")
    return metadata


def main():
    parser = argparse.ArgumentParser(description="Verify a produced Linux Aimux release archive")
    parser.add_argument("archive")
    parser.add_argument("arch", choices=("x64", "arm64"))
    parser.add_argument("--run", action="store_true", help="smoke-test --version on the matching native Linux host")
    args = parser.parse_args()
    try:
        metadata = check_package(args.archive, args.arch, args.run)
    except (OSError, ValueError, tarfile.TarError, subprocess.SubprocessError) as error:
        print(f"Linux package verification failed: {args.archive} ({args.arch}): {error}", file=sys.stderr)
        return 1
    print(f"Verified Linux package: {args.archive} ({args.arch}), variant={metadata['BUILD_VARIANT']}, profile={metadata['PACKAGE_PROFILE']}" + (", --version passed" if args.run else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
