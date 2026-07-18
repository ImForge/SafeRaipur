package xyz.imforge.guardian;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Custom plugins must be registered BEFORE super.onCreate().
        registerPlugin(GuardianTelephonyPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
