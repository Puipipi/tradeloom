package android.content

import java.io.File

class ApplicationInfo(val nativeLibraryDir: String)
class Context(val filesDir: File) {
    val cacheDir: File = File(filesDir, "cache")
    val applicationInfo = ApplicationInfo(File(filesDir, "lib").path)
}
