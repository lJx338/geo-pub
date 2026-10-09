from pathlib import Path
import struct
import tempfile
import unittest

from mas_macho import MH_EXECUTE, library_signing_targets, macho_files, macho_types


def thin(kind, endian='<'):
    return struct.pack(endian + '8I', 0xfeedfacf, 0x100000c, 0, kind, 0, 0, 0, 0)


def universal(kinds, wide=False, endian='>'):
    entry_size = 32 if wide else 20
    offset = 8 + len(kinds) * entry_size
    header = struct.pack(endian + '2I', 0xcafebabf if wide else 0xcafebabe, len(kinds))
    entries = b''
    for index, kind in enumerate(kinds):
        values = [0x100000c + index, 0, offset + 32 * index, 32, 0]
        if wide:
            values.append(0)
        entries += struct.pack(endian + ('IIQQII' if wide else '5I'), *values)
    return header + entries + b''.join(thin(kind) for kind in kinds)


class MachOTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)

    def file(self, relative, content):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
        return path

    def test_identifies_extensionless_libraries_and_executables(self):
        for endian in ('<', '>'):
            for kind in (MH_EXECUTE, 6, 8):
                with self.subTest(endian=endian, kind=kind):
                    self.assertEqual(macho_types(self.file('binary', thin(kind, endian))), (kind,))

    def test_checks_all_architectures_in_32_and_64_bit_fat_headers(self):
        for wide in (False, True):
            for endian in ('<', '>'):
                with self.subTest(wide=wide, endian=endian):
                    path = self.file('universal', universal([6, 6], wide, endian))
                    self.assertEqual(macho_types(path), (6, 6))

    def test_ignores_regular_resources(self):
        for content in (b'', b'x', b'<?xml version="1.0"?>', b'\x89PNG\r\n\x1a\n'):
            self.assertEqual(macho_types(self.file('resource', content)), ())

    def test_rejects_truncated_macho_instead_of_skipping_it(self):
        for content in (thin(6)[:8], universal([6])[:-20]):
            with self.assertRaisesRegex(ValueError, 'Truncated'):
                macho_types(self.file('truncated', content))

    def test_rejects_mixed_library_and_executable_architectures(self):
        self.file('Mixed.app/mixed', universal([MH_EXECUTE, 6]))
        with self.assertRaisesRegex(ValueError, 'Mixed executable/library'):
            list(macho_files(self.root / 'Mixed.app'))

    def test_signs_libraries_before_frameworks_and_preserves_helper_entitlements(self):
        app = self.root / 'Example.app'
        framework = app / 'Contents/Frameworks/Electron Framework.framework'
        library = self.file('Example.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework', thin(6))
        dylib = self.file('Example.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/libffmpeg.dylib', thin(6))
        main = self.file('Example.app/Contents/MacOS/Example', thin(MH_EXECUTE))
        helper = self.file('Example.app/Contents/Frameworks/Example Helper.app/Contents/MacOS/Example Helper', thin(MH_EXECUTE))
        cli = self.file('Example.app/Contents/Resources/cli/tool', thin(MH_EXECUTE))
        self.file('Example.app/Contents/Resources/icon.png', b'\x89PNG')
        targets = library_signing_targets(app)
        self.assertEqual(set(targets), {library, dylib, framework})
        self.assertLess(targets.index(dylib), targets.index(framework))
        self.assertLess(targets.index(library), targets.index(framework))
        for executable in (main, helper, cli):
            self.assertNotIn(executable, targets)


if __name__ == '__main__':
    unittest.main()
