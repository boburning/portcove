"""Fixed publisher ZIP; bounded structure and contained framework links before ditto."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import shutil
import stat
import struct
import subprocess
import tempfile
import urllib.request
import zipfile

native = Path('evidence/desktop-verify/opentyrian-macos/native')
native.mkdir(parents=True, exist_ok=True)
root = Path(tempfile.mkdtemp(prefix='portcove-opentyrian-mac-', dir=Path(os.environ['RUNNER_TEMP']).resolve()))
archive = root / 'publisher.zip'
url = 'https://github.com/andyvand/opentyrian2000/releases/download/3.0.0-SDL3/opentyrian2000-macOS.zip'
observed = '1cc51134dea33fab363048d672cbad3b199df45d2a1bf78b7ae9f0c7afe54a60'
closed = True
try:
    with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'Portcove-native-qualification/1.0'}), timeout=60) as response, archive.open('xb') as out:
        total = 0
        while chunk := response.read(65536):
            total += len(chunk)
            assert total <= 6337025, 'Publisher ZIP exceeds inspected size'
            out.write(chunk)
    raw = archive.read_bytes()
    assert len(raw) == 6337025 and hashlib.sha256(raw).hexdigest() == observed
    # Exact observed identity is a replay boundary, not trusted digest authority.
    # Bound classic ZIP central/local structural metadata before ZipFile parses it.
    end = struct.unpack('<4s4H2IH', raw[-22:])
    assert end[0] == b'PK\x05\x06' and end[1:3] == (0, 0) and end[3] == end[4] == 106 and end[7] == 0
    directory_size, offset = end[5:7]
    assert directory_size <= 65536 and offset + directory_size == len(raw) - 22
    cursor = offset
    for _ in range(end[4]):
        assert cursor + 46 <= offset + directory_size and raw[cursor:cursor+4] == b'PK\x01\x02'
        name_len, extra_len, comment_len = struct.unpack_from('<3H', raw, cursor + 28)
        assert name_len <= 256 and extra_len <= 4096 and comment_len <= 1024
        local = struct.unpack_from('<I', raw, cursor + 42)[0]
        assert local + 30 <= offset and raw[local:local+4] == b'PK\x03\x04'
        local_name, local_extra = struct.unpack_from('<2H', raw, local + 26)
        assert local_name <= 256 and local_extra <= 4096 and local + 30 + local_name + local_extra <= offset
        cursor += 46 + name_len + extra_len + comment_len
        assert cursor <= offset + directory_size
    assert cursor == offset + directory_size
    prefix = 'opentyrian2000.app/'
    links = {
        prefix+'Contents/Frameworks/SDL3.framework/Resources': 'Versions/Current/Resources',
        prefix+'Contents/Frameworks/SDL3.framework/SDL3': 'Versions/Current/SDL3',
        prefix+'Contents/Frameworks/SDL3.framework/Versions/Current': 'A',
    }
    expected = {}
    with zipfile.ZipFile(archive) as package_zip:
        names = set()
        decoded = 0
        for item in package_zip.infolist():
            path = PurePosixPath(item.filename)
            assert item.filename.isascii() and item.filename.startswith(prefix) and not path.is_absolute() and '\\' not in item.filename
            assert all(part not in ('', '.', '..') for part in item.filename.rstrip('/').split('/'))
            assert item.filename.rstrip('/').lower() not in names
            names.add(item.filename.rstrip('/').lower())
            assert not any(item.filename.startswith(link+'/') for link in links)
            mode = item.external_attr >> 16
            assert not item.flag_bits & 1 and item.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED)
            assert stat.S_IFMT(mode) in (stat.S_IFDIR, stat.S_IFREG, stat.S_IFLNK)
            assert item.file_size <= 16 * 1024 * 1024
            decoded += item.file_size
            assert decoded <= 64 * 1024 * 1024
            if stat.S_ISDIR(mode):
                assert item.file_size == 0
            elif stat.S_ISLNK(mode):
                assert item.filename in links and item.file_size <= 128
                assert package_zip.read(item).decode('utf8') == links[item.filename]
                expected[item.filename] = {'link': links[item.filename]}
            else:
                expected[item.filename] = {'sha256': hashlib.sha256(package_zip.read(item)).hexdigest(), 'size': item.file_size}
        assert {name for name, item in expected.items() if 'link' in item} == set(links)
    destination = root / 'extracted'
    destination.mkdir()
    closed = False
    extracted = subprocess.run(['/usr/bin/ditto', '-x', '-k', str(archive), str(destination)], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
    closed = True
    assert extracted.returncode == 0, 'Native ZIP extraction failed'
    actual = set()
    for directory, folders, files in os.walk(destination, followlinks=False):
        for name in folders + files:
            item = Path(directory) / name
            relative = item.relative_to(destination).as_posix()
            if item.is_symlink():
                assert relative in links and os.readlink(item) == links[relative]
                assert item.resolve(strict=True).is_relative_to(destination.resolve(strict=True))
                actual.add(relative)
            elif item.is_file():
                assert relative in expected
                assert item.stat().st_size == expected[relative]['size']
                assert hashlib.sha256(item.read_bytes()).hexdigest() == expected[relative]['sha256']
                actual.add(relative)
            else:
                assert item.is_dir()
    assert actual == set(expected)
    package = destination / 'opentyrian2000.app'
    player = package / 'Contents/MacOS/opentyrian2000'
    assert player.stat().st_mode & stat.S_IXUSR and not player.is_symlink()
    binary = player.read_bytes()
    assert binary[:4] == b'\xca\xfe\xba\xbe'
    slices = struct.unpack_from('>I', binary, 4)[0]
    assert 1 <= slices <= 8
    cpus = [struct.unpack_from('>I', binary, 8 + 20*i)[0] for i in range(slices)]
    assert 0x01000007 in cpus and 0x0100000c in cpus
    produced = Path('product/target/debug/portcove').resolve(strict=True)
    cli = root / 'portcove-cli'
    shutil.copy2(produced, cli)
    assert cli.stat().st_nlink == 1
    cli_hash = hashlib.sha256(cli.read_bytes()).hexdigest()
    assert cli_hash == hashlib.sha256(produced.read_bytes()).hexdigest()
    container = Path.home()/'Library/Containers/com.AnV.Software.opentyrian2000'
    globals_ = [container, Path.home()/'.config/opentyrian2000', Path.home()/'Library/Preferences/com.AnV.Software.opentyrian2000.plist', Path.home()/'Library/Saved Application State/com.AnV.Software.opentyrian2000.savedState', Path.home()/'Library/Preferences/org.libsdl.app.plist', Path.home()/'Library/Saved Application State/org.libsdl.app.savedState']
    assert all(not p.exists() and not p.is_symlink() for p in globals_), 'Existing profile belongs to another owner'
    report = {'root': str(root), 'package': str(package), 'player': str(player), 'player_sha256': hashlib.sha256(binary).hexdigest(), 'working_directory': str(player.parent), 'profile_root': str(container/'Data'), 'profile_isolation': 'initially absent publisher sandbox container on a fresh hosted user; Mac package does not use the Linux XDG contract', 'cli': str(cli), 'cli_sha256': cli_hash, 'cli_bytes': cli.stat().st_size, 'produced_cli': str(produced), 'produced_cli_sha256': cli_hash, 'artifact': {'repository': 'andyvand/opentyrian2000', 'asset_id': 241882108, 'url': url, 'bytes': len(raw), 'observed_sha256': observed, 'publisher_digest': None}, 'archive_entries': 106, 'decoded_bytes': decoded, 'framework_links': links, 'package_regular_or_link_entries': len(expected), 'macho_cpus': cpus, 'runtime_cpu': 'unknown', 'initially_absent_global_paths': list(map(str, globals_)), 'product_source': 'b7abf3710d9bf75352baa6737e0602fb9d296cb7', 'controller_source': os.environ['GITHUB_SHA'], 'run': os.environ['GITHUB_RUN_ID'], 'attempt': os.environ['GITHUB_RUN_ATTEMPT'], 'os_architecture': platform.machine(), 'os_runtime': platform.platform(), 'scope': 'Official upstream-owned universal Mac package and included freeware data; no managed acquisition digest authority'}
    Path('opentyrian-macos-input.json').write_text(json.dumps(report, indent=2))
    (native/'inputs.json').write_text(json.dumps(report, indent=2))
finally:
    (native/'input-cleanup.json').write_text(json.dumps({'all_owned_operations_closed': closed, 'scope': 'bounded download/extraction; no mounted image or persistent install'}))
