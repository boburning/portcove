from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parent
REPO_ROOT = ROOT.parents[5]
TRANSPARENT = (
    REPO_ROOT
    / "apps"
    / "desktop"
    / "assets"
    / "brand"
    / "generated"
    / "v2"
    / "model"
)
PROOF = TRANSPARENT / "proofs"
FRONT = TRANSPARENT / "portcove-mascot-v2-model-front.png"


def normalize_png(path: Path) -> None:
    with Image.open(path) as image:
        normalized = image.convert("RGBA")
        normalized.load()
    normalized.save(path, format="PNG", optimize=True, compress_level=9)


def inspect_alpha(path: Path) -> tuple[int, int, int, tuple[int, int, int, int]]:
    with Image.open(path) as image:
        if image.mode != "RGBA":
            raise ValueError(f"{path.name} must be RGBA, found {image.mode}")
        alpha = image.getchannel("A")
        histogram = alpha.histogram()
        transparent = histogram[0]
        opaque = histogram[255]
        partial = sum(histogram[1:255])
        corners = (
            alpha.getpixel((0, 0)),
            alpha.getpixel((image.width - 1, 0)),
            alpha.getpixel((0, image.height - 1)),
            alpha.getpixel((image.width - 1, image.height - 1)),
        )
        if corners != (0, 0, 0, 0):
            raise ValueError(f"{path.name} has nontransparent corners: {corners}")
        if transparent == 0 or opaque == 0 or partial == 0:
            raise ValueError(
                f"{path.name} alpha coverage is incomplete: transparent={transparent}, "
                f"opaque={opaque}, partial={partial}"
            )
        bounds = alpha.getbbox()
        if bounds is None:
            raise ValueError(f"{path.name} has no visible pixels")
        margins = (
            bounds[0],
            bounds[1],
            image.width - bounds[2],
            image.height - bounds[3],
        )
        if min(margins) < 4:
            raise ValueError(f"{path.name} is clipped or lacks safe edge space: {margins}")
        return transparent, opaque, partial, bounds


def composite_front(name: str, background: str) -> Path:
    with Image.open(FRONT) as source:
        source = source.convert("RGBA")
        stage = Image.new("RGBA", source.size, background)
        stage.alpha_composite(source)
        output = PROOF / name
        stage.convert("RGB").save(output, optimize=True)
        return output


def runtime_size_proof(size: int) -> Path:
    with Image.open(FRONT) as source:
        source = source.convert("RGBA")
        source.thumbnail((size, size), Image.Resampling.LANCZOS)
        stage = Image.new("RGBA", (size, size), "#191A1D")
        offset = ((size - source.width) // 2, (size - source.height) // 2)
        stage.alpha_composite(source, offset)
        output = PROOF / f"portcove-mascot-v2-model-front-{size}px-proof.png"
        stage.convert("RGB").save(output, optimize=True)
        return output


def main() -> None:
    PROOF.mkdir(parents=True, exist_ok=True)
    bounds_by_name = {}
    for path in sorted(TRANSPARENT.glob("*.png")):
        normalize_png(path)
        transparent, opaque, partial, bounds = inspect_alpha(path)
        bounds_by_name[path.name] = bounds
        print(
            f"{path.name}: transparent={transparent}, opaque={opaque}, "
            f"partial={partial}, bounds={bounds}"
        )
    left = bounds_by_name["portcove-mascot-v2-model-front-left-three-quarter.png"]
    right = bounds_by_name["portcove-mascot-v2-model-front-right-three-quarter.png"]
    left_size = (left[2] - left[0], left[3] - left[1])
    right_size = (right[2] - right[0], right[3] - right[1])
    if abs(left_size[0] - right_size[0]) > 12 or abs(left_size[1] - right_size[1]) > 4:
        raise ValueError(
            "three-quarter framing is not mirror-consistent: "
            f"left={left_size}, right={right_size}"
        )
    dark = composite_front("portcove-mascot-v2-model-front-graphite-proof.png", "#191A1D")
    light = composite_front("portcove-mascot-v2-model-front-light-proof.png", "#F2EFE8")
    runtime_proofs = [runtime_size_proof(size) for size in (512, 256, 128)]
    print(f"DARK_PROOF={dark}")
    print(f"LIGHT_PROOF={light}")
    for runtime_proof in runtime_proofs:
        print(f"RUNTIME_SIZE_PROOF={runtime_proof}")


if __name__ == "__main__":
    main()
