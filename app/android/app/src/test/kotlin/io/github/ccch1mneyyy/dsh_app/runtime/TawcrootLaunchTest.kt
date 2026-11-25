package io.github.ccch1mneyyy.dsh_app.runtime

import java.io.File
import java.nio.file.Files
import org.junit.Assert.*
import org.junit.Test

class TawcrootLaunchTest {
    private val runtime = "/data/user/0/io.github.ccch1mneyyy.dsh_app/files/runtime"
    private val root = "$runtime/rootfs"
    private val native = "/data/app/x/lib/arm64"
    private val command = "echo \$\$ > /tmp/dsh-web.pid; exec /usr/local/bin/dsh web --host 127.0.0.1 --port 3080 --no-open"

    private val fixedBinds = listOf(
        "/dev", "/dev/urandom:/dev/random", "/proc", "/proc/self/fd:/dev/fd",
        "/proc/self/fd/0:/dev/stdin", "/proc/self/fd/1:/dev/stdout", "/proc/self/fd/2:/dev/stderr",
        "/sys", "$root/var/lib/dsh-app/empty:/sys/fs/selinux",
        "$root/var/lib/dsh-app/shm:/dev/shm", "/system", "/apex",
    )
    private val guest = listOf("/usr/bin/env", "-i", "HOME=/root", "EMPTY=", "TZ=Asia/Shanghai", "/bin/sh", "-c", command)

    private fun proot(binds: List<String> = fixedBinds, tail: List<String> = guest) = listOf(
        "$native/libproot.so", "--kill-on-exit", "--link2symlink", "--sysvipc", "-L", "-0", "--rootfs=$root", "--cwd=/root",
    ) + binds.flatMap { listOf("-b", it) } + tail

    private val hostEnv = linkedMapOf(
        "PATH" to "/system/bin:/system/xbin", "HOME" to "/files", "PROOT_TMP_DIR" to "/tmp",
        "PROOT_LOADER" to "$native/libproot-loader.so", "PROOT_L2S_DIR" to "$root/root/.l2s", "LD_LIBRARY_PATH" to native,
    )

    @Test fun theRuntimeTemplateMapsOntoTawcroot() {
        val plan = TawcrootLaunch.prepare(root, native, proot(), hostEnv)
        assertEquals(listOf(
            "$native/libtawcroot.so", "-s", "-r", root,
            "-b", "$runtime/dev-view:/dev", "-b", "/proc:/proc", "-b", "/sys:/sys",
            "-b", "$root/var/lib/dsh-app/empty:/sys/fs/selinux", "-b", "$root/var/lib/dsh-app/shm:/dev/shm",
            "-b", "/system:/system", "-b", "/apex:/apex", "--",
        ) + guest, plan.argv)
        assertEquals("$root/root", plan.cwd)
        assertEquals(mapOf("PATH" to "/system/bin:/system/xbin", "HOME" to "/files"), plan.environment)
        assertEquals("$runtime/dev-view", plan.devView.directory)
        for ((name, target) in mapOf("random" to "/dev/urandom", "fd" to "/proc/self/fd", "stdin" to "/proc/self/fd/0",
                "stdout" to "/proc/self/fd/1", "stderr" to "/proc/self/fd/2")) {
            assertEquals(target, plan.devView.links[name])
        }
    }

    @Test fun phoneStorageAndTheRootfsAliasPassThrough() {
        val binds = fixedBinds + listOf("/storage/emulated/0:/sdcard", "/storage", "$root:$root")
        val plan = TawcrootLaunch.prepare(root, native, proot(binds), hostEnv)
        val before = plan.argv.takeWhile { it != "--" }
        assertTrue(before.containsAll(listOf("/storage/emulated/0:/sdcard", "/storage:/storage", "$root:$root")))
    }

    @Test fun anythingElseStaysOnProot() {
        val cases = listOf(
            proot(fixedBinds + "/data/other:/mnt"),
            proot(fixedBinds.drop(1)),
            proot(fixedBinds + "/dev"),
            proot(tail = listOf("/bin/sh", "-c", command)),
            listOf("$native/libproot.so", "--rootfs=$root") + guest,
        )
        for (argv in cases) {
            assertThrows(TawcrootLaunch.Unsupported::class.java) { TawcrootLaunch.prepare(root, native, argv, hostEnv) }
        }
        assertThrows(TawcrootLaunch.Unsupported::class.java) { TawcrootLaunch.prepare("/rootfs", native, proot(), hostEnv) }
    }

    @Test fun availabilityNeedsTheLibraryAndApi29() {
        val dir = kotlin.io.path.createTempDirectory("tawc-lib").toFile()
        try {
            assertEquals(TawcrootLaunch.API_TOO_OLD, TawcrootLaunch.unavailable(dir.path, 28))
            assertEquals(TawcrootLaunch.NOT_BUNDLED, TawcrootLaunch.unavailable(dir.path, 36))
            File(dir, TawcrootLaunch.LIBRARY).writeText("elf")
            assertNull(TawcrootLaunch.unavailable(dir.path, 36))
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test fun devViewLinksAreRewritten() {
        val dir = kotlin.io.path.createTempDirectory("tawc-dev").toFile()
        try {
            val view = TawcrootLaunch.DevView(File(dir, "dev-view").path, mapOf("fd" to "/proc/self/fd", "null" to "/dev/null"))
            TawcrootLaunch.writeDevView(view)
            TawcrootLaunch.writeDevView(view)
            assertEquals("/proc/self/fd", Files.readSymbolicLink(File(dir, "dev-view/fd").toPath()).toString())
            assertEquals("/dev/null", Files.readSymbolicLink(File(dir, "dev-view/null").toPath()).toString())
        } finally {
            dir.deleteRecursively()
        }
    }
}
