import android.accessibilityservice.AccessibilityServiceInfo;
import android.app.UiAutomation;
import android.graphics.Rect;
import android.os.HandlerThread;
import android.os.Looper;
import android.util.Xml;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;
import org.xmlpull.v1.XmlSerializer;

/** Shell-only test helper: observe overlays without suspending their accessibility service. */
public final class PetUiDump {
    public static void main(String[] args) throws Exception {
        Looper.prepareMainLooper();
        HandlerThread thread = new HandlerThread("pet-ui-dump");
        thread.start();
        Class<?> connectionType = Class.forName("android.app.IUiAutomationConnection");
        Object connection = Class.forName("android.app.UiAutomationConnection").getConstructor().newInstance();
        UiAutomation ui = (UiAutomation) UiAutomation.class.getConstructor(Looper.class, connectionType)
                .newInstance(thread.getLooper(), connection);
        try {
            UiAutomation.class.getMethod("connect", int.class)
                    .invoke(ui, UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES);
            AccessibilityServiceInfo info = ui.getServiceInfo();
            info.flags |= AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS;
            ui.setServiceInfo(info);
            ui.clearCache();
            XmlSerializer xml = Xml.newSerializer();
            xml.setOutput(System.out, "UTF-8");
            xml.startDocument("UTF-8", true);
            xml.startTag(null, "hierarchy");
            for (AccessibilityWindowInfo window : ui.getWindows()) {
                AccessibilityNodeInfo root = window.getRoot();
                if (root != null) dump(xml, root, 0);
            }
            xml.endTag(null, "hierarchy");
            xml.endDocument();
            xml.flush();
        } finally {
            UiAutomation.class.getMethod("disconnect").invoke(ui);
            thread.quitSafely();
        }
        System.exit(0);
    }

    private static void dump(XmlSerializer xml, AccessibilityNodeInfo node, int depth) throws Exception {
        if (depth > 50 || !node.isVisibleToUser()) return;
        Rect bounds = new Rect();
        node.getBoundsInScreen(bounds);
        xml.startTag(null, "node");
        xml.attribute(null, "package", value(node.getPackageName()));
        xml.attribute(null, "class", value(node.getClassName()));
        xml.attribute(null, "text", value(node.getText()));
        xml.attribute(null, "content-desc", value(node.getContentDescription()));
        xml.attribute(null, "bounds", bounds.toShortString());
        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            if (child != null) dump(xml, child, depth + 1);
        }
        xml.endTag(null, "node");
    }

    private static String value(CharSequence text) { return text == null ? "" : text.toString(); }
}
