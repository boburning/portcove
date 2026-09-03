from __future__ import annotations

import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector


SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[5]
OUTPUT_DIR = SCRIPT_DIR
RENDER_DIR = (
    REPO_ROOT
    / "apps"
    / "desktop"
    / "assets"
    / "brand"
    / "generated"
    / "v2"
    / "model"
)
BLEND_PATH = OUTPUT_DIR / "portcove-mascot-v2.blend"
GLB_PATH = OUTPUT_DIR / "portcove-mascot-v2.glb"

PALETTE = {
    "SignatureRed": (0.886, 0.122, 0.040, 1.0),
    "CobaltBlue": (0.020, 0.105, 0.920, 1.0),
    "GoldenYellow": (0.950, 0.610, 0.015, 1.0),
    "EmeraldGreen": (0.010, 0.510, 0.220, 1.0),
    "WarmWhite": (0.920, 0.900, 0.840, 1.0),
    "Graphite": (0.012, 0.013, 0.016, 1.0),
}


def reset_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for datablocks in (
        bpy.data.meshes,
        bpy.data.curves,
        bpy.data.cameras,
        bpy.data.lights,
        bpy.data.materials,
    ):
        for block in list(datablocks):
            datablocks.remove(block)
    for collection in list(bpy.data.collections):
        if collection.name != "Collection":
            bpy.data.collections.remove(collection)
    root_collection = bpy.data.collections.get("Collection")
    if root_collection:
        root_collection.name = "PORTCOVE_V2"


def new_collection(name: str, parent: bpy.types.Collection | None = None) -> bpy.types.Collection:
    collection = bpy.data.collections.new(name)
    (parent or bpy.context.scene.collection).children.link(collection)
    return collection


def move_to_collection(obj: bpy.types.Object, collection: bpy.types.Collection) -> None:
    for current in list(obj.users_collection):
        current.objects.unlink(obj)
    collection.objects.link(obj)


def make_material(name: str, rgba: tuple[float, float, float, float]) -> bpy.types.Material:
    material = bpy.data.materials.new(name=f"MAT_{name}")
    material.diffuse_color = rgba
    material.use_nodes = True
    bsdf = material.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = rgba
    bsdf.inputs["Metallic"].default_value = 0.0
    bsdf.inputs["Roughness"].default_value = 0.86
    if "Specular IOR Level" in bsdf.inputs:
        bsdf.inputs["Specular IOR Level"].default_value = 0.18
    return material


def assign_material(obj: bpy.types.Object, material: bpy.types.Material) -> None:
    obj.data.materials.append(material)
    for polygon in obj.data.polygons:
        polygon.use_smooth = False


def make_ico(
    name: str,
    location: tuple[float, float, float],
    scale: tuple[float, float, float],
    material: bpy.types.Material,
    collection: bpy.types.Collection,
    subdivisions: int = 2,
    rotation_y: float = 0.0,
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_ico_sphere_add(
        subdivisions=subdivisions,
        radius=1.0,
        location=location,
        rotation=(0.0, rotation_y, 0.0),
    )
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    assign_material(obj, material)
    move_to_collection(obj, collection)
    return obj


def make_segment(
    name: str,
    start: tuple[float, float, float],
    end: tuple[float, float, float],
    radius_start: float,
    radius_end: float,
    material: bpy.types.Material,
    collection: bpy.types.Collection,
    vertices: int = 8,
) -> bpy.types.Object:
    start_v = Vector(start)
    end_v = Vector(end)
    direction = end_v - start_v
    midpoint = (start_v + end_v) / 2.0
    bpy.ops.mesh.primitive_cone_add(
        vertices=vertices,
        radius1=radius_start,
        radius2=radius_end,
        depth=direction.length,
        location=midpoint,
    )
    obj = bpy.context.object
    obj.name = name
    obj.rotation_mode = "QUATERNION"
    obj.rotation_quaternion = direction.to_track_quat("Z", "Y")
    assign_material(obj, material)
    move_to_collection(obj, collection)
    return obj


def make_prism(
    name: str,
    points_xz: list[tuple[float, float]],
    y_center: float,
    depth: float,
    material: bpy.types.Material,
    collection: bpy.types.Collection,
    parent: bpy.types.Object | None = None,
    origin: tuple[float, float, float] | None = None,
) -> bpy.types.Object:
    y_front = y_center - depth / 2.0
    y_back = y_center + depth / 2.0
    vertices = [(x, y_front, z) for x, z in points_xz] + [
        (x, y_back, z) for x, z in points_xz
    ]
    if parent:
        bpy.context.view_layer.update()
        parent_inverse = parent.matrix_world.inverted()
        vertices = [tuple(parent_inverse @ Vector(vertex)) for vertex in vertices]
    count = len(points_xz)
    faces = [tuple(range(count)), tuple(reversed(range(count, count * 2)))]
    for index in range(count):
        next_index = (index + 1) % count
        faces.append((index, next_index, count + next_index, count + index))
    mesh = bpy.data.meshes.new(f"{name}.Mesh")
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    collection.objects.link(obj)
    assign_material(obj, material)
    if origin:
        obj.location = (-origin[0], -origin[1], -origin[2])
        for vertex in mesh.vertices:
            vertex.co += Vector(origin)
        obj.location = Vector(origin)
    if parent:
        obj.parent = parent
    return obj


def make_empty(name: str, location: tuple[float, float, float], collection: bpy.types.Collection) -> bpy.types.Object:
    obj = bpy.data.objects.new(name, None)
    obj.empty_display_type = "PLAIN_AXES"
    obj.empty_display_size = 0.34
    obj.location = location
    collection.objects.link(obj)
    return obj


def parent_to_root(obj: bpy.types.Object, root: bpy.types.Object) -> None:
    if obj is root or obj.parent is not None:
        return
    matrix_world = obj.matrix_world.copy()
    obj.parent = root
    obj.matrix_world = matrix_world


def mirror_right_meshes_from_left() -> None:
    bpy.context.view_layer.update()
    left_objects = sorted(
        (obj for obj in bpy.data.objects if obj.type == "MESH" and "L" in obj.name.split(".")),
        key=lambda obj: obj.name,
    )
    for left in left_objects:
        right_parts = left.name.split(".")
        right_parts[right_parts.index("L")] = "R"
        right_name = ".".join(right_parts)
        right = bpy.data.objects.get(right_name)
        if right is None or right.type != "MESH":
            raise ValueError(f"missing bilateral mesh pair for {left.name}: {right_name}")
        inverse_right = right.matrix_world.inverted()
        vertices = []
        for vertex in left.data.vertices:
            world = left.matrix_world @ vertex.co
            world.x = -world.x
            vertices.append(tuple(inverse_right @ world))
        faces = [tuple(reversed(polygon.vertices[:])) for polygon in left.data.polygons]
        mirrored_mesh = bpy.data.meshes.new(f"{right.name}.MirroredMesh")
        mirrored_mesh.from_pydata(vertices, [], faces)
        mirrored_mesh.update()
        for material in left.data.materials:
            mirrored_mesh.materials.append(material)
        for polygon in mirrored_mesh.polygons:
            polygon.use_smooth = False
        previous_mesh = right.data
        right.data = mirrored_mesh
        if previous_mesh.users == 0:
            bpy.data.meshes.remove(previous_mesh)
        mirrored_mesh.name = f"{right.name}.Mesh"
        right["mirrored_from"] = left.name


def build_model() -> tuple[bpy.types.Object, dict[str, bpy.types.Material], bpy.types.Collection]:
    scene_root = bpy.data.collections["PORTCOVE_V2"]
    model_collection = new_collection("MODEL", scene_root)
    body_collection = new_collection("Body", model_collection)
    face_collection = new_collection("Face", model_collection)
    eyes_collection = new_collection("Eyes", model_collection)
    lids_collection = new_collection("Lids", model_collection)
    claws_collection = new_collection("Claws", model_collection)
    legs_collection = new_collection("WalkingLegs_4_Total", model_collection)
    spikes_collection = new_collection("SideSpikes_4_Total", model_collection)

    materials = {name: make_material(name, rgba) for name, rgba in PALETTE.items()}
    root = make_empty("PortcoveMascotV2.Root", (0.0, 0.0, 0.0), model_collection)
    root["brand"] = "Portcove"
    root["mascot_version"] = 2
    root["shell_width_units"] = 6.73
    root["walking_leg_count"] = 4
    root["side_spike_count"] = 4
    root["claw_count"] = 2
    root["eye_count"] = 2
    root["art_direction"] = "Approved 2026-09-03 raster turnaround"

    shell = make_ico(
        "Shell",
        (0.0, 0.0, 0.28),
        (3.365, 2.65, 1.55),
        materials["SignatureRed"],
        body_collection,
        subdivisions=2,
    )
    shell.scale.x *= 6.73 / shell.dimensions.x
    bpy.context.view_layer.update()
    bpy.ops.object.select_all(action="DESELECT")
    shell.select_set(True)
    bpy.context.view_layer.objects.active = shell
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    shell.select_set(False)
    shell["canonical_measure"] = "shell width = 6.73 units"

    belly = make_prism(
        "Belly.FrontOnly",
        [
            (-1.76, 0.08),
            (1.76, 0.08),
            (1.48, -0.70),
            (0.62, -1.32),
            (-0.62, -1.32),
            (-1.48, -0.70),
        ],
        -2.61,
        0.26,
        materials["GoldenYellow"],
        body_collection,
    )
    belly["placement_rule"] = "front third only; hidden in rear view"

    mouth_border = make_prism(
        "Mouth.Border",
        [(-1.08, 0.92), (1.16, 0.45), (-1.05, 0.28)],
        -2.64,
        0.15,
        materials["Graphite"],
        face_collection,
    )
    mouth = make_prism(
        "Mouth.WarmWhite",
        [(-0.89, 0.77), (0.91, 0.47), (-0.86, 0.39)],
        -2.74,
        0.08,
        materials["WarmWhite"],
        face_collection,
    )
    mouth["expression_role"] = "narrow asymmetric mischievous grin"

    for side, suffix in ((-1.0, "L"), (1.0, "R")):
        eye_x = side * 1.025
        stalk = make_segment(
            f"EyeStalk.{suffix}",
            (eye_x * 0.91, -1.08, 1.58),
            (eye_x, -1.52, 2.42),
            0.18,
            0.22,
            materials["SignatureRed"],
            eyes_collection,
            vertices=7,
        )
        housing = make_ico(
            f"EyeHousing.{suffix}",
            (eye_x, -1.54, 3.28),
            (0.64, 0.62, 1.10),
            materials["SignatureRed"],
            eyes_collection,
            subdivisions=2,
        )
        sclera = make_ico(
            f"EyeGlobe.Sclera.{suffix}",
            (eye_x, -2.14, 3.25),
            (0.49, 0.16, 0.84),
            materials["WarmWhite"],
            eyes_collection,
            subdivisions=2,
        )
        iris = make_ico(
            f"EyeGlobe.Iris.{suffix}",
            (side * 0.94, -2.31, 3.22),
            (0.30, 0.065, 0.56),
            materials["CobaltBlue"],
            eyes_collection,
            subdivisions=2,
        )
        pupil = make_ico(
            f"EyeGlobe.Pupil.{suffix}",
            (side * 0.91, -2.38, 3.27),
            (0.145, 0.035, 0.36),
            materials["Graphite"],
            eyes_collection,
            subdivisions=2,
        )
        highlight = make_ico(
            f"EyeGlobe.Highlight.{suffix}",
            (side * 0.82, -2.425, 3.56),
            (0.062, 0.022, 0.10),
            materials["WarmWhite"],
            eyes_collection,
            subdivisions=1,
        )
        for obj in (stalk, housing, sclera, iris, pupil, highlight):
            obj["bilateral_pair"] = suffix

        outer_x = side * 1.62
        hinge = make_empty(f"LidHinge.{suffix}", (outer_x, -2.18, 4.02), lids_collection)
        hinge.rotation_mode = "XYZ"
        hinge["control"] = "rotate local Y for expression"
        hinge["recommended_range_degrees"] = 12.0
        hinge["neutral_rotation_degrees"] = 0.0

        red_points = [
            (side * 1.62, 4.02),
            (side * 1.56, 4.66),
            (side * 1.10, 4.84),
            (side * 0.72, 4.68),
            (side * 0.37, 3.93),
            (side * 0.91, 4.25),
        ]
        black_points = [
            (side * 1.53, 4.08),
            (side * 0.91, 4.26),
            (side * 0.36, 3.92),
            (side * 0.47, 3.74),
            (side * 1.50, 3.88),
        ]
        lid_red = make_prism(
            f"Lid.RedExterior.{suffix}",
            red_points,
            -2.14,
            0.36,
            materials["SignatureRed"],
            lids_collection,
            parent=hinge,
        )
        lid_black = make_prism(
            f"Lid.GraphiteUnderside.{suffix}",
            black_points,
            -2.34,
            0.16,
            materials["Graphite"],
            lids_collection,
            parent=hinge,
        )
        lid_red["moves_with"] = hinge.name
        lid_black["moves_with"] = hinge.name

        shoulder_x = side * 3.30
        claw_base_x = side * 4.15
        shoulder = make_ico(
            f"Claw.Shoulder.{suffix}",
            (shoulder_x, -1.52, -0.02),
            (0.52, 0.56, 0.58),
            materials["SignatureRed"],
            claws_collection,
            subdivisions=1,
        )
        arm = make_segment(
            f"Claw.Arm.{suffix}",
            (side * 3.42, -1.56, -0.04),
            (claw_base_x, -2.66, -0.06),
            0.28,
            0.34,
            materials["SignatureRed"],
            claws_collection,
            vertices=7,
        )
        blue = make_ico(
            f"Claw.CobaltMass.{suffix}",
            (side * 4.84, -3.16, -0.02),
            (1.10, 1.02, 1.24),
            materials["CobaltBlue"],
            claws_collection,
            subdivisions=2,
            rotation_y=side * math.radians(8.0),
        )
        yellow = make_segment(
            f"Claw.GoldenOuterTip.{suffix}",
            (side * 5.18, -2.92, -0.22),
            (side * 6.02, -4.02, -1.67),
            0.80,
            0.25,
            materials["GoldenYellow"],
            claws_collection,
            vertices=6,
        )
        lower = make_segment(
            f"Claw.RedInnerPincer.{suffix}",
            (side * 4.48, -2.86, -0.25),
            (side * 4.70, -3.70, -1.62),
            0.66,
            0.21,
            materials["SignatureRed"],
            claws_collection,
            vertices=6,
        )
        for obj in (shoulder, arm, blue, yellow, lower):
            obj["bilateral_pair"] = suffix

        leg_specs = (
            ("Front", 1.40, -1.35, -0.72, 0.46, -0.28),
            ("Rear", 2.03, 1.15, -0.64, 0.37, 0.30),
        )
        for label, root_x, root_y, root_z, x_step, y_step in leg_specs:
            leg_root = (side * root_x, root_y, root_z)
            knee = (side * (root_x + x_step), root_y + y_step, root_z - 0.58)
            toe = (side * (root_x + x_step * 0.76), root_y + y_step * 1.55, root_z - 1.08)
            upper = make_segment(
                f"WalkingLeg.{label}.{suffix}.Upper",
                leg_root,
                knee,
                0.25,
                0.20,
                materials["SignatureRed"],
                legs_collection,
                vertices=6,
            )
            lower_leg = make_segment(
                f"WalkingLeg.{label}.{suffix}.Lower",
                knee,
                toe,
                0.21,
                0.13,
                materials["SignatureRed"],
                legs_collection,
                vertices=6,
            )
            upper["anatomy"] = f"walking leg {label.lower()} {suffix}"
            lower_leg["anatomy"] = f"walking leg {label.lower()} {suffix}"

        spike_specs = (
            ("Front", 2.42, -0.38, 1.24, 0.66, 1.42),
            ("Rear", 2.93, 0.96, 0.84, 0.76, 1.22),
        )
        for label, base_x, base_y, base_z, outward, rise in spike_specs:
            base = Vector((side * base_x, base_y, base_z))
            tip = Vector((side * (base_x + outward), base_y + 0.02, base_z + rise))
            split = base.lerp(tip, 0.74)
            green = make_segment(
                f"SideSpike.{label}.{suffix}.EmeraldBody",
                tuple(base),
                tuple(split),
                0.40,
                0.24,
                materials["EmeraldGreen"],
                spikes_collection,
                vertices=6,
            )
            gold = make_segment(
                f"SideSpike.{label}.{suffix}.GoldenTip",
                tuple(split),
                tuple(tip),
                0.245,
                0.025,
                materials["GoldenYellow"],
                spikes_collection,
                vertices=6,
            )
            green["anatomy"] = f"side spike {label.lower()} {suffix}"
            gold["anatomy"] = f"side spike {label.lower()} {suffix}"

    mirror_right_meshes_from_left()

    for collection in (
        body_collection,
        face_collection,
        eyes_collection,
        lids_collection,
        claws_collection,
        legs_collection,
        spikes_collection,
    ):
        for obj in collection.objects:
            parent_to_root(obj, root)
    for hinge in [obj for obj in lids_collection.objects if obj.name.startswith("LidHinge")]:
        parent_to_root(hinge, root)

    return root, materials, model_collection


def add_camera(
    name: str,
    location: tuple[float, float, float],
    target: tuple[float, float, float],
    collection: bpy.types.Collection,
    ortho_scale: float = 12.65,
    shift_x: float = 0.0,
) -> bpy.types.Object:
    data = bpy.data.cameras.new(name)
    data.type = "ORTHO"
    data.ortho_scale = ortho_scale
    data.shift_x = shift_x
    data.lens = 50.0
    camera = bpy.data.objects.new(name, data)
    collection.objects.link(camera)
    camera.location = location
    camera.rotation_euler = (Vector(target) - Vector(location)).to_track_quat("-Z", "Y").to_euler()
    camera["canonical_view"] = name.removeprefix("Camera.")
    return camera


def add_lighting(collection: bpy.types.Collection) -> None:
    lights = (
        ("Key", "AREA", (-5.5, -7.5, 10.0), 1050.0, 6.0, (1.0, 0.84, 0.66)),
        ("Fill", "AREA", (6.0, -4.0, 5.5), 620.0, 5.0, (0.62, 0.74, 1.0)),
        ("Rim", "AREA", (0.0, 6.5, 8.0), 800.0, 5.0, (1.0, 0.38, 0.18)),
    )
    for name, light_type, location, energy, size, color in lights:
        data = bpy.data.lights.new(f"Light.{name}", type=light_type)
        data.energy = energy
        data.shape = "DISK"
        data.size = size
        data.color = color
        obj = bpy.data.objects.new(f"Light.{name}", data)
        collection.objects.link(obj)
        obj.location = location
        obj.rotation_euler = (Vector((0.0, 0.0, 0.8)) - Vector(location)).to_track_quat("-Z", "Y").to_euler()


def configure_scene() -> dict[str, bpy.types.Object]:
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = 1254
    scene.render.resolution_y = 1254
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.image_settings.color_depth = "8"
    scene.render.image_settings.compression = 18
    scene.render.film_transparent = True
    scene.render.use_file_extension = True
    scene.render.image_settings.color_mode = "RGBA"
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"
    scene.view_settings.exposure = 0.0
    scene.view_settings.gamma = 1.0
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.image_settings.color_mode = "RGBA"

    world = bpy.data.worlds.new("Portcove.World") if not bpy.data.worlds else bpy.data.worlds[0]
    scene.world = world
    world.use_nodes = True
    background = world.node_tree.nodes.get("Background")
    background.inputs["Color"].default_value = (0.035, 0.035, 0.045, 1.0)
    background.inputs["Strength"].default_value = 0.32

    scene_root = bpy.data.collections["PORTCOVE_V2"]
    camera_collection = new_collection("CAMERAS_FIXED", scene_root)
    light_collection = new_collection("LIGHTS_SIMPLE", scene_root)
    add_lighting(light_collection)
    target = (0.0, 0.0, 1.25)
    cameras = {
        "front": add_camera("Camera.Front", (0.0, -20.0, 3.55), target, camera_collection),
        "front-left-three-quarter": add_camera(
            "Camera.FrontLeftThreeQuarter",
            (-10.0, -17.3, 4.55),
            target,
            camera_collection,
            ortho_scale=14.2,
            shift_x=0.10,
        ),
        "front-right-three-quarter": add_camera(
            "Camera.FrontRightThreeQuarter",
            (10.0, -17.3, 4.55),
            target,
            camera_collection,
            ortho_scale=14.2,
            shift_x=-0.10,
        ),
        "left-side": add_camera("Camera.LeftSide", (20.0, 0.0, 3.75), target, camera_collection),
        "back": add_camera("Camera.Back", (0.0, 20.0, 3.55), target, camera_collection),
    }
    return cameras


def render_views(cameras: dict[str, bpy.types.Object]) -> None:
    RENDER_DIR.mkdir(parents=True, exist_ok=True)
    scene = bpy.context.scene
    for slug, camera in cameras.items():
        hidden_for_view = []
        if slug == "left-side":
            for obj in bpy.data.objects:
                if obj.name.endswith(".L") or ".L." in obj.name:
                    hidden_for_view.append(obj)
                    obj.hide_render = True
        scene.camera = camera
        scene.render.filepath = str(RENDER_DIR / f"portcove-mascot-v2-model-{slug}.png")
        bpy.ops.render.render(write_still=True)
        for obj in hidden_for_view:
            obj.hide_render = False


def save_and_export(model_collection: bpy.types.Collection) -> None:
    BLEND_PATH.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(BLEND_PATH), compress=True)
    bpy.ops.object.select_all(action="DESELECT")
    for obj in bpy.data.objects:
        if obj.type in {"MESH", "EMPTY", "CAMERA", "LIGHT"}:
            obj.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=str(GLB_PATH),
        export_format="GLB",
        export_cameras=True,
        export_lights=True,
        export_extras=True,
        export_yup=True,
        use_selection=True,
    )


def main() -> None:
    reset_scene()
    _, _, model_collection = build_model()
    cameras = configure_scene()
    render_views(cameras)
    save_and_export(model_collection)
    print(f"BLEND={BLEND_PATH}")
    print(f"GLB={GLB_PATH}")
    print(f"RENDERS={RENDER_DIR}")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Portcove model build failed: {error}", file=sys.stderr)
        raise
