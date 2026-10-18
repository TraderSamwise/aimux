#!/usr/bin/env python3
"""Validate the canonical full release set, then stage its npm native files."""

import argparse
import gzip
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import sys
import tarfile
import tempfile

SCRIPT_DIR = Path(__file__).resolve().parent


class InvalidAsset(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise InvalidAsset(message)


def release_entries():
    result = subprocess.run(
        [sys.executable, str(SCRIPT_DIR / "release-asset-matrix.py")],
        capture_output=True, text=True,
    )
    require(result.returncode == 0, f"could not read canonical release matrix: {result.stderr.strip() or result.stdout.strip()}")
    entries = []
    identities = set()
    for line in result.stdout.splitlines():
        fields = line.split("\t")
        require(len(fields) == 4, f"invalid release matrix output: {line!r}")
        platform, arch, variant, asset = fields
        if variant != "full":
            continue
        require(platform in ("linux", "darwin"), f"unsupported npm platform: {platform}")
        require(arch in ("x64", "arm64"), f"unsupported npm architecture: {arch}")
        require(asset == Path(asset).name and asset not in ("", ".", ".."), f"unsafe matrix asset: {asset!r}")
        identity = f"{platform}-{arch}"
        require(identity not in identities, f"duplicate full matrix platform: {identity}")
        identities.add(identity)
        entries.append((platform, arch, asset))
    require(entries, "release matrix contains no full assets")
    return entries


def member_path(name, label):
    require(name and not name.startswith("/") and "\\" not in name, f"unsafe archive path in {label}: {name!r}")
    parts = name.rstrip("/").split("/")
    require(all(part not in ("", ".", "..") for part in parts), f"unsafe archive path in {label}: {name!r}")
    require(parts[0] == "aimux", f"archive path outside aimux in {label}: {name!r}")
    return "/".join(parts)


def within(path, root):
    return path == root or path.startswith(root + "/")


def resolved_link(path, members, label):
    pending = path.split("/")
    result = []
    followed = 0
    while pending:
        component = pending.pop(0)
        if component in ("", "."):
            continue
        if component == "..":
            require(len(result) > 1, f"escaping symlink in {label}: {path}")
            result.pop()
            continue
        result.append(component)
        current = "/".join(result)
        member = members.get(current)
        if member is not None and member.issym():
            followed += 1
            require(followed <= 40, f"cyclic or excessive archive symlink chain in {label}: {path}")
            target = member.linkname
            require(target and not target.startswith("/") and "\\" not in target, f"unsafe symlink in {label}: {current} -> {target}")
            pending = result[:-1] + target.split("/") + pending
            result = []
    resolved = "/".join(result)
    require(resolved in members or any(name.startswith(resolved + "/") for name in members), f"dangling archive symlink in {label}: {path} -> {resolved}")
    return resolved


def remove_path(path):
    if path.is_symlink() or path.is_file():
        path.unlink()
    elif path.exists():
        shutil.rmtree(path)


def validate_archive(archive, platform, arch, destination):
    label = str(archive)
    binary = f"aimux/native/{platform}-{arch}/aimux"
    bundle = "aimux/native/darwin/aimux-notifier.app"
    selected = lambda name: name == binary or (platform == "darwin" and within(name, bundle))
    metadata = {"aimux/BUILD_VARIANT": "full", "aimux/PACKAGE_PROFILE": "full", "aimux/BUILD_PROFILE": "full"}
    with gzip.open(archive, "rb") as compressed:
        while compressed.read(1024 * 1024):
            pass
    with tarfile.open(archive, "r:gz") as source:
        members = {}
        for member in source.getmembers():
            name = member_path(member.name, label)
            require(name not in members, f"duplicate archive path in {label}: {name}")
            require(0 <= member.mode <= 0o7777 and member.size >= 0, f"invalid archive mode or size in {label}: {name}")
            require(member.isdir() or member.isfile() or member.issym(), f"unsupported archive entry in {label}: {name} (hardlinks and special files are refused)")
            members[name] = member
        for name in metadata:
            require(name in members, f"missing required metadata {name} in {label}")
            require(members[name].isfile(), f"metadata must be a regular file in {label}: {name}")
        for name, member in members.items():
            parent = PurePosixPath(name).parent
            while str(parent) != ".":
                ancestor = members.get(str(parent))
                require(ancestor is None or ancestor.isdir(), f"archive path has non-directory ancestor in {label}: {name} through {parent}")
                parent = parent.parent
            if member.issym():
                resolved = resolved_link(name, members, label)
                if selected(name):
                    require(within(resolved, bundle), f"notifier symlink leaves bundle in {label}: {name} -> {resolved}")
        required = [binary]
        if platform == "darwin":
            required += [f"{bundle}/Contents/MacOS/aimux-notifier", f"{bundle}/Contents/Info.plist"]
        for name in required:
            require(name in members, f"missing required file in {label}: {name}")
            member = members[name]
            resolved = members.get(resolved_link(name, members, label)) if member.issym() else member
            require(resolved is not None and resolved.isfile() and resolved.size > 0, f"required file is not a nonempty regular file in {label}: {name}")
            if not name.endswith("Info.plist"):
                require(resolved.mode & 0o111, f"required executable lacks execute permission in {label}: {name}")
            if name == binary:
                require(member.isfile(), f"native binary must be a regular file in {label}: {name}")
        for name, member in members.items():
            if member.isdir() and selected(name):
                relative = "aimux-notifier.app" + name[len(bundle):]
                (destination / relative).mkdir(parents=True, exist_ok=True)
            if not member.isfile():
                continue
            output = None
            if selected(name):
                relative = "aimux" if name == binary else "aimux-notifier.app" + name[len(bundle):]
                output = destination / relative
                output.parent.mkdir(parents=True, exist_ok=True)
            with source.extractfile(member) as contents:
                if name in metadata:
                    value = contents.read().decode("utf-8").strip()
                    require(value == metadata[name], f"wrong {name.rsplit('/', 1)[-1]} in {label}: expected full, got {value!r}")
                elif output is not None:
                    with output.open("xb") as target:
                        shutil.copyfileobj(contents, target)
                    output.chmod(member.mode & 0o777)
                else:
                    while contents.read(1024 * 1024):
                        pass
        for name, member in members.items():
            if member.issym() and selected(name):
                target = destination / ("aimux-notifier.app" + name[len(bundle):])
                target.parent.mkdir(parents=True, exist_ok=True)
                target.symlink_to(member.linkname)
        for name, member in reversed(list(members.items())):
            if member.isdir() and selected(name):
                directory = destination / ("aimux-notifier.app" + name[len(bundle):])
                directory.chmod(member.mode & 0o777)
        if platform == "linux":
            result = subprocess.run(
                [sys.executable, str(SCRIPT_DIR / "verify-linux-binary.py"), str(destination / "aimux"), arch],
                capture_output=True, text=True,
            )
            require(result.returncode == 0, f"invalid Linux binary in {label}: {result.stderr.strip() or result.stdout.strip()}")


def stage(release_dir, root):
    entries = release_entries()
    with tempfile.TemporaryDirectory(prefix="aimux-npm-assets-") as temporary:
        prepared = Path(temporary)
        for platform, arch, asset in entries:
            archive = release_dir / f"{asset}.tar.gz"
            require(archive.is_file() and not archive.is_symlink(), f"missing regular release asset: {archive}")
            destination = prepared / f"{platform}-{arch}"
            destination.mkdir()
            try:
                validate_archive(archive, platform, arch, destination)
            except (OSError, tarfile.TarError, UnicodeError, EOFError) as error:
                raise InvalidAsset(f"invalid release archive {archive}: {error}") from error
        native = root / "native"
        require(not native.is_symlink(), f"refusing symlink staging directory: {native}")
        require(not native.exists() or native.is_dir(), f"native staging path is not a directory: {native}")
        for platform, arch, _ in entries:
            destination = native / f"{platform}-{arch}"
            require(not destination.is_symlink(), f"refusing symlink staging target: {destination}")
            require(not destination.exists() or destination.is_dir(), f"native staging target is not a directory: {destination}")
        native.mkdir(parents=True, exist_ok=True)
        commit_root = Path(tempfile.mkdtemp(prefix=".npm-assets-", dir=native))
        keep_recovery = False
        try:
            replacements = []
            for platform, arch, _ in entries:
                identity = f"{platform}-{arch}"
                replacement = commit_root / identity
                shutil.copytree(prepared / identity, replacement, symlinks=True)
                replacements.append((native / identity, replacement, commit_root / f"backup-{identity}"))
            changed = []
            try:
                for destination, replacement, backup in replacements:
                    if destination.exists():
                        destination.rename(backup)
                    changed.append((destination, backup))
                    replacement.rename(destination)
            except OSError as error:
                failures = []
                for destination, backup in reversed(changed):
                    try:
                        remove_path(destination)
                        if backup.exists():
                            backup.rename(destination)
                    except OSError as cleanup_error:
                        failures.append(f"restore {destination}: {cleanup_error}")
                keep_recovery = bool(failures)
                detail = f"; rollback failed: {'; '.join(failures)}; recovery files retained at {commit_root}" if failures else ""
                raise InvalidAsset(f"native staging commit failed: {error}{detail}") from error
        finally:
            if not keep_recovery:
                shutil.rmtree(commit_root)
        print("Staged npm native assets: " + ", ".join(f"{platform}-{arch}" for platform, arch, _ in entries))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("release_dir", type=Path)
    parser.add_argument("--root", type=Path, default=SCRIPT_DIR.parent)
    args = parser.parse_args()
    try:
        stage(args.release_dir.resolve(), args.root.resolve())
    except (InvalidAsset, OSError, tarfile.TarError, UnicodeError, EOFError, subprocess.SubprocessError) as error:
        print(f"npm native asset staging failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
