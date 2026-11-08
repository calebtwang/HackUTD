#!/usr/bin/env python3
"""Create a deployment source archive without local state or dependencies."""
import os
from pathlib import Path
import sys
import tarfile

if len(sys.argv) != 2:
    raise SystemExit('Usage: python3 deploy/package-source.py /path/to/hackutd-source.tar.gz')
root = Path(__file__).resolve().parent.parent
destination = Path(sys.argv[1]).expanduser().resolve()
if destination.exists():
    raise SystemExit('Output already exists; choose a new archive path.')
files = ['Dockerfile', '.dockerignore', 'package.json', 'package-lock.json', 'index.html', 'tsconfig.json', 'vite.config.ts', 'docs/HOSTING.md']
excluded = {'.git', '.local', 'node_modules', 'dist', 'screenshots', '__pycache__', '.DS_Store'}
for directory in ['src', 'server', 'workers', 'shared', 'deploy']:
    for path in sorted((root / directory).rglob('*')):
        relative = path.relative_to(root)
        if any(part in excluded or part.startswith('.env') for part in relative.parts):
            continue
        if path.is_file() and not path.is_symlink() and path.suffix != '.log':
            files.append(str(relative))
os.umask(0o077)
destination.parent.mkdir(parents=True, exist_ok=True)
with tarfile.open(destination, 'w:gz') as archive:
    for filename in sorted(set(files)):
        path = root / filename
        if not path.is_file() or path.is_symlink():
            raise SystemExit(f'Missing regular source file: {filename}')
        archive.add(path, arcname=filename, recursive=False)
print(f'Created deployment source archive ({len(set(files))} files). No private configuration was included.')
