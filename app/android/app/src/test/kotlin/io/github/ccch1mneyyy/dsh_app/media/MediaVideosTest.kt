package io.github.ccch1mneyyy.dsh_app.media

import java.io.File
import org.junit.Assert.*
import org.junit.Test

class MediaVideosTest {
    @Test fun onlyExistingAbsoluteLocalFilesAreAccepted() {
        assertFalse(MediaVideos.localFile("https://example.com/movie.mp4"))
        assertFalse(MediaVideos.localFile("content://media/video/12"))
        assertFalse(MediaVideos.localFile("relative.mp4"))
        assertFalse(MediaVideos.localFile(null))
        val file = File.createTempFile("media-video", ".mp4")
        try {
            assertTrue(MediaVideos.localFile(file.absolutePath))
            assertFalse(MediaVideos.localFile(file.parent))
        } finally { file.delete() }
    }
    @Test fun seekIsClampedBeforeConvertingToPlatformInt() {
        assertEquals(0, MediaVideos.seek(-100, 5_000))
        assertEquals(2_000, MediaVideos.seek(2_000, 5_000))
        assertEquals(5_000, MediaVideos.seek(Long.MAX_VALUE, 5_000))
        assertEquals(0, MediaVideos.seek(100, -1))
    }
    @Test fun postersAreSmallAndPreserveAspectWithoutUpscaling() {
        assertEquals(512 to 288, MediaVideos.posterSize(3840, 2160))
        assertEquals(288 to 512, MediaVideos.posterSize(1080, 1920))
        assertEquals(100 to 200, MediaVideos.posterSize(100, 200))
        assertEquals(1 to 512, MediaVideos.posterSize(1, 4096))
    }
}
