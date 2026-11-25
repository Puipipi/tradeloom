package io.github.ccch1mneyyy.dsh_app.runtime

import java.io.File
import java.io.RandomAccessFile
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.StandardCopyOption
import java.nio.file.NoSuchFileException
import java.nio.file.attribute.BasicFileAttributes

/** Explicit glibc loader launch; no ELF or user-profile mutation. Pure JVM/testable. */
object DirectLaunch {
    const val PRELOAD = "opt/dsh-go/direct/preload.mjs"
    /** PRoot's Node gets Direct's per-family DNS resolver through this import (runtime/direct/proot-dns.mjs). */
    const val PROOT_DNS = "/opt/dsh-go/direct/proot-dns.mjs"
    private const val OWNED = "opt/dsh-app/direct"

    /** Fallback reason: Direct already failed to launch here with this runtime. */
    const val FAILED = "directFailed"
    /** Fallback reasons around PRoot's fake hard links: still there; no room or an error tidying them ([L2sMigration]). */
    const val INCOMPATIBLE = "incompatibleFiles"
    const val NOT_ENOUGH_SPACE = "notEnoughSpace"
    const val MIGRATION_FAILED = "migrationFailed"

    data class Plan(val argv: List<String>, val environment: Map<String, String>, val cwd: File)
    data class Selection(val direct: Boolean, val fallbackReason: String? = null)
    data class Mount(val host: String, val guest: String)

    /**
     * The saved launch method. [saved] is the user's explicit choice (null until they make one);
     * [failedRuntime] the runtime version Direct last failed to launch with.
     */
    data class Preference(val saved: Boolean?, val available: Boolean, val failedRuntime: String?, val runtime: String?) {
        /** Off until the user turns it on: Android's seccomp filter kills glibc's loader on some
         * phones (Android 16, x86_64), so Direct stays opt-in for now. */
        val requested: Boolean get() = (saved ?: false) && available
        /** Compatible launch until the runtime changes or the user turns Direct on again. */
        val failed: Boolean get() = failedRuntime != null && failedRuntime == runtime
        /** What the switch shows: whether the next normal start tries Direct. */
        val enabled: Boolean get() = requested && !failed
    }

    /** Only mounts in the final launch authorize a host path (not a fixed /sdcard allowlist). */
    fun mounts(argv: List<String>, root: String): List<Mount> {
        val found = linkedMapOf<String, Mount>()
        var at = 0
        while (at < argv.size) {
            val arg = argv[at++]
            val value = when {
                arg == "-b" || arg == "--bind" -> argv.getOrNull(at++) ?: error("direct engine: missing bind value")
                arg.startsWith("--bind=") -> arg.substringAfter('=')
                else -> continue
            }
            val parts = value.split(':')
            require(parts.size in 1..2 && parts.all { File(it).isAbsolute }) { "direct engine: unsupported bind" }
            val host = parts[0].trimEnd('/').ifEmpty { "/" }
            val guest = parts.getOrElse(1) { parts[0] }.trimEnd('/').ifEmpty { "/" }
            if (host == root && guest == root) continue
            require(guest != "/") { "direct engine: root-overriding bind is unsupported" }
            found[guest] = Mount(host, guest)
        }
        return found.values.sortedByDescending { it.guest.length }
    }

    fun select(rootfs: File, requested: Boolean, safe: Boolean, failed: Boolean = false): Selection {
        if (!requested || safe) return Selection(false)
        if (failed) return Selection(false, FAILED)
        val reason = compatibilityReason(rootfs)
        return Selection(reason == null, reason)
    }

    /** NODE_OPTIONS for a PRoot launch: the caller's flags (heap, DNS order) plus [PROOT_DNS]. */
    fun prootNodeOptions(nodeOptions: String?): String =
        listOfNotNull(nodeOptions?.ifEmpty { null }, "--import=$PROOT_DNS").joinToString(" ")

    fun loaderPath(abi: String): String = when (abi) {
        "arm64-v8a" -> "usr/lib/aarch64-linux-gnu/ld-linux-aarch64.so.1"
        "x86_64" -> "usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2"
        else -> error("direct engine: unsupported ABI $abi")
    }

    fun unavailable(rootfs: File, abi: String): String? = when {
        abi !in setOf("arm64-v8a", "x86_64") -> "unsupportedAbi"
        !File(rootfs, PRELOAD).isFile || !File(rootfs, "opt/dsh-go/direct/dns.mjs").isFile ||
            !File(rootfs, "opt/dsh-go/direct/modules.mjs").isFile ||
            !File(rootfs, "opt/dsh-go/direct/native-addons.json").isFile -> "runtimeUpdateRequired"
        !File(rootfs, loaderPath(abi)).canExecute() || !File(rootfs, "opt/node/bin/node").canExecute() -> "runtimeIncomplete"
        else -> null
    }

    /** Locked DSH addons use these directories for native dependencies. Loading
     * the addon itself through a verified FD cannot retain its original $ORIGIN.
     * Never add user profile directories to the process-wide library search. */
    fun libraryDirectories(abi: String): List<String> {
        loaderPath(abi) // reject an unknown ABI before choosing any package name
        val triplet = if (abi == "x86_64") "x86_64-linux-gnu" else "aarch64-linux-gnu"
        val arch = if (abi == "x86_64") "x64" else "arm64"
        return listOf("usr/lib/$triplet", "lib/$triplet", "usr/lib", "lib",
            "opt/dsh/node_modules/@img/sharp-libvips-linux-$arch/lib",
            "opt/dsh/node_modules/sherpa-onnx-linux-$arch")
    }

    /**
     * PRoot's fake hard links need its lstat/rename/link-count semantics; a
     * Direct start turns them into real files first ([L2sMigration]) rather
     * than broadening the filesystem sandbox. Recheck immediately before spawn;
     * an unreadable backing store is unknown, not evidence that direct
     * execution is compatible.
     */
    fun compatibilityReason(rootfs: File): String? = try {
        val backing = File(rootfs, "root/.l2s").toPath()
        val attributes = Files.readAttributes(backing, BasicFileAttributes::class.java, LinkOption.NOFOLLOW_LINKS)
        if (!attributes.isDirectory) INCOMPATIBLE
        else Files.newDirectoryStream(backing).use { if (it.iterator().hasNext()) INCOMPATIBLE else null }
    } catch (_: NoSuchFileException) { null }
    catch (_: Exception) { INCOMPATIBLE }

    /** Physical cwd/links from an opted-in direct run remain readable on rollback. */
    fun samePathBind(rootfs: File): String {
        val path = rootfs.canonicalPath
        require(':' !in path && '\n' !in path && '\u0000' !in path) { "direct engine: invalid rootfs path" }
        return "$path:$path"
    }

    private const val ALIAS_MARKER = ".dsh-go-direct-path-alias"

    private fun hasGeneratedConfig(rootfs: File): Boolean =
        listOf("opt", "opt/dsh-app", OWNED).all {
            Files.isDirectory(File(rootfs, it).toPath(), LinkOption.NOFOLLOW_LINKS)
        } && Files.isRegularFile(File(rootfs, "$OWNED/config.json").toPath(), LinkOption.NOFOLLOW_LINKS)

    private fun markerText(rootfs: File) = "v1\n${rootfs.canonicalPath}\n"

    private fun hasAliasMarker(rootfs: File, home: File = File(rootfs, "root")): Boolean = runCatching {
        val marker = File(home, ALIAS_MARKER)
        Files.isDirectory(home.toPath(), LinkOption.NOFOLLOW_LINKS) &&
            Files.isRegularFile(marker.toPath(), LinkOption.NOFOLLOW_LINKS) &&
            marker.length() <= 4096 && marker.readText() == markerText(rootfs)
    }.getOrDefault(false)

    /** Keep only the path-compatibility fact with /root, which survives archive
     * replacement. Also recognizes an R3 configuration before its /opt is lost.
     * This marker is not account, permission or process-ownership evidence. */
    fun preservePhysicalAlias(rootfs: File, home: File = File(rootfs, "root"), retiredRootfs: File? = null) {
        if (!hasGeneratedConfig(rootfs) && retiredRootfs?.let(::hasGeneratedConfig) != true &&
            !hasAliasMarker(rootfs, home)) return
        if (!home.exists() && !Files.isSymbolicLink(home.toPath())) return
        check(Files.isDirectory(home.toPath(), LinkOption.NOFOLLOW_LINKS)) { "direct engine: cannot preserve paths through a symlinked home" }
        write(File(home, ALIAS_MARKER), markerText(rootfs))
    }

    /** Fresh default-mode installs do not need the physical alias. An App-owned
     * direct configuration or carried marker records a prior preparation that
     * may have persisted physical paths; retain its alias without migrating data.
     * Only remove this exact legacy bind, and only before the guest command. */
    fun prootArguments(rootfs: File, argv: List<String>, direct: Boolean): List<String> {
        val envAt = argv.indexOf("/usr/bin/env")
        if (envAt < 1) return argv
        val same = samePathBind(rootfs)
        val aliases = setOf(same, "{ROOTFS}:{ROOTFS}")
        val configured = hasGeneratedConfig(rootfs) || hasAliasMarker(rootfs)
        val result = ArrayList<String>()
        var at = 0
        while (at < envAt) {
            val arg = argv[at]
            if ((arg == "-b" || arg == "--bind") && at + 1 < envAt && argv[at + 1] in aliases) {
                at += 2
                continue
            }
            if (arg.startsWith("--bind=") && arg.substringAfter('=') in aliases) {
                at++
                continue
            }
            result += arg
            at++
        }
        if (direct || configured) result.addAll(listOf("-b", same))
        result.addAll(argv.drop(envAt))
        return result
    }

    /** Reject an unknown future shell template rather than interpreting shell syntax ourselves. */
    fun webArguments(command: String): List<String> {
        val prefix = "echo \$\$ > /tmp/dsh-web.pid; exec /usr/local/bin/dsh "
        require(command.startsWith(prefix)) { "direct engine: unsupported launch template" }
        val text = command.removePrefix(prefix)
        require(Regex("[A-Za-z0-9_./ :\\-]+").matches(text)) { "direct engine: unsupported launch syntax" }
        val args = text.trim().split(Regex(" +"))
        require(args.firstOrNull() == "web") { "direct engine: only the web profile can run directly" }
        var i = 1
        var port = false
        var host = false
        while (i < args.size) {
            when (args[i]) {
                "--no-open" -> i++
                "--patch" -> {
                    require(i + 1 < args.size && args[i + 1].startsWith('/')) { "direct engine: invalid patch argument" }
                    i += 2
                }
                "--host" -> {
                    require(!host && args.getOrNull(i + 1) == "127.0.0.1") { "direct engine: loopback host required" }
                    host = true; i += 2
                }
                "--port" -> {
                    require(!port && args.getOrNull(i + 1)?.toIntOrNull() in 1..65535) { "direct engine: invalid port" }
                    port = true; i += 2
                }
                else -> throw IllegalArgumentException("direct engine: unsupported web flag ${args[i]}")
            }
        }
        require(port && host) { "direct engine: host and port required" }
        return args
    }

    fun quote(value: String): String {
        require('\u0000' !in value && '\n' !in value && '\r' !in value) { "direct engine: invalid shell argument" }
        return "'" + value.replace("'", "'\\''") + "'"
    }

    /**
     * Consume the one fully expanded proot argv/env: overlays, performance defaults,
     * and explicit caller settings have already been composed by DshProcess.
     * hostShell is /system/bin/sh on Android and /bin/sh only in the host harness.
     */
    fun prepare(rootfs: File, abi: String, argv: List<String>, hostEnv: Map<String, String>, hostShell: String = "/system/bin/sh"): Plan {
        check(unavailable(rootfs, abi) == null) { "direct engine: ${unavailable(rootfs, abi)}" }
        check(compatibilityReason(rootfs) == null) { "direct engine: proot hard-link backing files require compatible launch" }
        val root = rootfs.canonicalFile
        val rootPath = root.path
        val envAt = argv.indexOf("/usr/bin/env")
        require(envAt > 0 && argv.getOrNull(envAt + 1) == "-i") { "direct engine: missing guest environment" }
        val guest = linkedMapOf<String, String>()
        var i = envAt + 2
        while (i < argv.size && argv[i].contains('=')) {
            val pair = argv[i++].split('=', limit = 2)
            require(Regex("[A-Za-z_][A-Za-z0-9_]*").matches(pair[0])) { "direct engine: invalid environment name" }
            guest[pair[0]] = pair[1]
        }
        require(argv.drop(i).take(2) == listOf("/bin/sh", "-c") && argv.size == i + 3) { "direct engine: unsupported guest command" }
        val web = webArguments(argv.last()).toMutableList()
        for (at in 1 until web.lastIndex) if (web[at] == "--patch") web[at + 1] = rootPath + web[at + 1]

        val loader = File(root, loaderPath(abi)).path
        val libraries = libraryDirectories(abi).joinToString(":") { File(root, it).path }
        val node = File(root, "opt/node/bin/node").path
        val preload = File(root, PRELOAD).path
        val owned = File(root, OWNED)
        // These are App-owned generated files, never a user profile or configuration.
        for (relative in listOf("opt", "opt/dsh-app", OWNED, "$OWNED/bin")) {
            val dir = File(root, relative)
            require(!Files.isSymbolicLink(dir.toPath())) { "direct engine: generated directory is a symlink" }
            check(dir.isDirectory || dir.mkdir()) { "direct engine: cannot create $relative" }
        }
        val bin = File(owned, "bin").path
        val guestPath = guest["PATH"] ?: "/usr/local/bin:/usr/bin:/bin"
        val proot = argv.take(envAt).filterNot { it.startsWith("--cwd=") }.toMutableList()
        val sameBind = samePathBind(root)
        if (!proot.contains(sameBind)) proot.addAll(listOf("-b", sameBind))
        val mounts = mounts(proot, rootPath)
        val prefix = buildString {
            append("#!$hostShell\nset -e\n")
            append("unset DSH_GO_DIRECT_MAIN DSH_GO_DIRECT_ROOTFS LD_PRELOAD\n")
            append("export DSH_GO_RUNTIME_ROOT=${quote(rootPath)}\n")
            append("guest_path=${quote(guestPath)}\n")
            append("if [ \"\${DSH_GO_GUEST_PATH+x}\" = x ]; then guest_path=\"\$DSH_GO_GUEST_PATH\"; fi\n")
            for (key in listOf("LD_LIBRARY_PATH", "PROOT_LOADER", "PROOT_TMP_DIR", "PROOT_L2S_DIR")) {
                hostEnv[key]?.let { append("export $key=${quote(it)}\n") }
            }
            append("exec ")
            append(proot.joinToString(" ", transform = ::quote))
            append(" --cwd=\"\$(pwd -P)\" /usr/bin/env -u LD_LIBRARY_PATH -u LD_PRELOAD -u PROOT_LOADER -u PROOT_TMP_DIR -u PROOT_L2S_DIR -u DSH_GO_GUEST_PATH ")
            append("\"PATH=\$guest_path\"")
            append(" 'SHELL=/bin/bash' 'TMPDIR=/tmp' \"\$@\"\n")
        }
        write(File(bin, "guest"), prefix, executable = true)
        for (shell in listOf("sh", "bash")) write(File(bin, shell), "#!$hostShell\nexec ${quote("$bin/guest")} ${quote("/bin/$shell")} \"\$@\"\n", true)
        val nodeScript = "#!$hostShell\nunset DSH_GO_DIRECT_MAIN\n" +
            "if [ -z \"\${HOME:-}\" ]; then export HOME=${quote("$rootPath/root")}; fi\n" +
            "if [ -z \"\${TMPDIR:-}\" ]; then export TMPDIR=${quote("$rootPath/tmp")}; fi\n" +
            "export DSH_GO_RUNTIME_ROOT=${quote(rootPath)} DSH_GO_DIRECT_ROOTFS=${quote(rootPath)}\nexec ${quote(loader)} --library-path ${quote(libraries)} ${quote(node)} ${quote("--import=$preload")} \"\$@\"\n"
        write(File(bin, "node"), nodeScript, true)
        for (name in listOf("pnpm", "pnpx")) write(File(bin, name),
            "#!$hostShell\nexport pnpm_config_package_import_method=copy npm_config_package_import_method=copy\nexec ${quote("$bin/node")} ${quote("$rootPath/usr/local/lib/node_modules/pnpm/bin/$name.mjs")} \"\$@\"\n", true)

        val rgArch = if (abi == "x86_64") "x64" else "arm64"
        val rg = File(root, "opt/dsh/node_modules/@vscode/ripgrep-linux-$rgArch/bin/rg")
        require(rg.isFile) { "direct engine: packaged ripgrep missing" }
        // The manifest records this per ABI; the current pinned binaries are
        // static PIE. The host test audits PT_INTERP, rather than guessing by name.
        val dynamic = elfHasInterpreter(rg)
        val values = linkedMapOf("rootfs" to rootPath, "bin" to bin, "loader" to loader, "libraryPath" to libraries,
            "node" to node, "hostShell" to hostShell)
        val config = "{\"schema\":2," + values.entries.joinToString(",") { json(it.key) + ":" + json(it.value) } +
            ",\"mounts\":[" + mounts.joinToString(",") { "{\"host\":" + json(it.host) + ",\"guest\":" + json(it.guest) + "}" } + "]" +
            ",\"ripgrep\":{\"path\":" + json(rg.path) + ",\"dynamic\":$dynamic}}\n"
        write(File(owned, "config.json"), config)
        preservePhysicalAlias(root)

        val directEnv = LinkedHashMap(hostEnv)
        directEnv.keys.removeAll { it.startsWith("PROOT_") || it == "LD_LIBRARY_PATH" || it == "LD_PRELOAD" }
        directEnv.putAll(guest)
        fun hostPath(path: String): String {
            if (!path.startsWith('/') || path == rootPath || path.startsWith("$rootPath/")) return path
            val mount = mounts.firstOrNull { path == it.guest || path.startsWith("${it.guest}/") }
            return if (mount == null) rootPath + path else mount.host + path.removePrefix(mount.guest)
        }
        for (key in listOf("HOME", "DSH_HOME", "DSH_AGENTS_HOME", "TMPDIR", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE")) {
            directEnv[key]?.let { directEnv[key] = hostPath(it) }
        }
        directEnv["SSL_CERT_DIR"]?.let { directEnv["SSL_CERT_DIR"] = it.split(':').joinToString(":", transform = ::hostPath) }
        directEnv["HOME"] = directEnv["HOME"] ?: "$rootPath/root"
        directEnv["DSH_HOME"] = directEnv["DSH_HOME"] ?: "$rootPath/root/.dsh"
        directEnv["TMPDIR"] = directEnv["TMPDIR"] ?: "$rootPath/tmp"
        directEnv["SHELL"] = "$bin/bash"
        directEnv["PATH"] = bin + ":" + guestPath.split(':').joinToString(":", transform = ::hostPath)
        directEnv["TZDIR"] = "$rootPath/usr/share/zoneinfo"
        directEnv["DSH_GO_RUNTIME_ROOT"] = rootPath
        directEnv["DSH_GO_DIRECT_ROOTFS"] = rootPath
        directEnv["DSH_GO_DIRECT_MAIN"] = "1"
        val launch = listOf(loader, "--library-path", libraries, node, "--import=$preload", "$rootPath/opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js") + web
        return Plan(launch, directEnv, File(root, "root"))
    }

    /** Minimal ELF64 PT_INTERP check; malformed/other-class inputs fail closed. */
    fun elfHasInterpreter(file: File): Boolean {
        RandomAccessFile(file, "r").use { input ->
            val header = ByteArray(64).also(input::readFully)
            require(header.size == 64 && header.sliceArray(0..3).contentEquals(byteArrayOf(0x7f, 69, 76, 70)) && header[4] == 2.toByte() && header[5] == 1.toByte()) { "direct engine: unsupported ELF" }
            fun number(bytes: ByteArray, at: Int, count: Int): Long = (0 until count).fold(0L) { n, shift -> n or ((bytes[at + shift].toLong() and 255) shl (shift * 8)) }
            val offset = number(header, 32, 8)
            val size = number(header, 54, 2).toInt()
            val count = number(header, 56, 2).toInt()
            require(offset >= 64 && size in 56..256 && count in 1..1024) { "direct engine: invalid ELF program headers" }
            input.seek(offset)
            repeat(count) {
                val entry = ByteArray(size).also(input::readFully)
                require(entry.size == size) { "direct engine: truncated ELF" }
                if (number(entry, 0, 4) == 3L) return true
            }
            return false
        }
    }

    private fun write(file: File, text: String, executable: Boolean = false) {
        val bytes = text.toByteArray(Charsets.UTF_8)
        if (Files.isRegularFile(file.toPath(), LinkOption.NOFOLLOW_LINKS) && file.readBytes().contentEquals(bytes)) {
            if (executable) check(file.setExecutable(true, true))
            return
        }
        val temp = File.createTempFile(".direct-", ".tmp", file.parentFile)
        try {
            temp.writeBytes(bytes)
            temp.setReadable(false, false); temp.setWritable(false, false)
            check(temp.setReadable(true, true) && temp.setWritable(true, true))
            if (executable) check(temp.setExecutable(true, true))
            Files.move(temp.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE)
        } finally { temp.delete() }
    }

    private fun json(value: String): String = buildString {
        append('"')
        for (c in value) when (c) {
            '"' -> append("\\\"")
            '\\' -> append("\\\\")
            in '\u0000'..'\u001f' -> append("\\u" + c.code.toString(16).padStart(4, '0'))
            else -> append(c)
        }
        append('"')
    }
}
