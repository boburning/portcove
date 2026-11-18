"""Fixed official Mac package, private copy, and exact owned read-only mount."""
import hashlib
import json
import os
from pathlib import Path
import platform
import plistlib
import shutil
import stat
import struct
import subprocess
import tempfile
import urllib.request

native = Path('evidence/desktop-verify/cdogs-macos/native')
native.mkdir(parents=True, exist_ok=True)
root = Path(tempfile.mkdtemp(prefix='portcove-cdogs-mac-', dir=Path(os.environ['RUNNER_TEMP']).resolve()))
image = root / 'C-Dogs.SDL-2.5.0-OSX.dmg'
mount = root / 'mounted'
mount.mkdir()
expected = '97c10a380af36b5544e116b29babf0975cbf2e650376342e5d3207dd5829b437'
url = 'https://github.com/cxong/cdogs-sdl/releases/download/2.5.0/C-Dogs.SDL-2.5.0-OSX.dmg'
attach_attempted = False
device = None
closed = True


def command(args):
    return subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True, timeout=90).stdout


def own_images():
    data = plistlib.loads(command(['/usr/bin/hdiutil', 'info', '-plist']))
    return [entry for entry in data.get('images', []) if entry.get('image-path') == str(image)]


try:
    with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'Portcove-native-qualification/1.0'}), timeout=60) as response, image.open('xb') as out:
        total = 0
        while chunk := response.read(65536):
            total += len(chunk)
            assert total <= 31136702, 'Publisher image exceeds reviewed size'
            out.write(chunk)
    assert image.stat().st_size == 31136702 and hashlib.sha256(image.read_bytes()).hexdigest() == expected
    assert not own_images(), 'This image already has a mount owner'
    attach_attempted = True
    closed = False
    attachment = plistlib.loads(command(['/usr/bin/hdiutil', 'attach', '-readonly', '-nobrowse', '-plist', '-mountpoint', str(mount), str(image)]))
    matches = [entry for entry in attachment.get('system-entities', []) if entry.get('mount-point') == str(mount)]
    assert len(matches) == 1 and matches[0].get('dev-entry', '').startswith('/dev/disk')
    device = matches[0]['dev-entry']
    source = mount / 'cdogs-sdl'
    assert source.is_dir() and not source.is_symlink(), 'Expected publisher cdogs-sdl folder; observed ' + repr(sorted(x.name for x in mount.iterdir()))
    count = total = 0
    for directory, folders, files in os.walk(source, followlinks=False):
        for name in folders + files:
            item = Path(directory) / name
            count += 1
            assert count <= 8000
            metadata = item.lstat()
            if stat.S_ISLNK(metadata.st_mode):
                assert not Path(os.readlink(item)).is_absolute()
                assert item.resolve(strict=True).is_relative_to(source.resolve(strict=True))
            elif stat.S_ISREG(metadata.st_mode):
                assert metadata.st_size <= 64 * 1024 * 1024
                total += metadata.st_size
                assert total <= 512 * 1024 * 1024
            else:
                assert stat.S_ISDIR(metadata.st_mode), 'Nonordinary publisher entry'
    package = root / 'package'
    shutil.copytree(source, package, symlinks=True)
    player = (package / 'bin/cdogs-sdl').resolve(strict=True)
    assert player.is_relative_to(package) and player.stat().st_mode & stat.S_IXUSR
    header = player.read_bytes()[:8]
    assert header[:4] == b'\xcf\xfa\xed\xfe' and struct.unpack('<I', header[4:8])[0] == 0x100000c, 'Expected reviewed Apple Silicon Mach-O'
    produced = Path('product/target/debug/portcove').resolve(strict=True)
    cli = root / 'portcove-cli'
    shutil.copy2(produced, cli)
    assert cli.stat().st_nlink == 1
    cli_hash = hashlib.sha256(cli.read_bytes()).hexdigest()
    assert cli_hash == hashlib.sha256(produced.read_bytes()).hexdigest()
    globals_ = [Path.home() / '.config/cdogs-sdl', Path.home() / 'Library/Preferences/org.libsdl.app.plist', Path.home() / 'Library/Saved Application State/org.libsdl.app.savedState']
    assert all(not p.exists() and not p.is_symlink() for p in globals_), 'An existing profile belongs to another owner'
    report = {'root': str(root), 'package': str(package), 'player': str(player), 'player_sha256': hashlib.sha256(player.read_bytes()).hexdigest(), 'working_directory': str(player.parent), 'cli': str(cli), 'cli_sha256': cli_hash, 'cli_bytes': cli.stat().st_size, 'produced_cli': str(produced), 'produced_cli_sha256': cli_hash, 'artifact': {'repository_id': '7571859', 'asset_id': 646845609, 'url': url, 'bytes': image.stat().st_size, 'sha256': expected, 'digest_source': 'publisher GitHub release asset metadata'}, 'package_entries': count, 'package_regular_bytes': total, 'initially_absent_global_paths': list(map(str, globals_)), 'product_source': '27b0a6e994545e622d67b3bea016d32665224192', 'controller_source': os.environ['GITHUB_SHA'], 'run': os.environ['GITHUB_RUN_ID'], 'attempt': os.environ['GITHUB_RUN_ATTEMPT'], 'os_architecture': platform.machine(), 'os_runtime': platform.platform(), 'scope': 'Official upstream-owned Apple Silicon package; no retail inputs, signing changes or save uploads'}
    Path('cdogs-macos-input.json').write_text(json.dumps(report, indent=2))
    (native / 'inputs.json').write_text(json.dumps(report, indent=2))
finally:
    if attach_attempted:
        try:
            images = own_images()
            if device:
                owned = [entry for image_entry in images for entry in image_entry.get('system-entities', []) if entry.get('dev-entry') == device and entry.get('mount-point') == str(mount)]
                assert len(owned) == 1, 'Mount identity changed; do not detach another owner'
                command(['/usr/bin/hdiutil', 'detach', device])
            closed = not own_images()
        except Exception as error:
            closed = False
            (native / 'mount-cleanup-error.json').write_text(json.dumps({'message': str(error), 'scope': 'owned mount closure unknown; retain admission'}))
    (native / 'input-cleanup.json').write_text(json.dumps({'all_owned_operations_closed': closed, 'attachment_attempted': attach_attempted, 'device': device, 'mountpoint': str(mount), 'scope': 'read-only private publisher image mount only'}))
    if not closed:
        raise RuntimeError('Owned mount closure not established')
