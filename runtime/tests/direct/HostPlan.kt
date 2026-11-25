package io.github.ccch1mneyyy.dsh_app.runtime

import java.io.File

/** Host harness calls the production Android launch planner, not a second implementation. */
fun main(args: Array<String>) {
    require(args.size in 6..7) { "rootfs abi argv-nul env-nul output-directory host-shell [direct|proot]" }
    val requested = args.getOrElse(6) { "direct" }
    require(requested in listOf("direct", "proot"))
    val argv = File(args[2]).readText().split('\u0000').filter { it.isNotEmpty() }
    val env = File(args[3]).readText().split('\u0000').filter { it.isNotEmpty() }.associate {
        val split = it.indexOf('=')
        require(split > 0)
        it.substring(0, split) to it.substring(split + 1)
    }
    val root = File(args[0])
    val selection = DirectLaunch.select(root, requested = requested == "direct", safe = false)
    val compatible = DirectLaunch.prootArguments(root, argv, selection.direct)
    val plan = if (selection.direct) DirectLaunch.prepare(root, args[1], compatible, env, args[5])
        else DirectLaunch.Plan(compatible, env, File(root, "root"))
    val out = File(args[4]).apply { mkdirs() }
    File(out, "selection.json").writeText("{\"requested\":\"$requested\",\"actual\":\"${if (selection.direct) "direct" else "proot"}\",\"fallbackReason\":${selection.fallbackReason?.let { "\"$it\"" } ?: "null"}}\n")
    File(out, "argv.nul").writeText(plan.argv.joinToString("\u0000", postfix = "\u0000"))
    File(out, "env.nul").writeText(plan.environment.map { "${it.key}=${it.value}" }.joinToString("\u0000", postfix = "\u0000"))
    File(out, "cwd.txt").writeText(plan.cwd.path)
}
