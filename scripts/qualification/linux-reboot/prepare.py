"""Retain one previously qualified tuple and prepare the existing guest cell."""
from pathlib import Path
import base64, datetime, hashlib, json, os, resource, shutil, stat, subprocess, sys, zipfile
from common import child, hosted_context, identity, publish, require
from qualification_archive import preflight, controls as archive_controls

HERE = Path(__file__).resolve().parent
COHORT = json.loads((HERE / 'cohort.json').read_bytes())


def admit_provider(run, artifact):
    require(run['id'] == COHORT['run'] and run['head_sha'] == COHORT['source'] and run['run_attempt'] == COHORT['attempt']
            and run['workflow_id'] == COHORT['workflow_id'] and run['status'] == 'completed' and run['conclusion'] == 'success', 'Frozen producer identity changed')
    require(artifact['id'] == COHORT['artifact'] and artifact['expired'] is False
            and artifact['workflow_run']['id'] == COHORT['run'] and artifact['workflow_run']['head_sha'] == COHORT['source']
            and artifact['size_in_bytes'] == COHORT['archive_bytes'] and artifact['digest'] == 'sha256:' + COHORT['archive_sha256'], 'Frozen artifact identity changed')


def stage():
    workspace, root = hosted_context()
    require(not (root / 'tuple.json').exists(), 'Never replace an earlier attempt')
    archive_controls()
    # Only this step receives the job-scoped actions:read token. Never transfer it to a guest.
    private_home = root / 'artifact-client-home'
    private_home.mkdir(mode=0o700)
    environment = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'HOME': str(private_home),
                   'GH_TOKEN': os.environ.get('GH_TOKEN', ''), 'GH_HOST': 'github.com', 'GH_PROMPT_DISABLED': '1'}
    require(bool(environment['GH_TOKEN']), 'Read-only artifact transport credential required')
    metadata = {}
    for label, endpoint in [('run', f"repos/boburning/portcove/actions/runs/{COHORT['run']}"),
                            ('artifact', f"repos/boburning/portcove/actions/artifacts/{COHORT['artifact']}")]:
        text = child(root, 'provider-' + label, ['gh', 'api', endpoint], environment=environment, timeout=30)
        require(len(text.encode()) <= 1024 * 1024, 'Provider metadata bound')
        metadata[label] = json.loads(text)
    run, artifact = metadata['run'], metadata['artifact']
    admit_provider(run, artifact)
    archive = root / 'retained-cohort.zip'
    result = None
    failure = None
    def limit_download():
        resource.setrlimit(resource.RLIMIT_FSIZE, (COHORT['archive_bytes'] + 1, COHORT['archive_bytes'] + 1))
    try:
        with archive.open('xb') as output, (root / 'artifact-download.stderr.private.txt').open('xb') as err:
            result = subprocess.run(['gh', 'api', f"repos/boburning/portcove/actions/artifacts/{COHORT['artifact']}/zip"],
                                    env=environment, stdout=output, stderr=err, timeout=600, preexec_fn=limit_download)
    except (OSError, subprocess.TimeoutExpired) as error:
        failure = error
    publish(root / 'artifact-download.status.json', {'code': None if result is None else result.returncode,
            'timed_out': isinstance(failure, subprocess.TimeoutExpired), 'error_type': None if failure is None else type(failure).__name__,
            'stderr': identity(root / 'artifact-download.stderr.private.txt'),
            'scope': 'Raw transport diagnostics remain private; no signed redirect URL or token is published'})
    if failure:
        raise RuntimeError('Artifact transport failed; retain partial bytes and private diagnostics') from None
    require(result.returncode == 0, 'Artifact transport failed; no automatic retry')
    actual = identity(archive)
    require(actual['bytes'] == COHORT['archive_bytes'] and actual['sha256'] == COHORT['archive_sha256'], 'Artifact bytes disagree')
    wanted = {row['path']: row for row in COHORT['files']}
    require(len(wanted) == 17, 'Only the frozen public tuple may enter the guest')
    audited = []
    with archive.open('rb') as source:
        before = os.fstat(source.fileno())
        raw = preflight(source)
        require(len(raw) == COHORT['file_count'], 'Frozen archive inventory changed')
        source.seek(0)
        with zipfile.ZipFile(source) as data:
            infos = data.infolist()
            require(len(infos) == len(raw), 'Raw and semantic entry counts disagree')
            for info, row in zip(infos, raw):
                require((info.filename, info.file_size, info.compress_size, info.header_offset) ==
                        (row['path'], row['bytes'], row['packed'], row['local']), 'Raw and semantic entry identities disagree')
                sha = hashlib.sha256()
                total = 0
                with data.open(info) as member:
                    while block := member.read(1024 * 1024):
                        total += len(block)
                        require(total <= row['bytes'], 'Member exceeds raw size')
                        sha.update(block)
                require(total == row['bytes'], 'Truncated member')
                observed = {'path': info.filename, 'bytes': total, 'sha256': sha.hexdigest(), 'crc32': f'{info.CRC:08x}'}
                if info.filename in wanted:
                    require(all(observed[key] == wanted[info.filename][key] for key in observed), 'Frozen public tuple changed')
                audited.append(observed)
            require(sum(row['bytes'] for row in audited) == COHORT['expanded_bytes'], 'Frozen expanded bytes changed')
            output = root / 'public-inputs'
            output.mkdir(mode=0o700)
            for name, row in wanted.items():
                require(row['bytes'] <= 128 * 1024 ** 2, 'Selected input bound')
                target = output / name
                target.parent.mkdir(parents=True, exist_ok=True)
                with data.open(name) as member, target.open('xb') as destination:
                    shutil.copyfileobj(member, destination, 1024 * 1024)
                observed = identity(target)
                require(observed['bytes'] == row['bytes'] and observed['sha256'] == row['sha256'], 'Selected copy changed')
                target.chmod(0o444)
        after = os.fstat(source.fileno())
        require((before.st_ino, before.st_size, before.st_mtime_ns) == (after.st_ino, after.st_size, after.st_mtime_ns), 'Archive changed during audit')
    key = base64.b64decode((output / 'updater-rehearsal/disposable.key.pub').read_bytes(), validate=True)
    require(len(key) == 114 and hashlib.sha256(key).hexdigest() == '8555d4c53b9d32ca1fadbf4a71a28a02ee2ebd908246510ef213dbfc76d0a03d', 'Wrong decoded payload key')
    publish(root / 'tuple.json', {'controller_source': os.environ['GITHUB_SHA'], 'controller_run': os.environ['GITHUB_RUN_ID'],
            'controller_attempt': os.environ['GITHUB_RUN_ATTEMPT'], 'cohort': COHORT, 'audit': audited,
            'parser': {'python': sys.version, 'zipfile': zipfile.__file__},
            'scope': 'Complete bounded ZIP/hash/CRC audit and exact17public-file extraction only; native installed staging still authenticates metadata and candidate signature'})


def helper():
    workspace, root = hosted_context()
    source = workspace / 'work/updater-linux-reboot-helper-source'
    head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=source, timeout=20).decode().strip()
    require(head == COHORT['helper_source'], 'Frozen helper source required')
    require(not subprocess.check_output(['git', 'status', '--porcelain', '--untracked-files=no'], cwd=source, timeout=20).strip(), 'Helper source is dirty')
    environment = {key: value for key, value in os.environ.items() if not key.startswith(('PORTCOVE_APPLICATION_', 'TAURI_SIGNING_'))
                   and key not in ('GH_TOKEN', 'GITHUB_TOKEN', 'PORTCOVE_GITHUB_TOKEN', 'TAURI_CONFIG', 'LD_PRELOAD', 'LD_AUDIT')}
    environment['RUSTUP_AUTO_INSTALL'] = '0'
    child(root, 'helper-build', ['cargo', 'build', '--locked', '--profile', 'controller-tools', '-p', 'portcove-desktop', '--example', 'prepare_installed_update'],
          environment=environment, cwd=source, timeout=1200)
    require(subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=source, timeout=20).decode().strip() == head
            and not subprocess.check_output(['git', 'status', '--porcelain', '--untracked-files=no'], cwd=source, timeout=20).strip(), 'Helper source changed during build')
    compiler = child(root, 'rustc-version', ['rustc', '--version', '--verbose'], environment=environment)
    cargo = child(root, 'cargo-version', ['cargo', '--version'], environment=environment)
    binary = Path(environment['CARGO_TARGET_DIR']) / 'controller-tools/examples/prepare_installed_update'
    output = root / 'public-inputs/prepare_installed_update'
    # Cargo's two hardlinked output aliases are not an input-copy identity.
    with binary.open('rb') as reader, output.open('xb') as destination:
        shutil.copyfileobj(reader, destination, 1024 * 1024)
    require(identity(binary)['sha256'] == identity(output)['sha256'] and output.stat().st_nlink == 1, 'Helper copy differs')
    output.chmod(0o444)
    publish(root / 'helper.json', {'source': head, 'shipping_product_source': COHORT['source'], 'helper': identity(output),
            'build_os_exit_code': 0, 'compiler': compiler, 'cargo': cargo, 'cargo_lock': identity(source / 'Cargo.lock'), 'scope': 'Existing preparation example/profile only; no shipping application/package, frontend, signing, or public feed build'})


def runtime():
    workspace, root = hosted_context()
    files = []
    tools = {}
    env = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'HOME': str(root), 'TMPDIR': str(root)}
    for name in ['qemu-system-x86_64', 'qemu-img']:
        tool = Path(shutil.which(name)).resolve()
        tools[name] = str(tool)
        files.append(identity(tool))
        child(root, name + '-version', [str(tool), '--version'], environment=env)
        libraries = child(root, name + '-libraries', ['/usr/bin/ldd', str(tool)], environment=env)
        require('not found' not in libraries, 'Incomplete host tool runtime')
        for line in libraries.splitlines():
            words = line.strip().split()
            path = words[2] if len(words) > 2 and words[1] == '=>' else words[0] if words else ''
            if path.startswith('/'):
                selected = Path(path).resolve()
                if str(selected) not in {row['path'] for row in files}:
                    files.append(identity(selected))
    bios = Path('/usr/share/seabios/bios-256k.bin').resolve()
    files.append(identity(bios))
    packages = child(root, 'host-packages', ['dpkg-query', '-W', 'qemu-system-x86', 'qemu-utils', 'seabios', 'ubuntu-keyring'], environment=env)
    publish(root / 'runtime.json', {'tools': tools, 'bios': str(bios), 'data': '/usr/share/qemu', 'files': files,
            'packages': packages, 'scope': 'Managed Ubuntu24 hosted tool prerequisites; actualbinary/library/firmware hashes, no host reboot or GPU/KVM assumption'})
    version = subprocess.check_output(['dpkg-query', '-W', '-f=${Version}', 'ubuntu-keyring'], timeout=20).decode()
    records = subprocess.check_output(['apt-cache', 'show', 'ubuntu-keyring=' + version], timeout=20).decode().split('\n\n')
    candidates = []
    for paragraph in records:
        fields = dict(line.split(': ', 1) for line in paragraph.splitlines() if ': ' in line and not line.startswith(' '))
        if fields.get('Version') == version and fields.get('Package') == 'ubuntu-keyring':
            candidates.append(fields)
    require(len(candidates) == 1, 'Exact installed Ubuntu keyring package metadata unavailable')
    package = candidates[0]
    downloads = root / 'keyring-download'
    downloads.mkdir(mode=0o700)
    child(root, 'keyring-download', ['apt-get', 'download', 'ubuntu-keyring=' + version], environment=env, cwd=downloads)
    debs = list(downloads.glob('*.deb'))
    require(len(debs) == 1 and debs[0].stat().st_size == int(package['Size']) <= 1024 * 1024, 'Keyring package bound')
    require(identity(debs[0])['sha256'] == package['SHA256'], 'Keyring package differs from APT identity')
    publish(root / 'keyring-package-receipt.json', {'phase': 'installed-keyring-package-retained',
            'packages': [{'Package': 'ubuntu-keyring', 'Version': version, 'SHA256': package['SHA256'],
                          'deb': str(debs[0]), 'extracted': '/', 'source': package['Filename']}]})


def finalize():
    workspace, root = hosted_context()
    output = root / 'public-inputs'
    shutil.copyfile(HERE / 'guest.py', output / 'guest-reboot-case.py')
    rows = {row['path']: row for row in COHORT['files']}
    predecessor = rows['updater-rehearsal/qualified-0.1.0-bundles/appimage/Portcove_0.1.0_amd64.AppImage']
    candidate = rows['updater-rehearsal/0.3.0-linux-x86_64/Portcove_0.3.0_amd64.AppImage']
    selected_helper = json.loads((root / 'helper.json').read_bytes())
    config = {'source_commit': COHORT['source'], 'state': '/home/portcove/qualification',
              'stable': {**{k: predecessor[k] for k in ['bytes', 'sha256']}, 'path': '/home/portcove/Applications/Portcove Public beta β.AppImage'},
              'candidate': {**{k: candidate[k] for k in ['bytes', 'sha256']}, 'path': '/home/portcove/inputs/Portcove_0.3.0_amd64.AppImage'},
              'helper': {**{k: selected_helper['helper'][k] for k in ['bytes', 'sha256']}, 'path': '/home/portcove/tools/prepare_installed_update', 'source_commit': COHORT['helper_source']}}
    publish(output / 'configuration.json', config)
    inputs = [identity(output / row['path']) for row in COHORT['files']]
    inputs += [identity(output / name) for name in ['prepare_installed_update', 'guest-reboot-case.py', 'configuration.json']]
    for row in inputs:
        row['path'] = str(Path(row['path']).relative_to(output))
    publish(output / 'inputs.json', {**{key: COHORT[key] for key in ['source', 'run', 'attempt', 'artifact', 'archive_sha256']}, 'files': inputs})
    runtime = json.loads((root / 'runtime.json').read_bytes())
    files = [identity(output / 'inputs.json')] + [identity(output / row['path']) for row in inputs]
    files += [identity(root / name) for name in ['tuple.json', 'helper.json', 'runtime.json', 'image/image-receipt.json', 'image/ubuntu-26.04-server-cloudimg-amd64.img']]
    files += [identity(HERE / name) for name in ['common.py', 'prepare.py', 'image.py', 'qualification_archive.py', 'controller.py', 'guest.py', 'evidence.py', 'cohort.json', 'controls.py']]
    files += runtime['files']
    publish(root / 'launch-inputs.json', {'controller_source': os.environ['GITHUB_SHA'], 'run': os.environ['GITHUB_RUN_ID'],
            'attempt': os.environ['GITHUB_RUN_ATTEMPT'], 'product_source': COHORT['source'], 'files': files,
            'plan': {'cpus': 2, 'ram_mib': 3072, 'disk_bytes': 12 * 1024 ** 3, 'qemu_seconds': 5400, 'single_process_and_disk': True}})
    print('manifest_sha256=' + identity(root / 'launch-inputs.json')['sha256'])


if __name__ == '__main__':
    require(sys.argv[1:] in [['stage'], ['helper'], ['runtime'], ['finalize']], 'One fixed case phase required')
    {'stage': stage, 'helper': helper, 'runtime': runtime, 'finalize': finalize}[sys.argv[1]]()
