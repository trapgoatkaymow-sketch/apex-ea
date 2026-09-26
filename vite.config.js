import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  handleBrokers,
  handleConnect,
  handleDisconnect,
  handleHealth,
  handleMentorTrade,
  handleStatus,
  handleTrade,
} from './api/metaapi/_handlers.js'
import signupsHandler from './api/signups/index.js'
import licensesHandler from './api/licenses/index.js'
import licensesPhotoHandler from './api/licenses/photo.js'
import mentorsHandler from './api/mentors/index.js'
import mt5AccountsHandler from './api/mt5-accounts/index.js'
import tradeEventsHandler from './api/trade-events/index.js'
import calendarHandler from './api/calendar/index.js'
import chartSymbolHandler from './api/chart/symbol.js'
import chartAnalyzeHandler from './api/chart/analyze.js'
import paypalConfigHandler from './api/paypal/config.js'
import paypalCreateOrderHandler from './api/paypal/create-order.js'
import paypalCaptureOrderHandler from './api/paypal/capture-order.js'

function resolveBuildId(env) {
  return (
    process.env.VERCEL_GIT_COMMIT_SHA ||
    process.env.CF_PAGES_COMMIT_SHA ||
    process.env.GITHUB_SHA ||
    env.VITE_APP_BUILD_ID ||
    process.env.VITE_APP_BUILD_ID ||
    `local-${Date.now().toString(36)}`
  )
}

function appVersionPlugin(buildId) {
  // Keep in sync with src/uiShellLock.js — Vite config cannot import ESM app code
  // reliably during config evaluation, so the number is duplicated here.
  const shellGeneration = 75;
  const shellLabel = "product-frozen-stable";
  const uiLocked = true;
  const minShellGeneration = 75;

  const writeVersion = (outDir) => {
    try {
      mkdirSync(outDir, { recursive: true })
      writeFileSync(
        resolve(outDir, 'app-version.json'),
        `${JSON.stringify(
          {
            buildId,
            builtAt: new Date().toISOString(),
            shellGeneration,
            shellLabel,
            uiLocked,
            minShellGeneration,
          },
          null,
          2
        )}\n`,
        'utf8'
      )
    } catch {
      // ignore
    }
  }

  return {
    name: 'apexea-app-version',
    config() {
      writeVersion(resolve(process.cwd(), 'public'))
      return {
        define: {
          'import.meta.env.VITE_APP_BUILD_ID': JSON.stringify(buildId),
          'import.meta.env.VITE_UI_SHELL_GENERATION': JSON.stringify(shellGeneration),
          'import.meta.env.VITE_UI_SHELL_LOCKED': JSON.stringify(uiLocked),
        },
      }
    },
    closeBundle() {
      writeVersion(resolve(process.cwd(), 'dist'))
    },
  }
}

function metaApiDevPlugin() {
  return {
    name: 'metaapi-dev-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        try {
          const url = new URL(req.url || '/', 'http://localhost')

          if (url.pathname === '/api/signups' || url.pathname === '/api/signups/') {
            req.url = `${url.pathname}${url.search}`
            return signupsHandler(req, res)
          }

          if (url.pathname === '/api/licenses/photo') {
            req.url = `${url.pathname}${url.search}`
            return licensesPhotoHandler(req, res)
          }

          if (url.pathname === '/api/licenses' || url.pathname === '/api/licenses/') {
            req.url = `${url.pathname}${url.search}`
            return licensesHandler(req, res)
          }

          if (url.pathname === '/api/mentors' || url.pathname === '/api/mentors/') {
            req.url = `${url.pathname}${url.search}`
            return mentorsHandler(req, res)
          }

          if (url.pathname === '/api/mt5-accounts' || url.pathname === '/api/mt5-accounts/') {
            req.url = `${url.pathname}${url.search}`
            return mt5AccountsHandler(req, res)
          }

          if (url.pathname === '/api/trade-events' || url.pathname === '/api/trade-events/') {
            req.url = `${url.pathname}${url.search}`
            return tradeEventsHandler(req, res)
          }

          if (url.pathname === '/api/calendar' || url.pathname === '/api/calendar/') {
            req.url = `${url.pathname}${url.search}`
            return calendarHandler(req, res)
          }

          if (url.pathname === '/api/chart/symbol' || url.pathname === '/api/chart/symbol/') {
            req.url = `${url.pathname}${url.search}`
            return chartSymbolHandler(req, res)
          }

          if (url.pathname === '/api/chart/analyze' || url.pathname === '/api/chart/analyze/') {
            req.url = `${url.pathname}${url.search}`
            return chartAnalyzeHandler(req, res)
          }

          if (url.pathname === '/api/paypal/config' || url.pathname === '/api/paypal/config/') {
            req.url = `${url.pathname}${url.search}`
            return paypalConfigHandler(req, res)
          }

          if (
            url.pathname === '/api/paypal/create-order' ||
            url.pathname === '/api/paypal/create-order/'
          ) {
            req.url = `${url.pathname}${url.search}`
            return paypalCreateOrderHandler(req, res)
          }

          if (
            url.pathname === '/api/paypal/capture-order' ||
            url.pathname === '/api/paypal/capture-order/'
          ) {
            req.url = `${url.pathname}${url.search}`
            return paypalCaptureOrderHandler(req, res)
          }

          if (!url.pathname.startsWith('/api/metaapi/')) return next()

          // Preserve full path+query for handlers that parse req.url
          req.url = `${url.pathname}${url.search}`

          if (req.method === 'GET' && url.pathname === '/api/metaapi/brokers') {
            return handleBrokers(req, res)
          }
          if (req.method === 'GET' && url.pathname === '/api/metaapi/health') {
            return handleHealth(req, res)
          }
          if (req.method === 'GET' && url.pathname === '/api/metaapi/status') {
            return handleStatus(req, res)
          }
          if (req.method === 'POST' && url.pathname === '/api/metaapi/connect') {
            return handleConnect(req, res)
          }
          if (req.method === 'POST' && url.pathname === '/api/metaapi/trade') {
            return handleTrade(req, res)
          }
          if (req.method === 'POST' && url.pathname === '/api/metaapi/mentor-trade') {
            return handleMentorTrade(req, res)
          }
          if (req.method === 'POST' && url.pathname === '/api/metaapi/disconnect') {
            return handleDisconnect(req, res)
          }

          res.statusCode = 404
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ error: 'Not found' }))
        } catch (error) {
          res.statusCode = 500
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ error: error.message || 'Server error' }))
        }
      })
    },
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const buildId = resolveBuildId(env)
  process.env.VITE_APP_BUILD_ID = buildId
  process.env.METAAPI_TOKEN = process.env.METAAPI_TOKEN || env.METAAPI_TOKEN || ''
  process.env.METAAPI_STRATEGY_ID = process.env.METAAPI_STRATEGY_ID || env.METAAPI_STRATEGY_ID || ''
  process.env.METAAPI_REGION = process.env.METAAPI_REGION || env.METAAPI_REGION || 'new-york'
  process.env.SIGNUPS_GITHUB_TOKEN =
    process.env.SIGNUPS_GITHUB_TOKEN || env.SIGNUPS_GITHUB_TOKEN || ''
  process.env.GITHUB_TOKEN = process.env.GITHUB_TOKEN || env.GITHUB_TOKEN || ''
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || env.OPENAI_API_KEY || ''
  process.env.OPENAI_VISION_MODEL =
    process.env.OPENAI_VISION_MODEL || env.OPENAI_VISION_MODEL || 'gpt-4o-mini'
  process.env.PAYPAL_CLIENT_ID =
    process.env.PAYPAL_CLIENT_ID || env.PAYPAL_CLIENT_ID || env.VITE_PAYPAL_CLIENT_ID || ''
  process.env.PAYPAL_CLIENT_SECRET =
    process.env.PAYPAL_CLIENT_SECRET || env.PAYPAL_CLIENT_SECRET || ''
  process.env.PAYPAL_MODE = process.env.PAYPAL_MODE || env.PAYPAL_MODE || 'live'
  process.env.MT5_API_BASE =
    process.env.MT5_API_BASE || env.MT5_API_BASE || env.MT5_API_TARGET || 'http://66.23.225.158'

  return {
    plugins: [react(), appVersionPlugin(buildId), metaApiDevPlugin()],
    server: {
      proxy: {
        '/mt5-api': {
          target: process.env.MT5_API_BASE,
          changeOrigin: true,
          secure: false,
          rewrite: (path) => path.replace(/^\/mt5-api/, ''),
        },
      },
    },
  }
})
