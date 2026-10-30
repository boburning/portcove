"""One retained Linux qualification case; no production release authority."""
from pathlib import Path
import datetime, hashlib, json, os, re, stat, subprocess


def require(value, message):
    if not value:
        raise RuntimeError(message)


def identity(path):
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and not path.is_symlink(), 'Direct regular input required')
    with path.open('rb') as stream:
        sha = hashlib.file_digest(stream, 'sha256').hexdigest()
    return {'path': str(path), 'bytes': info.st_size, 'sha256': sha}


def publish(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('x') as target:
        json.dump(value, target, indent=2)
        target.write('\n')
        target.flush()
        os.fsync(target.fileno())


def hosted_context():
    require(os.geteuid() != 0, 'Ordinary hosted caller required')
    expected = {'GITHUB_ACTIONS': 'true', 'GITHUB_REPOSITORY': 'boburning/portcove',
                'GITHUB_EVENT_NAME': 'workflow_dispatch', 'RUNNER_ENVIRONMENT': 'github-hosted',
                'RUNNER_OS': 'Linux', 'RUNNER_ARCH': 'X64', 'GITHUB_JOB': 'linux-retained-reboot'}
    for key, value in expected.items():
        require(os.environ.get(key) == value, 'Unexpected hosted context: ' + key)
    require(re.fullmatch(r'[0-9a-f]{40}', os.environ.get('GITHUB_SHA', '')), 'Exact source required')
    for key in ['GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT']:
        require(re.fullmatch(r'[1-9][0-9]{0,15}', os.environ.get(key, '')), 'Exact run/attempt required')
    require(os.environ.get('GITHUB_WORKFLOW_REF', '').startswith('boburning/portcove/.github/workflows/updater-artifact-rehearsal.yml@refs/heads/'), 'Registered rehearsal only')
    workspace = Path(os.environ['GITHUB_WORKSPACE'])
    require(workspace.is_absolute() and workspace.resolve() == workspace, 'Direct workspace required')
    actual = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=workspace, timeout=20).decode().strip()
    require(actual == os.environ['GITHUB_SHA'], 'Checkout does not match dispatched head')
    root = workspace / 'work/updater-linux-reboot'
    if not root.exists():
        root.mkdir(mode=0o700, parents=True)
    require(root.is_dir() and not root.is_symlink() and root.stat().st_uid == os.geteuid(), 'Owned case directory required')
    return workspace, root


def child(root, label, arguments, timeout=120, environment=None, cwd=None):
    result = None
    failure = None
    try:
        with (root / (label + '.stdout.txt')).open('xb') as out, (root / (label + '.stderr.txt')).open('xb') as err:
            result = subprocess.run(arguments, cwd=cwd, env=environment, stdout=out, stderr=err, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as error:
        failure = error
    publish(root / (label + '.status.json'), {'arguments': arguments, 'code': None if result is None else result.returncode,
            'timed_out': isinstance(failure, subprocess.TimeoutExpired), 'error': None if failure is None else str(failure)})
    if failure:
        raise failure
    require(result.returncode == 0, label + ' failed; retained raw outcome')
    require(all((root / (label + suffix)).stat().st_size <= 8 * 1024 ** 2 for suffix in ['.stdout.txt', '.stderr.txt']), 'Child diagnostics exceeded read bound')
    return (root / (label + '.stdout.txt')).read_text()


def verified_admission(raw, expected):
    require(hashlib.sha256(raw).hexdigest() == expected, 'Admitted manifest differs from pinned bytes')
    return json.loads(raw)
