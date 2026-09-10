"""Package the extension for Chrome and Firefox.

The two browsers want different manifests in two places: Firefox needs
``browser_specific_settings`` for a stable add-on id and rejects
``background.service_worker`` in favour of an event page, while Chrome wants
the opposite. Each zip therefore gets its own generated manifest rather than a
copy of the file on disk.
"""

import json
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parent

MANIFEST = "manifest.json"

# Everything except the manifest, which is generated per browser. Only the
# generated icons ship; the source artwork in static/ stays in the repo.
ASSETS = [
    "background.js",
    "content.js",
    "bridge.js",
    "markdown.js",
    "static/icon-16.png",
    "static/icon-32.png",
    "static/icon-48.png",
    "static/icon-128.png",
]

REQUIRED_KEYS = ("manifest_version", "name", "version", "description")


def load_manifest() -> dict:
    with (ROOT / MANIFEST).open("r", encoding="utf-8") as file:
        return json.load(file)


def validate(manifest: dict) -> None:
    for key in REQUIRED_KEYS:
        if key not in manifest:
            raise ValueError(f"{MANIFEST} is missing required key: {key}")

    if manifest["manifest_version"] != 3:
        raise ValueError("This build script expects Manifest V3.")

    missing = [name for name in ASSETS if not (ROOT / name).exists()]

    if missing:
        raise FileNotFoundError("Missing files: " + ", ".join(missing))

    # Every file the manifest points at must actually be packaged. Content
    # scripts are registered at runtime, so they are not listed here.
    referenced = [manifest.get("background", {}).get("service_worker")]

    referenced.extend(manifest.get("icons", {}).values())
    referenced.extend(manifest.get("action", {}).get("default_icon", {}).values())

    for entry in manifest.get("web_accessible_resources", []):
        referenced.extend(entry.get("resources", []))

    for name in filter(None, referenced):
        if name not in ASSETS:
            raise ValueError(f"{MANIFEST} references {name}, which is not packaged.")

    print(f"✓ {MANIFEST} validated")


def for_chrome(manifest: dict) -> dict:
    return {
        key: value
        for key, value in manifest.items()
        if key != "browser_specific_settings"
    }


def for_firefox(manifest: dict) -> dict:
    firefox = dict(manifest)
    worker = manifest.get("background", {}).get("service_worker")

    # Firefox implements MV3 background as an event page, not a worker.
    if worker:
        firefox["background"] = {"scripts": [worker]}

    return firefox


def build_zip(output_name: str, manifest: dict) -> None:
    output_path = ROOT / output_name

    with zipfile.ZipFile(output_path, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(
            MANIFEST,
            json.dumps(manifest, indent=2, ensure_ascii=False) + "\n",
        )

        for name in ASSETS:
            archive.write(ROOT / name, name)

    size = output_path.stat().st_size / 1024
    print(f"✓ Created {output_path.name} ({size:.1f} KiB)")


def build_extension() -> None:
    manifest = load_manifest()
    validate(manifest)

    print("Building Chrome package...")
    build_zip("markdown-confluence-chrome.zip", for_chrome(manifest))

    print("Building Firefox package...")
    build_zip("markdown-confluence-firefox.zip", for_firefox(manifest))

    print("Build complete.")


if __name__ == "__main__":
    build_extension()
