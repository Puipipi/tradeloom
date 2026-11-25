package io.github.ccch1mneyyy.dsh_app.runtime

import java.io.File
import org.junit.Assert.*
import org.junit.Test

/**
 * API 26 configuration fds rely on the Java child launcher closing inherited fds.
 * Keep both native and Dart entry points here. Run after the Android time-zone
 * channel change: the old Dart getprop call deliberately fails this test.
 *
 * This is a source guard for explicit launch APIs, not whole-program analysis:
 * dependency binaries, reflection and C preprocessor aliases need separate review.
 */
class ProcessLaunchGuardTest {
    private data class Token(val text: String, val offset: Int)

    /** Comments/literal text cannot launch; interpolated expressions can. */
    private class Code(private val source: String, private val language: String) {
        val tokens = mutableListOf<Token>()
        private var at = 0
        private val interpolates = language == "kt" || language == "dart"
        private val nestedComments = interpolates

        fun read(): List<Token> { code(false); return tokens }

        private fun code(stopAtBrace: Boolean) {
            while (at < source.length) {
                val start = at
                val c = source[at]
                when {
                    c.isWhitespace() -> at++
                    source.startsWith("//", at) -> {
                        at = source.indexOf('\n', at).let { if (it < 0) source.length else it }
                    }
                    source.startsWith("/*", at) -> {
                        at += 2
                        var depth = 1
                        while (at < source.length && depth > 0) {
                            when {
                                nestedComments && source.startsWith("/*", at) -> { depth++; at += 2 }
                                source.startsWith("*/", at) -> { depth--; at += 2 }
                                else -> at++
                            }
                        }
                        check(depth == 0) { "Unterminated comment at $start" }
                    }
                    language == "dart" && c == 'r' && source.getOrNull(at + 1) in listOf('\'', '"') -> {
                        at++
                        string(raw = true)
                    }
                    language in setOf("c", "cc", "cpp", "cxx", "h", "hpp") && source.startsWith("R\"", at) -> {
                        val open = source.indexOf('(', at + 2)
                        check(open >= 0) { "Unterminated raw string at $start" }
                        val end = ")" + source.substring(at + 2, open) + "\""
                        val close = source.indexOf(end, open + 1)
                        check(close >= 0) { "Unterminated raw string at $start" }
                        at = close + end.length
                    }
                    c == '\'' || c == '"' -> string(raw = false)
                    language == "kt" && c == '`' -> {
                        val end = source.indexOf('`', at + 1)
                        check(end >= 0) { "Unterminated identifier at $start" }
                        tokens += Token(source.substring(at + 1, end), start)
                        at = end + 1
                    }
                    c == '}' && stopAtBrace -> { at++; return }
                    c == '{' -> {
                        tokens += Token("{", at++)
                        code(true)
                        tokens += Token("}", at - 1)
                    }
                    c.isLetterOrDigit() || c == '_' || c == '$' -> {
                        at++
                        while (at < source.length && (source[at].isLetterOrDigit() || source[at] in "_$")) at++
                        tokens += Token(source.substring(start, at), start)
                    }
                    else -> { tokens += Token(c.toString(), at); at++ }
                }
            }
            check(!stopAtBrace) { "Unterminated code block" }
        }

        private fun string(raw: Boolean) {
            val start = at
            val quote = source[at]
            val triple = source.startsWith(quote.toString().repeat(3), at)
            val delimiter = quote.toString().repeat(if (triple) 3 else 1)
            at += delimiter.length
            while (at < source.length) {
                when {
                    source.startsWith(delimiter, at) -> { at += delimiter.length; return }
                    !raw && !(language == "kt" && triple) && source[at] == '\\' -> at += 2
                    !raw && interpolates && source.startsWith("${'$'}{", at) -> {
                        at += 2
                        tokens += Token("{", at - 1)
                        code(true)
                        tokens += Token("}", at - 1)
                    }
                    else -> at++
                }
            }
            error("Unterminated string at $start")
        }
    }

    private val nativeNames = setOf(
        "ProcessBuilder", "exec", "fork", "vfork", "posix_spawn", "posix_spawnp",
        "execl", "execle", "execlp", "execv", "execve", "execvp", "execvpe", "fexecve", "execveat",
    )
    private val cLanguages = setOf("c", "cc", "cpp", "cxx", "h", "hpp")
    private val nativeLanguages = cLanguages + setOf("kt", "java")
    private val diagnosticJavaOwner = "app/android/app/src/main/kotlin/io/github/ccch1mneyyy/dsh_app/diagnostics/SystemImeLogcat.kt"
    private val updateJavaOwner = "app/android/app/src/main/kotlin/io/github/ccch1mneyyy/dsh_app/update/privileged/SelfUpdateInstallerService.kt"
    private val allowedNative = setOf(
        "app/android/app/src/main/kotlin/io/github/ccch1mneyyy/dsh_app/runtime/DshProcess.kt",
        // The explicit root channel's `su -c <fixed command>` (argv from RootCommands): also a
        // Java ProcessBuilder child, which closes inherited fds like DshProcess's launches.
        "app/android/app/src/main/kotlin/io/github/ccch1mneyyy/dsh_app/phone/background/RootProcess.kt",
        // Explicitly authorized Android Shell: Java-owned helper and its bounded child shell.
        "app/android/app/src/main/kotlin/io/github/ccch1mneyyy/dsh_app/phone/shell/AndroidShellProcess.kt",
        // The bounded privileged logcat reader also uses Java's fd-closing launcher.
        // The test below restricts this owner to one fixed-command ProcessBuilder.
        diagnosticJavaOwner,
        // Only the standard fixed-argv self-update command, separately constrained below.
        updateJavaOwner,
    )
    private val localHelper = "app/lib/remote/ssh/remote_shell.dart"

    private fun nativeCalls(source: String, language: String): List<Token> {
        val t = Code(source, language).read()
        val imports = t.indices.filter { t[it].text == "import" }.map { i ->
            // Consume the qualified name and optional Kotlin alias, not the
            // rest of the line: legal Kotlin statements can follow a semicolon.
            var end = i + 1
            if (t.getOrNull(end)?.text == "static") end++
            check(end < t.size) { "Incomplete import" }
            end++
            while (t.getOrNull(end)?.text == "." && end + 1 < t.size) end += 2
            if (t.getOrNull(end)?.text == "as") {
                check(end + 1 < t.size) { "Incomplete import alias" }
                end += 2
            }
            i until end
        }
        val aliases = t.indices.mapNotNull { i ->
            if (t[i].text == "ProcessBuilder" && t.getOrNull(i + 1)?.text == "as") t.getOrNull(i + 2)?.text else null
        }.toSet()
        val names = nativeNames + aliases + if (language in cLanguages) setOf("system", "popen") else emptySet()
        return t.indices.filter { i ->
            val name = t[i].text
            val previous = t.getOrNull(i - 1)?.text
            val imported = imports.any { i in it }
            // Type aliases and parameters can start a builder elsewhere without
            // spelling its constructor. A new non-import type use needs review.
            val builderReference = name in aliases + "ProcessBuilder" && !imported
            val callableReference = name in names && !imported &&
                (previous == ":" || (language in cLanguages && previous == "&"))
            val call = name in names && t.getOrNull(i + 1)?.text == "(" &&
                previous !in setOf("fun", "class", "interface") &&
                // A preceding type denotes a Java/C declaration, not an invocation.
                !(previous != null && previous.matches(Regex("[A-Za-z_][A-Za-z_0-9]*")) &&
                    previous !in setOf("new", "return", "throw", "await", "else"))
            builderReference || callableReference || call
        }.map { t[it] }
    }

    private fun helperDefinition(tokens: List<Token>, path: String): IntRange? {
        if (path != localHelper) return null
        val definitions = tokens.indices.filter {
            tokens[it].text == "class" && tokens.getOrNull(it + 1)?.text == "LocalProcessShell"
        }
        check(definitions.size == 1) { "Review the LocalProcessShell exception if its definition moves or changes" }
        val start = definitions.single()
        val open = (start until tokens.size).first { tokens[it].text == "{" }
        var depth = 0
        for (i in open until tokens.size) {
            if (tokens[i].text == "{") depth++
            if (tokens[i].text == "}") {
                depth--
                if (depth == 0) return start..i
            }
        }
        error("Unterminated LocalProcessShell definition")
    }

    private fun dartProblems(source: String, path: String): List<Token> {
        val t = Code(source, "dart").read()
        val helper = helperDefinition(t, path)
        val typedefTargets = t.indices.filter { t[it].text == "typedef" }.flatMap { start ->
            val end = (start until t.size).firstOrNull { t[it].text == ";" } ?: t.size
            val equals = (start until end).firstOrNull { t[it].text == "=" }
            if (equals == null) emptyList() else (equals + 1 until end).filter { t[it].text == "Process" }
        }.toSet()
        val className = helper?.first?.plus(1)
        val constructor = helper?.let { range ->
            val member = (range.first..range.last).first { t[it].text == "{" } + 1
            check(t[member].text == "LocalProcessShell" && t.getOrNull(member + 1)?.text == "(") {
                "Review the helper exception if its constructor declaration changes"
            }
            member
        }
        return t.indices.filter { i ->
            val process = t[i].text == "Process" && t.getOrNull(i + 1)?.text == "." &&
                t.getOrNull(i + 2)?.text in setOf("run", "runSync", "start")
            // Disallow tear-offs as well as immediate calls: a saved launcher is
            // still a new launch entry point. Likewise no production reference
            // to the test-only helper beyond its class/constructor declaration.
            val helperUse = path.startsWith("app/lib/") && t[i].text == "LocalProcessShell" &&
                i != className && i != constructor
            // Dart permits P.run after `typedef P = Process`. Reject at the
            // alias definition, even if the eventual use is in another part.
            ((process || i in typedefTargets) && (helper == null || i !in helper)) || helperUse
        }.map { t[it] }
    }

    private fun repository(): File = generateSequence(File(System.getProperty("user.dir")).canonicalFile) { it.parentFile }
        .firstOrNull { File(it, "app/pubspec.yaml").isFile && File(it, "packages").isDirectory }
        ?: error("Run this source guard inside the repository")

    private fun files(directory: File): List<File> = directory.walkTopDown()
        .onEnter { it.name !in setOf("build", ".gradle", ".dart_tool", ".git") }
        .filter { it.isFile }.toList()

    private fun location(path: String, source: String, token: Token) =
        "$path:${1 + source.take(token.offset).count { it == '\n' }}: ${token.text}"

    @Test fun nativeLaunchesOnlyUseTheReviewedJavaOwner() {
        val root = repository()
        // JVM tests start host tools (java, sh, mkfifo) on the build machine; they never ship.
        val jvmTests = File(root, "app/android/app/src/test").toPath()
        val sourceFiles = files(File(root, "app/android")).filter {
            it.extension in nativeLanguages && !it.toPath().startsWith(jvmTests)
        }
        assertTrue("The Android source tree must be present", sourceFiles.isNotEmpty())
        for (allowed in allowedNative) assertTrue("The reviewed launcher must be present: $allowed", File(root, allowed).isFile)
        val violations = sourceFiles.flatMap { file ->
            val path = file.relativeTo(root).invariantSeparatorsPath
            val source = file.readText()
            nativeCalls(source, file.extension).filter { path !in allowedNative }.map { location(path, source, it) }
        }
        assertEquals("New launch sites may inherit API 26 configuration fds; use a reviewed Java owner.\n" +
            violations.joinToString("\n"), emptyList<String>(), violations)
    }

    @Test fun diagnosticOwnerHasOnlyTheFixedJavaLogcatLaunch() {
        val source = File(repository(), diagnosticJavaOwner).readText()
        val calls = nativeCalls(source, "kt")
        assertEquals(listOf("ProcessBuilder"), calls.map { it.text })
        val expected = listOf("ProcessBuilder", "(", "SystemImeEvidence", ".", "command", ")",
            ".", "redirectErrorStream", "(", "true", ")", ".", "start", "(", ")")
        val actual = Code(source.substring(calls.single().offset), "kt").read().take(expected.size).map { it.text }
        assertEquals(expected, actual)
    }

    @Test fun shellOwnerOnlyLaunchesItsReviewedHelperAndAndroidSh() {
        val path = "app/android/app/src/main/kotlin/io/github/ccch1mneyyy/dsh_app/phone/shell/AndroidShellProcess.kt"
        val source = File(repository(), path).readText()
        val calls = nativeCalls(source, "kt")
        val constructors = calls.filter { Code(source.substring(it.offset), "kt").read().getOrNull(1)?.text == "(" }
        assertEquals(listOf("ProcessBuilder", "ProcessBuilder"), constructors.map { it.text })
        val redirects = calls.filterNot { it in constructors }
        assertEquals(2, redirects.size)
        for (reference in redirects) assertEquals(listOf("ProcessBuilder", ".", "Redirect", ".", "INHERIT"),
            Code(source.substring(reference.offset), "kt").read().take(5).map { it.text })
        assertTrue(source.contains("\"/system/bin/app_process\", \"/system/bin\", AndroidShellJobMain::class.java.name"))
        assertTrue(source.contains("ProcessBuilder(\"/system/bin/sh\", \"-c\", args[1])"))
    }

    @Test fun selfUpdateOwnerOnlyLaunchesTheReviewedSystemInstaller() {
        val source = File(repository(), updateJavaOwner).readText()
        val calls = nativeCalls(source, "kt")
        assertEquals(listOf("ProcessBuilder"), calls.map { it.text })
        val expected = listOf("ProcessBuilder", "(", "SelfUpdatePolicy", ".", "installArgv", "(",
            "userId", ",", "size", ")", ")")
        assertEquals(expected, Code(source.substring(calls.single().offset), "kt").read()
            .take(expected.size).map { it.text })
        assertTrue(source.contains("environment().clear()"))
        assertTrue(source.contains("redirectErrorStream(true)"))
    }

    @Test fun productionDartCannotLaunchOrConstructTheLocalTestShell() {
        val root = repository()
        val directories = listOf(File(root, "app/lib")) + File(root, "packages").listFiles().orEmpty()
            .filter { it.isDirectory }.map { File(it, "lib") }.filter { it.isDirectory }
        assertTrue(File(root, localHelper).isFile)
        val sourceFiles = directories.flatMap(::files).filter { it.extension == "dart" }
        assertTrue("Production Dart sources must be present", sourceFiles.isNotEmpty())
        val violations = sourceFiles.flatMap { file ->
            val path = file.relativeTo(root).invariantSeparatorsPath
            val source = file.readText()
            dartProblems(source, path).map { location(path, source, it) }
        }
        assertEquals("Dart subprocesses bypass the API 26 Java fd-closing premise.\n" +
            violations.joinToString("\n"), emptyList<String>(), violations)
    }

    @Test fun nativeChecksCallsInsteadOfExecutePrefixesOrLiteralText() {
        val source = """
            // Runtime.getRuntime().exec("not a call")
            /* ProcessBuilder("text") */
            val description = "fork() and ProcessBuilder()"
            executor.execute { worker.execute(task) }
            engine.dartExecutor.executeDartEntrypoint(entry)
            env.system().apps()
            fun exec(command: String) = command
        """.trimIndent()
        assertTrue(nativeCalls(source, "kt").isEmpty())
        assertTrue(nativeCalls("pid_t fork(void); int execve(const char *, char **, char **);", "c").isEmpty())
    }

    @Test fun nativeCallsIncludeAliasesQualifiedNamesAndAllPosixExecVariants() {
        assertEquals(2, nativeCalls("new java.lang.ProcessBuilder(args); Runtime.getRuntime().exec(args);", "java").size)
        assertEquals(1, nativeCalls("import java.lang.ProcessBuilder as PB\nval p = PB(args)", "kt").size)
        for (name in nativeNames - setOf("ProcessBuilder", "exec") + setOf("system", "popen")) {
            assertEquals(name, listOf(name), nativeCalls("auto result = ::$name(args);", "cpp").map { it.text })
        }
    }

    @Test fun builderTypeAliasesAndParametersCannotHideAnOutsideStart() {
        val alias = "typealias Launcher = java.lang.ProcessBuilder; fun launch() = Launcher(\"true\").start()"
        assertEquals(listOf("ProcessBuilder"), nativeCalls(alias, "kt").map { it.text })
        assertEquals(1, nativeCalls("fun launch(builder: ProcessBuilder) = builder.start()", "kt").size)
        assertEquals(1, nativeCalls("import java.lang.ProcessBuilder as PB\nfun launch(builder: PB) = builder.start()", "kt").size)
        assertTrue(nativeCalls("import java.lang.ProcessBuilder\nval label = \"ProcessBuilder\"", "kt").isEmpty())
    }

    @Test fun nativeCallableReferencesCannotSaveASeparateLaunchEntryPoint() {
        assertEquals(1, nativeCalls("val launch = Runtime.getRuntime()::exec", "kt").size)
        assertEquals(1, nativeCalls("val launch = ProcessBuilder::start", "kt").size)
        assertEquals(1, nativeCalls("var launch = Runtime.getRuntime()::exec;", "java").size)
        assertEquals(1, nativeCalls("auto launch = &posix_spawn; launch(args);", "cpp").size)
    }

    @Test fun anImportCannotHideAnotherStatementOnTheSameLine() {
        val source = "import java.lang.ProcessBuilder; typealias Launcher = ProcessBuilder\nfun launch() = Launcher(\"true\").start()"
        assertEquals(listOf("ProcessBuilder"), nativeCalls(source, "kt").map { it.text })
        assertEquals(1, nativeCalls("import java.lang.ProcessBuilder as PB; typealias Launcher = PB\nfun launch() = Launcher(\"true\").start()", "kt").size)
        assertTrue(nativeCalls("import /* ; not a delimiter */ java.lang.ProcessBuilder\nval name = \"text\"", "kt").isEmpty())
        assertTrue(nativeCalls("import java.lang.\nProcessBuilder;", "java").isEmpty())
    }

    @Test fun interpolationContainsExecutableCodeButRawLiteralTextDoesNot() {
        assertEquals(1, nativeCalls("val value = \"${'$'}{Runtime.getRuntime().exec(args)}\"", "kt").size)
        assertEquals(1, dartProblems("final x = '${'$'}{Process.run(\"sh\", [])}';", "app/lib/probe.dart").size)
        assertTrue(dartProblems("final x = r'${'$'}{Process.run(\"sh\", [])}';", "app/lib/probe.dart").isEmpty())
        assertTrue(nativeCalls("auto text = R\"tag(fork() and execve())tag\";", "cpp").isEmpty())
    }

    @Test fun dartChecksQualifiedCallsAndSavedLaunchers() {
        for (method in listOf("run", "runSync", "start")) {
            assertEquals(1, dartProblems("await io.Process.$method('sh', []);", "packages/example/lib/main.dart").size)
            assertEquals(1, dartProblems("final launch = Process.$method; launch('sh', []);", "app/lib/probe.dart").size)
        }
        assertTrue(dartProblems("// Process.start()\nfinal text = 'Process.run()'; queue.execute();", "app/lib/probe.dart").isEmpty())
    }

    @Test fun dartProcessTypeAliasesAreCheckedAtTheirDefinition() {
        assertEquals(1, dartProblems("typedef P = Process; Future<void> launch() async { await P.run('true', []); }", "app/lib/probe.dart").size)
        assertEquals(1, dartProblems("typedef P<T> = io.Process;", "packages/example/lib/alias.dart").size)
        assertTrue(dartProblems("typedef Run = Future<void> Function(); // typedef P = Process;", "app/lib/probe.dart").isEmpty())
    }

    @Test fun localShellExceptionIsOnlyTheOneDefinitionNotTheWholeFile() {
        val definition = "class LocalProcessShell implements RemoteShell { LocalProcessShell(); void run() { Process.start('sh', []); } }"
        assertTrue(dartProblems(definition, localHelper).isEmpty())
        assertEquals(1, dartProblems(definition + " void other() { Process.run('sh', []); }", localHelper).size)
        assertEquals(1, dartProblems(definition + " final shell = LocalProcessShell();", localHelper).size)
        assertEquals(1, dartProblems("final shell = LocalProcessShell();", "app/lib/probe.dart").size)
        assertEquals(1, dartProblems("final create = LocalProcessShell.new;", "app/lib/probe.dart").size)
        assertEquals(1, dartProblems("typedef Alias = LocalProcessShell;", "app/lib/probe.dart").size)
    }
}
