"""Identify Mach-O code by its header, not its filename or executable bit."""
from pathlib import Path
import struct

MH_EXECUTE = 2
THIN = {b'\xce\xfa\xed\xfe': '<', b'\xcf\xfa\xed\xfe': '<',
        b'\xfe\xed\xfa\xce': '>', b'\xfe\xed\xfa\xcf': '>'}
FAT = {b'\xca\xfe\xba\xbe': ('>', False), b'\xbe\xba\xfe\xca': ('<', False),
       b'\xca\xfe\xba\xbf': ('>', True), b'\xbf\xba\xfe\xca': ('<', True)}


def macho_types(path):
    """Return file types for every architecture; an empty tuple means non-Mach-O."""
    with Path(path).open('rb') as handle:
        def read_at(offset, length):
            handle.seek(offset)
            data = handle.read(length)
            if len(data) != length:
                raise ValueError(f'Truncated Mach-O header: {path}')
            return data

        magic = handle.read(4)
        if magic in THIN:
            return (struct.unpack(THIN[magic] + 'I', read_at(12, 4))[0],)
        if magic not in FAT:
            return ()
        endian, wide = FAT[magic]
        count = struct.unpack(endian + 'I', read_at(4, 4))[0]
        if not 1 <= count <= 32:
            raise ValueError(f'Invalid Mach-O architecture count: {path}')
        types = []
        for index in range(count):
            entry = 8 + index * (32 if wide else 20)
            offset = struct.unpack(endian + ('Q' if wide else 'I'),
                                   read_at(entry + 8, 8 if wide else 4))[0]
            slice_magic = read_at(offset, 4)
            if slice_magic not in THIN:
                raise ValueError(f'Invalid Mach-O architecture header: {path}')
            types.append(struct.unpack(THIN[slice_magic] + 'I', read_at(offset + 12, 4))[0])
        return tuple(types)


def macho_files(app):
    for path in sorted(Path(app).rglob('*')):
        if path.is_symlink() or not path.is_file():
            continue
        types = macho_types(path)
        if types:
            if MH_EXECUTE in types and any(kind != MH_EXECUTE for kind in types):
                raise ValueError(f'Mixed executable/library architectures: {path}')
            yield path, types


def library_signing_targets(app):
    """Sign library binaries first, then seal their containing framework bundles."""
    libraries = [path for path, types in macho_files(app) if MH_EXECUTE not in types]
    frameworks = [path for path in Path(app).rglob('*.framework')
                  if path.is_dir() and not path.is_symlink()]
    deepest_first = lambda path: (-len(path.parts), str(path))
    return sorted(libraries, key=deepest_first) + sorted(frameworks, key=deepest_first)
