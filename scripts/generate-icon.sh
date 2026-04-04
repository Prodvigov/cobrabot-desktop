#!/bin/bash
# Generate placeholder icon for CobraBot Desktop

# Create a simple icon with ImageMagick (if available)
# Otherwise, download placeholder

ASSETS_DIR="$(dirname "$0")/../assets"
mkdir -p "$ASSETS_DIR"

if command -v convert &> /dev/null; then
  # Generate icon with ImageMagick
  convert -size 512x512 xc:'#1a1a2e' \
    -fill '#4CAF50' \
    -draw 'circle 256,256 256,50' \
    -fill white \
    -font Arial -pointsize 200 -gravity center \
    -annotate +0+0 '🐍' \
    "$ASSETS_DIR/icon.png"
  
  echo "✅ Icon created: $ASSETS_DIR/icon.png"
else
  # Download placeholder
  echo "⚠️  ImageMagick not found. Please add icon manually:"
  echo "   1. Create a 512x512 PNG icon"
  echo "   2. Save as: $ASSETS_DIR/icon.png"
  echo ""
  echo "   Or install ImageMagick:"
  echo "   macOS: brew install imagemagick"
  echo "   Linux: sudo apt install imagemagick"
fi
