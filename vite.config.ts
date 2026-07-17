import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { execSync } from 'node:child_process';

// Build-time version stamp ("Report a problem" + a footer stamp use this to
// identify which deploy a user is looking at). Short git SHA, falling back to
// 'dev' when git is unavailable (e.g. a source-only build without .git).
function buildInfo() {
  let sha = 'dev';
  try {
    sha = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim() || 'dev';
  } catch {
    /* no git available at build time — keep 'dev' */
  }
  return { sha, date: new Date().toISOString() };
}

/**
 * McMaster-Carr-style critical CSS: our whole stylesheet is small (~12 kB raw),
 * so inline ALL of it into index.html — first paint needs zero CSS requests.
 */
function inlineCss(): Plugin {
  return {
    name: 'ucg-inline-css',
    apply: 'build',
    enforce: 'post',
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        if (!ctx.bundle) return html;
        for (const asset of Object.values(ctx.bundle)) {
          if (asset.type === 'asset' && asset.fileName.endsWith('.css')) {
            const css = asset.source.toString();
            const link = new RegExp(`<link[^>]*href="[^"]*${asset.fileName.replace(/[/.]/g, '\\$&')}"[^>]*>`);
            if (link.test(html)) html = html.replace(link, `<style>${css}</style>`);
          }
        }
        return html;
      },
    },
  };
}

/** Inline the tiny font-face CSS too, but the .woff2 files stay separate (they're preloaded). */
function preloadFonts(): Plugin {
  return {
    name: 'ucg-preload-fonts',
    apply: 'build',
    enforce: 'post',
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        if (!ctx.bundle) return html;
        // Preload latin woff2 of the two UI fonts so text renders on first paint.
        const fonts = Object.values(ctx.bundle)
          .filter((a) => a.fileName.endsWith('.woff2') && /latin/.test(a.fileName) && !/-ext|italic/.test(a.fileName))
          .map((a) => a.fileName);
        const tags = fonts.map((f) => `<link rel="preload" href="/ucg-platform/${f}" as="font" type="font/woff2" crossorigin>`).join('\n    ');
        return html.replace('</title>', `</title>\n    ${tags}`);
      },
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    inlineCss(),
    preloadFonts(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'UCG Registration & Scoring',
        short_name: 'UCG',
        description: 'United Club Gymnastics — registration, scoring, live results.',
        theme_color: '#1e2b38',
        background_color: '#dbebee',
        display: 'standalone',
        start_url: '/ucg-platform/',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
        ],
      },
      workbox: {
        // Precache the app shell + all hashed assets + the calculators & their data.
        globPatterns: ['**/*.{js,css,html,woff2,svg,png}', 'calculators/**/*'],
        // Big test datasets are runtime-cached instead of precached.
        globIgnores: ['data/**'],
        navigateFallback: '/ucg-platform/index.html',
        // Calculator iframes are real documents, not SPA routes — without this,
        // the fallback serves index.html INSIDE the calc iframe (app-in-app bug).
        navigateFallbackDenylist: [/\/calculators\//],
        // Calc URLs carry preset params (?apparatus=&ruleset=&level=); strip them
        // when matching the precache so the calculators also work offline.
        ignoreURLParametersMatching: [/^utm_/, /^fbclid$/, /^apparatus$/, /^ruleset$/, /^level$/],
        runtimeCaching: [
          {
            // Results test data & future API reads: serve cached instantly, refresh in background.
            urlPattern: /\/ucg-platform\/data\/.*\.json$/,
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'ucg-data', expiration: { maxEntries: 20 } },
          },
          {
            // CDN deps used inside calculator iframes (Bootstrap, jQuery).
            urlPattern: /^https:\/\/(cdn\.jsdelivr\.net|code\.jquery\.com|stackpath\.bootstrapcdn\.com|cdnjs\.cloudflare\.com)\/.*/,
            handler: 'CacheFirst',
            options: { cacheName: 'ucg-cdn', expiration: { maxEntries: 40, maxAgeSeconds: 60 * 60 * 24 * 90 } },
          },
        ],
      },
    }),
  ],
  define: {
    __BUILD_INFO__: JSON.stringify(buildInfo()),
  },
  base: '/ucg-platform/',
  build: {
    // Route-level chunks are defined via React.lazy in App.tsx; keep vendor split tidy.
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (/node_modules[\\/](react|react-dom|react-router|scheduler)[\\/]/.test(id)) return 'react';
        },
      },
    },
  },
})
