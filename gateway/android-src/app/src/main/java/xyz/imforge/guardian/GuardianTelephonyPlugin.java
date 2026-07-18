package xyz.imforge.guardian;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Build;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.telephony.SmsManager;

import java.util.HashMap;
import java.util.Locale;

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
    /**
     * Places a call AND speaks a message into it.
     *
     * Why this exists: a silent ringing phone proves nothing. If a contact
     * answers and hears dead air, they hang up thinking it's a spam call —
     * the single most important channel wasted. So after dialing we wait for
     * the callee to plausibly answer, then speak the emergency aloud through
     * the call audio, repeating it several times (people say "hello?" over
     * the first pass of any automated message).
     *
     * The honest limitation: Android gives apps NO reliable way to detect
     * "the other side answered" without READ_PHONE_STATE + a call listener,
     * and even then, carrier-dependent. So we use a fixed delay: dial, wait
     * ~8s (typical answer window), then speak on repeat. Some of the message
     * may land on voicemail or be missed if they answer late — which is
     * exactly why the SMS with the map link ALWAYS goes out too. The call is
     * the attention-getter; the SMS is the payload.
     */
    @PluginMethod
    public void placeCall(PluginCall call) {
        if (!hasTelephonyPerms()) { requestAllPermissions(call, "permsThenRetry"); return; }
        String to = call.getString("to");
        String speak = call.getString("speak");   // optional: message to read aloud
        if (to == null || to.isEmpty()) { call.reject("missing 'to'"); return; }
        try {
            Intent intent = new Intent(Intent.ACTION_CALL, Uri.parse("tel:" + to));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);

            if (speak != null && !speak.isEmpty()) {
                speakIntoCall(speak);
            }
            call.resolve(ok());
        } catch (SecurityException e) {
            call.reject("CALL_PHONE permission denied: " + e.getMessage());
        } catch (Exception e) {
            call.reject("Call failed: " + e.getMessage());
        }
    }

    /** Speak text through the call audio path, on repeat, after an answer delay. */
    private void speakIntoCall(final String text) {
        final Context ctx = getContext();
        new Thread(() -> {
            TextToSpeech[] holder = new TextToSpeech[1];
            try {
                Thread.sleep(8000); // give them time to actually answer

                holder[0] = new TextToSpeech(ctx, status -> {
                    if (status != TextToSpeech.SUCCESS) return;
                    TextToSpeech tts = holder[0];
                    tts.setLanguage(Locale.US);
                    tts.setSpeechRate(0.9f);   // slightly slow: clarity under stress

                    // Route audio into the voice call, and force speaker so the
                    // gateway's mic picks it up on handsets that won't inject
                    // TTS directly into the uplink.
                    AudioManager am = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
                    if (am != null) {
                        am.setMode(AudioManager.MODE_IN_CALL);
                        am.setSpeakerphoneOn(true);
                        am.setStreamVolume(AudioManager.STREAM_VOICE_CALL,
                            am.getStreamMaxVolume(AudioManager.STREAM_VOICE_CALL), 0);
                    }

                    HashMap<String, String> params = new HashMap<>();
                    params.put(TextToSpeech.Engine.KEY_PARAM_STREAM,
                               String.valueOf(AudioManager.STREAM_VOICE_CALL));

                    // repeat 3x — the first pass is usually talked over
                    for (int i = 0; i < 3; i++) {
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                            android.os.Bundle b = new android.os.Bundle();
                            b.putInt(TextToSpeech.Engine.KEY_PARAM_STREAM,
                                     AudioManager.STREAM_VOICE_CALL);
                            tts.speak(text, i == 0 ? TextToSpeech.QUEUE_FLUSH
                                                   : TextToSpeech.QUEUE_ADD, b, "grd" + i);
                        } else {
                            tts.speak(text, i == 0 ? TextToSpeech.QUEUE_FLUSH
                                                   : TextToSpeech.QUEUE_ADD, params);
                        }
                    }
                });
            } catch (Exception ignored) {
                // TTS must never crash the gateway; the SMS still carries the payload.
            }
        }).start();
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
