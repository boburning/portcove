from __future__ import annotations

import json
import struct
from pathlib import Path

import bpy
from mathutils import Vector


ROOT = Path(__file__).resolve().parent
GLB_PATH = ROOT / "portcove-mascot-v2.glb"


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def count_names(prefix: str) -> int:
    return sum(1 for obj in bpy.data.objects if obj.name.startswith(prefix))


def world_bounds(obj: bpy.types.Object) -> tuple[float, float, float, float, float, float]:
    corners = [obj.matrix_world @ Vector(corner) for corner in obj.bound_box]
    return (
        min(corner.x for corner in corners),
        max(corner.x for corner in corners),
        min(corner.y for corner in corners),
        max(corner.y for corner in corners),
        min(corner.z for corner in corners),
        max(corner.z for corner in corners),
    )


def require_close(actual: float, expected: float, message: str, tolerance: float = 1e-4) -> None:
    require(abs(actual - expected) <= tolerance, f"{message}: {actual} != {expected}")


def validate_bilateral_geometry() -> int:
    pair_count = 0
    for left in sorted(
        (obj for obj in bpy.data.objects if "L" in obj.name.split(".") and obj.type == "MESH"),
        key=lambda obj: obj.name,
    ):
        right_parts = left.name.split(".")
        right_parts[right_parts.index("L")] = "R"
        right_name = ".".join(right_parts)
        right = bpy.data.objects.get(right_name)
        require(right is not None and right.type == "MESH", f"bilateral pair is missing: {right_name}")
        left_bounds = world_bounds(left)
        right_bounds = world_bounds(right)
        require_close(left_bounds[0], -right_bounds[1], f"{left.name} minimum X is not mirrored")
        require_close(left_bounds[1], -right_bounds[0], f"{left.name} maximum X is not mirrored")
        for index, axis in ((2, "minimum Y"), (3, "maximum Y"), (4, "minimum Z"), (5, "maximum Z")):
            require_close(left_bounds[index], right_bounds[index], f"{left.name} {axis} drifted")
        pair_count += 1
    require(pair_count >= 20, f"bilateral mesh coverage is incomplete: {pair_count} pairs")
    return pair_count


def validate_blend() -> None:
    root = bpy.data.objects.get("PortcoveMascotV2.Root")
    require(root is not None, "model root is missing")
    require(root["mascot_version"] == 2, "mascot version must be 2")
    require(root["walking_leg_count"] == 4, "root must declare four walking legs")
    require(root["side_spike_count"] == 4, "root must declare four side spikes")
    require(root["claw_count"] == 2, "root must declare two claws")
    require(root["eye_count"] == 2, "root must declare two eyes")

    require(count_names("EyeHousing.") == 2, "model must contain two eye housings")
    require(count_names("Claw.CobaltMass.") == 2, "model must contain two claw masses")
    require(
        count_names("WalkingLeg.Front.") == 4 and count_names("WalkingLeg.Rear.") == 4,
        "model must contain upper and lower segments for exactly four walking legs",
    )
    require(
        count_names("SideSpike.Front.") == 4 and count_names("SideSpike.Rear.") == 4,
        "model must contain body and tip segments for exactly four side spikes",
    )
    require(count_names("LidHinge.") == 2, "model must contain two lid hinges")
    for suffix in ("L", "R"):
        hinge = bpy.data.objects[f"LidHinge.{suffix}"]
        child_names = {child.name for child in hinge.children}
        require(
            child_names
            == {f"Lid.RedExterior.{suffix}", f"Lid.GraphiteUnderside.{suffix}"},
            f"lid hinge {suffix} must own exactly its red exterior and graphite underside",
        )

    required_materials = {
        "MAT_SignatureRed",
        "MAT_CobaltBlue",
        "MAT_GoldenYellow",
        "MAT_EmeraldGreen",
        "MAT_WarmWhite",
        "MAT_Graphite",
    }
    require(
        {material.name for material in bpy.data.materials} == required_materials,
        "canonical material set drifted",
    )
    require(count_names("Camera.") == 5, "model must contain five fixed cameras")

    shell = bpy.data.objects["Shell"]
    require_close(shell.dimensions.x, 6.73, "shell width drifted")
    belly_bounds = world_bounds(bpy.data.objects["Belly.FrontOnly"])
    require(belly_bounds[3] < 0.0, "gold belly must remain entirely on the front half")

    left_camera = bpy.data.objects["Camera.FrontLeftThreeQuarter"]
    right_camera = bpy.data.objects["Camera.FrontRightThreeQuarter"]
    require_close(left_camera.location.x, -right_camera.location.x, "three-quarter camera X positions drifted")
    require_close(left_camera.location.y, right_camera.location.y, "three-quarter camera Y positions drifted")
    require_close(left_camera.location.z, right_camera.location.z, "three-quarter camera Z positions drifted")
    require_close(left_camera.data.ortho_scale, right_camera.data.ortho_scale, "three-quarter camera scales drifted")
    require_close(left_camera.data.shift_x, -right_camera.data.shift_x, "three-quarter camera framing drifted")

    bilateral_pairs = validate_bilateral_geometry()

    mesh_objects = [obj for obj in bpy.data.objects if obj.type == "MESH"]
    for obj in mesh_objects:
        obj.data.calc_loop_triangles()
    triangles = sum(len(obj.data.loop_triangles) for obj in mesh_objects)
    require(triangles < 5000, f"model is no longer low-poly: {triangles} triangles")
    print(
        f"BLEND_OK objects={len(bpy.data.objects)} meshes={len(mesh_objects)} "
        f"materials={len(bpy.data.materials)} triangles={triangles} "
        f"bilateral_pairs={bilateral_pairs}"
    )


def read_glb_json(path: Path) -> dict:
    with path.open("rb") as stream:
        magic, version, total_length = struct.unpack("<4sII", stream.read(12))
        require(magic == b"glTF", "GLB magic is invalid")
        require(version == 2, "GLB version must be 2")
        require(total_length == path.stat().st_size, "GLB length header is invalid")
        chunk_length, chunk_type = struct.unpack("<II", stream.read(8))
        require(chunk_type == 0x4E4F534A, "GLB first chunk must be JSON")
        return json.loads(stream.read(chunk_length).decode("utf-8").rstrip(" \t\r\n\0"))


def validate_glb() -> None:
    require(GLB_PATH.is_file(), "GLB export is missing")
    document = read_glb_json(GLB_PATH)
    require(document.get("asset", {}).get("version") == "2.0", "glTF asset version drifted")
    require(len(document.get("materials", [])) == 6, "GLB must contain six canonical materials")
    require(len(document.get("meshes", [])) >= 40, "GLB mesh set is incomplete")
    require(len(document.get("cameras", [])) == 5, "GLB must include five fixed cameras")
    node_names = {node.get("name") for node in document.get("nodes", [])}
    for required in (
        "PortcoveMascotV2.Root",
        "LidHinge.L",
        "LidHinge.R",
        "Belly.FrontOnly",
    ):
        require(required in node_names, f"GLB node is missing: {required}")
    print(
        f"GLB_OK nodes={len(document.get('nodes', []))} "
        f"meshes={len(document.get('meshes', []))} "
        f"materials={len(document.get('materials', []))} "
        f"cameras={len(document.get('cameras', []))}"
    )


def main() -> None:
    validate_blend()
    validate_glb()


if __name__ == "__main__":
    main()
