package io.github.ccch1mneyyy.dsh_app.runtime

import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/** Whether the next local start uses the rescue profile. */
enum class SafeState(val wire: String) {
    OFF("off"),

    /** Starts use the safe profile until the user asks for normal mode. */
    ON("on"),

    /** Back in normal mode on trial: a counted failure within the first two minutes returns to [ON]. */
    PROBATION("probation");

    companion object {
        fun parse(wire: String?): SafeState = entries.firstOrNull { it.wire == wire } ?: OFF
    }
}

/** The safe-mode state machine, free of Android so it can be checked on the JVM. */
object SafePolicy {
    const val STRIKE_LIMIT = 2
    const val HEALTHY_MS = 120_000L

    /**
     * Delay before restarting a run that was killed from outside after more than a minute up, or
     * null: at most three tries (5 s, 15 s, 45 s) in ten minutes. [recent] holds the earlier tries.
     */
    fun autoRestartDelay(kind: FailureKind, exitCode: Int, upMs: Long?, recent: List<Long>, now: Long): Long? {
        if (kind != FailureKind.KILLED || exitCode == 0 || upMs == null || upMs <= 60_000L) return null
        val count = recent.count { now - it < 600_000L }
        return listOf(5_000L, 15_000L, 45_000L).getOrNull(count)
    }

    /** [mode] is what the caller asked for: "safe", "normal", or null to keep the current mode. */
    fun onStartRequest(state: SafeState, mode: String?): SafeState = when (mode) {
        "safe" -> SafeState.ON
        "normal" -> if (state == SafeState.ON) SafeState.PROBATION else state
        else -> state
    }

    data class Outcome(
        val state: SafeState,
        val strikes: Int,
        /** Start again right away in safe mode. */
        val restartSafe: Boolean,
        val notice: String?,
        /** New value for the "why are we in safe mode" field; null keeps it. */
        val reason: String?,
    )

    fun onFailure(
        state: SafeState, strikes: Int, failure: RunFailure, autoSafe: Boolean,
        probationNotice: String = "正常模式还是起不来，已回到安全模式。", // l10n:keep test default
        autoNotice: String = "DSH 连续两次启动失败，已用安全模式启动。你的对话都在。", // l10n:keep test default
    ): Outcome {
        // Safe-mode runs never count against the main profile; uncounted kinds change nothing.
        if (failure.safeMode || !failure.kind.counts) return Outcome(state, strikes, false, null, null)
        val next = strikes + 1
        return when {
            state == SafeState.PROBATION ->
                Outcome(SafeState.ON, next, true, probationNotice, REASON_PROBATION)
            next >= STRIKE_LIMIT && autoSafe ->
                Outcome(SafeState.ON, next, true, autoNotice, REASON_AUTO)
            else -> Outcome(state, next, false, null, null)
        }
    }

    /**
     * A direct run that could not launch (the classifier's direct-only launch errors): start again
     * with PRoot instead of failing. Says nothing about plugins, so it never reaches [onFailure].
     */
    fun directLaunchFailed(failure: RunFailure, direct: Boolean): Boolean =
        direct && failure.kind == FailureKind.LAUNCH_FAILED

    const val REASON_MANUAL = "manual"
    const val REASON_AUTO = "auto"
    const val REASON_PROBATION = "probation"
}

/** A file in the shared DSH home that also applies to the safe profile. */
data class Hazard(val path: String, val kind: String, val detail: String) {
    fun toMap(): Map<String, Any?> = mapOf("path" to path, "kind" to kind, "detail" to detail)
}

/**
 * The rescue profile: rebuilt from DSH's shipped `web` template on every safe start, with the
 * app's overlay turning off plugin management and live recomposition, plus a briefing that tells
 * the agent what broke and how to repair the main profile.
 */
object SafeMode {
    const val PROFILE = "dsh-app-safe"
    const val GUEST_DIR = "/var/lib/dsh-app/safe-mode"
    const val ORIGINAL_HOME = "/root/.dsh"
    const val HOME = "$GUEST_DIR/home"
    const val OVERLAY = "$GUEST_DIR/overlay.patch.yml"
    const val AGENTS_HOME = "$GUEST_DIR/agents"
    const val TOOL = "$GUEST_DIR/bin/dsh-app-plugins"

    /** Optional launch-template placeholder; templates without it get [LEGACY_NORMAL] rewritten. */
    const val PROFILE_ARGS_PLACEHOLDER = "{DSH_PROFILE_ARGS}"
    const val NORMAL_PROFILE_ARGS = "web"
    const val SAFE_PROFILE_ARGS = "--profile $PROFILE --from-default-profile web --patch $OVERLAY"
    private const val LEGACY_NORMAL = "/usr/local/bin/dsh web "
    private const val LEGACY_SAFE = "/usr/local/bin/dsh $SAFE_PROFILE_ARGS "

    /** Extra guest environment for safe starts only. */
    val GUEST_ENV: Map<String, String> = linkedMapOf(
        "DSH_HOME" to HOME, "DSH_APP_ORIGINAL_HOME" to ORIGINAL_HOME,
        "DSH_AGENTS_HOME" to AGENTS_HOME, "DSH_APP_SAFE_MODE" to "1",
    )

    // l10n:keep agent repair briefing
    const val OVERLAY_YAML = """# dsh-app safe mode overlay (rewritten by the app on every safe start).
# The rescue profile never gains plugins: no plugin installs, no plugin_manager tool backend.
- id: plugin-manager
  disabled: true
- id: tool-plugin-manager
  disabled: true
# rc.1 Standard and Creator presets contain their own plugin-manager tools.
# Keep the shipped PTC and Minimal compositions, which do not enable those tools.
- id: preset-standard
  disabled: true
- id: preset-cordis
  disabled: true
- id: agent-preset-registry
  config:
    default: ptc
# No live recomposition: edits to any profile take effect only on the next boot.
- id: hmr
  disabled: true
"""

    /**
     * The launch argument with the profile selection for this mode, or null when [arg] selects
     * no profile (then it is used as is). A safe start whose template yields no rewrite must be
     * refused by the caller.
     */
    fun profileArg(arg: String, safe: Boolean): String? {
        if (arg.contains(PROFILE_ARGS_PLACEHOLDER)) {
            return arg.replace(PROFILE_ARGS_PLACEHOLDER, if (safe) SAFE_PROFILE_ARGS else NORMAL_PROFILE_ARGS)
        }
        if (!safe) return null
        val first = arg.indexOf(LEGACY_NORMAL)
        if (first < 0 || arg.indexOf(LEGACY_NORMAL, first + 1) >= 0) return null
        return arg.replace(LEGACY_NORMAL, LEGACY_SAFE)
    }

    // ── Preflight ───────────────────────────────────────────────────────────────────

    /** Files that move aside on request; nothing else is ever renamed. */
    val MOVABLE = listOf("/root/.dsh/cordis.patch.yml", "/root/.dsh/.env", "/root/.env")

    /** DSH 0.2.1's bootstrap-only names (`isBootstrapOnly` in dsh-app-boot): a `.env` setting one stops every profile. */
    private val BOOTSTRAP_NAMES = setOf(
        "PATH", "HOME", "USERPROFILE", "SHELL", "NODE_OPTIONS", "NODE_PATH", "NODE_EXTRA_CA_CERTS",
        "LD_PRELOAD", "LD_LIBRARY_PATH", "LD_AUDIT", "BASH_ENV", "ENV", "SHELLOPTS", "BASHOPTS",
        "PERL5OPT", "PERL5LIB", "PYTHONSTARTUP", "PYTHONPATH", "RUBYOPT", "RUBYLIB", "JAVA_TOOL_OPTIONS",
        "_JAVA_OPTIONS", "JDK_JAVA_OPTIONS", "PYTHONHOME", "GIT_SSH", "GIT_SSH_COMMAND", "GIT_EXTERNAL_DIFF",
        "GIT_PAGER", "GIT_EDITOR", "GIT_ASKPASS", "SSH_ASKPASS", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM",
        "GIT_CONFIG_COUNT", "EDITOR", "VISUAL", "PAGER", "BROWSER", "DEEPSEEK_BASE_URL", "DEEPSEEK_SEARCH_BASE_URL",
        "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
        "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE", "NODE_TLS_REJECT_UNAUTHORIZED",
    )
    private val BOOTSTRAP_PREFIXES = listOf("DSH_", "XDG_", "DYLD_", "BASH_FUNC_")
    private val HOME_PROXY_NAMES = setOf("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY")
    private val ENV_NAME = Regex("^\\s*(?:export\\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\\s*=")

    /** A patch layer that is only comments, blank lines or `[]`. */
    fun isTrivialPatch(text: String): Boolean {
        val body = text.lineSequence().map { it.trim() }.filter { it.isNotEmpty() && !it.startsWith("#") }.joinToString("")
        return body.isEmpty() || body == "[]"
    }

    /** Names in a `.env` that DSH refuses to start with ([home] = the `$DSH_HOME/.env`, which may set proxies). */
    fun launchOnlyNames(text: String, home: Boolean): List<String> = text.lineSequence()
        .mapNotNull { ENV_NAME.find(it)?.groupValues?.get(1) }
        .filter { name ->
            val upper = name.uppercase(Locale.ROOT)
            val bootstrap = upper in BOOTSTRAP_NAMES || BOOTSTRAP_PREFIXES.any { upper.startsWith(it) }
            bootstrap && !(home && upper in HOME_PROXY_NAMES)
        }
        .distinct()
        .toList()

    fun preflight(
        rootfs: File,
        patchDetail: String = "全局补丁文件：对所有配置（包括安全模式）都生效，可能就是它让 DSH 起不来。", // l10n:keep test default
        envDetail: (List<String>) -> String = { names ->
            "设置了 ${names.joinToString("、")}，DSH 不允许在 .env 里设置这些变量，会拒绝启动。" // l10n:keep test default
        },
    ): List<Hazard> {
        val out = ArrayList<Hazard>()
        readIfFile(rootfs, MOVABLE[0])?.let { text ->
            if (!isTrivialPatch(text)) {
                out += Hazard(MOVABLE[0], "homePatch", patchDetail)
            }
        }
        readIfFile(rootfs, MOVABLE[1])?.let { text ->
            val names = launchOnlyNames(text, home = true)
            if (names.isNotEmpty()) {
                out += Hazard(MOVABLE[1], "homeEnv", envDetail(names))
            }
        }
        readIfFile(rootfs, MOVABLE[2])?.let { text ->
            val names = launchOnlyNames(text, home = false)
            if (names.isNotEmpty()) {
                out += Hazard(MOVABLE[2], "cwdEnv", envDetail(names))
            }
        }
        return out
    }

    data class MoveAsideResult(val moved: List<Pair<String, String>>, val failure: IOException? = null)

    /** Stops at a failed rename; earlier successful moves remain available for the repair briefing. */
    fun moveAside(rootfs: File, guestPaths: List<String>, stamp: String): MoveAsideResult {
        val moved = ArrayList<Pair<String, String>>()
        for (path in guestPaths.distinct()) {
            if (path !in MOVABLE) continue
            val file = guestFile(rootfs, path)
            if (readableFile(rootfs, path) == null) continue
            var target = File(file.parentFile, "${file.name}.off-$stamp")
            var n = 1
            while (target.exists()) target = File(file.parentFile, "${file.name}.off-$stamp-${n++}")
            if (!file.renameTo(target)) {
                return MoveAsideResult(moved, IOException("could not move $path aside; ${moved.size} file(s) already moved"))
            }
            moved += path to (path.substringBeforeLast('/') + "/" + target.name)
        }
        return MoveAsideResult(moved)
    }

    // ── Guest files ─────────────────────────────────────────────────────────────────

    data class Briefing(
        /** The main profile's last failure (not a safe-mode one), if any. */
        val failure: RunFailure?,
        /** [SafePolicy.REASON_AUTO], [SafePolicy.REASON_PROBATION], [SafePolicy.REASON_MANUAL] or null. */
        val reason: String?,
        /** `from → to` guest paths moved aside before this start. */
        val moved: List<String>,
        val lkgAt: Long?,
        val lkgBundles: List<String>,
        val lkgVersions: Map<String, String>,
        /** Output around the failure, tokens already masked. */
        val failureLog: List<String>,
        val timeZone: TimeZone = TimeZone.getDefault(),
    )

    /** Writes the overlay, the agent briefing, the failure data and the repair tool under [GUEST_DIR]. */
    fun prepare(rootfs: File, briefing: Briefing) {
        val dir = realDir(guestFile(rootfs, GUEST_DIR))
        val home = File(dir, "home")
        if (Files.isSymbolicLink(home.toPath()) || (home.exists() && !home.isDirectory)) {
            throw IOException("rescue home must be a real directory: ${home.path}")
        }
        realDir(home)
        val agents = realDir(File(dir, "agents"))
        val bin = realDir(File(dir, "bin"))
        writeAtomic(File(dir, "overlay.patch.yml"), OVERLAY_YAML)
        writeAtomic(File(agents, "AGENTS.md"), renderBriefing(briefing))
        writeAtomic(
            File(dir, "last-failure.log"),
            // l10n:keep agent repair briefing
            if (briefing.failureLog.isEmpty()) "（没有记录到失败时的输出）\n" else briefing.failureLog.joinToString("\n", postfix = "\n"),
        )
        val f = briefing.failure
        val failureFile = File(dir, "failure.json")
        if (f == null) failureFile.delete() else writeAtomic(failureFile, json(f.toMap()) + "\n")
        val lkgFile = File(dir, "lkg.json")
        if (briefing.lkgAt == null) {
            lkgFile.delete()
        } else {
            writeAtomic(lkgFile, json(mapOf("at" to briefing.lkgAt, "bundles" to briefing.lkgBundles, "versions" to briefing.lkgVersions)) + "\n")
        }
        val tool = File(bin, "dsh-app-plugins")
        writeAtomic(tool, PLUGINS_SCRIPT)
        tool.setReadable(true, false)
        tool.setExecutable(true, false)
    }

    fun renderBriefing(b: Briefing): String = buildString {
        val f = b.failure
        // l10n:keep agent repair briefing
        appendLine("<!-- dsh-app:safe-mode — DSH App 每次进入安全模式时重写本文件，改了也会被覆盖 -->")
        // l10n:keep agent repair briefing
        appendLine("# 你现在运行在「安全模式」")
        appendLine()
        appendLine(
            // l10n:keep agent repair briefing
            "用户的正常配置（profile `web`）出了问题。App 用纯净 profile `$PROFILE` 启动了你：只有 DSH 自带组件，" +
                // l10n:keep agent repair briefing
                "没有任何第三方插件，插件管理和热加载都关掉了。原对话、登录和 API Key 保留在原目录，未复制到救援环境；救援助手可能需要重新配置模型。" +
                // l10n:keep agent repair briefing
                "你的任务是帮用户把 `web` 修好，让它能正常启动。",
        )
        appendLine()
        // l10n:keep agent repair briefing
        appendLine("## 这次出了什么事")
        if (f == null) {
            // l10n:keep agent repair briefing
            appendLine("- 用户手动进入了安全模式，App 没有记录到最近的崩溃。先问用户遇到了什么问题，再按下面的步骤查。")
        } else {
            // l10n:keep agent repair briefing
            appendLine("- 时间：${formatTime(f.at, b.timeZone)}；类型：${kindText(f)}；退出码：${f.exitCode}")
            // l10n:keep agent repair briefing
            f.summary?.let { appendLine("- 摘要：`$it`") }
            if (f.kind != FailureKind.LAUNCH_FAILED && f.requiredRows.isNotEmpty()) {
                appendLine(
                    // l10n:keep agent repair briefing
                    "- 没能启动的必需配置行：${f.requiredRows.joinToString("、") { "`$it`" }}。它们是被改坏的官方行，" +
                        // l10n:keep agent repair briefing
                        "不一定是元凶；用 `$TOOL blame` 查是谁改了它们。",
                )
            }
            // l10n:keep agent repair briefing
            val suspects = if (f.kind == FailureKind.LAUNCH_FAILED) emptyList() else f.suspects.map { "`$it`（崩溃信息里出现）" } +
                // l10n:keep agent repair briefing
                f.recent.filter { it !in f.suspects }.map { "`$it`（上次正常运行后新启用或升级过）" }
            // l10n:keep agent repair briefing
            appendLine("- 可疑插件：" + if (suspects.isEmpty()) "没能自动判断" else suspects.joinToString("、"))
            // l10n:keep agent repair briefing
            appendLine("- 失败前后的输出（token 已打码）：`$GUEST_DIR/last-failure.log`")
            // l10n:keep agent repair briefing
            appendLine("- DSH 启动诊断：" + (f.diagnostics?.let { "`$it`（里面可能有密钥，不要整段贴给用户）" } ?: "无"))
        }
        when (b.reason) {
            // l10n:keep agent repair briefing
            SafePolicy.REASON_AUTO -> appendLine("- 进入方式：主配置连续两次启动失败，App 自动进入了安全模式。")
            // l10n:keep agent repair briefing
            SafePolicy.REASON_PROBATION -> appendLine("- 进入方式：用户试过「恢复正常模式」，但正常模式 2 分钟内又崩了，App 自动回到了安全模式。")
            // l10n:keep agent repair briefing
            SafePolicy.REASON_MANUAL -> if (f != null) appendLine("- 进入方式：用户手动进入。")
        }
        if (b.moved.isNotEmpty()) {
            appendLine(
                // l10n:keep agent repair briefing
                "- App 已把这些全局文件改名移开（原配置仍需检查这些文件，工作目录 .env 也可能影响安全模式）：${b.moved.joinToString("；")}。" +
                    // l10n:keep agent repair briefing
                    "修好后和用户确认，再决定要不要改回来。",
            )
        }
        appendLine()
        // l10n:keep agent repair briefing
        appendLine("## 原数据与救援数据")
        // l10n:keep agent repair briefing
        appendLine("- 安全模式默认使用官方 PTC 预设，也可选择官方 Minimal；Standard 和 Creator 依赖已关闭的插件管理服务，在安全模式中不可用。正常模式的预设不变。")
        // l10n:keep agent repair briefing
        appendLine("- 当前救援 DSH_HOME 是 `$HOME`；原数据在 `$ORIGINAL_HOME`，修复工具和 trial 始终针对原目录。原对话不会显示在救援会话列表里。")
        // l10n:keep agent repair briefing
        appendLine("- 救援模式的 App 诊断快照在 `$HOME/dsh-app/diagnostics.md`；先在 App 设置里生成诊断。")
        // l10n:keep agent repair briefing
        appendLine("- 无需模型或发送消息：已有救援会话可直接打开标题详情里的终端。首次空库时，先切换到「网页模式」，让官方页面自动创建空救援会话，再通过 DSH 原生悬浮手柄「切回原生界面」保留该会话，打开标题详情里的终端。运行 `$TOOL export \"\$PWD/dsh-recovery.tar\"`，再在该对话的文件页长按归档保存到手机。必须指定尚不存在、位于原数据目录之外的输出文件。")
        // l10n:keep agent repair briefing
        appendLine("- 导出保留原始 sessions、attachments 和 workspace 元数据，包括损坏记录；不会修复数据，不是完整插件或工作区备份。符号链接只保存链接，不读取目标。归档含私人对话和图片，妥善保存；诊断包使用 App 设置里的诊断导出入口。")
        appendLine()
        // l10n:keep agent repair briefing
        appendLine("## 主配置在哪")
        // l10n:keep agent repair briefing
        appendLine("- `/root/.dsh/profiles/web/package.json`：`dependencies` 是装了的包，`dsh.profile.bundles` 是启用的组合包（按顺序叠加）。")
        // l10n:keep agent repair briefing
        appendLine("- `/root/.dsh/profiles/web/cordis.patch.yml`：web 的设置层（网页版设置页改的东西在这里）。")
        // l10n:keep agent repair briefing
        appendLine("- `/root/.dsh/profiles/web/.plugin-manager/logs/`：插件安装日志；`/root/.dsh/logs/`：DSH 的启动诊断。")
        // l10n:keep agent repair briefing
        appendLine("- 原数据根下的配置受 `/root/.dsh/cordis.patch.yml`、`/root/.dsh/.env` 影响；救援数据根与它们隔离。工作目录的 `/root/.env` 仍需单独检查。")
        if (b.lkgAt == null) {
            // l10n:keep agent repair briefing
            appendLine("- App 还没有记录过正常运行时的插件配置。")
        } else {
            appendLine(
                // l10n:keep agent repair briefing
                "- 上次正常运行（${formatTime(b.lkgAt, b.timeZone)}）时启用的组合包：" +
                    b.lkgBundles.joinToString("、") { name -> "`$name`" + (b.lkgVersions[name]?.let { "@$it" } ?: "") } + "。",
            )
        }
        appendLine()
        // l10n:keep agent repair briefing
        appendLine("## 怎么查")
        // l10n:keep agent repair briefing
        appendLine("1. `$TOOL list`：web 的插件、是否启用、是否第三方、和上次正常运行时比有没有变。")
        appendLine(
            // l10n:keep agent repair briefing
            "2. `$TOOL blame`：列出被第三方插件、设置层或全局补丁加入 / 改过的配置行；" +
                // l10n:keep agent repair briefing
                "启动失败信息里写着 `某行 (required)` 时，用 `$TOOL blame 某行`，`patched by` 后面的包通常就是元凶。",
        )
        appendLine(
            // l10n:keep agent repair briefing
            "3. 运行时崩溃看栈：路径里的 `/root/.dsh/profiles/web/node_modules/<包名>/` 就是出事的包；" +
                // l10n:keep agent repair briefing
                "它也可能只是某个插件的依赖，用 `grep -l '\"<包名>\"' /root/.dsh/profiles/web/node_modules/*/package.json` 查是谁依赖它。",
        )
        appendLine()
        // l10n:keep agent repair briefing
        appendLine("## 怎么修（先做可逆的）")
        // l10n:keep agent repair briefing
        appendLine("1. 停用可疑插件：`$TOOL disable <包名>`。只改启用清单，不删文件，不需要网络；`$TOOL enable <包名>` 可以撤销。")
        appendLine(
            // l10n:keep agent repair briefing
            "2. 设置写坏了：先备份 `cp /root/.dsh/profiles/web/cordis.patch.yml /root/.dsh/profiles/web/cordis.patch.yml.bak-\$(date +%Y%m%d%H%M)`，再改原文件。",
        )
        // l10n:keep agent repair briefing
        appendLine("3. 用户确认不要这个插件了，再卸载：`DSH_HOME=$ORIGINAL_HOME dsh plugin --profile web remove <包名>`。")
        appendLine(
            // l10n:keep agent repair briefing
            "4. 实在修不好，先问用户，再 `mv /root/.dsh/profiles/web /root/.dsh/profiles/web.broken-\$(date +%Y%m%d%H%M)`：" +
                // l10n:keep agent repair briefing
                "下次正常启动会重建一个干净的 web，插件和设置要重新装，对话不受影响。",
        )
        // l10n:keep agent repair briefing
        appendLine("每一步改了什么都告诉用户。")
        appendLine()
        // l10n:keep agent repair briefing
        appendLine("## 怎么验证")
        appendLine(
            // l10n:keep agent repair briefing
            "- `$TOOL trial`：在另一个端口试启动 web，看到 PASS 再说修好了。会多占几百 MB 内存、可能要一两分钟；" +
                // l10n:keep agent repair briefing
                "`free -m` 显示可用内存不到 1 GB 时，先问用户再跑。",
        )
        // l10n:keep agent repair briefing
        appendLine("- 最后请用户在 App 里点「恢复正常模式」。如果正常模式 2 分钟内又崩了，App 会自动回到安全模式，你可以接着查。")
        appendLine()
        // l10n:keep agent repair briefing
        appendLine("## 不要做")
        // l10n:keep agent repair briefing
        appendLine("- 不要往 `$PROFILE` 装插件，不要改救援工具、说明、`/opt/dsh`、`/opt/node`：它们会被重建或覆盖。救援 HOME 内的新对话保留，与原对话分开。")
        // l10n:keep agent repair briefing
        appendLine("- 不要结束 `/tmp/dsh-web.pid` 里的进程（那就是你自己），不要 `pkill node`。")
        // l10n:keep agent repair briefing
        appendLine("- 不要删 `/root/.dsh/sessions`、`/root/.dsh/storages`、`/root/.dsh/.credentials.yaml`。")
        // l10n:keep agent repair briefing
        appendLine("- 诊断文件和日志里可能有密钥，不要整段贴给用户。")
    }

    private fun kindText(f: RunFailure): String = when (f.kind) {
        // l10n:keep agent repair briefing
        FailureKind.LAUNCH_FAILED -> "本机运行环境未能执行 DSH（还未打印登录地址）"
        // l10n:keep agent repair briefing
        FailureKind.STARTUP_FAILED -> "启动失败（还没打印登录地址就退出了）"
        // l10n:keep agent repair briefing
        FailureKind.CRASHED_EARLY -> "启动后很快崩溃（打印登录地址 ${f.upSeconds ?: 0} 秒后退出）"
        // l10n:keep agent repair briefing
        FailureKind.CRASHED_LATE -> "运行中崩溃（打印登录地址 ${f.upSeconds ?: 0} 秒后退出）"
        // l10n:keep agent repair briefing
        FailureKind.KILLED -> "被系统结束（没有 DSH 的致命错误信息，可能是内存不足或省电策略）"
        // l10n:keep agent repair briefing
        FailureKind.NO_SPACE -> "存储空间不足"
    }

    fun formatTime(at: Long, zone: TimeZone = TimeZone.getDefault()): String =
        SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.ROOT).apply { timeZone = zone }.format(Date(at))

    /** `yyyyMMdd-HHmmss`, for `.off-` / `.bak-` suffixes. */
    fun stamp(at: Long = System.currentTimeMillis()): String =
        SimpleDateFormat("yyyyMMdd-HHmmss", Locale.ROOT).format(Date(at))

    // ── Small file helpers (plain java.io, so this file runs on the JVM too) ────────

    fun guestFile(rootfs: File, guestPath: String): File = File(rootfs, guestPath.removePrefix("/"))

    private fun readIfFile(rootfs: File, guestPath: String): String? = try {
        readableFile(rootfs, guestPath)?.readText()
    } catch (_: Exception) {
        null
    }

    // Preflight precedes the safe launch's tawc materialization. Resolve bytes for reading;
    // moveAside must still rename the original guest name, never its shared store object.
    private fun readableFile(rootfs: File, guestPath: String): File? = try {
        guestFile(rootfs, guestPath).takeIf { it.isFile }
            ?: io.github.ccch1mneyyy.dsh_app.files.GuestFiles.resolve(rootfs, guestPath, phoneRoot = PhoneStorage.GUEST_PATH)
    } catch (_: Exception) {
        null
    }

    /** A real directory at [dir]: a symlink or file planted there is removed first (never followed). */
    private fun realDir(dir: File): File {
        if (Files.isSymbolicLink(dir.toPath()) || (dir.exists() && !dir.isDirectory)) {
            if (!dir.delete()) throw IOException("could not remove ${dir.path}")
        }
        if (!dir.isDirectory && !dir.mkdirs()) throw IOException("could not create ${dir.path}")
        return dir
    }

    /** Writes a sibling temp file and renames it over [file] (replacing, not following, a symlink). */
    fun writeAtomic(file: File, text: String) {
        val tmp = File(file.parentFile, ".${file.name}.dsh-app-${System.nanoTime()}.tmp")
        try {
            tmp.writeText(text)
            if (!tmp.renameTo(file)) throw IOException("could not replace ${file.path}")
        } finally {
            if (tmp.exists()) tmp.delete()
        }
    }

    /** Minimal JSON for the guest-side data files (strings, numbers, booleans, lists, maps). */
    fun json(value: Any?): String = when (value) {
        null -> "null"
        is String -> quote(value)
        is Boolean, is Number -> value.toString()
        is Map<*, *> -> value.entries.joinToString(",", "{", "}") { quote(it.key.toString()) + ":" + json(it.value) }
        is Iterable<*> -> value.joinToString(",", "[", "]") { json(it) }
        else -> quote(value.toString())
    }

    private fun quote(s: String): String = buildString {
        append('"')
        for (c in s) {
            when {
                c == '"' -> append("\\\"")
                c == '\\' -> append("\\\\")
                c == '\n' -> append("\\n")
                c == '\r' -> append("\\r")
                c == '\t' -> append("\\t")
                c < ' ' -> append(String.format(Locale.ROOT, "\\u%04x", c.code))
                else -> append(c)
            }
        }
        append('"')
    }

    /**
     * `bin/dsh-app-plugins`, the agent's repair tool (list / disable / enable / blame / trial).
     * Written without `$` so the raw string needs no escaping; verified on a PC DSH 0.2.1 home.
     */
    // l10n:keep agent repair briefing
    const val PLUGINS_SCRIPT = """#!/usr/bin/env node
// dsh-app safe mode helper. The DSH App rewrites this file on every safe start.
//   list                 plugins of the main profile (web): enabled, third-party, changed since the last good run
//   disable <pkg>...     drop packages from dsh.profile.bundles (files stay; enable undoes it)
//   enable <pkg>...      put installed packages back into dsh.profile.bundles
//   blame [row-id...]    which package inserted / patched each config row (dsh --dump-config)
//   trial [profile]      boot the original profile on a spare port and report PASS / FAIL
//   export <output.tar>  preserve raw original conversations outside the original HOME
'use strict'
const fs = require('fs')
const path = require('path')
const cp = require('child_process')
const { randomUUID } = require('crypto')

const HOME = process.env.DSH_APP_ORIGINAL_HOME || process.env.DSH_HOME || '/root/.dsh'
const SAFE = process.env.DSH_APP_SAFE_DIR || '/var/lib/dsh-app/safe-mode'
const APP_PATCH = process.env.DSH_APP_PATCH || '/etc/dsh-app/dsh-web.patch.yml'
const SHIPPED = '@deepseek-ai/'
const CORE = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
const PROFILE = 'web'

function profileDir () { return path.join(HOME, 'profiles', PROFILE) }
function manifestPath () { return path.join(profileDir(), 'package.json') }
function readText (file) { try { return fs.readFileSync(file, 'utf8') } catch (e) { return null } }
function readJson (file, fallback) {
  const text = readText(file)
  if (text === null) return fallback
  try { return JSON.parse(text) } catch (e) { return fallback }
}
function out (line) { process.stdout.write(line + '\n') }
function when (ms) {
  const d = new Date(ms)
  const p = function (n) { return String(n).padStart(2, '0') }
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
}
function die (line) { process.stderr.write(line + '\n'); process.exit(1) }
function redact (line) { return line.replace(/token=[A-Za-z0-9._~%-]+/g, 'token=***') }
function sleep (ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }
function alive (pid) {
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}

function readManifest () {
  const m = readJson(manifestPath(), null)
  if (!m || typeof m !== 'object') die('读不到 ' + manifestPath() + '（文件不存在或不是合法 JSON）')
  return m
}
function bundlesOf (m) {
  const b = m.dsh && m.dsh.profile && m.dsh.profile.bundles
  return Array.isArray(b) ? b.slice() : []
}
function depsOf (m) { return m.dependencies && typeof m.dependencies === 'object' ? m.dependencies : {} }
function installedVersion (name) {
  const pkg = readJson(path.join(profileDir(), 'node_modules', name, 'package.json'), null)
  return pkg && typeof pkg.version === 'string' ? pkg.version : null
}

// Match DSH's installation-first package lookup without requiring a package
// to export package.json. Resolve metadata only; enabling does not boot code.
function requireInstalledBundle (name) {
  if (!/^(@[^/\\]+\/)?[^/\\]+$/.test(name) || name.split('/').some(function (part) { return part === '.' || part === '..' })) {
    throw new Error('不是有效的包名：' + name)
  }
  const createRequire = require('module').createRequire
  const anchors = ['/opt/dsh/node_modules/@deepseek-ai/dsh/package.json', manifestPath()]
  for (const anchor of anchors) {
    const paths = createRequire(anchor).resolve.paths(name) || []
    for (const directory of paths) {
      const file = path.join(directory, name, 'package.json')
      try {
        fs.statSync(file)
      } catch (e) {
        if (e.code === 'ENOENT' || e.code === 'ENOTDIR') continue
        throw e
      }
      // A broken installation copy must not silently select a profile copy.
      const pkg = JSON.parse(fs.readFileSync(file, 'utf8'))
      const bundle = pkg && pkg.dsh && pkg.dsh.bundle
      if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) {
        throw new Error(name + ' 的 package.json 没有有效的 dsh.bundle，不能启用')
      }
      // Reuse the installed runtime's read-only patch dialect (including !!js
      // data and ordered/empty arrays). Never boot plugins or rewrite layers.
      // Keep this import lazy: a damaged runtime must not break list/disable.
      const boot = createRequire(anchors[0])('@deepseek-ai/dsh-app-boot')
      for (const patch of boot.bundlePatchFiles(bundle)) {
        boot.loadOverlayPatches('dsh-app-plugins', path.join(path.dirname(file), patch))
      }
      return
    }
  }
  throw new Error(name + ' 在 DSH 安装和 web profile 中都无法解析，不能启用')
}

// Publish a complete pid record at <file>.lock; the other writers follow symlinks.
// Dead-pid takeover stays the same, and new manifest content still lands by rename.
function withLock (file, fn) {
  const lock = file + '.lock'
  const deadline = Date.now() + 5000
  const owner = path.join(path.dirname(file), '.dsh-helper-lock-' + randomUUID() + '.pid')
  const fd = fs.openSync(owner, 'wx', 0o600)
  let published = false
  try {
    try { fs.writeFileSync(fd, process.pid + '\n') } finally { fs.closeSync(fd) }
    for (;;) {
      try {
        fs.symlinkSync(path.basename(owner), lock)
        published = true
        break
      } catch (e) {
        if (e.code !== 'EEXIST') throw e
        const pid = parseInt(String(readText(lock) || '').trim(), 10)
        if (pid > 0 && !alive(pid)) {
          fs.rmSync(lock, { force: true })
          continue
        }
        if (Date.now() > deadline) break
        sleep(100)
      }
    }
    if (published) return fn()
  } finally {
    // If unlink fails, keep the owner so the remaining lock is still readable.
    if (published) fs.rmSync(lock, { force: true })
    fs.rmSync(owner, { force: true })
  }
  die('package.json 正被别的进程修改（锁文件 ' + lock + '），稍后再试')
}
function writeAtomic (file, text) {
  const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp'
  try {
    fs.writeFileSync(tmp, text)
    fs.renameSync(tmp, file)
  } finally {
    fs.rmSync(tmp, { force: true })
  }
}
function updateBundles (change) {
  const file = manifestPath()
  return withLock(file, function () {
    const m = readManifest()
    const before = bundlesOf(m)
    const after = change(before, depsOf(m))
    if (JSON.stringify(before) === JSON.stringify(after)) return false
    if (!m.dsh || typeof m.dsh !== 'object') m.dsh = {}
    if (!m.dsh.profile || typeof m.dsh.profile !== 'object') m.dsh.profile = {}
    m.dsh.profile.bundles = after
    writeAtomic(file, JSON.stringify(m, null, 2) + '\n')
    return true
  })
}

function lastGood () {
  const lkg = readJson(path.join(SAFE, 'lkg.json'), null)
  return lkg && Array.isArray(lkg.bundles) ? lkg : null
}

function list () {
  const m = readManifest()
  const bundles = bundlesOf(m)
  const deps = depsOf(m)
  const lkg = lastGood()
  const names = bundles.concat(Object.keys(deps).filter(function (n) { return bundles.indexOf(n) < 0 }))
  out('web 的组合包（' + manifestPath() + '，dsh.profile.bundles 按顺序叠加）：')
  for (const name of names) {
    const enabled = bundles.indexOf(name) >= 0
    const thirdParty = Object.prototype.hasOwnProperty.call(deps, name) || name.indexOf(SHIPPED) !== 0
    const version = installedVersion(name) || deps[name] || ''
    const notes = []
    if (!thirdParty) notes.push('DSH 自带')
    if (thirdParty && !Object.prototype.hasOwnProperty.call(deps, name)) notes.push('启用了但没安装')
    if (lkg) {
      const was = lkg.bundles.indexOf(name) >= 0
      const lkgVersion = lkg.versions && lkg.versions[name]
      if (enabled && !was) notes.push('上次正常运行后新启用')
      if (enabled && was && lkgVersion && version && lkgVersion !== version) notes.push('上次正常时是 ' + lkgVersion)
      if (!enabled && was) notes.push('上次正常时是启用的')
    }
    out((enabled ? '  [启用] ' : '  [停用] ') + name + (version ? '@' + version : '') + (notes.length ? '  — ' + notes.join('；') : ''))
  }
  if (!names.length) out('  （空）')
  out(lkg ? '上次正常运行的配置记录于 ' + when(lkg.at) + '。' : '没有上次正常运行的配置记录。')
}

function disable (names) {
  if (!names.length) die('用法：dsh-app-plugins disable <包名>...')
  for (const name of names) if (CORE.indexOf(name) >= 0) die(name + ' 是 DSH 的核心组件，不能停用')
  const notEnabled = []
  const changed = updateBundles(function (bundles) {
    for (const name of names) if (bundles.indexOf(name) < 0) notEnabled.push(name)
    return bundles.filter(function (b) { return names.indexOf(b) < 0 })
  })
  for (const name of notEnabled) out(name + ' 本来就没有启用')
  if (changed) out('已停用：' + names.filter(function (n) { return notEnabled.indexOf(n) < 0 }).join('、') + '。文件没有删除，可以用 enable 撤销；重启到正常模式后生效。')
}

function enable (names) {
  if (!names.length) die('用法：dsh-app-plugins enable <包名>...')
  let changed
  try {
    changed = updateBundles(function (bundles, deps) {
      for (const name of names) {
        if (!Object.prototype.hasOwnProperty.call(deps, name) && name.indexOf(SHIPPED) !== 0) throw new Error(name + ' 没有安装在 web 里（不在 dependencies 中），不能启用')
        requireInstalledBundle(name)
      }
      const next = bundles.slice()
      for (const name of names) if (next.indexOf(name) < 0) next.push(name)
      return next
    })
  } catch (e) {
    die(e.message)
  }
  out(changed ? '已启用：' + names.join('、') + '。重启到正常模式后生效。' : '这些包本来就是启用的')
}

// A raw rescue copy, independent of session parsing and model credentials.
function exportOriginal (args) {
  if (args.length !== 1 || !args[0]) die('用法：dsh-app-plugins export <output.tar>')
  let output
  let fd
  try {
    const home = fs.realpathSync(HOME)
    const requested = path.resolve(args[0])
    output = path.join(fs.realpathSync(path.dirname(requested)), path.basename(requested))
    const relative = path.relative(home, output)
    if (!relative || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))) {
      throw new Error('输出文件必须位于原 DSH_HOME 之外')
    }
    const sessions = fs.lstatSync(path.join(home, 'sessions'))
    if (!sessions.isDirectory()) throw new Error('原 sessions 必须是真实目录，不能是符号链接')
    const entries = ['sessions']
    function optional (name, directory) {
      let info
      try { info = fs.lstatSync(path.join(home, name)) } catch (e) {
        if (e.code === 'ENOENT') return
        throw e
      }
      if (info.isSymbolicLink()) throw new Error('不读取符号链接：' + name)
      if (directory ? !info.isDirectory() : !info.isFile()) throw new Error('不支持的文件类型：' + name)
      entries.push(name)
    }
    optional('attachments', true)
    let storage
    try { storage = fs.lstatSync(path.join(home, 'storages')) } catch (e) {
      if (e.code !== 'ENOENT') throw e
    }
    if (storage) {
      if (!storage.isDirectory()) throw new Error('原 storages 必须是真实目录，不能是符号链接')
      optional('storages/workspace.json', false)
      optional('storages/workspace', true)
    }
    fd = fs.openSync(output, 'wx', 0o600)
    const env = Object.assign({}, process.env)
    delete env.TAR_OPTIONS
    const result = cp.spawnSync('tar', ['--create', '--file', '-', '--directory', home, '--'].concat(entries), {
      env: env, stdio: ['ignore', fd, 'pipe'], encoding: 'utf8'
    })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error('tar 导出失败：' + (result.stderr || result.signal || result.status))
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = undefined
    out('已导出原始对话备份：' + output)
    out('包含：' + entries.join('、') + '。不含完整工作区、插件、凭据和诊断日志；符号链接不读取目标。')
  } catch (e) {
    if (fd !== undefined) {
      try { fs.closeSync(fd) } catch (_) {}
      try { fs.unlinkSync(output) } catch (_) {}
    }
    die('导出失败：' + e.message)
  }
}

function cleanEnv () {
  const env = Object.assign({}, process.env)
  delete env.DSH_AGENTS_HOME
  delete env.DSH_APP_SAFE_MODE
  delete env.DSH_APP_ORIGINAL_HOME
  env.DSH_HOME = HOME
  return env
}
function patchArgs () { return fs.existsSync(APP_PATCH) ? ['--patch', APP_PATCH] : [] }

function describeSource (src) {
  if (src === path.join(profileDir(), 'cordis.patch.yml')) return 'web 的设置层（' + src + '）'
  if (src === path.join(HOME, 'cordis.patch.yml')) return '全局补丁（' + src + '，对所有 profile 生效）'
  return src
}
function isOwnSource (src) { return src.indexOf(SHIPPED) === 0 || src === APP_PATCH }

function blame (ids) {
  if (!ids.length) {
    const failure = readJson(path.join(SAFE, 'failure.json'), null)
    if (failure && Array.isArray(failure.requiredRows)) ids = failure.requiredRows
  }
  const r = cp.spawnSync('dsh', ['--profile', PROFILE].concat(patchArgs(), ['--dump-config']), {
    encoding: 'utf8', env: cleanEnv(), maxBuffer: 64 * 1024 * 1024
  })
  if (r.error) die('运行 dsh 失败：' + r.error.message)
  if (r.status !== 0) {
    out('dsh --dump-config 失败（退出码 ' + r.status + '），主配置的补丁层本身可能有语法错误：')
    out(redact(String(r.stderr || '').split('\n').slice(-30).join('\n')))
    process.exit(1)
  }
  const rows = []
  let header = null // one header covers every row up to the next one
  for (const line of String(r.stdout).split('\n')) {
    if (line.indexOf('# == ') === 0) { header = line.slice(5).trim(); continue }
    if (line.indexOf('- id: ') === 0) {
      const id = line.slice(6).trim().replace(/['"]/g, '')
      const parts = (header || '').split(', patched by ')
      const by = parts.length > 1 ? parts.slice(1).join(', patched by ').split(', ') : []
      rows.push({ id: id, inserted: parts[0] || '?', patched: by })
    }
  }
  const describe = function (row) {
    let text = row.id + '：由 ' + describeSource(row.inserted) + ' 加入'
    if (row.patched.length) text += '，被 ' + row.patched.map(describeSource).join('、') + ' 改过'
    const suspects = [row.inserted].concat(row.patched).filter(function (s) { return !isOwnSource(s) })
    if (suspects.length) text += ' → 可疑：' + suspects.map(describeSource).join('、')
    return text
  }
  if (ids.length) {
    for (const id of ids) {
      const row = rows.find(function (x) { return x.id === id })
      out(row ? describe(row) : id + '：当前 web 配置里没有这一行')
    }
    return
  }
  const touched = rows.filter(function (row) {
    return [row.inserted].concat(row.patched).some(function (s) { return !isOwnSource(s) })
  })
  out('被第三方插件、设置层或全局补丁加入 / 改过的配置行（共 ' + rows.length + ' 行）：')
  for (const row of touched) out('  ' + describe(row))
  if (!touched.length) out('  （没有，web 的配置行都来自 DSH 自带组件）')
}

function trial (args) {
  const profile = args[0] || PROFILE
  const hold = parseInt(process.env.TRIAL_HOLD || '30', 10)
  const limit = parseInt(process.env.TRIAL_LIMIT || '240', 10)
  const started = Date.now()
  const tail = []
  let upAt = 0
  let passed = false
  let finished = false
  const child = cp.spawn('dsh', ['--profile', profile].concat(patchArgs(), ['--host', '127.0.0.1', '--port', '0', '--no-open']), {
    env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe']
  })
  const seconds = function (ms) { return Math.round(ms / 1000) }
  const capture = function (stream) {
    let pending = ''
    let line = ''
    const saveLine = function () {
      if (line) {
        const text = line.length > 2000 ? line.slice(0, 2000).replace(/[\uD800-\uDBFF]$/, '') + '…' : line
        tail.push(redact(text))
        if (tail.length > 60) tail.shift()
      }
      line = ''
    }
    stream.setEncoding('utf8')
    stream.on('data', function (chunk) {
      const text = pending + String(chunk)
      if (!upAt && text.indexOf('token=') >= 0) upAt = Date.now()
      // A pipe can split the six-byte marker anywhere; streams stay separate.
      pending = text.slice(-5)
      const lines = String(chunk).split('\n')
      for (let i = 0; i < lines.length; i++) {
        // One extra character records truncation without retaining an unbounded line.
        line += lines[i].slice(0, 2001 - line.length)
        if (i + 1 < lines.length) saveLine()
      }
    })
    return saveLine
  }
  const flushOutput = [capture(child.stdout), capture(child.stderr)]
  const finish = function (code, text, showTail) {
    if (finished) return
    finished = true
    clearInterval(timer)
    flushOutput.forEach(function (flush) { flush() })
    out(text)
    if (showTail) out(tail.slice(-40).join('\n'))
    else {
      const warnings = tail.filter(function (l) { return /warning|skipping/i.test(l) })
      if (warnings.length) out(warnings.slice(0, 20).join('\n'))
    }
    process.exit(code)
  }
  child.on('error', function (e) { finish(1, 'FAIL: 无法运行 dsh：' + e.message, false) })
  child.on('exit', function (code, signal) {
    if (passed) return finish(0, 'PASS: ' + profile + ' 在 ' + seconds(upAt - started) + ' 秒内启动，并稳定运行了 ' + hold + ' 秒', false)
    finish(1, 'FAIL: ' + profile + ' 在 ' + seconds(Date.now() - started) + ' 秒时退出（' + (signal ? '信号 ' + signal : '退出码 ' + code) + '）' +
      (upAt ? '，它在 ' + seconds(upAt - started) + ' 秒时已经打印了登录地址' : '，没打印登录地址') + '。最后的输出：', true)
  })
  const stop = function () {
    child.kill('SIGTERM')
    setTimeout(function () { try { child.kill('SIGKILL') } catch (e) {} }, 5000).unref()
  }
  const timer = setInterval(function () {
    if (upAt && Date.now() - upAt >= hold * 1000 && !passed) { passed = true; stop() }
    if (!upAt && Date.now() - started >= limit * 1000 && !finished) {
      child.kill('SIGKILL')
      finish(1, 'FAIL: ' + profile + ' 在 ' + limit + ' 秒内没有打印登录地址（可能卡住了）。最后的输出：', true)
    }
  }, 500)
}

const argv = process.argv.slice(2)
const command = argv[0]
const rest = argv.slice(1)
if (command === 'list') list()
else if (command === 'disable') disable(rest)
else if (command === 'enable') enable(rest)
else if (command === 'blame') blame(rest)
else if (command === 'trial') trial(rest)
else if (command === 'export') exportOriginal(rest)
else {
  out('用法：dsh-app-plugins list | disable <包名>... | enable <包名>... | blame [配置行 id...] | trial [profile] | export <output.tar>')
  process.exit(command ? 1 : 0)
}
"""
}
