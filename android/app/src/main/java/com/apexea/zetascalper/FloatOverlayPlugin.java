package com.apexea.zetascalper;

import android.content.Intent;
import android.os.Build;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "FloatOverlay")
public class FloatOverlayPlugin extends Plugin {

  @PluginMethod
  public void checkPermission(PluginCall call) {
    JSObject ret = new JSObject();
    ret.put("granted", FloatOverlayService.canDrawOverlays(getContext()));
    call.resolve(ret);
  }

  @PluginMethod
  public void requestPermission(PluginCall call) {
    boolean granted = FloatOverlayService.canDrawOverlays(getContext());
    if (!granted) {
      FloatOverlayService.openOverlaySettings(getContext());
    }
    JSObject ret = new JSObject();
    ret.put("granted", granted);
    ret.put("openedSettings", !granted);
    call.resolve(ret);
  }

  @PluginMethod
  public void show(PluginCall call) {
    if (!FloatOverlayService.canDrawOverlays(getContext())) {
      call.reject("Overlay permission not granted");
      return;
    }
    startOverlayService(buildIntent(FloatOverlayService.ACTION_SHOW, call));
    JSObject ret = new JSObject();
    ret.put("ok", true);
    call.resolve(ret);
  }

  @PluginMethod
  public void update(PluginCall call) {
    if (!FloatOverlayService.canDrawOverlays(getContext())) {
      call.resolve(new JSObject().put("ok", false));
      return;
    }
    startOverlayService(buildIntent(FloatOverlayService.ACTION_UPDATE, call));
    call.resolve(new JSObject().put("ok", true));
  }

  @PluginMethod
  public void hide(PluginCall call) {
    Intent intent = new Intent(getContext(), FloatOverlayService.class);
    intent.setAction(FloatOverlayService.ACTION_HIDE);
    getContext().startService(intent);
    call.resolve(new JSObject().put("ok", true));
  }

  private Intent buildIntent(String action, PluginCall call) {
    Intent intent = new Intent(getContext(), FloatOverlayService.class);
    intent.setAction(action);
    intent.putExtra(FloatOverlayService.EXTRA_PHOTO, call.getString("photoUrl", ""));
    intent.putExtra(FloatOverlayService.EXTRA_BOT_ID, call.getString("botId", ""));
    Double x = call.getDouble("x", -1.0);
    Double y = call.getDouble("y", -1.0);
    intent.putExtra(FloatOverlayService.EXTRA_X, x == null ? -1f : x.floatValue());
    intent.putExtra(FloatOverlayService.EXTRA_Y, y == null ? -1f : y.floatValue());
    intent.putExtra(FloatOverlayService.EXTRA_LABEL, call.getString("label", "Trade bubble"));
    intent.putExtra(FloatOverlayService.EXTRA_HISTORY, call.getString("historyText", ""));
    Boolean openHistory = call.getBoolean("openHistory", false);
    intent.putExtra(FloatOverlayService.EXTRA_OPEN_HISTORY, Boolean.TRUE.equals(openHistory));
    return intent;
  }

  private void startOverlayService(Intent intent) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      getContext().startForegroundService(intent);
    } else {
      getContext().startService(intent);
    }
  }
}
