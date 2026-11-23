#!/usr/bin/env python3
"""Build runtime-only ZIPs without local diagnostics, fixtures or credentials."""
import argparse
import hashlib
import json
import shutil
import stat
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def copy(source, target):
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)


def archive(folder, target):
    with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as output:
        for source in sorted(folder.rglob('*')):
            if not source.is_file():
                continue
            if source.is_symlink():
                raise RuntimeError('Unexpected symlink in package')
            output.write(source, source.relative_to(folder.parent))
    with zipfile.ZipFile(target) as output:
        for entry in output.infolist():
            parts = Path(entry.filename).parts
            if any(p in {'.local', '.git', '.orca', 'node_modules', 'verification', '__MACOSX'} for p in parts):
                raise RuntimeError('Private or development directory in package')
        if folder.name == 'orca-magpie-monitor':
            info = output.getinfo('orca-magpie-monitor/bin/magpie-popup')
            if not ((info.external_attr >> 16) & stat.S_IXUSR):
                raise RuntimeError('Popup lost its executable permission')
    return hashlib.sha256(target.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT.parent / 'packages')
    args = parser.parse_args()
    staged = ROOT / '.local' / 'package'
    if not (staged / 'orca-plugin.json').is_file():
        raise SystemExit('Run npm run stage first.')
    manifest = json.loads((staged / 'orca-plugin.json').read_text())
    if (ROOT / 'orca-plugin.json').read_bytes() != (staged / 'orca-plugin.json').read_bytes():
        raise SystemExit('Staged manifest is stale. Run npm run stage again.')
    args.output.mkdir(parents=True, exist_ok=True)
    sums = []
    with tempfile.TemporaryDirectory(prefix='magpie-share-') as directory:
        dest = Path(directory) / 'orca-magpie-monitor'
        copy(staged / 'orca-plugin.json', dest / 'orca-plugin.json')
        copy(ROOT / 'SHARING.md', dest / 'README.md')
        copy(ROOT / 'LICENSE', dest / 'LICENSE')
        for source in (ROOT / 'docs').glob('*.md'):
            copy(source, dest / 'docs' / source.name)
        for source in (staged / 'src').iterdir():
            if source.suffix not in {'.ts', '.tsx'} or source.name == 'fixtures.ts' or '.test.' in source.name or '.check.' in source.name:
                continue
            if (ROOT / 'src' / source.name).read_bytes() != source.read_bytes():
                raise SystemExit(f'Staged source is stale: {source.name}. Run npm run stage again.')
            copy(source, dest / 'src' / source.name)
        copy(staged / 'bin' / 'magpie-popup', dest / 'bin' / 'magpie-popup')
        for source in (staged / 'native').rglob('*'):
            if source.is_file() and source.name != '.DS_Store':
                copy(source, dest / 'native' / source.relative_to(staged / 'native'))
        name = f"orca-magpie-monitor-{manifest['version']}-macos-{'universal'}.zip"
        digest = archive(dest, args.output / name)
        sums.append(f'{digest}  {name}')

    (args.output / 'magpie-monitor-SHASUMS.txt').write_text('\n'.join(sums) + '\n')
    for line in sums:
        print(line)


if __name__ == '__main__':
    main()
