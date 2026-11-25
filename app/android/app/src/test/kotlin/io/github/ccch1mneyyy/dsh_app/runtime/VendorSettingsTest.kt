package io.github.ccch1mneyyy.dsh_app.runtime

import io.github.ccch1mneyyy.dsh_app.runtime.VendorSettings.Switch
import org.junit.Assert.*
import org.junit.Test

class VendorSettingsTest {
    private fun vendor(manufacturer: String?, brand: String? = null) = VendorSettings.vendorOf(manufacturer, brand)

    @Test fun mapsMakersAndSubBrands() {
        assertEquals("vivo", vendor("vivo", "vivo"))
        assertEquals("vivo", vendor("vivo", "iQOO"))
        assertEquals("xiaomi", vendor("Xiaomi", "Redmi"))
        assertEquals("xiaomi", vendor("Xiaomi", "POCO"))
        assertEquals("huawei", vendor("HUAWEI", "HUAWEI"))
        assertEquals("honor", vendor("HONOR", "HONOR"))
        assertEquals("oppo", vendor("OnePlus", "OnePlus"))
        assertEquals("oppo", vendor("realme", "realme"))
        assertEquals("oppo", vendor("OPPO", "OPPO"))
        assertEquals("samsung", vendor("samsung", "samsung"))
    }

    @Test fun huaweiEraHonorUsesHuaweisManager() {
        // Honor phones made by Huawei report MANUFACTURER=HUAWEI and run EMUI's manager.
        assertEquals("huawei", vendor("HUAWEI", "HONOR"))
    }

    @Test fun brandFillsInAndStockAndroidHasNone() {
        assertEquals("vivo", vendor(null, "iQOO"))
        assertNull(vendor("Google", "google"))
        assertNull(vendor(null, null))
        assertNull(vendor("  ", ""))
    }

    @Test fun backgroundPagesPerVendor() {
        assertEquals("com.vivo.abe", VendorSettings.pages("vivo").first().pkg)
        val xiaomi = VendorSettings.pages("xiaomi").single()
        assertEquals("package_name", xiaomi.packageExtra)
        assertEquals("package_label", xiaomi.labelExtra)
        assertEquals("com.hihonor.systemmanager", VendorSettings.pages("honor").first().pkg)
        assertEquals("com.huawei.systemmanager", VendorSettings.pages("huawei").first().pkg)
        // OPPO, Samsung and stock Android go straight to the app's details page.
        assertTrue(VendorSettings.pages("oppo").isEmpty())
        assertTrue(VendorSettings.pages("samsung").isEmpty())
        assertTrue(VendorSettings.pages(null).isEmpty())
    }

    @Test fun vivoHasAllThreeSwitches() {
        val autostart = VendorSettings.pages("vivo", Switch.AUTOSTART)
        assertEquals("com.vivo.permissionmanager.activity.BgStartUpManagerActivity", autostart.first().cls)
        assertTrue(autostart.any { it.pkg == "com.iqoo.secure" })
        val popup = VendorSettings.pages("vivo", Switch.POPUP)
        // The app's own permission page, named by package, first by component, then by action.
        assertEquals("com.vivo.permissionmanager.activity.SoftPermissionDetailActivity", popup[0].cls)
        assertEquals("packagename", popup[0].packageExtra)
        assertNull(popup[1].cls)
        assertEquals("permission.intent.action.softPermissionDetail", popup[1].action)
        assertEquals("packagename", popup[1].packageExtra)
    }

    @Test fun xiaomiAutostartAndPopUps() {
        assertEquals(
            "com.miui.permcenter.autostart.AutoStartManagementActivity",
            VendorSettings.pages("xiaomi", Switch.AUTOSTART).single().cls,
        )
        val popup = VendorSettings.pages("xiaomi", Switch.POPUP)
        assertTrue(popup.all { it.pkg == "com.miui.securitycenter" && it.packageExtra == "extra_pkgname" })
    }

    @Test fun huaweiAndHonorKeepStartUpWithBackground() {
        for (v in listOf("huawei", "honor", "oppo", "samsung", null)) {
            assertTrue("$v", VendorSettings.pages(v, Switch.AUTOSTART).isEmpty())
            assertTrue("$v", VendorSettings.pages(v, Switch.POPUP).isEmpty())
        }
    }

    @Test fun everyPageNamesAComponentOrAnAction() {
        for (v in listOf("vivo", "xiaomi", "huawei", "honor", "oppo", "samsung")) {
            for (s in Switch.values()) {
                for (p in VendorSettings.pages(v, s)) {
                    assertTrue("$v $s $p", (p.cls != null) != (p.action != null))
                    assertTrue("$v $s $p", p.pkg.isNotBlank())
                }
            }
        }
    }

    @Test fun switchesByWireName() {
        assertEquals(Switch.BACKGROUND, Switch.parse("background"))
        assertEquals(Switch.AUTOSTART, Switch.parse("autostart"))
        assertEquals(Switch.POPUP, Switch.parse("popup"))
        assertNull(Switch.parse("lockscreen"))
        assertNull(Switch.parse(null))
    }
}
