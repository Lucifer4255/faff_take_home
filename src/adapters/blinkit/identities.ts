import { type Browser, type BrowserContext, chromium, firefox, webkit } from 'playwright'

/**
 * Identity pool for headless Blinkit access.
 *
 * Cloudflare fingerprints the browser. Rather than lean on a headful window, we
 * rotate a fleet of **engine-backed** identities: each one launches its REAL
 * engine (Blink / Gecko / WebKit), so the TLS/JA3 handshake AND the JS
 * environment genuinely match the User-Agent. A "Safari" identity is real WebKit,
 * a "Firefox" identity is real Gecko — a coherent disguise, not a UA sticker on
 * Chromium (which is *more* detectable because the env contradicts the UA).
 *
 * All three engines were verified to pass Blinkit's Cloudflare headless
 * (scripts/blinkit-engine-probe.ts). The client picks one per process and
 * rotates to another on a 403, so a single fingerprint getting flagged doesn't
 * sink the run.
 */

export type Engine = 'chromium' | 'firefox' | 'webkit'

export interface Identity {
  id: string
  engine: Engine
  userAgent: string
  viewport: { width: number; height: number }
  /** Chromium only: WebGL vendor/renderer to spoof, matched to the identity's OS
   * (headless reports 'Google SwiftShader' — a bot tell). */
  webgl?: { vendor: string; renderer: string }
}

const ENGINES: Record<Engine, { launch: typeof chromium.launch }> = { chromium, firefox, webkit }

// India-only service → every identity uses en-IN + Asia/Kolkata (set on the
// context in launchIdentity). Desktop only, to match app_client=consumer_web /
// platform=desktop_web. Engine-consistent, recent real builds.
export const IDENTITIES: Identity[] = [
  {
    id: 'mac-chrome',
    engine: 'chromium',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
    webgl: { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)' },
  },
  {
    id: 'win-chrome',
    engine: 'chromium',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 768 },
    webgl: { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  },
  {
    id: 'mac-safari',
    engine: 'webkit',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
    viewport: { width: 1440, height: 900 },
  },
  {
    id: 'mac-firefox',
    engine: 'firefox',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0',
    viewport: { width: 1280, height: 800 },
  },
  {
    id: 'win-firefox',
    engine: 'firefox',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
    viewport: { width: 1536, height: 864 },
  },
]

export interface ProxyCfg {
  server: string
  username?: string
  password?: string
}

/** Launch an identity's real engine + a context configured to look like it.
 * Engine-aware stealth is applied before any page script runs. */
export async function launchIdentity(
  identity: Identity,
  opts: {
    headless: boolean
    proxy?: ProxyCfg
    geolocation?: { latitude: number; longitude: number }
    channel?: string
    /** Skip the fingerprint patches below. Use for a genuinely real, installed
     * browser (`channel` set) driven headful for a human to interact with
     * directly — the patches exist to make BUNDLED headless Chromium look
     * real; applied to an already-real Chrome they do the opposite; they're
     * CDP-injected script overrides (navigator.webdriver, window.chrome,
     * WebGL) that a real browser doesn't have and doesn't need, so injecting
     * them is itself a tell (observed: tripped Turnstile on a real-Chrome,
     * human-interactive login that should have passed cleanly). */
    skipStealth?: boolean
  },
): Promise<{ browser: Browser; ctx: BrowserContext }> {
  const engine = ENGINES[identity.engine]
  const browser = await engine.launch({
    headless: opts.headless,
    ...(opts.proxy ? { proxy: opts.proxy } : {}),
    // Chromium-only knobs: strip automation flags + give headless a WebGL context
    // to spoof. Firefox/WebKit ignore args and need none of this to pass.
    ...(identity.engine === 'chromium'
      ? {
          ...(opts.channel ? { channel: opts.channel } : {}),
          args: ['--disable-blink-features=AutomationControlled', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--enable-webgl'],
          ignoreDefaultArgs: ['--enable-automation'],
        }
      : {}),
  })
  const ctx = await browser.newContext({
    userAgent: identity.userAgent,
    viewport: identity.viewport,
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
    ...(opts.geolocation ? { geolocation: opts.geolocation, permissions: ['geolocation'] } : {}),
  })
  if (!opts.skipStealth) await applyStealth(ctx, identity)
  return { browser, ctx }
}

/** Engine-aware fingerprint patches (run before page scripts, incl. Cloudflare's
 * challenge). Only Chromium gets window.chrome + WebGL spoofing; adding those to
 * Firefox/WebKit would itself be a tell. */
async function applyStealth(ctx: BrowserContext, identity: Identity): Promise<void> {
  await ctx.addInitScript(
    (cfg: { engine: Engine; webgl?: { vendor: string; renderer: string } }) => {
      // biome-ignore lint: browser-context globals, typed loosely
      const nav = navigator as any
      // The #1 automation tell, on every engine.
      Object.defineProperty(nav, 'webdriver', { get: () => false, configurable: true })
      Object.defineProperty(nav, 'languages', { get: () => ['en-IN', 'en-US', 'en'], configurable: true })

      if (cfg.engine === 'chromium') {
        // biome-ignore lint: browser-context globals, typed loosely
        const win = window as any
        if (!win.chrome) win.chrome = { runtime: {} }
        Object.defineProperty(nav, 'plugins', { get: () => [1, 2, 3, 4, 5], configurable: true })
        if (cfg.webgl) {
          const spoof = (proto: { getParameter: (n: number) => unknown } | undefined) => {
            if (!proto) return
            const orig = proto.getParameter
            proto.getParameter = function (p: number) {
              if (p === 37445) return cfg.webgl?.vendor // UNMASKED_VENDOR_WEBGL
              if (p === 37446) return cfg.webgl?.renderer // UNMASKED_RENDERER_WEBGL
              return orig.call(this, p)
            }
          }
          spoof(win.WebGLRenderingContext?.prototype)
          spoof(win.WebGL2RenderingContext?.prototype)
        }
      }
    },
    { engine: identity.engine, webgl: identity.webgl },
  )
}
