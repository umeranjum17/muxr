#!/usr/bin/env bash
# Generate muxr brand assets. Regenerate with: bash scripts/genBrand.sh
# OUT overrides only the source-image destination; regeneration also updates
# the checked-in native, public web and Play Store icons at their fixed paths.
#
# Wordmark and glyph are rasterised small from a pixel font, upscaled with
# point sampling, then a gap is knocked out of each cell so the pixels read as
# discrete blocks. Cells are wider than tall, which is what makes it read as a
# display matrix rather than a checkerboard.
set -euo pipefail

# Departure Mono is SIL OFL-1.1. Not vendored: it is only used here to
# rasterise the assets, never bundled into the app.
FONT_URL='https://github.com/rektdeckard/departure-mono/releases/download/v1.500/DepartureMono-1.500.zip'
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
OUT=${OUT:-apps/mobile/sources/assets/images}
PUBLIC=apps/mobile/public
RES=apps/mobile/android/app/src/main/res
IOS=apps/mobile/ios/muxr/Images.xcassets/AppIcon.appiconset
DARK='#111111'
CREAM='#f0efe7'

mkdir -p "$OUT"
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [ -z "${FONT:-}" ]; then
    echo "fetching Departure Mono (OFL-1.1)..."
    curl -sL -o "$T/f.zip" "$FONT_URL"
    unzip -q -o "$T/f.zip" -d "$T/font"
    FONT=$(find "$T/font" -name 'DepartureMono-Regular.otf' | head -1)
fi
[ -f "$FONT" ] || { echo "font not found: $FONT" >&2; exit 1; }

# $1=out $2=text $3=pointsize $4=cellW $5=cellH $6=gap
blocks() {
    local out=$1 text=$2 pt=$3 cw=$4 ch=$5 gap=$6
    magick -background black -fill white -font "$FONT" -pointsize "$pt" \
           label:"$text" -alpha off -colorspace gray -threshold 50% \
           -trim +repage "$T/t.png"
    magick "$T/t.png" -filter point -resize "$((cw * 100))%x$((ch * 100))%" "$T/b.png"
    magick -size "${cw}x${ch}" xc:black -fill white \
           -draw "rectangle 0,0 $((cw - gap - 1)),$((ch - gap - 1))" "$T/cell.png"
    read -r bw bh < <(identify -format "%w %h\n" "$T/b.png")
    magick -size "${bw}x${bh}" "tile:$T/cell.png" "$T/grid.png"
    # White blocks on transparency: caller tints or flattens as needed.
    magick "$T/b.png" "$T/grid.png" -compose multiply -composite \
           -alpha copy -fill white -colorize 100 "$out"
}

# Wordmark: white on transparent so the app tints it per theme (one asset, not two).
blocks "$T/wm.png" "muxr" 16 36 18 4
magick "$T/wm.png" -resize 900x   "$OUT/wordmark@3x.png"
magick "$T/wm.png" -resize 600x   "$OUT/wordmark@2x.png"
magick "$T/wm.png" -resize 300x   "$OUT/wordmark.png"

# Glyph: "mx" -- two lowercase cells read cleanly at app-icon sizes, where a
# single-character glyph in this font turns to mush below ~48px.
blocks "$T/pi.png" "mx" 16 26 26 4

# Preserve the same block geometry as a vector for browsers at arbitrary DPI.
read -r gw gh < <(identify -format "%w %h\n" "$T/pi.png")
{
    echo '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">'
    echo '<path fill="#111111" d="M0 0h1024v1024H0z"/>'
    awk -v w="$gw" -v h="$gh" 'BEGIN {
        scale = 563 / w;
        printf "<g fill=\"white\" transform=\"translate(%g %g) scale(%g)\">\n", (1024-w*scale)/2, (1024-h*scale)/2, scale;
    }'
    magick "$T/t.png" txt:- | awk -F '[:, ]+' '
        /gray\(255\)|#FFFFFF/ {
            printf "<path d=\"M%d %dh22v22h-22z\"/>\n", $1*26, $2*26;
        }'
    echo '</g></svg>'
} > "$T/favicon.svg"

# Agent mark: a real pi, drawn as an explicit pixel matrix rather than set from
# the font. At the 14-15px an agent icon is drawn at, the font's pi collapses
# and block gaps fall below a pixel, so this is solid-stroke on a coarse grid.
# 1 = ink. Bar overhangs the legs, which is what separates pi from a capital.
cat > "$T/pi-mark.pbm" <<'PBM'
P1
7 6
1111111
0100010
0100010
0100010
0100010
0100010
PBM
magick "$T/pi-mark.pbm" -negate -filter point -resize 1400% \
       -alpha copy -fill white -colorize 100 \
       -background none -gravity center -extent 126x126 "$OUT/icon-pi.png"

# Square glyph on a background, padded to a given canvas.
# $1=out $2=size $3=bg $4=glyph-fraction
plate() {
    local out=$1 size=$2 bg=$3 frac=$4
    local inner=$(( size * frac / 100 ))
    magick "$T/pi.png" -resize "${inner}x${inner}" \
           -background "$bg" -gravity center -extent "${size}x${size}" \
           -alpha remove -alpha off "$out"
}

# Header glyph: white on transparent, tinted at runtime.
magick "$T/pi.png" -resize 72x   "$OUT/glyph@3x.png"
magick "$T/pi.png" -resize 48x   "$OUT/glyph@2x.png"
magick "$T/pi.png" -resize 24x   "$OUT/glyph.png"

plate "$OUT/icon.png"                 1024 "$DARK" 55
# Foreground stays transparent; the platform owns the solid background.
magick "$T/pi.png" -resize 410x410 -background none -gravity center -extent 1024x1024 "$OUT/icon-adaptive.png"
plate "$OUT/favicon.png"                48 "$DARK" 60
plate "$OUT/splash-android-dark.png"  1024 "$DARK" 30
plate "$OUT/splash-android-light.png" 1024 "$CREAM" 30

# Monochrome + notification: white glyph, transparent background.
magick "$T/pi.png" -resize 400x400 -background none -gravity center -extent 1024x1024 "$OUT/icon-monochrome.png"
magick "$T/pi.png" -resize  64x64  -background none -gravity center -extent   96x96  "$OUT/icon-notification.png"

# Android light splash needs a dark glyph on cream.
magick "$T/pi.png" -resize 300x300 -fill "$DARK" -colorize 100 \
       -background "$CREAM" -gravity center -extent 1024x1024 -alpha remove "$OUT/splash-android-light.png"

# Generate each target directly from the source mark, never from a favicon.
mkdir -p "$PUBLIC" "$IOS" docs/play/store-assets
for size in 16 32; do
    plate "$PUBLIC/favicon-$size.png" "$size" "$DARK" 60
done
magick "$PUBLIC/favicon-32.png" "$PUBLIC/favicon-16.png" "$PUBLIC/favicon.ico"
cp "$T/favicon.svg" "$PUBLIC/favicon.svg"
# The attention favicon has a visible dot, including at 16px.
for size in 16 32 48 64; do
    plate "$T/active-$size.png" "$size" "$DARK" 60
    magick "$T/active-$size.png" -fill '#ff9f0a' -draw "circle $((size*7/8)),$((size/8)) $((size*3/4)),$((size/8))" "$T/active-$size.png"
done
magick "$T/active-64.png" "$T/active-48.png" "$T/active-32.png" "$T/active-16.png" "$OUT/favicon-active.ico"
cp "$OUT/favicon-active.ico" "$PUBLIC/favicon-active.ico"
plate "$PUBLIC/apple-touch-icon.png" 180 "$DARK" 55
for size in 192 512; do
    plate "$PUBLIC/icon-$size.png" "$size" "$DARK" 55
    # The whole mark fits inside the maskable 80%-diameter safe circle.
    plate "$PUBLIC/icon-maskable-$size.png" "$size" "$DARK" 40
done
plate docs/play/store-assets/store-icon.png 512 "$DARK" 55
magick "$OUT/icon.png" -colorspace sRGB -type TrueColor "$IOS/App-Icon-1024x1024@1x.png"

# Xcode generates every iPhone/iPad size from the universal 1024 asset.
# Android's checked-in native project must match Expo's prebuild inputs.
for entry in mdpi:48:108:24 hdpi:72:162:36 xhdpi:96:216:48 xxhdpi:144:324:72 xxxhdpi:192:432:96; do
    IFS=: read -r density legacy adaptive notification <<< "$entry"
    mipmap="$RES/mipmap-$density"
    mkdir -p "$mipmap" "$RES/drawable-$density"
    magick "$OUT/icon.png" -resize "${legacy}x${legacy}" -define webp:lossless=true "$mipmap/ic_launcher.webp"
    magick -size "${legacy}x${legacy}" xc:none -fill white -draw "circle $((legacy/2)),$((legacy/2)) $((legacy/2)),0" "$T/mask.png"
    magick "$mipmap/ic_launcher.webp" "$T/mask.png" -alpha off -compose CopyOpacity -composite -define webp:lossless=true "$mipmap/ic_launcher_round.webp"
    for layer in foreground monochrome; do
        source="$OUT/icon-adaptive.png"
        if [ "$layer" = monochrome ]; then source="$OUT/icon-monochrome.png"; fi
        magick "$source" -resize "${adaptive}x${adaptive}" -define webp:lossless=true "$mipmap/ic_launcher_$layer.webp"
    done
    magick "$OUT/icon-notification.png" -resize "${notification}x${notification}" "$RES/drawable-$density/notification_icon.png"
done

echo "wrote:"; ls -la "$OUT"
