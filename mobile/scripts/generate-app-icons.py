# /// script
# requires-python = ">=3.11"
# dependencies = ["Pillow==12.1.1"]
# ///
"""Rebuild with `uv run mobile/scripts/generate-app-icons.py` from any cwd.

Optional: --preview-dir PATH writes launcher mask previews outside the repository.
The source is avatar-b3.png, not a redraw: retain its framing, remove only the
outer circular border and paper noise, then use the same ink for every asset.
"""

import argparse
import json
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFont

ASSETS = Path(__file__).resolve().parents[1] / "assets"
SIZE = 1024
# Avatar b3 is 256px square. Its circular border occupies the outer ~6px;
# the ear/body meet that border, so connected-component deletion would erase them.
BORDER_INSET = 6
ADAPTIVE_CANVAS_DP = 108
ADAPTIVE_SAFE_DP = 66
ADAPTIVE_VIEWPORT_DP = 72


def source_ink() -> Image.Image:
    with Image.open(ASSETS / "avatar-b3.png") as source:
        if source.size != (256, 256):
            raise ValueError("avatar-b3 framing changed; review the border inset before regenerating")
        paper = Image.new("RGBA", source.size, "white")
        paper.alpha_composite(source.convert("RGBA"))
        # White becomes transparent; retain antialiasing rather than thresholding
        # the drawing into jagged binary pixels. Both launcher layers are black ink.
        alpha = paper.convert("L").point(lambda value: max(0, min(255, round((240 - value) * 255 / 224))))
    # Remove the rim before resampling: Lanczos otherwise pulls faint echoes of
    # the black ring into the interior, leaving a ghost circle on white.
    interior = Image.new("L", alpha.size)
    radius = (alpha.width - 1) / 2 - BORDER_INSET
    center = (alpha.width - 1) / 2
    interior.putdata([
        255 if (x - center) ** 2 + (y - center) ** 2 <= radius ** 2 else 0
        for y in range(alpha.height) for x in range(alpha.width)
    ])
    alpha = ImageChops.multiply(alpha, interior).resize((SIZE, SIZE), Image.Resampling.LANCZOS)
    ink = Image.new("RGBA", (SIZE, SIZE))
    ink.putalpha(alpha)
    return ink


def on_white(ink: Image.Image) -> Image.Image:
    background = Image.new("RGBA", ink.size, "white")
    return Image.alpha_composite(background, ink).convert("RGB")


def adaptive_layer(ink: Image.Image) -> Image.Image:
    # Put the entire original framing, not just its bounding box, in the safe
    # zone. This preserves composition and fits all OEM masks without clipping.
    safe_size = SIZE * ADAPTIVE_SAFE_DP // ADAPTIVE_CANVAS_DP
    offset = (SIZE - safe_size) // 2
    layer = Image.new("RGBA", (SIZE, SIZE))
    layer.alpha_composite(ink.resize((safe_size, safe_size), Image.Resampling.LANCZOS), (offset, offset))
    return layer


def shape_mask(size: int, shape: str) -> Image.Image:
    mask = Image.new("L", (size, size))
    draw = ImageDraw.Draw(mask)
    box = (0, 0, size - 1, size - 1)
    if shape == "circle":
        draw.ellipse(box, fill=255)
    elif shape == "rounded-square":
        draw.rounded_rectangle(box, radius=size // 4, fill=255)
    else:
        draw.rectangle(box, fill=255)
    return mask


def previews(directory: Path, ink: Image.Image, adaptive: Image.Image) -> list[dict]:
    directory.mkdir(parents=True, exist_ok=True)
    # Android crops the overscan layer to the central 72dp before applying the
    # launcher mask. Masking the whole 108dp image would understate icon size.
    inset = round(SIZE * (ADAPTIVE_CANVAS_DP - ADAPTIVE_VIEWPORT_DP) / (2 * ADAPTIVE_CANVAS_DP))
    visible = adaptive.crop((inset, inset, SIZE - inset, SIZE - inset))
    font = ImageFont.load_default(size=18)
    sheet = Image.new("RGB", (900, 960), "#e0e0e0")
    draw = ImageDraw.Draw(sheet)
    measurements = []
    for row, (name, layer) in enumerate((("icon", ink), ("adaptive", visible), ("monochrome", visible))):
        for column, shape in enumerate(("circle", "square", "rounded-square")):
            mask = shape_mask(layer.width, shape)
            clipped = ImageChops.multiply(layer.getchannel("A"), ImageChops.invert(mask))
            if clipped.getbbox() is not None:
                raise ValueError(f"{name}/{shape} clips the subject")
            measurements.append({"asset": name, "mask": shape, "clipped_alpha_pixels": 0})
            if name == "monochrome":
                colored = Image.new("RGB", layer.size, "#283c23")
                tile = Image.new("RGB", layer.size, "#dcebcf")
                tile.paste(colored, mask=layer.getchannel("A"))
            else:
                tile = on_white(layer)
            preview = Image.new("RGB", layer.size, "#e0e0e0")
            preview.paste(tile, mask=mask)
            preview.save(directory / f"{name}-{shape}.png")
            x, y = column * 300 + 22, row * 320 + 36
            sheet.paste(preview.resize((256, 256), Image.Resampling.LANCZOS), (x, y))
            draw.text((x, y - 26), f"{name} / {shape}", font=font, fill="#202020")
    sheet.save(directory / "icon-mask-previews.png")
    return measurements


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--preview-dir", type=Path)
    args = parser.parse_args()
    ink = source_ink()
    icon = on_white(ink)
    adaptive = adaptive_layer(ink)
    icon.save(ASSETS / "icon.png")
    icon.save(ASSETS / "splash-icon.png")
    icon.resize((48, 48), Image.Resampling.LANCZOS).save(ASSETS / "favicon.png")
    adaptive.save(ASSETS / "android-icon-foreground.png")
    # The artwork is already single-color; Android uses its alpha for theme tint.
    adaptive.save(ASSETS / "android-icon-monochrome.png")
    Image.new("RGB", (SIZE, SIZE), "white").save(ASSETS / "android-icon-background.png")
    report = {"source": "avatar-b3.png", "canvas": SIZE, "safe_zone_ratio": "66/108",
              "foreground_ink_bounds": adaptive.getbbox()}
    if args.preview_dir:
        report["previews"] = previews(args.preview_dir, ink, adaptive)
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
