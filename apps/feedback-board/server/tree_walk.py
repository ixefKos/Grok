#!/usr/bin/env python3
"""Read an agent worktree using directory fds. Do not follow symlinks."""

import base64
import errno
import json
import os
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


def read_regular(fd, walk, rel):
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
    walk.allowed_count += 1
    if walk.reason:
        return
    walk.files.append({"rel": rel, "bytes": base64.b64encode(data).decode("ascii")})


def classify(parent_fd, name, rel, walk, at_root):
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
            walk_fd(child, rel, walk)
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
        read_regular(fd, walk, rel)
    finally:
        os.close(fd)


def walk_fd(dir_fd, rel_dir, walk):
    try:
        entries = list(os.scandir(dir_fd))
    except OSError:
        walk.fail(10, "Could not read the agent tree.", rel_dir or ".")
        return
    entries.sort(key=lambda entry: (0 if fold(entry.name) == ".git" else 1, entry.name))
    for entry in entries:
        rel = f"{rel_dir}/{entry.name}" if rel_dir else entry.name
        classify(dir_fd, entry.name, rel, walk, at_root=rel_dir == "")


def main():
    if len(sys.argv) != 2:
        sys.stdout.write(json.dumps({"ok": False, "reason": "Could not read the agent tree.", "blocked": []}))
        return 1
    if not hasattr(os, "O_NOFOLLOW"):
        sys.stdout.write(json.dumps({"ok": False, "reason": "Could not read the agent tree.", "blocked": []}))
        return 1
    root = sys.argv[1]
    try:
        root_fd = os.open(root, OPEN_DIR)
    except OSError:
        sys.stdout.write(
            json.dumps({"ok": False, "reason": "Could not read the agent tree.", "blocked": [root]})
        )
        return 0
    walk = Walk()
    try:
        walk_fd(root_fd, "", walk)
    finally:
        os.close(root_fd)
    return finish(walk)


if __name__ == "__main__":
    sys.exit(main())
