"""Package the extension for Chrome and Firefox.

The two browsers want slightly different manifests: Firefox needs
``browser_specific_settings`` for a stable add-on id, and Chrome warns about
the key. Each zip therefore gets its own generated manifest rather than a
copy of the file on disk.
"""

import json
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parent

MANIFEST = "manifest.json"

# Everything except the manifest, which is generated per browser.
ASSETS = [
    "popup.html",
    "popup.css",
    "popup.js",
    "markdown.js",
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

    # The manifest may only point at files that are actually packaged.
    popup = manifest.get("action", {}).get("default_popup")

    if popup and popup not in ASSETS:
        raise ValueError(f"action.default_popup ({popup}) is not packaged.")

    print(f"✓ {MANIFEST} validated")


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

    chrome = {
        key: value
        for key, value in manifest.items()
        if key != "browser_specific_settings"
    }

    print("Building Chrome package...")
    build_zip("markdown-confluence-chrome.zip", chrome)

    print("Building Firefox package...")
    build_zip("markdown-confluence-firefox.zip", manifest)

    print("Build complete.")


if __name__ == "__main__":
    build_extension()
