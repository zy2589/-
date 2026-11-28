#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD="$ROOT/.build/macos"
WORK="$BUILD/work"
DIST="$BUILD/dist"
OUTPUT="$BUILD/output"
PACKAGE_RESOURCES="$BUILD/package-resources"
ENGINE="$BUILD/剪辑助手内核"
ENGINE_EDITOR="$ENGINE/Modules/剪辑助手/剪辑界面"
ENGINE_MEDIA="$ENGINE/Modules/剪辑助手/media"
TIMESTAMP="${CLIPASSIST_RELEASE_TIMESTAMP:-$(TZ=Pacific/Auckland date +%Y%m%d-%H%M%S)}"
SHOTCUT_VERSION="26.11.15"
SHOTCUT_SHA256="664c6ea4195d58dbf3fd43f3d74ae46d59b6310f9ac628d5e70a8e2786a4f80b"
DEEPFILTERNET_COMMIT="978576aa8400552a4ce9730838c635aa30db5e61"

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "This build must run on an Apple Silicon macOS host." >&2
  exit 2
fi
if [[ ! "$TIMESTAMP" =~ ^[0-9]{8}-[0-9]{6}$ ]]; then
  echo "Invalid release timestamp: $TIMESTAMP" >&2
  exit 2
fi

PYTHON="$(command -v python)"
NODE="$(command -v node)"
if [[ "$("$PYTHON" -c 'import platform; print(platform.python_version())')" != "3.14.10" ]]; then
  echo "The macOS package requires Python 3.14.10." >&2
  exit 2
fi
if [[ "$("$NODE" -p 'process.versions.node')" != "22.23.5" || "$("$NODE" -p 'process.versions.undici')" != "6.29.1" ]]; then
  echo "The macOS package requires Node 22.23.5 / Undici 6.29.1." >&2
  exit 2
fi

mkdir -p "$WORK" "$OUTPUT"
rm -rf "$DIST" "$PACKAGE_RESOURCES" "$ENGINE"
mkdir -p "$DIST" "$PACKAGE_RESOURCES/ffmpeg" "$ENGINE/runtime/node" \
  "$ENGINE/Frameworks" "$ENGINE_MEDIA" "$ENGINE_EDITOR" "$OUTPUT"

"$PYTHON" -m pip install --disable-pip-version-check -r "$ROOT/requirements.txt"

pushd "$ROOT/core/editor_runtime" >/dev/null
npm ci --no-audit --no-fund
node src/ui/build.mjs
popd >/dev/null

# Build the native Apple Silicon denoiser from a pinned upstream source tag and
# its committed Cargo.lock instead of downloading an unverified executable.
DFN_SOURCE="$WORK/DeepFilterNet"
if [[ ! -d "$DFN_SOURCE/.git" ]]; then
  git clone --depth 1 --branch v0.5.6 https://github.com/Rikorose/DeepFilterNet.git "$DFN_SOURCE"
fi
git -C "$DFN_SOURCE" fetch --depth 1 origin "$DEEPFILTERNET_COMMIT"
git -C "$DFN_SOURCE" checkout --detach "$DEEPFILTERNET_COMMIT"
if [[ "$(git -C "$DFN_SOURCE" rev-parse HEAD)" != "$DEEPFILTERNET_COMMIT" ]]; then
  echo "DeepFilterNet source revision does not match the pinned commit." >&2
  exit 1
fi
cargo build --locked --release --manifest-path "$DFN_SOURCE/libDF/Cargo.toml" \
  --bin deep-filter --features bin,tract,wav-utils,transforms
DEEP_FILTER="$DFN_SOURCE/target/release/deep-filter"
"$DEEP_FILTER" --version
cp "$DEEP_FILTER" "$ENGINE_MEDIA/deep-filter"
cp "$DEEP_FILTER" "$PACKAGE_RESOURCES/deep-filter"
chmod 755 "$ENGINE_MEDIA/deep-filter" "$PACKAGE_RESOURCES/deep-filter"

# Obtain FFmpeg and its dynamic libraries from the same checksum-verified
# Shotcut macOS release used by the project's Windows media-runtime staging.
SHOTCUT_DMG="$WORK/shotcut-macos-$SHOTCUT_VERSION.dmg"
SHOTCUT_URL="https://github.com/mltframework/shotcut/releases/download/v$SHOTCUT_VERSION/shotcut-macos-$SHOTCUT_VERSION.dmg"
if [[ ! -f "$SHOTCUT_DMG" ]]; then
  curl --fail --location --retry 3 --output "$SHOTCUT_DMG" "$SHOTCUT_URL"
fi
echo "$SHOTCUT_SHA256  $SHOTCUT_DMG" | shasum -a 256 --check
MOUNT="$WORK/shotcut-mount"
mkdir -p "$MOUNT"
hdiutil attach -quiet -nobrowse -readonly -mountpoint "$MOUNT" "$SHOTCUT_DMG"
cleanup_mount() { hdiutil detach -quiet "$MOUNT" >/dev/null 2>&1 || true; }
trap cleanup_mount EXIT
SHOTCUT_APP="$(find "$MOUNT" -maxdepth 3 -type d -name 'Shotcut.app' -print -quit)"
if [[ -z "$SHOTCUT_APP" ]]; then
  echo "Pinned Shotcut DMG does not contain Shotcut.app." >&2
  exit 1
fi
FFMPEG_SOURCE="$(find -L "$SHOTCUT_APP/Contents" -type f -name ffmpeg -perm -111 -print -quit)"
FFPROBE_SOURCE="$(find -L "$SHOTCUT_APP/Contents" -type f -name ffprobe -perm -111 -print -quit)"
if [[ -z "$FFMPEG_SOURCE" || -z "$FFPROBE_SOURCE" ]]; then
  echo "Pinned Shotcut app is missing FFmpeg or FFprobe." >&2
  exit 1
fi
if [[ ! -d "$SHOTCUT_APP/Contents/Frameworks" ]]; then
  echo "Pinned Shotcut app is missing its Frameworks directory." >&2
  exit 1
fi
cp -R "$SHOTCUT_APP/Contents/Frameworks/." "$ENGINE/Frameworks/"
cp -R "$SHOTCUT_APP/Contents/Frameworks/." "$PACKAGE_RESOURCES/Frameworks/"
cp "$FFMPEG_SOURCE" "$ENGINE_MEDIA/ffmpeg"
cp "$FFPROBE_SOURCE" "$ENGINE_MEDIA/ffprobe"
cp "$FFMPEG_SOURCE" "$PACKAGE_RESOURCES/ffmpeg/ffmpeg"
cp "$FFPROBE_SOURCE" "$PACKAGE_RESOURCES/ffmpeg/ffprobe"
chmod 755 "$ENGINE_MEDIA/ffmpeg" "$ENGINE_MEDIA/ffprobe" \
  "$PACKAGE_RESOURCES/ffmpeg/ffmpeg" "$PACKAGE_RESOURCES/ffmpeg/ffprobe"
for binary in "$ENGINE_MEDIA/ffmpeg" "$ENGINE_MEDIA/ffprobe" \
              "$PACKAGE_RESOURCES/ffmpeg/ffmpeg" "$PACKAGE_RESOURCES/ffmpeg/ffprobe"; do
  if ! otool -l "$binary" | grep -Fq '@executable_path/../../../Frameworks'; then
    install_name_tool -add_rpath '@executable_path/../../../Frameworks' "$binary"
  fi
  if ! otool -l "$binary" | grep -Fq '@executable_path/../../../Resources/剪辑助手内核/Frameworks'; then
    install_name_tool -add_rpath '@executable_path/../../../Resources/剪辑助手内核/Frameworks' "$binary"
  fi
done
"$PACKAGE_RESOURCES/ffmpeg/ffmpeg" -version | head -n 1
"$PACKAGE_RESOURCES/ffmpeg/ffprobe" -version | head -n 1

cp "$NODE" "$ENGINE/runtime/node/node"
chmod 755 "$ENGINE/runtime/node/node"
swiftc -O -framework Security -o "$ENGINE/runtime/keychain-helper" "$ROOT/macos/KeychainHelper.swift"
chmod 755 "$ENGINE/runtime/keychain-helper"

cp -R "$ROOT/core/editor_runtime/src/." "$ENGINE_EDITOR/src/"
mkdir -p "$ENGINE/Modules/剪辑助手/剪辑界面/assets"
cp -R "$ROOT/resources/editor-runtime/assets/." "$ENGINE/Modules/剪辑助手/剪辑界面/assets/"
mkdir -p "$ENGINE_EDITOR/vendor"
cp -R "$ROOT/core/editor_runtime/node_modules/node-pty" "$ENGINE_EDITOR/vendor/node-pty"
cp "$ROOT/README.md" "$ENGINE/README.md"
cp "$ROOT/resources/editor-runtime/LICENSE.txt" "$ENGINE/LICENSE-media-runtime.txt"
cp -R "$ROOT/resources/matting_models" "$PACKAGE_RESOURCES/matting_models"
cp "$ROOT/resources/editor-runtime/assets/models/std.rnnn" "$PACKAGE_RESOURCES/std.rnnn"
cp "$ROOT/resources/editor-runtime/assets/models/face_landmarker.task" "$PACKAGE_RESOURCES/face_landmarker.task"
cp "$ROOT/resources/ffmpeg/LICENSE.txt" "$PACKAGE_RESOURCES/ffmpeg/LICENSE.txt"

export CLIPASSIST_MEDIA_ROOT="$ENGINE_MEDIA"
export PYTHONPATH="$ROOT${PYTHONPATH:+:$PYTHONPATH}"
"$PYTHON" -m unittest discover -s "$ROOT/tests"
node --test "$ROOT/tests"/*.test.mjs
node --check "$ENGINE_EDITOR/src/main.mjs"
"$PYTHON" -m py_compile "$ROOT/core/embedded_editor_macos.py" "$ROOT/core/ui.py" \
  "$ROOT/core/media_runtime.py" "$ROOT/core/denoise.py" \
  "$ROOT/core/downloader_runtime/template_translation.py"
"$PYTHON" "$ROOT/core/preflight_media.py"

# Build an app icon without changing the tracked source assets.
ICONSET="$WORK/ClipAssistant.iconset"
mkdir -p "$ICONSET"
sips -z 16 16 "$ROOT/assets/剪辑助手图标-1024.png" --out "$ICONSET/icon_16x16.png" >/dev/null
sips -z 32 32 "$ROOT/assets/剪辑助手图标-1024.png" --out "$ICONSET/icon_16x16@2x.png" >/dev/null
sips -z 32 32 "$ROOT/assets/剪辑助手图标-1024.png" --out "$ICONSET/icon_32x32.png" >/dev/null
sips -z 64 64 "$ROOT/assets/剪辑助手图标-1024.png" --out "$ICONSET/icon_32x32@2x.png" >/dev/null
sips -z 128 128 "$ROOT/assets/剪辑助手图标-1024.png" --out "$ICONSET/icon_128x128.png" >/dev/null
sips -z 256 256 "$ROOT/assets/剪辑助手图标-1024.png" --out "$ICONSET/icon_128x128@2x.png" >/dev/null
sips -z 256 256 "$ROOT/assets/剪辑助手图标-1024.png" --out "$ICONSET/icon_256x256.png" >/dev/null
sips -z 512 512 "$ROOT/assets/剪辑助手图标-1024.png" --out "$ICONSET/icon_256x256@2x.png" >/dev/null
sips -z 512 512 "$ROOT/assets/剪辑助手图标-1024.png" --out "$ICONSET/icon_512x512.png" >/dev/null
sips -z 1024 1024 "$ROOT/assets/剪辑助手图标-1024.png" --out "$ICONSET/icon_512x512@2x.png" >/dev/null
iconutil -c icns "$ICONSET" -o "$WORK/ClipAssistant.icns"

"$PYTHON" -m PyInstaller --noconfirm --clean --onedir --windowed \
  --name '剪辑助手' --icon "$WORK/ClipAssistant.icns" \
  --osx-bundle-identifier org.clipassistant.desktop \
  --collect-all tkinterdnd2 --collect-all yt_dlp --collect-all gdown \
  --collect-all requests --collect-all urllib3 --collect-all certifi \
  --collect-all phonenumbers --collect-all onnxruntime \
  --hidden-import AppKit --hidden-import Foundation --hidden-import WebKit --hidden-import objc \
  --hidden-import PIL.ImageGrab --hidden-import PIL.ImageTk \
  --hidden-import core.rotoscope \
  --add-data "$PACKAGE_RESOURCES:resources" \
  --add-data "$ROOT/assets:assets" \
  --add-data "$ROOT/core/downloader_runtime:core/downloader_runtime" \
  --distpath "$DIST" --workpath "$WORK/pyinstaller" \
  "$ROOT/剪辑助手.pyw"

APP="$DIST/剪辑助手.app"
if [[ ! -d "$APP" ]]; then
  echo "PyInstaller did not produce the macOS application bundle." >&2
  exit 1
fi
cp -R "$ENGINE" "$APP/Contents/Resources/剪辑助手内核"
cp "$ROOT/README.md" "$APP/Contents/Resources/README.md"
cat > "$APP/Contents/Resources/版本清单.json" <<EOF
{
  "version": "ClipAssistant-macos-$TIMESTAMP",
  "createdAtPacificAuckland": "$(TZ=Pacific/Auckland date '+%Y-%m-%d %H:%M:%S %z')",
  "architecture": "arm64",
  "python": "3.14.10",
  "node": "v22.23.5",
  "undici": "6.29.1",
  "shotcutMediaRuntime": "$SHOTCUT_VERSION",
  "deepFilterNet": "0.5.6",
  "userDataIncluded": false,
  "credentialSeedIncluded": false,
  "signature": "ad-hoc; not notarized"
}
EOF

# Ad-hoc signing protects bundle integrity but is not Developer ID signing or
# notarization. A public release must disclose this until signing credentials
# are configured for the project.
codesign --force --deep --sign - "$APP"
codesign --verify --deep --strict "$APP"

python_version="$($PYTHON --version 2>&1)"
node_version="$("$APP/Contents/Resources/剪辑助手内核/runtime/node/node" --version)"
undici_version="$("$APP/Contents/Resources/剪辑助手内核/runtime/node/node" -p 'process.versions.undici')"
[[ "$python_version" == "Python 3.14.10" ]]
[[ "$node_version" == "v22.23.5" ]]
[[ "$undici_version" == "6.29.1" ]]

ZIP="$OUTPUT/ClipAssistant-macos-$TIMESTAMP.zip"
DMG="$OUTPUT/ClipAssistant-macos-$TIMESTAMP.dmg"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"
hdiutil create -quiet -volname '剪辑助手' -srcfolder "$APP" -ov -format UDZO "$DMG"
shasum -a 256 "$ZIP" | awk '{print $1 "  " $2}' > "$ZIP.sha256"
shasum -a 256 "$DMG" | awk '{print $1 "  " $2}' > "$DMG.sha256"
printf 'App bundle: %s\nZIP: %s\nDMG: %s\n' "$APP" "$ZIP" "$DMG"
shasum -a 256 "$ZIP" "$DMG"
