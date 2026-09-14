# Tray icon

`source/adb-bridge-icon.jpg` is the original artwork (1408×768). The app icons are
cut from it:

- `icon.png` — 256×256, a 600×600 crop around the emblem (offset 405,83) with
  rounded corners, so it reads on light and dark taskbars.
- `icon.ico` — the same, at 256/64/48/32/16.

To regenerate after replacing the artwork (ImageMagick 7):

```sh
magick source/adb-bridge-icon.jpg -crop 600x600+405+83 +repage -resize 256x256 \
  \( -size 256x256 xc:none -fill white -draw "roundrectangle 0,0 255,255 48,48" \) \
  -compose DstIn -composite icon.png
magick icon.png -define icon:auto-resize=256,64,48,32,16 icon.ico
```

The tray, its settings and console windows, and the installer all read the icons
from this folder.
