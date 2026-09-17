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
    Intent intent = new Intent(getContext(), FloatOverlayService.class);
    intent.setAction(FloatOverlayService.ACTION_SHOW);
    intent.putExtra(FloatOverlayService.EXTRA_PHOTO, call.getString("photoUrl", ""));
    Double xShow = call.getDouble("x", -1.0);
    Double yShow = call.getDouble("y", -1.0);
    intent.putExtra(FloatOverlayService.EXTRA_X, xShow == null ? -1f : xShow.floatValue());
    intent.putExtra(FloatOverlayService.EXTRA_Y, yShow == null ? -1f : yShow.floatValue());
    intent.putExtra(FloatOverlayService.EXTRA_LABEL, call.getString("label", "Trade bubble"));
    startOverlayService(intent);
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
    Intent intent = new Intent(getContext(), FloatOverlayService.class);
    intent.setAction(FloatOverlayService.ACTION_UPDATE);
    intent.putExtra(FloatOverlayService.EXTRA_PHOTO, call.getString("photoUrl", ""));
    Double xUp = call.getDouble("x", -1.0);
    Double yUp = call.getDouble("y", -1.0);
    intent.putExtra(FloatOverlayService.EXTRA_X, xUp == null ? -1f : xUp.floatValue());
    intent.putExtra(FloatOverlayService.EXTRA_Y, yUp == null ? -1f : yUp.floatValue());
    intent.putExtra(FloatOverlayService.EXTRA_LABEL, call.getString("label", "Trade bubble"));
    startOverlayService(intent);
    call.resolve(new JSObject().put("ok", true));
  }

  @PluginMethod
  public void hide(PluginCall call) {
    Intent intent = new Intent(getContext(), FloatOverlayService.class);
    intent.setAction(FloatOverlayService.ACTION_HIDE);
    getContext().startService(intent);
    call.resolve(new JSObject().put("ok", true));
  }

  private void startOverlayService(Intent intent) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      getContext().startForegroundService(intent);
    } else {
      getContext().startService(intent);
    }
  }
}
