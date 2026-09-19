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
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.provider.Settings;
import android.text.method.ScrollingMovementMethod;
import android.util.Base64;
import android.util.DisplayMetrics;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import androidx.core.app.NotificationCompat;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * System overlay bubble so the EA photo stays visible over MetaTrader.
 * Tap opens trade History without leaving the other app.
 */
public class FloatOverlayService extends Service {
  public static final String ACTION_SHOW = "com.apexea.zetascalper.FLOAT_SHOW";
  public static final String ACTION_HIDE = "com.apexea.zetascalper.FLOAT_HIDE";
  public static final String ACTION_UPDATE = "com.apexea.zetascalper.FLOAT_UPDATE";
  public static final String EXTRA_PHOTO = "photoUrl";
  public static final String EXTRA_BOT_ID = "botId";
  public static final String EXTRA_X = "x";
  public static final String EXTRA_Y = "y";
  public static final String EXTRA_LABEL = "label";
  public static final String EXTRA_HISTORY = "historyText";
  public static final String EXTRA_OPEN_HISTORY = "openHistory";

  private static final String CHANNEL_ID = "float_overlay";
  private static final int NOTIF_ID = 2716;
  private static final int BUBBLE_DP = 58;
  private static final int PANEL_WIDTH_DP = 280;
  private static final int PANEL_MAX_HEIGHT_DP = 360;
  private static final String GITHUB_RAW_BASE =
      "https://raw.githubusercontent.com/trapgoatkaymow-sketch/apex-ea/main/data/ea-photos/";

  private final Handler mainHandler = new Handler(Looper.getMainLooper());
  private final ExecutorService photoExecutor = Executors.newSingleThreadExecutor();

  private WindowManager windowManager;
  private FrameLayout bubble;
  private ImageView photoView;
  private LinearLayout historyPanel;
  private TextView historyBody;
  private TextView historyTitle;
  private WindowManager.LayoutParams layoutParams;
  private WindowManager.LayoutParams historyParams;
  private String currentPhotoKey = "";
  private String currentBotId = "";
  private String historyContent = "No trades taken yet.";
  private boolean showing = false;
  private boolean historyShowing = false;

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
      hideHistory();
      hideBubble();
      stopSelf();
      return START_NOT_STICKY;
    }
    if (ACTION_SHOW.equals(action) || ACTION_UPDATE.equals(action)) {
      String photo = intent.getStringExtra(EXTRA_PHOTO);
      String botId = intent.getStringExtra(EXTRA_BOT_ID);
      float x = intent.getFloatExtra(EXTRA_X, -1f);
      float y = intent.getFloatExtra(EXTRA_Y, -1f);
      String label = intent.getStringExtra(EXTRA_LABEL);
      String history = intent.getStringExtra(EXTRA_HISTORY);
      boolean openHistory = intent.getBooleanExtra(EXTRA_OPEN_HISTORY, false);
      if (history != null) {
        historyContent = history.trim().isEmpty() ? "No trades taken yet." : history.trim();
        if (historyBody != null) {
          mainHandler.post(() -> historyBody.setText(historyContent));
        }
      }
      if (label != null && !label.trim().isEmpty()) {
        startForeground(NOTIF_ID, buildNotification(label.trim() + " · tap for History"));
      }
      showOrUpdate(photo, botId, x, y);
      if (openHistory) {
        mainHandler.post(this::showHistory);
      }
      return START_STICKY;
    }
    return START_STICKY;
  }

  @Override
  public void onDestroy() {
    hideHistory();
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

  private void showOrUpdate(String photoUrl, String botId, float x, float y) {
    if (!canDrawOverlays(this)) {
      stopSelf();
      return;
    }
    mainHandler.post(
        () -> {
          ensureBubble();
          applyPosition(x, y);
          String nextBot = botId == null ? "" : botId.trim();
          String nextPhoto = photoUrl == null ? "" : photoUrl.trim();
          String key = nextBot + "|" + nextPhoto;
          if (!key.equals(currentPhotoKey)) {
            currentPhotoKey = key;
            currentBotId = nextBot;
            loadPhoto(nextPhoto, nextBot);
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
          if (historyShowing) {
            positionHistoryPanel();
            try {
              if (historyPanel != null && historyPanel.getParent() != null) {
                windowManager.updateViewLayout(historyPanel, historyParams);
              }
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
    ring.setStroke(dp(2), 0xCCFF2D7A);
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
    // Placeholder until EA photo loads — never leave the app-logo look if we can avoid it.
    photoView.setImageResource(android.R.drawable.ic_menu_gallery);

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
                if (historyShowing) {
                  positionHistoryPanel();
                  try {
                    if (historyPanel != null && historyPanel.getParent() != null) {
                      windowManager.updateViewLayout(historyPanel, historyParams);
                    }
                  } catch (Exception ignored) {
                    // ignore
                  }
                }
                return true;
              }
            case MotionEvent.ACTION_UP:
              {
                float dx = Math.abs(event.getRawX() - drag[0]);
                float dy = Math.abs(event.getRawY() - drag[1]);
                if (dx < dp(8) && dy < dp(8)) {
                  toggleHistory();
                }
                return true;
              }
            default:
              return false;
          }
        });
  }

  private void toggleHistory() {
    if (historyShowing) {
      hideHistory();
    } else {
      showHistory();
    }
  }

  private void showHistory() {
    ensureHistoryPanel();
    if (historyBody != null) {
      historyBody.setText(historyContent == null || historyContent.isEmpty()
          ? "No trades taken yet."
          : historyContent);
    }
    positionHistoryPanel();
    if (historyPanel != null && historyPanel.getParent() == null && windowManager != null) {
      try {
        windowManager.addView(historyPanel, historyParams);
        historyShowing = true;
      } catch (Exception ignored) {
        historyShowing = false;
      }
    } else if (historyPanel != null && historyPanel.getParent() != null) {
      try {
        windowManager.updateViewLayout(historyPanel, historyParams);
        historyShowing = true;
      } catch (Exception ignored) {
        // ignore
      }
    }
  }

  private void hideHistory() {
    mainHandler.post(
        () -> {
          if (historyPanel != null && historyPanel.getParent() != null && windowManager != null) {
            try {
              windowManager.removeView(historyPanel);
            } catch (Exception ignored) {
              // ignore
            }
          }
          historyShowing = false;
        });
  }

  private void ensureHistoryPanel() {
    if (historyPanel != null) return;

    historyPanel = new LinearLayout(this);
    historyPanel.setOrientation(LinearLayout.VERTICAL);
    historyPanel.setPadding(dp(14), dp(12), dp(14), dp(12));
    GradientDrawable bg = new GradientDrawable();
    bg.setCornerRadius(dp(18));
    bg.setColor(0xF214141C);
    bg.setStroke(dp(1), 0x66FF2D7A);
    historyPanel.setBackground(bg);
    historyPanel.setElevation(dp(12));

    LinearLayout head = new LinearLayout(this);
    head.setOrientation(LinearLayout.HORIZONTAL);
    head.setGravity(Gravity.CENTER_VERTICAL);

    historyTitle = new TextView(this);
    historyTitle.setText("History");
    historyTitle.setTextColor(Color.WHITE);
    historyTitle.setTypeface(Typeface.DEFAULT_BOLD);
    historyTitle.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
    LinearLayout.LayoutParams titleLp =
        new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
    head.addView(historyTitle, titleLp);

    TextView close = new TextView(this);
    close.setText("Close");
    close.setTextColor(0xFFFF7AB5);
    close.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
    close.setPadding(dp(8), dp(4), dp(4), dp(4));
    close.setOnClickListener(v -> hideHistory());
    head.addView(close);

    historyPanel.addView(
        head,
        new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));

    TextView note = new TextView(this);
    note.setText("Taken trades · stays over other apps");
    note.setTextColor(0x99FFFFFF);
    note.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11);
    note.setPadding(0, dp(2), 0, dp(8));
    historyPanel.addView(
        note,
        new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));

    ScrollView scroll = new ScrollView(this);
    scroll.setFillViewport(true);
    historyBody = new TextView(this);
    historyBody.setText(historyContent);
    historyBody.setTextColor(0xFFEDEDF2);
    historyBody.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12.5f);
    historyBody.setLineSpacing(dp(2), 1.15f);
    historyBody.setTypeface(Typeface.MONOSPACE);
    historyBody.setMovementMethod(new ScrollingMovementMethod());
    scroll.addView(
        historyBody,
        new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT));
    historyPanel.addView(
        scroll,
        new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.MATCH_PARENT));

    historyParams =
        new WindowManager.LayoutParams(
            dp(PANEL_WIDTH_DP),
            dp(PANEL_MAX_HEIGHT_DP),
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                : WindowManager.LayoutParams.TYPE_PHONE,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS
                | WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED,
            PixelFormat.TRANSLUCENT);
    historyParams.gravity = Gravity.TOP | Gravity.START;
  }

  private void positionHistoryPanel() {
    if (historyParams == null || layoutParams == null) return;
    DisplayMetrics metrics = getResources().getDisplayMetrics();
    int panelW = dp(PANEL_WIDTH_DP);
    int panelH = dp(PANEL_MAX_HEIGHT_DP);
    int bubbleSize = dp(BUBBLE_DP);
    int gap = dp(10);

    int x = layoutParams.x - panelW - gap;
    if (x < dp(8)) {
      x = layoutParams.x + bubbleSize + gap;
    }
    if (x + panelW > metrics.widthPixels - dp(8)) {
      x = Math.max(dp(8), metrics.widthPixels - panelW - dp(8));
    }

    int y = layoutParams.y - dp(20);
    if (y < dp(48)) y = dp(48);
    if (y + panelH > metrics.heightPixels - dp(24)) {
      y = Math.max(dp(48), metrics.heightPixels - panelH - dp(24));
    }

    // Shrink height if needed so it fits under the bubble area.
    int available = metrics.heightPixels - y - dp(24);
    historyParams.width = panelW;
    historyParams.height = Math.min(panelH, Math.max(dp(160), available));
    historyParams.x = x;
    historyParams.y = y;
  }

  private void applyPosition(float x, float y) {
    if (layoutParams == null) return;
    if (x >= 0 && y >= 0) {
      layoutParams.x = Math.max(0, (int) x);
      layoutParams.y = Math.max(0, (int) y);
    }
  }

  private void loadPhoto(String raw, String botId) {
    final String src = raw == null ? "" : raw.trim();
    final String id = botId == null ? "" : botId.trim();
    photoExecutor.execute(
        () -> {
          Bitmap bitmap = null;
          for (String candidate : photoCandidates(src, id)) {
            bitmap = decodePhoto(candidate);
            if (bitmap != null) break;
          }
          if (bitmap == null) return;
          final Bitmap ready = bitmap;
          mainHandler.post(
              () -> {
                if (photoView != null) {
                  photoView.setImageBitmap(ready);
                }
              });
        });
  }

  private List<String> photoCandidates(String src, String botId) {
    List<String> list = new ArrayList<>();
    if (src != null && !src.isEmpty()) list.add(src);
    if (botId != null && !botId.isEmpty()) {
      String enc;
      try {
        enc = Uri.encode(botId);
      } catch (Exception e) {
        enc = botId;
      }
      list.add(GITHUB_RAW_BASE + enc + ".jpg");
      list.add(GITHUB_RAW_BASE + enc + ".jpeg");
      list.add(GITHUB_RAW_BASE + enc + ".png");
      list.add(GITHUB_RAW_BASE + enc + ".webp");
      list.add("https://www.apex-ea.com/api/licenses/photo?botId=" + enc);
    }
    return list;
  }

  private Bitmap decodePhoto(String src) {
    try {
      if (src == null || src.isEmpty()) return null;
      if (src.startsWith("blob:")) {
        // WebView-only URL — cannot decode in a Service.
        return null;
      }
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
        conn.setRequestProperty("User-Agent", "apex-ea-overlay");
        conn.connect();
        int code = conn.getResponseCode();
        if (code >= 400) {
          conn.disconnect();
          return null;
        }
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
      if (path == null || path.isEmpty() || "/".equals(path)) return "";
      if (path.startsWith("/")) path = path.substring(1);
      if (!path.startsWith("public/")) path = "public/" + path;
      return path;
    } catch (Exception e) {
      return "";
    }
  }

  private Bitmap loadAssetPhoto(String assetPath) {
    if (assetPath == null || assetPath.isEmpty()) return null;
    // Never silently substitute the app logo — caller should try the next EA candidate.
    if (assetPath.endsWith("logo.png") || assetPath.contains("/logo.png")) return null;
    String path = assetPath.startsWith("/") ? assetPath.substring(1) : assetPath;
    AssetManager assets = getAssets();
    String[] candidates =
        new String[] {
          path, path.startsWith("public/") ? path : "public/" + path,
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
    channel.setDescription("Keeps the EA bubble and History visible over MetaTrader");
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
