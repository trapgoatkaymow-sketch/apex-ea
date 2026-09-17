package com.apexea.zetascalper;

import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;

/**
 * Client trading app shell.
 * UI loads from https://www.apex-ea.com so web deploys reach Android without
 * another APK rebuild. PayPal, licenses, Chart Scanner, MetaAPI stay remote.
 * Mentor/admin portal routes are blocked inside the APK.
 */
public class MainActivity extends BridgeActivity {
  @Override
  public void onCreate(Bundle savedInstanceState) {
    registerPlugin(FloatOverlayPlugin.class);
    super.onCreate(savedInstanceState);
    Bridge bridge = this.getBridge();
    if (bridge == null) return;
    WebView webView = bridge.getWebView();
    if (webView == null) return;

    // GPU compositing for smoother scrolls/animations (closer to mobile Chrome).
    webView.setLayerType(View.LAYER_TYPE_HARDWARE, null);
    webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
    WebSettings settings = webView.getSettings();
    if (settings != null) {
      settings.setCacheMode(WebSettings.LOAD_DEFAULT);
      settings.setDomStorageEnabled(true);
      settings.setLoadWithOverviewMode(true);
      settings.setUseWideViewPort(true);
      // Avoid layout thrash from font size adjustments.
      settings.setTextZoom(100);
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
        settings.setOffscreenPreRaster(true);
      }
    }

    webView.setWebViewClient(
      new BridgeWebViewClient(bridge) {
        private boolean isAdminUrl(String url) {
          if (url == null) return false;
          String lower = url.toLowerCase();
          return lower.contains("/admin") || lower.contains("/admin/");
        }

        private void goHome() {
          Bridge b = MainActivity.this.getBridge();
          if (b != null && b.getWebView() != null) {
            // Live site — same as capacitor server.url (no packaged UI lag).
            b.getWebView().loadUrl("https://www.apex-ea.com/");
          }
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
          if (request != null && request.getUrl() != null && isAdminUrl(request.getUrl().toString())) {
            goHome();
            return true;
          }
          return super.shouldOverrideUrlLoading(view, request);
        }

        @Override
        @SuppressWarnings("deprecation")
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
          if (isAdminUrl(url)) {
            goHome();
            return true;
          }
          return super.shouldOverrideUrlLoading(view, url);
        }
      }
    );
  }

  @Override
  public void onPause() {
    Bridge bridge = this.getBridge();
    WebView webView = bridge != null ? bridge.getWebView() : null;
    if (webView != null) {
      // Do NOT call pauseTimers() — it freezes CSS animations / JS timers and
      // makes the app feel dead compared to mobile web after resume.
      webView.onPause();
      webView.evaluateJavascript(
        "document.documentElement.classList.add('is-paused');",
        null
      );
    }
    super.onPause();
  }

  @Override
  public void onResume() {
    super.onResume();
    Bridge bridge = this.getBridge();
    WebView webView = bridge != null ? bridge.getWebView() : null;
    if (webView != null) {
      webView.onResume();
      webView.evaluateJavascript(
        "document.documentElement.classList.remove('is-paused');",
        null
      );
    }
  }
}
