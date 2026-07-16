package xyz.imforge.guardian;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.provider.Telephony;
import android.telephony.SmsMessage;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Captures every inbound SMS the gateway SIM receives and appends it to the
 * shared inbox queue. The JS poll loop drains this queue and forwards each
 * message to gateway_inbound() — which is how a contact's "coming!" reply
 * becomes an ACK that halts the escalation ladder.
 *
 * Manifest-registered so it fires even if the WebView is momentarily busy.
 */
public class SmsReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        if (!Telephony.Sms.Intents.SMS_RECEIVED_ACTION.equals(intent.getAction())) return;

        try {
            SmsMessage[] msgs = Telephony.Sms.Intents.getMessagesFromIntent(intent);
            if (msgs == null || msgs.length == 0) return;

            // Multipart SMS arrive as several SmsMessage chunks from the same
            // sender — stitch them back into one body.
            String from = msgs[0].getDisplayOriginatingAddress();
            StringBuilder body = new StringBuilder();
            for (SmsMessage m : msgs) body.append(m.getMessageBody());

            SharedPreferences prefs = context.getSharedPreferences(
                GuardianTelephonyPlugin.INBOX_PREFS, Context.MODE_PRIVATE);

            JSONArray queue = new JSONArray(prefs.getString(
                GuardianTelephonyPlugin.INBOX_KEY, "[]"));

            JSONObject msg = new JSONObject();
            msg.put("from", from == null ? "" : from);
            msg.put("body", body.toString());
            msg.put("at", System.currentTimeMillis());
            queue.put(msg);

            prefs.edit().putString(GuardianTelephonyPlugin.INBOX_KEY,
                queue.toString()).apply();
        } catch (Exception ignored) {
            // A malformed carrier SMS must never crash the gateway process.
        }
    }
}
