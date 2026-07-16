package xyz.imforge.guardian;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.telephony.SmsManager;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import org.json.JSONArray;

import java.util.ArrayList;

/**
 * GuardianTelephony — the gateway phone's hands.
 *
 * Three verbs, mirroring the backend's three verbs:
 *   sendSms(to, body)  — physically sends an SMS through the SIM
 *   placeCall(to)      — physically dials (ACTION_CALL, no user tap needed)
 *   drainInbox()       — returns + clears inbound SMS captured by SmsReceiver
 *
 * Design note: inbound SMS arrive in SmsReceiver (a manifest-registered
 * BroadcastReceiver that runs even when the WebView is busy). The receiver
 * appends them to a SharedPreferences-backed queue; the JS loop drains that
 * queue on every poll tick. No fragile in-memory handoff, no lost messages
 * if a text lands mid-restart.
 */
@CapacitorPlugin(
    name = "GuardianTelephony",
    permissions = {
        @Permission(alias = "telephony", strings = {
            Manifest.permission.SEND_SMS,
            Manifest.permission.CALL_PHONE,
            Manifest.permission.RECEIVE_SMS
        })
    }
)
public class GuardianTelephonyPlugin extends Plugin {

    static final String INBOX_PREFS = "guardian_inbox";
    static final String INBOX_KEY = "queue";

    // ------------------------------------------------------------------ SMS
    @PluginMethod
    public void sendSms(PluginCall call) {
        if (!hasTelephonyPerms()) { requestAllPermissions(call, "permsThenRetry"); return; }
        String to = call.getString("to");
        String body = call.getString("body", "");
        if (to == null || to.isEmpty()) { call.reject("missing 'to'"); return; }
        try {
            SmsManager sms = SmsManager.getDefault();
            // Emergency texts can exceed 160 chars (maps links) → multipart.
            ArrayList<String> parts = sms.divideMessage(body);
            sms.sendMultipartTextMessage(to, null, parts, null, null);
            call.resolve(ok());
        } catch (Exception e) {
            call.reject("SMS send failed: " + e.getMessage());
        }
    }

    // ----------------------------------------------------------------- CALL
    @PluginMethod
    public void placeCall(PluginCall call) {
        if (!hasTelephonyPerms()) { requestAllPermissions(call, "permsThenRetry"); return; }
        String to = call.getString("to");
        if (to == null || to.isEmpty()) { call.reject("missing 'to'"); return; }
        try {
            Intent intent = new Intent(Intent.ACTION_CALL, Uri.parse("tel:" + to));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve(ok());
        } catch (SecurityException e) {
            call.reject("CALL_PHONE permission denied: " + e.getMessage());
        } catch (Exception e) {
            call.reject("Call failed: " + e.getMessage());
        }
    }

    // ---------------------------------------------------------------- INBOX
    @PluginMethod
    public void drainInbox(PluginCall call) {
        try {
            SharedPreferences prefs = getContext()
                .getSharedPreferences(INBOX_PREFS, Context.MODE_PRIVATE);
            String raw = prefs.getString(INBOX_KEY, "[]");
            prefs.edit().putString(INBOX_KEY, "[]").apply();
            JSObject out = new JSObject();
            out.put("messages", JSArray.from(new JSONArray(raw)));
            call.resolve(out);
        } catch (Exception e) {
            call.reject("drainInbox failed: " + e.getMessage());
        }
    }

    // ---------------------------------------------------------- PERMISSIONS
    @PluginMethod
    public void ensurePermissions(PluginCall call) {
        if (hasTelephonyPerms()) { call.resolve(ok()); }
        else { requestAllPermissions(call, "permsThenRetry"); }
    }

    @PermissionCallback
    private void permsThenRetry(PluginCall call) {
        if (hasTelephonyPerms()) { call.resolve(ok()); }
        else { call.reject("Telephony permissions denied — gateway cannot operate"); }
    }

    private boolean hasTelephonyPerms() {
        return getPermissionState("telephony") == com.getcapacitor.PermissionState.GRANTED;
    }

    private JSObject ok() {
        JSObject o = new JSObject();
        o.put("ok", true);
        return o;
    }
}
