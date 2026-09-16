#!/usr/bin/env python3
"""Generate and verify Aimux release SPDX SBOMs from Cargo metadata."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path


PLATFORM_TARGETS = {
    "darwin-arm64": "aarch64-apple-darwin",
    "darwin-x64": "x86_64-apple-darwin",
    "linux-arm64": "aarch64-unknown-linux-gnu",
    "linux-x64": "x86_64-unknown-linux-gnu",
}


def fail(message: str) -> None:
    print(f"aimux SBOM generation failed: {message}", file=sys.stderr)
    raise SystemExit(1)


def run_cargo_metadata(manifest_path: Path, variant: str, platform_arch: str) -> dict:
    target = PLATFORM_TARGETS.get(platform_arch)
    if target is None:
        fail(f"unsupported platform-arch: {platform_arch}")
    command = [
        "cargo",
        "metadata",
        "--format-version",
        "1",
        "--locked",
        "--manifest-path",
        str(manifest_path),
        "--filter-platform",
        target,
    ]
    if variant == "lite":
        command.append("--no-default-features")
    elif variant != "full":
        fail(f"unsupported build variant: {variant}")
    result = subprocess.run(command, check=False, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode != 0:
        fail(
            "cargo metadata failed for "
            f"{variant} {platform_arch} with exit {result.returncode}:\n{result.stderr.rstrip()}"
        )
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as error:
        fail(f"cargo metadata produced invalid JSON: {error}")


def reachable_package_ids(metadata: dict) -> list[str]:
    resolve = metadata.get("resolve") or {}
    root = resolve.get("root")
    nodes = {node.get("id"): node for node in resolve.get("nodes") or [] if node.get("id")}
    if not root:
        workspace_members = metadata.get("workspace_members") or []
        root = workspace_members[0] if workspace_members else None
    if not root or root not in nodes:
        fail("cargo metadata did not include a resolvable root package")
    seen: set[str] = set()
    ordered: list[str] = []

    def visit(package_id: str) -> None:
        if package_id in seen:
            return
        seen.add(package_id)
        ordered.append(package_id)
        for dependency in nodes.get(package_id, {}).get("deps") or []:
            dependency_id = dependency.get("pkg")
            if dependency_id in nodes:
                visit(dependency_id)

    visit(root)
    return ordered


def spdx_id(name: str, version: str, package_id: str) -> str:
    suffix = hashlib.sha256(package_id.encode("utf-8")).hexdigest()[:10]
    raw = f"SPDXRef-Package-{name}-{version}-{suffix}"
    return re.sub(r"[^A-Za-z0-9.-]", "-", raw)


def package_purl(name: str, version: str) -> str:
    return f"pkg:cargo/{name}@{version}"


def license_declared(package: dict) -> str:
    license_value = (package.get("license") or "").strip()
    return license_value or "NOASSERTION"


def package_download_location(package: dict, is_root: bool) -> str:
    if is_root:
        return "NOASSERTION"
    name = package.get("name")
    version = package.get("version")
    if name and version:
        return f"https://crates.io/crates/{name}/{version}"
    return "NOASSERTION"


def build_document(args: argparse.Namespace) -> dict:
    metadata = run_cargo_metadata(args.manifest_path, args.variant, args.platform_arch)
    packages_by_id = {package["id"]: package for package in metadata.get("packages") or []}
    package_ids = reachable_package_ids(metadata)
    root_id = package_ids[0]
    spdx_ids: dict[str, str] = {}
    packages: list[dict] = []
    for package_id in package_ids:
        package = packages_by_id.get(package_id)
        if not package:
            fail(f"cargo metadata referenced missing package: {package_id}")
        is_root = package_id == root_id
        name = package["name"]
        version = args.version if is_root else package["version"]
        package_spdx_id = spdx_id(name, version, package_id)
        spdx_ids[package_id] = package_spdx_id
        packages.append(
            {
                "name": name,
                "SPDXID": package_spdx_id,
                "versionInfo": version,
                "downloadLocation": package_download_location(package, is_root),
                "filesAnalyzed": False,
                "supplier": "NOASSERTION",
                "licenseConcluded": "NOASSERTION",
                "licenseDeclared": license_declared(package),
                "copyrightText": "NOASSERTION",
                "externalRefs": [
                    {
                        "referenceCategory": "PACKAGE-MANAGER",
                        "referenceType": "purl",
                        "referenceLocator": package_purl(name, version),
                    }
                ],
            }
        )
    packages.sort(key=lambda package: (package["name"], package["versionInfo"], package["SPDXID"]))

    node_by_id = {
        node.get("id"): node for node in (metadata.get("resolve") or {}).get("nodes") or [] if node.get("id")
    }
    relationships = [
        {
            "spdxElementId": "SPDXRef-DOCUMENT",
            "relationshipType": "DESCRIBES",
            "relatedSpdxElement": spdx_ids[root_id],
        }
    ]
    for package_id in package_ids:
        for dependency in node_by_id.get(package_id, {}).get("deps") or []:
            dependency_id = dependency.get("pkg")
            if dependency_id in spdx_ids:
                relationships.append(
                    {
                        "spdxElementId": spdx_ids[package_id],
                        "relationshipType": "DEPENDS_ON",
                        "relatedSpdxElement": spdx_ids[dependency_id],
                    }
                )
    relationships.sort(
        key=lambda relationship: (
            relationship["spdxElementId"],
            relationship["relationshipType"],
            relationship["relatedSpdxElement"],
        )
    )

    root_spdx_id = spdx_ids[root_id]
    return {
        "spdxVersion": "SPDX-2.3",
        "dataLicense": "CC0-1.0",
        "SPDXID": "SPDXRef-DOCUMENT",
        "name": f"{args.asset}.sbom",
        "documentNamespace": (
            "https://aimux.app/sbom/"
            f"{args.source_revision}/{args.asset}/{args.asset_sha256}/"
            f"{args.variant}/{args.platform_arch}"
        ),
        "creationInfo": {
            "created": "1970-01-01T00:00:00Z",
            "creators": ["Tool: scripts/generate-cargo-sbom.py", "Tool: cargo metadata"],
        },
        "documentDescribes": [root_spdx_id],
        "packages": packages,
        "relationships": relationships,
        "annotations": [
            {
                "annotationDate": "1970-01-01T00:00:00Z",
                "annotationType": "OTHER",
                "annotator": "Tool: scripts/generate-cargo-sbom.py",
                "SPDXREF": root_spdx_id,
                "comment": (
                    f"buildVariant={args.variant}; "
                    f"platformArch={args.platform_arch}; "
                    f"assetSha256={args.asset_sha256}"
                ),
            }
        ],
    }


def package_identity_set(document: dict) -> set[tuple[str, str, str]]:
    identities: set[tuple[str, str, str]] = set()
    for package in document.get("packages") or []:
        name = package.get("name")
        version = package.get("versionInfo")
        purls = [
            ref.get("referenceLocator")
            for ref in package.get("externalRefs") or []
            if ref.get("referenceCategory") == "PACKAGE-MANAGER" and ref.get("referenceType") == "purl"
        ]
        purl = purls[0] if purls else ""
        if not isinstance(name, str) or not isinstance(version, str) or not isinstance(purl, str):
            continue
        identities.add((name, version, purl))
    return identities


def verify_document(expected: dict, actual_path: Path, asset: str) -> None:
    try:
        actual = json.loads(actual_path.read_text())
    except FileNotFoundError:
        fail(f"SBOM file is missing for {asset}: {actual_path}")
    except json.JSONDecodeError as error:
        fail(f"SBOM is not valid JSON for {asset}: {error}")
    if actual.get("spdxVersion") != "SPDX-2.3":
        fail(f"SBOM spdxVersion mismatch for {asset}: expected SPDX-2.3")
    if actual.get("name") != expected.get("name"):
        fail(f"SBOM name mismatch for {asset}: expected {expected.get('name')}")
    if actual.get("documentNamespace") != expected.get("documentNamespace"):
        fail(f"SBOM documentNamespace mismatch for {asset}")
    expected_packages = package_identity_set(expected)
    actual_packages = package_identity_set(actual)
    if expected_packages != actual_packages:
        missing = sorted(expected_packages - actual_packages)
        unexpected = sorted(actual_packages - expected_packages)
        details: list[str] = []
        if missing:
            details.append("missing " + ", ".join(f"{name}@{version}" for name, version, _ in missing[:5]))
        if unexpected:
            details.append(
                "unexpected " + ", ".join(f"{name}@{version}" for name, version, _ in unexpected[:5])
            )
        fail(f"SBOM dependency set mismatch for {asset}: {'; '.join(details)}")
    expected_relationships = {
        (
            relationship.get("spdxElementId"),
            relationship.get("relationshipType"),
            relationship.get("relatedSpdxElement"),
        )
        for relationship in expected.get("relationships") or []
    }
    actual_relationships = {
        (
            relationship.get("spdxElementId"),
            relationship.get("relationshipType"),
            relationship.get("relatedSpdxElement"),
        )
        for relationship in actual.get("relationships") or []
    }
    if expected_relationships != actual_relationships:
        fail(f"SBOM dependency relationship mismatch for {asset}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest-path", type=Path, default=Path("native/Cargo.toml"))
    parser.add_argument("--asset", required=True)
    parser.add_argument("--asset-sha256", required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--source-revision", required=True)
    parser.add_argument("--variant", choices=["full", "lite"], required=True)
    parser.add_argument("--platform-arch", choices=sorted(PLATFORM_TARGETS), required=True)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--verify", type=Path)
    args = parser.parse_args()
    if bool(args.output) == bool(args.verify):
        fail("provide exactly one of --output or --verify")
    if not re.fullmatch(r"[0-9a-fA-F]{40}", args.source_revision):
        fail(f"source revision must be a 40-character git sha: {args.source_revision}")
    if not re.fullmatch(r"[0-9a-fA-F]{64}", args.asset_sha256):
        fail(f"asset sha256 must be a 64-character digest: {args.asset_sha256}")
    return args


def main() -> None:
    args = parse_args()
    document = build_document(args)
    if args.output:
        args.output.write_text(json.dumps(document, indent=2, sort_keys=True) + "\n")
        print(f"Wrote {args.output}")
    else:
        verify_document(document, args.verify, args.asset)
        print(f"SBOM dependency set verified for {args.asset}")


if __name__ == "__main__":
    main()
