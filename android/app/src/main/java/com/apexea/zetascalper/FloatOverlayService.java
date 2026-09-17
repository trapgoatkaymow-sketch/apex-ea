package com.apexea.zetascalper;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.res.AssetManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.PixelFormat;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.provider.Settings;
import android.util.Base64;
import android.util.DisplayMetrics;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.ImageView;
import androidx.core.app.NotificationCompat;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * System overlay bubble so the trade script orb stays visible over MetaTrader
 * and other apps (requires Settings.canDrawOverlays).
 */
public class FloatOverlayService extends Service {
  public static final String ACTION_SHOW = "com.apexea.zetascalper.FLOAT_SHOW";
  public static final String ACTION_HIDE = "com.apexea.zetascalper.FLOAT_HIDE";
  public static final String ACTION_UPDATE = "com.apexea.zetascalper.FLOAT_UPDATE";
  public static final String EXTRA_PHOTO = "photoUrl";
  public static final String EXTRA_X = "x";
  public static final String EXTRA_Y = "y";
  public static final String EXTRA_LABEL = "label";

  private static final String CHANNEL_ID = "float_overlay";
  private static final int NOTIF_ID = 2716;
  private static final int BUBBLE_DP = 58;

  private final Handler mainHandler = new Handler(Looper.getMainLooper());
  private final ExecutorService photoExecutor = Executors.newSingleThreadExecutor();

  private WindowManager windowManager;
  private FrameLayout bubble;
  private ImageView photoView;
  private WindowManager.LayoutParams layoutParams;
  private String currentPhotoUrl = "";
  private boolean showing = false;

  @Override
  public IBinder onBind(Intent intent) {
    return null;
  }

  @Override
  public void onCreate() {
    super.onCreate();
    windowManager = (WindowManager) getSystemService(WINDOW_SERVICE);
    ensureChannel();
    startForeground(NOTIF_ID, buildNotification("Trade bubble active over other apps"));
  }

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    if (intent == null) {
      return START_STICKY;
    }
    String action = intent.getAction();
    if (ACTION_HIDE.equals(action)) {
      hideBubble();
      stopSelf();
      return START_NOT_STICKY;
    }
    if (ACTION_SHOW.equals(action) || ACTION_UPDATE.equals(action)) {
      String photo = intent.getStringExtra(EXTRA_PHOTO);
      float x = intent.getFloatExtra(EXTRA_X, -1f);
      float y = intent.getFloatExtra(EXTRA_Y, -1f);
      String label = intent.getStringExtra(EXTRA_LABEL);
      if (label != null && !label.trim().isEmpty()) {
        startForeground(NOTIF_ID, buildNotification(label.trim() + " · over other apps"));
      }
      showOrUpdate(photo, x, y);
      return START_STICKY;
    }
    return START_STICKY;
  }

  @Override
  public void onDestroy() {
    hideBubble();
    photoExecutor.shutdownNow();
    super.onDestroy();
  }

  public static boolean canDrawOverlays(Context context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true;
    return Settings.canDrawOverlays(context);
  }

  public static void openOverlaySettings(Context context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return;
    Intent intent =
        new Intent(
            Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
            Uri.parse("package:" + context.getPackageName()));
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
    context.startActivity(intent);
  }

  private void showOrUpdate(String photoUrl, float x, float y) {
    if (!canDrawOverlays(this)) {
      stopSelf();
      return;
    }
    mainHandler.post(
        () -> {
          ensureBubble();
          applyPosition(x, y);
          if (photoUrl != null && !photoUrl.equals(currentPhotoUrl)) {
            currentPhotoUrl = photoUrl;
            loadPhoto(photoUrl);
          }
          if (!showing && bubble != null && bubble.getParent() == null) {
            try {
              windowManager.addView(bubble, layoutParams);
              showing = true;
            } catch (Exception ignored) {
              showing = false;
            }
          } else if (showing && bubble != null) {
            try {
              windowManager.updateViewLayout(bubble, layoutParams);
            } catch (Exception ignored) {
              // ignore
            }
          }
        });
  }

  private void hideBubble() {
    mainHandler.post(
        () -> {
          if (bubble != null && bubble.getParent() != null && windowManager != null) {
            try {
              windowManager.removeView(bubble);
            } catch (Exception ignored) {
              // ignore
            }
          }
          showing = false;
        });
  }

  private void ensureBubble() {
    if (bubble != null) return;
    int size = dp(BUBBLE_DP);
    bubble = new FrameLayout(this);
    bubble.setClickable(true);
    bubble.setFocusable(true);

    GradientDrawable ring = new GradientDrawable();
    ring.setShape(GradientDrawable.OVAL);
    ring.setColor(0xE6101018);
    ring.setStroke(dp(2), 0xCCB388FF);
    bubble.setBackground(ring);
    bubble.setElevation(dp(8));

    photoView = new ImageView(this);
    photoView.setScaleType(ImageView.ScaleType.CENTER_CROP);
    FrameLayout.LayoutParams imgLp =
        new FrameLayout.LayoutParams(size - dp(6), size - dp(6), Gravity.CENTER);
    GradientDrawable clip = new GradientDrawable();
    clip.setShape(GradientDrawable.OVAL);
    clip.setColor(0xFF000000);
    photoView.setBackground(clip);
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
      photoView.setClipToOutline(true);
      photoView.setOutlineProvider(
          new android.view.ViewOutlineProvider() {
            @Override
            public void getOutline(View view, android.graphics.Outline outline) {
              outline.setOval(0, 0, view.getWidth(), view.getHeight());
            }
          });
    }
    bubble.addView(photoView, imgLp);
    photoView.setImageResource(R.mipmap.ic_launcher_round);

    layoutParams =
        new WindowManager.LayoutParams(
            size,
            size,
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                : WindowManager.LayoutParams.TYPE_PHONE,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS
                | WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED,
            PixelFormat.TRANSLUCENT);
    layoutParams.gravity = Gravity.TOP | Gravity.START;
    DisplayMetrics metrics = getResources().getDisplayMetrics();
    layoutParams.x = Math.max(0, metrics.widthPixels - size - dp(16));
    layoutParams.y = Math.max(dp(120), (int) (metrics.heightPixels * 0.35f));

    final float[] drag = new float[4];
    bubble.setOnTouchListener(
        (v, event) -> {
          switch (event.getActionMasked()) {
            case MotionEvent.ACTION_DOWN:
              drag[0] = event.getRawX();
              drag[1] = event.getRawY();
              drag[2] = layoutParams.x;
              drag[3] = layoutParams.y;
              return true;
            case MotionEvent.ACTION_MOVE:
              {
                float dx = event.getRawX() - drag[0];
                float dy = event.getRawY() - drag[1];
                layoutParams.x = (int) (drag[2] + dx);
                layoutParams.y = (int) (drag[3] + dy);
                try {
                  windowManager.updateViewLayout(bubble, layoutParams);
                } catch (Exception ignored) {
                  // ignore
                }
                return true;
              }
            case MotionEvent.ACTION_UP:
              {
                float dx = Math.abs(event.getRawX() - drag[0]);
                float dy = Math.abs(event.getRawY() - drag[1]);
                if (dx < dp(8) && dy < dp(8)) {
                  bringAppToFront();
                }
                return true;
              }
            default:
              return false;
          }
        });
  }

  private void applyPosition(float x, float y) {
    if (layoutParams == null) return;
    if (x >= 0 && y >= 0) {
      layoutParams.x = Math.max(0, (int) x);
      layoutParams.y = Math.max(0, (int) y);
    }
  }

  private void bringAppToFront() {
    Intent launch = new Intent(this, MainActivity.class);
    launch.addFlags(
        Intent.FLAG_ACTIVITY_NEW_TASK
            | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
            | Intent.FLAG_ACTIVITY_SINGLE_TOP);
    startActivity(launch);
  }

  private void loadPhoto(String raw) {
    final String src = raw == null ? "" : raw.trim();
    photoExecutor.execute(
        () -> {
          Bitmap bitmap = decodePhoto(src);
          if (bitmap == null) return;
          mainHandler.post(
              () -> {
                if (photoView != null) {
                  photoView.setImageBitmap(bitmap);
                }
              });
        });
  }

  private Bitmap decodePhoto(String src) {
    try {
      if (src.startsWith("data:image")) {
        int comma = src.indexOf(',');
        if (comma > 0) {
          byte[] bytes = Base64.decode(src.substring(comma + 1), Base64.DEFAULT);
          return BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
        }
      }
      if (src.startsWith("http://") || src.startsWith("https://")) {
        if (src.contains("localhost") || src.contains("127.0.0.1")) {
          return loadAssetPhoto(assetPathFromLocalhost(src));
        }
        HttpURLConnection conn = (HttpURLConnection) new URL(src).openConnection();
        conn.setConnectTimeout(8000);
        conn.setReadTimeout(8000);
        conn.setInstanceFollowRedirects(true);
        conn.connect();
        try (InputStream in = conn.getInputStream()) {
          return BitmapFactory.decodeStream(in);
        } finally {
          conn.disconnect();
        }
      }
      if (src.startsWith("file:///android_asset/")) {
        return loadAssetPhoto(src.substring("file:///android_asset/".length()));
      }
      if (src.startsWith("/")) {
        Bitmap fromAsset = loadAssetPhoto("public" + src);
        if (fromAsset != null) return fromAsset;
        // Fall back to live site for API photos packaged as relative paths.
        return decodePhoto("https://www.apex-ea.com" + src);
      }
      return loadAssetPhoto(src);
    } catch (Exception ignored) {
      return null;
    }
  }

  private String assetPathFromLocalhost(String src) {
    try {
      Uri uri = Uri.parse(src);
      String path = uri.getPath();
      if (path == null || path.isEmpty() || "/".equals(path)) return "public/logo.png";
      if (path.startsWith("/")) path = path.substring(1);
      if (!path.startsWith("public/")) path = "public/" + path;
      return path;
    } catch (Exception e) {
      return "public/logo.png";
    }
  }

  private Bitmap loadAssetPhoto(String assetPath) {
    if (assetPath == null || assetPath.isEmpty()) return null;
    String path = assetPath.startsWith("/") ? assetPath.substring(1) : assetPath;
    AssetManager assets = getAssets();
    String[] candidates =
        new String[] {
          path,
          path.startsWith("public/") ? path : "public/" + path,
          "public/logo.png"
        };
    for (String candidate : candidates) {
      try (InputStream in = assets.open(candidate)) {
        Bitmap bmp = BitmapFactory.decodeStream(in);
        if (bmp != null) return bmp;
      } catch (Exception ignored) {
        // try next
      }
    }
    return null;
  }

  private void ensureChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
    NotificationManager nm = getSystemService(NotificationManager.class);
    if (nm == null) return;
    NotificationChannel channel =
        new NotificationChannel(
            CHANNEL_ID, "Trade bubble overlay", NotificationManager.IMPORTANCE_LOW);
    channel.setDescription("Keeps the robot bubble visible over MetaTrader");
    channel.setShowBadge(false);
    nm.createNotificationChannel(channel);
  }

  private Notification buildNotification(String text) {
    Intent launch = new Intent(this, MainActivity.class);
    launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
    PendingIntent pi =
        PendingIntent.getActivity(
            this,
            0,
            launch,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    return new NotificationCompat.Builder(this, CHANNEL_ID)
        .setContentTitle("apex-ea")
        .setContentText(text == null || text.isEmpty() ? "Bubble over other apps" : text)
        .setSmallIcon(R.mipmap.ic_launcher)
        .setContentIntent(pi)
        .setOngoing(true)
        .setSilent(true)
        .build();
  }

  private int dp(int value) {
    return Math.round(value * getResources().getDisplayMetrics().density);
  }
}
