#!/usr/bin/env bash
# Generate muxr brand assets. Regenerate with: bash scripts/genBrand.sh
#
# Wordmark and glyph are rasterised small from a pixel font, upscaled with
# point sampling, then a gap is knocked out of each cell so the pixels read as
# discrete blocks. Cells are wider than tall, which is what makes it read as a
# display matrix rather than a checkerboard.
set -euo pipefail

# Departure Mono is SIL OFL-1.1. Not vendored: it is only used here to
# rasterise the assets, never bundled into the app.
FONT_URL='https://github.com/rektdeckard/departure-mono/releases/download/v1.500/DepartureMono-1.500.zip'
OUT=${OUT:-apps/mobile/sources/assets/images}
DARK='#111111'
CREAM='#f0efe7'

mkdir -p "$OUT"
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT

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
plate "$OUT/icon-adaptive.png"        1024 "$DARK" 40   # Android masks ~33% margin
plate "$OUT/favicon.png"                48 "$DARK" 60
plate "$OUT/splash-android-dark.png"  1024 "$DARK" 30
plate "$OUT/splash-android-light.png" 1024 "$CREAM" 30

# Monochrome + notification: white glyph, transparent background.
magick "$T/pi.png" -resize 400x400 -background none -gravity center -extent 1024x1024 "$OUT/icon-monochrome.png"
magick "$T/pi.png" -resize  64x64  -background none -gravity center -extent   96x96  "$OUT/icon-notification.png"

# Android light splash needs a dark glyph on cream.
magick "$T/pi.png" -resize 300x300 -fill "$DARK" -colorize 100 \
       -background "$CREAM" -gravity center -extent 1024x1024 -alpha remove "$OUT/splash-android-light.png"

magick "$OUT/favicon.png" -define icon:auto-resize=64,48,32,16 "$OUT/favicon-active.ico"

echo "wrote:"; ls -la "$OUT"
