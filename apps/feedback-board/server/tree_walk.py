#!/usr/bin/env python3
"""Read an agent worktree using directory fds. Do not follow symlinks."""

import base64
import ctypes
import errno
import hashlib
import json
import os
import shutil
import stat
import sys
import unicodedata

CAP = 2 * 1024 * 1024
MAX_FILES = 200
ALLOWED = ("apps/thedailylumen/", "apps/feedback-board/")
META = {".gitattributes", ".gitmodules"}
OPEN_DIR = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
OPEN_FILE = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC


def fold(name):
    return unicodedata.normalize("NFC", name).lower()


def unsafe_name(name):
    if "\\" in name or "\n" in name or "\r" in name:
        return True
    for char in name:
        code = ord(char)
        if code < 32 or code == 127:
            return True
    return False


def allowed(rel):
    return rel.startswith(ALLOWED)


class Walk:
    def __init__(self):
        self.reason = None
        self.rank = -1
        self.blocked = []
        self.files = []
        self.outside = []
        self.allowed_count = 0

    def fail(self, rank, reason, rel):
        if rel and rel not in self.blocked:
            self.blocked.append(rel)
        if rank > self.rank:
            self.rank = rank
            self.reason = reason


def finish(walk):
    if walk.reason:
        sys.stdout.write(
            json.dumps({"ok": False, "reason": walk.reason, "blocked": walk.blocked})
        )
        return 0
    sys.stdout.write(
        json.dumps({"ok": True, "files": walk.files, "outside": walk.outside})
    )
    return 0


STATX_BTIME = 0x800
AT_EMPTY_PATH = 0x1000


class _StatxTimestamp(ctypes.Structure):
    _fields_ = [
        ("tv_sec", ctypes.c_int64),
        ("tv_nsec", ctypes.c_uint32),
        ("__reserved", ctypes.c_int32),
    ]


class _Statx(ctypes.Structure):
    _fields_ = [
        ("stx_mask", ctypes.c_uint32),
        ("stx_blksize", ctypes.c_uint32),
        ("stx_attributes", ctypes.c_uint64),
        ("stx_nlink", ctypes.c_uint32),
        ("stx_uid", ctypes.c_uint32),
        ("stx_gid", ctypes.c_uint32),
        ("stx_mode", ctypes.c_uint16),
        ("__spare0", ctypes.c_uint16),
        ("stx_ino", ctypes.c_uint64),
        ("stx_size", ctypes.c_uint64),
        ("stx_blocks", ctypes.c_uint64),
        ("stx_attributes_mask", ctypes.c_uint64),
        ("stx_atime", _StatxTimestamp),
        ("stx_btime", _StatxTimestamp),
        ("stx_ctime", _StatxTimestamp),
        ("stx_mtime", _StatxTimestamp),
        ("stx_rdev_major", ctypes.c_uint32),
        ("stx_rdev_minor", ctypes.c_uint32),
        ("stx_dev_major", ctypes.c_uint32),
        ("stx_dev_minor", ctypes.c_uint32),
    ]


def statx_birth(fd):
    libc = getattr(statx_birth, "libc", None)
    if libc is False:
        return None
    try:
        if libc is None:
            loaded = ctypes.CDLL(None, use_errno=True)
            if not hasattr(loaded, "statx"):
                statx_birth.libc = False
                return None
            loaded.statx.argtypes = [
                ctypes.c_int,
                ctypes.c_char_p,
                ctypes.c_int,
                ctypes.c_uint,
                ctypes.POINTER(_Statx),
            ]
            loaded.statx.restype = ctypes.c_int
            statx_birth.libc = loaded
            libc = loaded
        buf = _Statx()
        rc = libc.statx(fd, b"", AT_EMPTY_PATH, STATX_BTIME, ctypes.byref(buf))
    except (OSError, AttributeError):
        return None
    if rc != 0 or (buf.stx_mask & STATX_BTIME) == 0:
        return None
    return buf.stx_btime.tv_sec + (buf.stx_btime.tv_nsec / 1_000_000_000)


def file_birth(fd):
    st = os.fstat(fd)
    birth = getattr(st, "st_birthtime", None)
    if isinstance(birth, (int, float)) and birth > 0:
        return float(birth)
    return statx_birth(fd)


def provenance_ok(rel, data, st, birth, policy):
    if not policy:
        return True
    base = policy.get("base") or {}
    if base.get(rel) == hashlib.sha256(data).hexdigest():
        return True
    if f"{st.st_dev}:{st.st_ino}" in policy.get("inode_set", ()):
        return True
    spawn = policy.get("spawn")
    if birth is not None and isinstance(spawn, (int, float)) and birth >= float(spawn):
        return True
    return False


def read_regular(fd, walk, rel, policy):
    st = os.fstat(fd)
    if not stat.S_ISREG(st.st_mode):
        walk.fail(80, "Agent tree contains a socket, fifo, or device.", rel)
        return
    if st.st_nlink != 1:
        walk.fail(50, "Agent tree contains a hardlinked file.", rel)
        return
    if st.st_size > CAP:
        walk.fail(40, "Agent tree contains a file over the size cap.", rel)
        return
    if walk.allowed_count >= MAX_FILES:
        walk.fail(40, "Agent tree contains more than 200 files in the allowed folders.", rel)
        return
    data = b""
    while len(data) <= CAP:
        chunk = os.read(fd, min(1024 * 1024, CAP + 1 - len(data)))
        if not chunk:
            break
        data += chunk
    if len(data) > CAP:
        walk.fail(40, "Agent tree contains a file over the size cap.", rel)
        return
    again = os.fstat(fd)
    if (
        again.st_dev != st.st_dev
        or again.st_ino != st.st_ino
        or not stat.S_ISREG(again.st_mode)
        or again.st_nlink != 1
        or again.st_size > CAP
        or again.st_size != len(data)
    ):
        walk.fail(80, "Agent tree changed while it was being read.", rel)
        return
    birth = file_birth(fd)
    if not provenance_ok(rel, data, again, birth, policy):
        walk.fail(55, "Agent tree contains a file moved in from outside this run.", rel)
        return
    walk.allowed_count += 1
    if walk.reason:
        return
    walk.files.append({
        "rel": rel,
        "bytes": base64.b64encode(data).decode("ascii"),
        "dev": str(again.st_dev),
        "ino": str(again.st_ino),
        "birth": birth,
    })


def classify(parent_fd, name, rel, walk, at_root, policy):
    if unsafe_name(name) or unsafe_name(rel):
        walk.fail(60, "Agent tree contains an unsafe path name.", rel)
        return
    folded = fold(name)
    try:
        st = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    except OSError:
        walk.fail(10, "Could not read the agent tree.", rel)
        return
    if folded == ".git":
        if at_root and stat.S_ISREG(st.st_mode) and not stat.S_ISLNK(st.st_mode):
            return
        walk.fail(100, "Agent tree contains a .git file or directory.", rel)
        return
    if folded in META:
        walk.fail(70, "Agent tree contains .gitattributes or .gitmodules.", rel)
        return
    if stat.S_ISLNK(st.st_mode):
        walk.fail(90, "Agent tree contains a symlink.", rel)
        return
    if stat.S_ISDIR(st.st_mode):
        try:
            child = os.open(name, OPEN_DIR, dir_fd=parent_fd)
        except OSError as error:
            if error.errno in (errno.ELOOP, errno.ENOTDIR, errno.EPERM):
                walk.fail(90, "Agent tree contains a symlink.", rel)
            else:
                walk.fail(10, "Could not read the agent tree.", rel)
            return
        try:
            walk_fd(child, rel, walk, policy)
        finally:
            os.close(child)
        return
    if stat.S_ISFIFO(st.st_mode) or stat.S_ISSOCK(st.st_mode) or stat.S_ISCHR(st.st_mode) or stat.S_ISBLK(st.st_mode):
        walk.fail(80, "Agent tree contains a socket, fifo, or device.", rel)
        return
    if not stat.S_ISREG(st.st_mode):
        walk.fail(10, "Agent tree contains a file that is not a regular file.", rel)
        return
    if not allowed(rel):
        if st.st_size > CAP:
            walk.fail(40, "Agent tree contains a file over the size cap.", rel)
            return
        if st.st_nlink != 1:
            walk.fail(50, "Agent tree contains a hardlinked file.", rel)
            return
        walk.outside.append(rel)
        return
    try:
        fd = os.open(name, OPEN_FILE, dir_fd=parent_fd)
    except OSError as error:
        if error.errno in (errno.ELOOP, errno.EPERM):
            walk.fail(90, "Agent tree contains a symlink.", rel)
        elif error.errno == errno.ENXIO:
            walk.fail(80, "Agent tree contains a socket, fifo, or device.", rel)
        else:
            walk.fail(10, "Could not read the agent tree.", rel)
        return
    try:
        read_regular(fd, walk, rel, policy)
    finally:
        os.close(fd)


def walk_fd(dir_fd, rel_dir, walk, policy):
    try:
        entries = list(os.scandir(dir_fd))
    except OSError:
        walk.fail(10, "Could not read the agent tree.", rel_dir or ".")
        return
    entries.sort(key=lambda entry: (0 if fold(entry.name) == ".git" else 1, entry.name))
    for entry in entries:
        rel = f"{rel_dir}/{entry.name}" if rel_dir else entry.name
        classify(dir_fd, entry.name, rel, walk, at_root=rel_dir == "", policy=policy)


def load_policy(path):
    if not path:
        return None
    with open(path, "r", encoding="utf8") as handle:
        policy = json.load(handle)
    if not isinstance(policy, dict):
        return None
    policy["inode_set"] = set(policy.get("inodes") or [])
    return policy


def snapshot_fd(dir_fd, inodes):
    for entry in os.scandir(dir_fd):
        try:
            st = os.stat(entry.name, dir_fd=dir_fd, follow_symlinks=False)
        except OSError:
            continue
        if stat.S_ISLNK(st.st_mode):
            continue
        if stat.S_ISDIR(st.st_mode):
            try:
                child = os.open(entry.name, OPEN_DIR, dir_fd=dir_fd)
            except OSError:
                continue
            try:
                snapshot_fd(child, inodes)
            finally:
                os.close(child)
            continue
        if stat.S_ISREG(st.st_mode):
            inodes.append(f"{st.st_dev}:{st.st_ino}")


def snapshot_main(root):
    try:
        root_fd = os.open(root, OPEN_DIR)
    except OSError:
        sys.stdout.write(json.dumps({"ok": False, "reason": "Could not read the agent tree.", "inodes": []}))
        return 0
    inodes = []
    try:
        snapshot_fd(root_fd, inodes)
    finally:
        os.close(root_fd)
    sys.stdout.write(json.dumps({"ok": True, "inodes": inodes}))
    return 0


def remove_main(root):
    assert shutil.rmtree.avoids_symlink_attacks is True
    if not os.path.lexists(root):
        sys.stdout.write(json.dumps({"ok": True}))
        return 0
    try:
        info = os.lstat(root)
    except FileNotFoundError:
        sys.stdout.write(json.dumps({"ok": True}))
        return 0
    if stat.S_ISLNK(info.st_mode):
        os.unlink(root)
        sys.stdout.write(json.dumps({"ok": True}))
        return 0
    try:
        shutil.rmtree(root)
    except OSError:
        if os.path.islink(root):
            os.unlink(root)
            sys.stdout.write(json.dumps({"ok": True}))
            return 0
        sys.stdout.write(json.dumps({"ok": False, "reason": "Could not remove the agent tree."}))
        return 1
    sys.stdout.write(json.dumps({"ok": True}))
    return 0


def walk_main(root, policy_path):
    if not hasattr(os, "O_NOFOLLOW"):
        sys.stdout.write(json.dumps({"ok": False, "reason": "Could not read the agent tree.", "blocked": []}))
        return 1
    try:
        policy = load_policy(policy_path)
    except (OSError, json.JSONDecodeError):
        sys.stdout.write(json.dumps({"ok": False, "reason": "Could not read the agent tree.", "blocked": []}))
        return 0
    try:
        root_fd = os.open(root, OPEN_DIR)
    except OSError:
        sys.stdout.write(
            json.dumps({"ok": False, "reason": "Could not read the agent tree.", "blocked": [root]})
        )
        return 0
    walk = Walk()
    try:
        walk_fd(root_fd, "", walk, policy)
    finally:
        os.close(root_fd)
    return finish(walk)


def main():
    if len(sys.argv) == 2:
        return walk_main(sys.argv[1], None)
    if len(sys.argv) == 3 and sys.argv[1] == "snapshot":
        return snapshot_main(sys.argv[2])
    if len(sys.argv) == 3 and sys.argv[1] == "rmtree":
        return remove_main(sys.argv[2])
    if len(sys.argv) in (3, 4) and sys.argv[1] == "walk":
        return walk_main(sys.argv[2], sys.argv[3] if len(sys.argv) == 4 else None)
    sys.stdout.write(json.dumps({"ok": False, "reason": "Could not read the agent tree.", "blocked": []}))
    return 1


if __name__ == "__main__":
    sys.exit(main())
