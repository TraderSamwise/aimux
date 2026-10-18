#!/usr/bin/env python3
import argparse
from pathlib import Path
import struct
import sys


class InvalidElf(ValueError):
    pass


def require(condition, cause):
    if not condition:
        raise InvalidElf(cause)


class Elf:
    def __init__(self, data, arch):
        self.data = data
        self.loads = []
        self.span(0, 64, "ELF header")
        ident = data[:16]
        require(ident[:4] == b"\x7fELF", "not an ELF binary")
        require(ident[4] == 2, "expected ELF64")
        require(ident[5] == 1, "expected little-endian ELF")
        require(ident[6] == 1, "invalid ELF identification version")
        require(ident[7] in (0, 3), "expected Linux/System V ELF ABI")
        header = self.unpack("HHIQQQIHHHHHH", 16, "ELF header")
        kind, machine, version, _, self.phoff, self.shoff, _, size, self.phsize, self.phnum, self.shsize, self.shnum, names = header
        require(kind in (2, 3), "expected executable or static PIE ELF type")
        require(machine == {"x64": 62, "arm64": 183}[arch], f"wrong ELF machine {machine} for {arch}")
        require(version == 1 and size == 64, "invalid ELF header version or size")
        require(0 < self.phnum < 0xFFFF and self.phsize == 56, "invalid or unsupported program header table")
        self.span(self.phoff, self.phnum * self.phsize, "program header table")
        require(self.phoff >= 64, "program header table overlaps ELF header")
        require(self.shnum != 0 or self.shoff == 0, "unsupported extended section counts")
        if self.shnum:
            require(self.shoff >= 64 and self.shsize == 64, "invalid section header table")
            require(names == 0 or names < self.shnum, "invalid section name table index")
            self.span(self.shoff, self.shnum * self.shsize, "section header table")
        else:
            require(names == 0, "section names without section headers")

    def span(self, offset, size, label):
        require(0 <= offset <= len(self.data) and 0 <= size <= len(self.data) - offset, f"{label} outside binary bounds")

    def unpack(self, fmt, offset, label):
        self.span(offset, struct.calcsize("<" + fmt), label)
        return struct.unpack_from("<" + fmt, self.data, offset)

    def string(self, table, index, label):
        offset, size = table
        require(index < size, f"{label} string index outside string table")
        end = self.data.find(b"\0", offset + index, offset + size)
        require(end >= 0, f"unterminated {label} string")
        return self.data[offset + index:end]

    def virtual(self, address, size, label):
        matches = []
        for virtual, offset, length in self.loads:
            if address >= virtual and address - virtual < length and size <= length - (address - virtual):
                matches.append((offset + address - virtual, length - (address - virtual)))
        require(len(set(matches)) == 1, f"{label} has no unique file-backed PT_LOAD mapping")
        return matches[0]

    def versions(self, offset, size, count, strings, label):
        require(0 < count <= size // 16, f"invalid {label} version requirement count")
        self.span(offset, size, label)
        cursor = 0
        for number in range(count):
            require(cursor + 16 <= size, f"truncated {label} version requirement")
            version, auxiliaries, filename, auxiliary, following = self.unpack("HHIII", offset + cursor, label)
            require(version == 1 and auxiliaries > 0, f"invalid {label} version requirement header")
            self.string(strings, filename, label)
            require(auxiliary >= 16, f"invalid {label} auxiliary offset")
            aux = cursor + auxiliary
            for index in range(auxiliaries):
                require(aux + 16 <= size, f"truncated {label} version auxiliary")
                _, _, _, name, next_aux = self.unpack("IHHII", offset + aux, label)
                imported = self.string(strings, name, label)
                require(not imported.startswith(b"GLIBC_"), f"imported GLIBC version {imported.decode('ascii', errors='replace')}")
                if index + 1 < auxiliaries:
                    require(next_aux >= 16, f"invalid {label} auxiliary chain")
                    aux += next_aux
                else:
                    require(next_aux == 0, f"invalid {label} auxiliary count")
            if number + 1 < count:
                require(following >= 16, f"invalid {label} version chain")
                cursor += following
            else:
                require(following == 0, f"invalid {label} version requirement count")

    def verify(self):
        dynamics = []
        for index in range(self.phnum):
            kind, _, offset, address, _, filesz, memsz, alignment = self.unpack("IIQQQQQQ", self.phoff + index * 56, "program header")
            self.span(offset, filesz, "program segment")
            require(alignment in (0, 1) or alignment & (alignment - 1) == 0, "invalid program segment alignment")
            require(kind != 3, "PT_INTERP requires an external dynamic loader")
            if kind == 1:
                require(filesz <= memsz, "PT_LOAD file size exceeds memory size")
                require(alignment <= 1 or address % alignment == offset % alignment, "misaligned PT_LOAD segment")
                self.loads.append((address, offset, filesz))
            if kind == 2:
                require(filesz > 0 and filesz % 16 == 0, "invalid PT_DYNAMIC size")
                dynamics.append((offset, filesz))
        require(self.loads, "no PT_LOAD segments")
        require(len(dynamics) <= 1, "multiple PT_DYNAMIC segments")
        for offset, size in dynamics:
            tags = {}
            terminated = False
            for entry in range(offset, offset + size, 16):
                tag, value = self.unpack("qQ", entry, "dynamic entry")
                if tag == 0:
                    terminated = True
                    break
                require(tag != 1, "DT_NEEDED requires an external shared library")
                if tag in (5, 10, 0x6FFFFFFE, 0x6FFFFFFF):
                    require(tag not in tags, f"duplicate dynamic tag {tag:#x}")
                    tags[tag] = value
            require(terminated, "unterminated PT_DYNAMIC table")
            if 0x6FFFFFFE in tags or 0x6FFFFFFF in tags:
                require(all(tag in tags for tag in (5, 10, 0x6FFFFFFE, 0x6FFFFFFF)), "incomplete dynamic version requirement metadata")
                string_offset, _ = self.virtual(tags[5], tags[10], "dynamic string table")
                version_offset, remaining = self.virtual(tags[0x6FFFFFFE], 16, "dynamic version requirements")
                self.versions(version_offset, remaining, tags[0x6FFFFFFF], (string_offset, tags[10]), "dynamic")
        sections = []
        for index in range(self.shnum):
            section = self.unpack("IIQQQQIIQQ", self.shoff + index * 64, "section header")
            _, kind, _, _, offset, size, _, _, alignment, _ = section
            require(alignment in (0, 1) or alignment & (alignment - 1) == 0, "invalid section alignment")
            if kind != 8:
                self.span(offset, size, "section data")
            sections.append(section)
        for section in sections:
            _, kind, _, _, offset, size, link, count, _, _ = section
            if kind == 0x6FFFFFFE:
                require(link < len(sections) and sections[link][1] == 3, "version requirements missing linked string table")
                strings = sections[link]
                self.versions(offset, size, count, (strings[4], strings[5]), "section")


def verify_binary(path, arch):
    Elf(Path(path).read_bytes(), arch).verify()


def main():
    parser = argparse.ArgumentParser(description="Verify a self-contained Linux ELF64 release binary")
    parser.add_argument("binary")
    parser.add_argument("arch", choices=("x64", "arm64"))
    args = parser.parse_args()
    try:
        verify_binary(args.binary, args.arch)
    except (OSError, InvalidElf, struct.error) as error:
        print(f"Linux binary verification failed: {args.binary} ({args.arch}): {error}", file=sys.stderr)
        return 1
    print(f"Verified Linux binary: {args.binary} ({args.arch}), ELF64 without external loader, shared libraries, or GLIBC imports")
    return 0


if __name__ == "__main__":
    sys.exit(main())
