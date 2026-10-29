# Third-party notices

`android/src/main/jniLibs` holds binaries from Termux's package repository,
renamed and with their dynamic-library names patched by `scripts/vendor-proot.py`.

| File                  | Package                    | License           | Source                                     |
| --------------------- | -------------------------- | ----------------- | ------------------------------------------ |
| `libproot.so`         | proot 5.1.107.101          | GPL-2.0-or-later  | https://github.com/termux/proot            |
| `libproot-loader.so`  | proot 5.1.107.101 (loader) | GPL-2.0-or-later  | https://github.com/termux/proot            |
| `libtalloc.so`        | libtalloc 2.5.0            | LGPL-3.0-or-later | https://www.samba.org/ftp/talloc/          |
| `libandroid-shmem.so` | libandroid-shmem 0.7       | BSD-3-Clause      | https://github.com/termux/libandroid-shmem |

Build recipes: https://github.com/termux/termux-packages (`packages/proot`,
`packages/libtalloc`, `packages/libandroid-shmem`).

The app runs proot as a separate program; nothing links it into the app.
