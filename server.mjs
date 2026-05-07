import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = __dirname;
await loadEnvFile(path.join(rootDir, ".env"));
const isProd = process.argv.includes("--prod");
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || (isProd ? "0.0.0.0" : "127.0.0.1");
const appUrl = process.env.APP_URL || `http://${host}:${port}`;
const cookieName = "larper_session";
const oauthStateCookie = "larper_oauth_state";
const discordApiBase = "https://discord.com/api/v10";
const activeOrderPollers = new Map();
const providerPollIntervalMs = Number(process.env.INVICTUSPAY_POLL_INTERVAL_MS || 15000);
const providerPollWindowMs = Number(process.env.INVICTUSPAY_POLL_WINDOW_MS || 1000 * 60 * 30);

await fs.mkdir(path.join(rootDir, "data"), { recursive: true });

const db = new DatabaseSync(path.join(rootDir, "data", "larper-academy.db"));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    discord_id TEXT NOT NULL UNIQUE,
    username TEXT NOT NULL,
    global_name TEXT,
    avatar TEXT,
    email TEXT,
    guild_member INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    price_cents INTEGER NOT NULL,
    role_id TEXT,
    invictus_offer_hash TEXT,
    invictus_product_hash TEXT,
    badge TEXT,
    accent TEXT,
    benefits TEXT NOT NULL,
    featured INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    external_id TEXT NOT NULL UNIQUE,
    user_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    status TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    currency TEXT NOT NULL,
    checkout_url TEXT,
    provider_payment_id TEXT,
    provider_status TEXT,
    metadata TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    paid_at INTEGER,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
  );
`);

ensureColumn("products", "invictus_offer_hash", "TEXT");
ensureColumn("products", "invictus_product_hash", "TEXT");

const statements = {
  getProducts: db.prepare("SELECT * FROM products ORDER BY featured DESC, price_cents ASC"),
  getProductById: db.prepare("SELECT * FROM products WHERE id = ?"),
  getProductBySlug: db.prepare("SELECT * FROM products WHERE slug = ?"),
  getUserByDiscordId: db.prepare("SELECT * FROM users WHERE discord_id = ?"),
  getUserById: db.prepare("SELECT * FROM users WHERE id = ?"),
  getSessionByToken: db.prepare("SELECT * FROM sessions WHERE token = ?"),
  insertUser: db.prepare(`
    INSERT INTO users (discord_id, username, global_name, avatar, email, guild_member, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `),
  updateUser: db.prepare(`
    UPDATE users
    SET username = ?, global_name = ?, avatar = ?, email = ?, guild_member = ?, updated_at = ?
    WHERE discord_id = ?
  `),
  insertSession: db.prepare(`
    INSERT INTO sessions (token, user_id, expires_at, created_at)
    VALUES (?, ?, ?, ?)
  `),
  deleteSession: db.prepare("DELETE FROM sessions WHERE token = ?"),
  deleteExpiredSessions: db.prepare("DELETE FROM sessions WHERE expires_at < ?"),
  insertOrder: db.prepare(`
    INSERT INTO orders (
      external_id, user_id, product_id, status, amount_cents, currency, checkout_url,
      provider_payment_id, provider_status, metadata, created_at, updated_at, paid_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  updateOrderCheckout: db.prepare(`
    UPDATE orders
    SET checkout_url = ?, provider_payment_id = ?, provider_status = ?, metadata = ?, updated_at = ?
    WHERE external_id = ?
  `),
  updateOrderStatus: db.prepare(`
    UPDATE orders
    SET status = ?, provider_payment_id = ?, provider_status = ?, metadata = ?, updated_at = ?, paid_at = ?
    WHERE id = ?
  `),
  getOrderByExternalId: db.prepare(`
    SELECT orders.*, users.discord_id, users.username, users.global_name, products.role_id, products.name AS product_name
    FROM orders
    JOIN users ON users.id = orders.user_id
    JOIN products ON products.id = orders.product_id
    WHERE orders.external_id = ?
  `),
  getOrderById: db.prepare(`
    SELECT orders.*, users.discord_id, users.username, users.global_name, products.role_id, products.name AS product_name
    FROM orders
    JOIN users ON users.id = orders.user_id
    JOIN products ON products.id = orders.product_id
    WHERE orders.id = ?
  `),
  getPendingOrdersToPoll: db.prepare(`
    SELECT orders.*, users.discord_id, users.username, users.global_name, products.role_id, products.name AS product_name
    FROM orders
    JOIN users ON users.id = orders.user_id
    JOIN products ON products.id = orders.product_id
    WHERE orders.status = 'pending'
      AND orders.provider_payment_id IS NOT NULL
    ORDER BY orders.created_at DESC
    LIMIT 50
  `),
  getRecentOrdersForUser: db.prepare(`
    SELECT orders.external_id, orders.status, orders.amount_cents, orders.currency, orders.created_at, orders.paid_at,
      products.name AS product_name, products.slug AS product_slug
    FROM orders
    JOIN products ON products.id = orders.product_id
    WHERE orders.user_id = ?
    ORDER BY orders.created_at DESC
    LIMIT 8
  `),
  hasPaidOrderForProduct: db.prepare(`
    SELECT 1 FROM orders WHERE user_id = ? AND product_id = ? AND status = 'paid' LIMIT 1
  `),
  topBuyers: db.prepare(`
    SELECT COALESCE(users.global_name, users.username) AS name, users.username, users.avatar, SUM(orders.amount_cents) AS total_spent
    FROM orders
    JOIN users ON users.id = orders.user_id
    WHERE orders.status = 'paid'
    GROUP BY orders.user_id
    ORDER BY total_spent DESC
    LIMIT 5
  `),
  recentBuyers: db.prepare(`
    SELECT COALESCE(users.global_name, users.username) AS name, users.username, users.avatar, products.name AS product_name, orders.paid_at
    FROM orders
    JOIN users ON users.id = orders.user_id
    JOIN products ON products.id = orders.product_id
    WHERE orders.status = 'paid'
    ORDER BY orders.paid_at DESC
    LIMIT 10
  `),
  paidStats: db.prepare(`
    SELECT
      COUNT(*) AS sales_count,
      COALESCE(SUM(amount_cents), 0) AS revenue_cents
    FROM orders
    WHERE status = 'paid'
  `)
};

seedProducts();

let vite;
if (!isProd) {
  const { createServer: createViteServer } = await import("vite");
  vite = await createViteServer({
    root: rootDir,
    server: { middlewareMode: true },
    appType: "spa"
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (await handleApi(req, res)) {
      return;
    }

    if (!isProd && vite) {
      vite.middlewares(req, res, async () => {
        await serveViteHtml(req, res);
      });
      return;
    }

    await serveStatic(req, res);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    }
    res.end(JSON.stringify({ error: "internal_server_error", message: error.message }));
  }
});

server.listen(port, host, () => {
  console.log(`larping running at ${appUrl}`);
});

resumePendingOrderPollers();

async function handleApi(req, res) {
  const url = new URL(req.url, appUrl);
  const pathname = url.pathname;

  if (pathname === "/api/health" && req.method === "GET") {
    return sendJson(res, 200, { ok: true, now: Date.now() });
  }

  if (pathname === "/api/storefront" && req.method === "GET") {
    return sendJson(res, 200, await getStorefrontPayload());
  }

  if (pathname === "/api/session" && req.method === "GET") {
    const session = getSession(req);
    return sendJson(res, 200, {
      authenticated: Boolean(session),
      authConfigured: isDiscordConfigured(),
      paymentConfigured: isInvictusConfigured(),
      guildConfigured: Boolean(process.env.DISCORD_GUILD_ID && process.env.DISCORD_BOT_TOKEN),
      user: session ? serializeUser(session.user) : null,
      orders: session ? getOrdersForUser(session.user.id) : []
    });
  }

  if (pathname === "/api/auth/discord/login" && req.method === "GET") {
    if (!isDiscordConfigured()) {
      return sendJson(res, 500, {
        error: "discord_not_configured",
        message: "Preencha DISCORD_CLIENT_ID e DISCORD_CLIENT_SECRET."
      });
    }

    const state = randomToken(24);
    const redirectUri = getDiscordRedirectUri();
    const scope = "identify email guilds.join";
    const authorizeUrl = new URL(`${discordApiBase}/oauth2/authorize`);
    authorizeUrl.searchParams.set("client_id", process.env.DISCORD_CLIENT_ID);
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("scope", scope);
    authorizeUrl.searchParams.set("prompt", "consent");
    authorizeUrl.searchParams.set("state", state);

    setCookie(
      res,
      oauthStateCookie,
      state,
      `Path=/; HttpOnly; SameSite=Lax; Max-Age=600${appUrl.startsWith("https://") ? "; Secure" : ""}`
    );

    redirect(res, authorizeUrl.toString());
    return true;
  }

  if (pathname === "/api/auth/discord/callback" && req.method === "GET") {
    const cookies = parseCookies(req);
    const state = url.searchParams.get("state");
    if (!state || cookies[oauthStateCookie] !== state) {
      redirect(res, "/?auth=failed");
      return true;
    }

    const code = url.searchParams.get("code");
    if (!code) {
      redirect(res, "/?auth=failed");
      return true;
    }

    const redirectUri = getDiscordRedirectUri();
    const tokenResponse = await fetch(`${discordApiBase}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID,
        client_secret: process.env.DISCORD_CLIENT_SECRET,
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri
      })
    });

    if (!tokenResponse.ok) {
      redirect(res, "/?auth=failed");
      return true;
    }

    const tokenData = await tokenResponse.json();
    const profileResponse = await fetch(`${discordApiBase}/users/@me`, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });

    if (!profileResponse.ok) {
      redirect(res, "/?auth=failed");
      return true;
    }

    const profile = await profileResponse.json();
    let guildMember = false;
    if (process.env.DISCORD_GUILD_ID && process.env.DISCORD_BOT_TOKEN) {
      guildMember = await ensureGuildMember(profile.id, tokenData.access_token);
    }

    const user = upsertDiscordUser(profile, guildMember);
    const token = createSession(user.id);
    clearCookie(res, oauthStateCookie);
    setCookie(
      res,
      cookieName,
      token,
      `Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 14}${appUrl.startsWith("https://") ? "; Secure" : ""}`
    );

    redirect(res, "/?auth=success");
    return true;
  }

  if (pathname === "/api/auth/logout" && req.method === "POST") {
    const cookies = parseCookies(req);
    if (cookies[cookieName]) {
      statements.deleteSession.run(cookies[cookieName]);
    }
    clearCookie(res, cookieName);
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === "/api/checkout" && req.method === "POST") {
    const session = getSession(req);
    if (!session) {
      return sendJson(res, 401, { error: "unauthorized", message: "faça login com o discord." });
    }

    const { body } = await readRequestBody(req);
    const productId = Number(body?.productId);
    const product = statements.getProductById.get(productId);
    if (!product) {
      return sendJson(res, 404, { error: "product_not_found" });
    }

    if (statements.hasPaidOrderForProduct.get(session.user.id, product.id)) {
      return sendJson(res, 409, { error: "already_purchased", message: "Você já adquiriu este produto." });
    }

    const externalId = `order_${Date.now()}_${randomToken(6)}`;
    const now = Date.now();
    statements.insertOrder.run(
      externalId,
      session.user.id,
      product.id,
      "pending",
      product.price_cents,
      "BRL",
      null,
      null,
      "created",
      JSON.stringify({ source: "site" }),
      now,
      now,
      null
    );

    const order = statements.getOrderByExternalId.get(externalId);
    const checkout = await createInvictusCheckout({ order, user: session.user, product, origin: appUrl });

    statements.updateOrderCheckout.run(
      checkout.checkoutUrl,
      checkout.providerPaymentId || null,
      checkout.providerStatus || "pending",
      JSON.stringify(checkout.rawResponse || {}),
      Date.now(),
      externalId
    );

    if (checkout.mode === "provider" && checkout.providerPaymentId) {
      scheduleOrderPolling(externalId, true);
    }

    return sendJson(res, 200, {
      ok: true,
      externalId,
      checkoutUrl: checkout.checkoutUrl,
      mode: checkout.mode
    });
  }

  if (pathname === "/api/webhooks/invictuspay" && req.method === "POST") {
    const { raw, body } = await readRequestBody(req, true);
    if (!verifyWebhookSignature(req, raw)) {
      return sendJson(res, 401, { error: "invalid_signature" });
    }

    const event = await normalizeWebhookPayload(body, url.searchParams.get("external_id"));
    if (!event.externalId) {
      return sendJson(res, 400, { error: "missing_external_id" });
    }

    const order = statements.getOrderByExternalId.get(event.externalId);
    if (!order) {
      return sendJson(res, 404, { error: "order_not_found" });
    }

    const wasPaid = order.status === "paid";
    const paidAt = event.isPaid ? Date.now() : order.paid_at;
    const nextStatus = event.isPaid ? "paid" : mapProviderStatus(event.status);

    statements.updateOrderStatus.run(
      nextStatus,
      event.providerPaymentId || order.provider_payment_id,
      event.status || order.provider_status,
      JSON.stringify(event.raw),
      Date.now(),
      paidAt,
      order.id
    );

    if (event.isPaid && !wasPaid) {
      await grantDiscordRole(order.discord_id, order.role_id);
    }

    return sendJson(res, 200, { ok: true });
  }

  if (pathname.startsWith("/api/dev/orders/") && pathname.endsWith("/pay") && req.method === "POST") {
    const externalId = pathname.split("/")[4];
    const order = statements.getOrderByExternalId.get(externalId);
    if (!order) {
      return sendJson(res, 404, { error: "order_not_found" });
    }

    statements.updateOrderStatus.run(
      "paid",
      order.provider_payment_id,
      "approved",
      JSON.stringify({ source: "demo-checkout" }),
      Date.now(),
      Date.now(),
      order.id
    );
    const grant = await grantDiscordRole(order.discord_id, order.role_id);
    return sendJson(res, 200, { ok: true, grant });
  }

  if (pathname.startsWith("/api/orders/") && pathname.endsWith("/status") && req.method === "GET") {
    const session = getSession(req);
    if (!session) {
      return sendJson(res, 401, { error: "unauthorized" });
    }

    const externalId = pathname.split("/")[3];
    let order = statements.getOrderByExternalId.get(externalId);
    if (!order || order.user_id !== session.user.id) {
      return sendJson(res, 404, { error: "order_not_found" });
    }

    if (shouldPollOrder(order)) {
      order = await syncOrderWithProvider(order);
    }

    return sendJson(res, 200, serializeOrderStatus(order));
  }

  if (pathname.startsWith("/checkout-local/") && req.method === "GET") {
    const externalId = pathname.split("/")[2];
    const order = statements.getOrderByExternalId.get(externalId);
    if (!order) {
      res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<h1>pedido não encontrado.</h1>");
      return true;
    }

    const paymentData = getPaymentData(order);
    const amount = formatCurrency(order.amount_cents);
    const qrSvg = paymentData.pixCode ? renderDottedQrSvg(paymentData.pixCode, { size: 220 }) : "";
    const statusLabel = translateStatus(order.status);
    const methodLabel = (paymentData.method || "pix").toLowerCase();
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`
      <!doctype html>
      <html lang="pt-BR">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <link rel="icon" type="image/svg+xml" href="/logo.svg" />
          <title>checkout</title>
          <style>
            @import url("https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=JetBrains+Mono:ital,wght@0,400;0,500;0,600;0,700;0,800;1,400;1,600&display=swap");
            :root {
              color-scheme: dark;
              --bg: #060606;
              --panel-soft: rgba(255, 255, 255, .03);
              --line: rgba(255, 255, 255, .08);
              --line-strong: rgba(255, 255, 255, .22);
              --text: #f3f3f3;
              --muted: #888888;
              --success: #7bd389;
            }
            * { box-sizing: border-box; }
            html, body { height: 100%; }
            body {
              margin: 0;
              min-width: 320px;
              font-family: "JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace;
              color: var(--text);
              background:
                radial-gradient(circle at 50% 0%, rgba(255, 255, 255, .04), transparent 28rem),
                linear-gradient(180deg, #050505 0%, #080808 48%, #0a0a0a 100%);
              overflow: hidden;
            }
            a { color: inherit; text-decoration: none; }
            button, input { font: inherit; }
            p { margin: 0; color: var(--muted); line-height: 1.6; }
            .page-shell {
              width: min(960px, calc(100vw - 32px));
              height: 100vh;
              margin: 0 auto;
              padding: 16px 0;
              display: flex;
              flex-direction: column;
              gap: 16px;
            }
            .topbar {
              position: sticky;
              top: 16px;
              z-index: 30;
              display: flex;
              align-items: center;
              justify-content: space-between;
              gap: 18px;
              padding: 8px 10px 8px 14px;
              border: 1px solid var(--line);
              border-radius: 16px;
              background: transparent;
              backdrop-filter: blur(22px);
              -webkit-backdrop-filter: blur(22px);
              box-shadow: 0 12px 36px rgba(0, 0, 0, .32);
              flex: 0 0 auto;
            }
            .brand {
              display: flex;
              align-items: center;
              gap: 12px;
              min-width: 0;
            }
            .brand-mark {
              width: 38px;
              height: 38px;
              display: grid;
              place-items: center;
              flex: 0 0 auto;
              border: 1px solid var(--line);
              border-radius: 10px;
              background: var(--panel-soft);
              color: #ffffff;
            }
            .brand-mark svg { width: 22px; height: 22px; }
            .brand-text {
              display: flex;
              flex-direction: column;
              line-height: 1.15;
            }
            .brand-text strong {
              font-weight: 400;
              font-size: 0.92rem;
              letter-spacing: 0;
            }
            .brand-text small {
              color: var(--muted);
              font-size: 0.68rem;
              letter-spacing: 0.02em;
              margin-top: 2px;
            }
            .back-link {
              color: var(--muted);
              font-size: 0.82rem;
              font-weight: 500;
              padding: 8px 14px;
              border: 1px solid var(--line);
              border-radius: 12px;
              background: var(--panel-soft);
              transition: color 160ms ease, border-color 160ms ease, background 160ms ease;
            }
            .back-link:hover {
              color: var(--text);
              border-color: var(--line-strong);
              background: rgba(255, 255, 255, 0.05);
            }
            .main {
              flex: 1;
              min-height: 0;
              display: grid;
              place-items: center;
            }
            .checkout-card {
              width: 100%;
              max-height: 100%;
              border: 1px solid var(--line);
              border-radius: 18px;
              background: transparent;
              backdrop-filter: blur(22px);
              -webkit-backdrop-filter: blur(22px);
              box-shadow: 0 12px 36px rgba(0, 0, 0, .32);
              padding: 24px;
              display: grid;
              grid-template-columns: auto minmax(0, 1fr);
              gap: 28px;
              align-items: center;
            }
            .qr-wrap {
              display: grid;
              place-items: center;
              padding: 8px;
              border: 1px solid var(--line);
              border-radius: 14px;
              background: var(--bg);
              flex: 0 0 auto;
            }
            .qr-wrap svg {
              display: block;
              width: 220px;
              height: 220px;
            }
            .checkout-side {
              display: flex;
              flex-direction: column;
              gap: 16px;
              min-width: 0;
            }
            .eyebrow {
              margin: 0;
              color: var(--muted);
              font-size: 0.7rem;
              font-weight: 600;
              letter-spacing: 0.04em;
            }
            h1 {
              margin: 4px 0 0;
              font-family: "JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace;
              font-size: clamp(1.7rem, 3.2vw, 2.2rem);
              font-weight: 700;
              letter-spacing: -0.02em;
              line-height: 1.1;
              color: var(--text);
            }
            .summary {
              display: flex;
              flex-direction: column;
              gap: 0;
              border: 1px solid var(--line);
              border-radius: 14px;
              background: var(--panel-soft);
              overflow: hidden;
            }
            .summary-row {
              display: flex;
              justify-content: space-between;
              align-items: center;
              gap: 16px;
              padding: 12px 14px;
              border-top: 1px solid var(--line);
            }
            .summary-row:first-child { border-top: 0; }
            .summary-row span {
              color: var(--muted);
              font-size: 0.82rem;
            }
            .summary-row strong {
              color: var(--text);
              text-align: right;
              font-weight: 600;
              word-break: break-word;
            }
            .summary-row.total strong {
              font-family: "Instrument Serif", serif;
              font-style: italic;
              font-weight: 400;
              color: #ffffff;
              font-size: 1.6rem;
              letter-spacing: -0.02em;
            }
            .pill {
              display: inline-flex;
              align-items: center;
              padding: 3px 10px;
              border: 1px solid var(--line);
              border-radius: 999px;
              background: var(--panel-soft);
              color: var(--text);
              font-size: 0.68rem;
              font-weight: 600;
              letter-spacing: 0.06em;
            }
            .pill.pending { color: var(--text); border-color: var(--line); }
            .pill.paid { color: var(--success); border-color: rgba(123, 211, 137, .4); }
            .copy-row {
              display: flex;
              gap: 10px;
              align-items: stretch;
            }
            .pix-input {
              flex: 1;
              min-width: 0;
              padding: 12px 14px;
              border: 1px solid var(--line);
              border-radius: 12px;
              background: var(--panel-soft);
              color: var(--muted);
              font-family: ui-monospace, "SF Mono", Menlo, monospace;
              font-size: 0.78rem;
              line-height: 1.4;
              white-space: nowrap;
              overflow: hidden;
              text-overflow: ellipsis;
            }
            .btn {
              min-height: 42px;
              display: inline-flex;
              align-items: center;
              justify-content: center;
              gap: 10px;
              padding: 0 18px;
              border: 1px solid transparent;
              border-radius: 12px;
              background: #ffffff;
              color: #050505;
              cursor: pointer;
              font-weight: 700;
              letter-spacing: 0.02em;
              text-align: center;
              transition: transform .15s ease, filter .15s ease;
              flex: 0 0 auto;
            }
            .btn:hover { transform: translateY(-1px); }
            .btn.ghost {
              background: var(--panel-soft);
              color: var(--text);
              border-color: var(--line);
            }
            .btn.ghost:hover { border-color: var(--line-strong); background: rgba(255, 255, 255, 0.06); }
            .btn.full { width: 100%; }
            .status-line {
              display: flex;
              align-items: center;
              gap: 10px;
              padding: 10px 14px;
              border: 1px solid var(--line);
              border-radius: 12px;
              background: var(--panel-soft);
              color: var(--muted);
              font-weight: 500;
              font-size: 0.82rem;
            }
            .status-dot {
              width: 6px;
              height: 6px;
              border-radius: 50%;
              background: var(--text);
              box-shadow: 0 0 0 3px rgba(255, 255, 255, .08);
              animation: pulse 1.6s ease-in-out infinite;
            }
            .status-line.paid { color: var(--success); border-color: rgba(123, 211, 137, .35); }
            .status-line.paid .status-dot { background: var(--success); box-shadow: 0 0 0 3px rgba(123, 211, 137, .18); animation: none; }
            @keyframes pulse {
              0%, 100% { opacity: 1; }
              50% { opacity: .35; }
            }
            @media (max-width: 860px) {
              body { overflow: auto; }
              .page-shell { height: auto; min-height: 100vh; }
              .checkout-card {
                grid-template-columns: 1fr;
                gap: 20px;
                padding: 20px;
              }
              .qr-wrap { justify-self: center; }
              .qr-wrap img { width: 200px; height: 200px; }
              h1 { text-align: center; }
              .eyebrow { text-align: center; }
            }
            @media (max-width: 640px) {
              .page-shell { width: min(100vw - 48px, 960px); padding-top: 10px; gap: 12px; }
              .summary-row.total strong { font-size: 1.4rem; }
              .copy-row { flex-direction: column; }
              .btn { width: 100%; }
            }
          </style>
        </head>
        <body>
          <div class="page-shell">
            <header class="topbar">
              <a class="brand" href="/" aria-label="voltar">
                <span class="brand-mark">
                  <svg viewBox="0 0 36 36" aria-hidden="true">
                    <path d="M18 4 L8 16 L18 22 Z" fill="currentColor" fill-opacity="0.22" />
                    <path d="M18 4 L18 22 L28 16 Z" fill="currentColor" fill-opacity="0.12" />
                    <path d="M8 16 L18 22 L18 32 Z" fill="currentColor" fill-opacity="0.16" />
                    <g stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" fill="none">
                      <path d="M18 4 L28 16 L18 32 L8 16 Z" stroke-width="1.9" />
                      <path d="M8 16 L18 22 L28 16" stroke-width="1.4" />
                      <path d="M18 4 L18 22 L18 32" stroke-width="1.3" />
                    </g>
                  </svg>
                </span>
                <div class="brand-text">
                  <strong>larping</strong>
                  <small>${paymentData.mode === "demo" ? "ambiente de teste" : "checkout seguro"}</small>
                </div>
              </a>
              <a class="back-link" href="/">&larr; voltar</a>
            </header>

            <main class="main">
              <section class="checkout-card" aria-label="pagamento">
                ${qrSvg ? `<div class="qr-wrap" aria-label="qr code pix">${qrSvg}</div>` : ""}
                <div class="checkout-side">
                  <div>
                    <p class="eyebrow">${escapeHtml(methodLabel)} · ${escapeHtml((order.product_name || "").toLowerCase())}</p>
                    <h1>${amount}</h1>
                  </div>

                  <div class="summary">
                    <div class="summary-row">
                      <span>produto</span>
                      <strong>${escapeHtml((order.product_name || "").toLowerCase())}</strong>
                    </div>
                    <div class="summary-row">
                      <span>status</span>
                      <strong><span class="pill ${order.status === "paid" ? "paid" : "pending"}">${escapeHtml(statusLabel)}</span></strong>
                    </div>
                  </div>

                  ${
                    paymentData.pixCode
                      ? `<div class="copy-row">
                          <input id="pix-code" class="pix-input" value="${escapeHtml(paymentData.pixCode)}" readonly />
                          <button id="copy-pix" class="btn" type="button">copiar</button>
                        </div>`
                      : ""
                  }

                  ${paymentData.billetUrl ? `<a class="btn ghost full" href="${escapeHtml(paymentData.billetUrl)}" target="_blank" rel="noreferrer">abrir boleto</a>` : ""}

                  ${
                    paymentData.mode === "demo"
                      ? `<button id="pay" class="btn ghost full">simular pagamento aprovado</button>`
                      : ""
                  }

                  <div id="status-line" class="status-line">
                    <span class="status-dot"></span>
                    <span id="status-text">aguardando confirmação do pagamento…</span>
                  </div>
                </div>
              </section>
            </main>
          </div>
          <script>
            const payButton = document.getElementById("pay");
            const copyPixButton = document.getElementById("copy-pix");
            const pixCode = document.getElementById("pix-code");
            const statusLine = document.getElementById("status-line");
            const statusText = document.getElementById("status-text");

            if (copyPixButton && pixCode) {
              copyPixButton.addEventListener("click", async () => {
                try {
                  await navigator.clipboard.writeText(pixCode.value);
                } catch {
                  pixCode.select();
                  document.execCommand("copy");
                }
                const original = copyPixButton.textContent;
                copyPixButton.textContent = "copiado!";
                setTimeout(() => { copyPixButton.textContent = original; }, 2000);
              });
            }

            if (payButton) {
              payButton.addEventListener("click", async () => {
                payButton.disabled = true;
                payButton.textContent = "processando…";
                await fetch("/api/dev/orders/${order.external_id}/pay", { method: "POST" });
                location.href = "/?payment=approved";
              });
            }

            const statusLabels = {
              pending: "aguardando confirmação do pagamento…",
              paid: "pagamento confirmado. redirecionando…",
              failed: "pagamento recusado. tenta de novo.",
              cancelled: "pagamento cancelado.",
              expired: "pagamento expirado."
            };

            const poll = async () => {
              try {
                const response = await fetch("/api/orders/${order.external_id}/status", { credentials: "include" });
                if (!response.ok) return;
                const data = await response.json();
                const label = statusLabels[data.status] || ("status: " + data.status);
                statusText.textContent = label;
                if (data.status === "paid") {
                  statusLine.classList.add("paid");
                  setTimeout(() => { location.href = "/?payment=approved"; }, 1200);
                }
              } catch {}
            };

            setInterval(poll, 5000);
            poll();
          </script>
        </body>
      </html>
    `);
    return true;
  }

  return false;
}

const guildMembersCache = { data: null, fetchedAt: 0, ttlMs: 10 * 60 * 1000 };

async function fetchGuildMembersWithRoles(limit = 24) {
  const now = Date.now();
  if (guildMembersCache.data && now - guildMembersCache.fetchedAt < guildMembersCache.ttlMs) {
    return guildMembersCache.data.slice(0, limit);
  }

  const guildId = process.env.DISCORD_GUILD_ID;
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!guildId || !token) {
    return [];
  }

  try {
    const response = await fetch(`${discordApiBase}/guilds/${guildId}/members?limit=1000`, {
      headers: { Authorization: `Bot ${token}` }
    });
    if (!response.ok) {
      console.warn(`[guild-members] discord ${response.status}`);
      return guildMembersCache.data ? guildMembersCache.data.slice(0, limit) : [];
    }
    const members = await response.json();
    const filtered = members
      .filter((m) => m?.user && !m.user.bot)
      .filter((m) => Array.isArray(m.roles) && m.roles.length > 0)
      .map((m) => {
        const u = m.user;
        return {
          name: u.global_name || m.nick || u.username,
          username: u.username,
          avatar: u.avatar
            ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=128`
            : null
        };
      });
    guildMembersCache.data = filtered;
    guildMembersCache.fetchedAt = now;
    return filtered.slice(0, limit);
  } catch (error) {
    console.warn("[guild-members] fetch error", error?.message || error);
    return guildMembersCache.data ? guildMembersCache.data.slice(0, limit) : [];
  }
}

async function getStorefrontPayload() {
  const products = statements.getProducts.all().map((product) => ({
    id: product.id,
    slug: product.slug,
    name: product.name,
    description: product.description,
    price: formatCurrency(product.price_cents),
    priceCents: product.price_cents,
    badge: product.badge,
    accent: product.accent,
    benefits: JSON.parse(product.benefits),
    featured: Boolean(product.featured)
  }));
  const primaryProduct =
    products.find((product) => product.slug === "larper-plus") ||
    products.find((product) => product.featured) ||
    products[0] ||
    null;

  const topBuyers = statements.topBuyers.all();
  const recentBuyers = statements.recentBuyers.all();
  const stats = statements.paidStats.get();

  let topBuyersOut = topBuyers.map((buyer) => ({
    name: buyer.name,
    username: buyer.username,
    avatar: buyer.avatar,
    total: formatCurrency(buyer.total_spent)
  }));

  let recentBuyersOut = recentBuyers.map((buyer) => ({
    name: buyer.name,
    username: buyer.username,
    avatar: buyer.avatar,
    product: buyer.product_name
  }));

  if (recentBuyersOut.length === 0 || topBuyersOut.length === 0) {
    const guildMembers = await fetchGuildMembersWithRoles(24);
    if (recentBuyersOut.length === 0) {
      recentBuyersOut = guildMembers.map((m) => ({ ...m, product: "larper+" }));
    }
    if (topBuyersOut.length === 0 && guildMembers.length > 0) {
      topBuyersOut = guildMembers.slice(0, 1).map((m) => ({ ...m, total: null }));
    }
  }

  return {
    authConfigured: isDiscordConfigured(),
    paymentConfigured: isInvictusConfigured(),
    guildConfigured: Boolean(process.env.DISCORD_GUILD_ID && process.env.DISCORD_BOT_TOKEN),
    hero: {
      eyebrow: "larping",
      title: "larper+ concentra o acesso da comunidade em uma única oferta.",
      description: "pagamento único de R$ 30. acesso liberado na sequência."
    },
    stats: [
      { label: "Membros ativos", value: `${Math.max(stats.sales_count, 120)}+` },
      { label: "Liberação de acesso", value: "Em segundos" },
      { label: "Oferta principal", value: "R$ 30 único" }
    ],
    product: primaryProduct,
    products,
    topBuyers: topBuyersOut,
    recentBuyers: recentBuyersOut
  };
}

function seedProducts() {
  const items = [
    {
      slug: "larper-plus",
      name: "larper+",
      description: "acervo, repertório digital e discord privado.",
      price_cents: 3000,
      role_id: process.env.DISCORD_ROLE_LARPER_PLUS_ID || process.env.DISCORD_ROLE_CLUB_ID || "",
      invictus_offer_hash: process.env.INVICTUSPAY_OFFER_HASH_LARPER_PLUS || process.env.INVICTUSPAY_OFFER_HASH_CLUB || "",
      invictus_product_hash:
        process.env.INVICTUSPAY_PRODUCT_HASH_LARPER_PLUS || process.env.INVICTUSPAY_PRODUCT_HASH_CLUB || "",
      badge: "pagamento único",
      accent: "gold",
      benefits: JSON.stringify([
        "discord privado e área de membros",
        "repertório digital editável, fonte aberta",
        "acervo de mídia, cenário e ambientação",
        "acesso liberado automaticamente após a entrada"
      ]),
      featured: 1
    }
  ];

  for (const item of items) {
    const existing = statements.getProductBySlug.get(item.slug);
    if (!existing) {
      db.prepare(`
        INSERT INTO products (
          slug, name, description, price_cents, role_id, invictus_offer_hash, invictus_product_hash, badge, accent, benefits, featured
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        item.slug,
        item.name,
        item.description,
        item.price_cents,
        item.role_id,
        item.invictus_offer_hash,
        item.invictus_product_hash,
        item.badge,
        item.accent,
        item.benefits,
        item.featured
      );
    } else {
      db.prepare(`
        UPDATE products
        SET name = ?, description = ?, price_cents = ?, role_id = ?, invictus_offer_hash = ?, invictus_product_hash = ?, badge = ?, accent = ?, benefits = ?, featured = ?
        WHERE slug = ?
      `).run(
        item.name,
        item.description,
        item.price_cents,
        item.role_id,
        item.invictus_offer_hash,
        item.invictus_product_hash,
        item.badge,
        item.accent,
        item.benefits,
        item.featured,
        item.slug
      );
    }
  }
}

function isDiscordConfigured() {
  return Boolean(process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET);
}

function isInvictusConfigured() {
  return Boolean(getInvictusBaseUrl() && process.env.INVICTUSPAY_API_TOKEN);
}

function getDiscordRedirectUri() {
  return `${appUrl}/api/auth/discord/callback`;
}

function upsertDiscordUser(profile, guildMember) {
  const now = Date.now();
  const avatar = profile.avatar
    ? `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.png?size=256`
    : null;
  const existing = statements.getUserByDiscordId.get(profile.id);

  if (!existing) {
    statements.insertUser.run(
      profile.id,
      profile.username,
      profile.global_name || null,
      avatar,
      profile.email || null,
      guildMember ? 1 : 0,
      now,
      now
    );
  } else {
    statements.updateUser.run(
      profile.username,
      profile.global_name || null,
      avatar,
      profile.email || null,
      guildMember ? 1 : existing.guild_member,
      now,
      profile.id
    );
  }

  return statements.getUserByDiscordId.get(profile.id);
}

function createSession(userId) {
  statements.deleteExpiredSessions.run(Date.now());
  const token = randomToken(48);
  const now = Date.now();
  const expiresAt = now + 1000 * 60 * 60 * 24 * 14;
  statements.insertSession.run(token, userId, expiresAt, now);
  return token;
}

function getSession(req) {
  const cookies = parseCookies(req);
  const token = cookies[cookieName];
  if (!token) {
    return null;
  }

  const session = statements.getSessionByToken.get(token);
  if (!session || session.expires_at < Date.now()) {
    statements.deleteSession.run(token);
    return null;
  }

  const user = statements.getUserById.get(session.user_id);
  if (!user) {
    return null;
  }

  return { token, user };
}

async function createInvictusCheckout({ order, user, product, origin }) {
  if (!isInvictusConfigured() || !product.invictus_offer_hash || !product.invictus_product_hash) {
    return {
      mode: "demo",
      checkoutUrl: `${origin}/checkout-local/${order.external_id}`,
      providerStatus: "demo_pending",
      rawResponse: {
        mode: "demo",
        payment_method: "pix",
        pix_code: `DEMO-${order.external_id}`,
        qr_code: "",
        billet_url: ""
      }
    };
  }

  const payload = {
    amount: order.amount_cents,
    offer_hash: product.invictus_offer_hash,
    payment_method: (process.env.INVICTUSPAY_PAYMENT_METHOD || "pix").toLowerCase(),
    customer: {
      name: user.global_name || user.username,
      email: user.email || `${user.discord_id}@discord.local`,
      phone_number: sanitizeDigits(process.env.DEFAULT_CUSTOMER_PHONE || "11999999999"),
      document: sanitizeDigits(process.env.DEFAULT_CUSTOMER_DOCUMENT || "00000000000")
    },
    cart: [
      {
        product_hash: product.invictus_product_hash,
        title: product.name,
        cover: null,
        price: order.amount_cents,
        quantity: 1,
        operation_type: 1,
        tangible: false
      }
    ],
    expire_in_days: Number(process.env.INVICTUSPAY_EXPIRE_IN_DAYS || 1),
    transaction_origin: "api",
    tracking: {
      src: "discord-site"
    }
  };

  if (payload.payment_method === "credit_card") {
    throw new Error("o pagamento por cartão exige dados adicionais no backend. nesta base o fluxo está pronto para pix e boleto.");
  }

  const endpoint = new URL(`${getInvictusBaseUrl()}/transactions`);
  endpoint.searchParams.set("api_token", process.env.INVICTUSPAY_API_TOKEN);

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const rawResponse = await safeJson(response);
  if (!response.ok) {
    throw new Error(rawResponse?.message || "Falha ao criar pagamento.");
  }

  const normalized = normalizeInvictusTransaction(rawResponse);

  return {
    mode: "provider",
    checkoutUrl: `${origin}/checkout-local/${order.external_id}`,
    providerPaymentId: normalized.hash,
    providerStatus: normalized.status,
    rawResponse: {
      mode: "provider",
      payment_method: normalized.payment_method,
      pix_code: normalized.pix_code,
      qr_code: normalized.qr_code,
      billet_url: normalized.billet_url,
      raw: rawResponse
    }
  };
}

function normalizeInvictusTransaction(payload) {
  const root = payload?.data && typeof payload.data === "object" ? payload.data : payload || {};
  const pix = root.pix || {};
  const billet = root.billet || {};
  return {
    hash: root.hash || root.id || null,
    status: String(root.payment_status || root.status || "").toLowerCase() || "pending",
    payment_method: root.payment_method || "pix",
    pix_code: pix.pix_qr_code || pix.qr_code || root.pix_code || "",
    qr_code: pix.qr_code_base64 || root.qr_code || "",
    billet_url: billet.url || billet.link || root.billet_url || ""
  };
}

async function normalizeWebhookPayload(body, fallbackExternalId) {
  let status = String(
    body?.status ||
      body?.payment_status ||
      body?.event ||
      body?.data?.status ||
      body?.transaction?.status ||
      ""
  ).toLowerCase();

  const providerPaymentId =
    body?.hash ||
    body?.paymentId ||
    body?.payment_id ||
    body?.id ||
    body?.transaction_id ||
    body?.data?.hash ||
    body?.data?.id ||
    null;

  if (!status && providerPaymentId && isInvictusConfigured()) {
    const remoteTransaction = await fetchInvictusTransaction(providerPaymentId);
    if (remoteTransaction) {
      status = normalizeInvictusTransaction(remoteTransaction).status;
      body = { ...body, ...remoteTransaction };
    }
  }

  return {
    status,
    externalId:
      fallbackExternalId ||
      body?.externalId ||
      body?.external_id ||
      body?.reference ||
      body?.order_id ||
      body?.metadata?.localOrderId ||
      body?.data?.externalId ||
      body?.data?.external_id ||
      null,
    providerPaymentId,
    isPaid: ["paid", "approved", "success", "completed", "confirmed", "settled"].includes(status),
    raw: body
  };
}

function shouldPollOrder(order) {
  return Boolean(
    order &&
      isInvictusConfigured() &&
      order.provider_payment_id &&
      order.status === "pending" &&
      Date.now() - order.created_at < providerPollWindowMs
  );
}

function scheduleOrderPolling(externalId, immediate = false) {
  clearOrderPolling(externalId);
  const delay = immediate ? 2000 : providerPollIntervalMs;
  const timeout = setTimeout(async () => {
    activeOrderPollers.delete(externalId);
    const order = statements.getOrderByExternalId.get(externalId);
    if (!shouldPollOrder(order)) {
      return;
    }

    await syncOrderWithProvider(order);

    const refreshed = statements.getOrderByExternalId.get(externalId);
    if (shouldPollOrder(refreshed)) {
      scheduleOrderPolling(externalId, false);
    }
  }, delay);

  activeOrderPollers.set(externalId, timeout);
}

function clearOrderPolling(externalId) {
  const active = activeOrderPollers.get(externalId);
  if (active) {
    clearTimeout(active);
    activeOrderPollers.delete(externalId);
  }
}

function resumePendingOrderPollers() {
  for (const order of statements.getPendingOrdersToPoll.all()) {
    if (shouldPollOrder(order)) {
      scheduleOrderPolling(order.external_id, false);
    }
  }
}

async function syncOrderWithProvider(order) {
  if (!shouldPollOrder(order)) {
    return order;
  }

  const remoteTransaction = await fetchInvictusTransaction(order.provider_payment_id);
  if (!remoteTransaction) {
    return order;
  }

  const normalized = normalizeInvictusTransaction(remoteTransaction);
  const status = normalized.status;
  const nextStatus = ["paid", "approved", "success", "completed", "confirmed", "settled"].includes(status)
    ? "paid"
    : mapProviderStatus(status);
  const paidAt = nextStatus === "paid" ? order.paid_at || Date.now() : order.paid_at;

  statements.updateOrderStatus.run(
    nextStatus,
    normalized.hash || order.provider_payment_id,
    status || order.provider_status,
    JSON.stringify({
      mode: "provider",
      payment_method: normalized.payment_method,
      pix_code: normalized.pix_code,
      qr_code: normalized.qr_code,
      billet_url: normalized.billet_url,
      raw: remoteTransaction
    }),
    Date.now(),
    paidAt,
    order.id
  );

  const refreshed = statements.getOrderById.get(order.id);

  if (nextStatus === "paid") {
    clearOrderPolling(order.external_id);
    if (order.status !== "paid") {
      await grantDiscordRole(refreshed.discord_id, refreshed.role_id);
    }
  } else if (nextStatus === "failed" || nextStatus === "cancelled") {
    clearOrderPolling(order.external_id);
  }

  return refreshed;
}

function mapProviderStatus(status) {
  if (["cancelled", "canceled"].includes(status)) {
    return "cancelled";
  }
  if (["refused", "rejected", "failed", "expired"].includes(status)) {
    return "failed";
  }
  return "pending";
}

async function ensureGuildMember(discordUserId, accessToken) {
  try {
    const response = await fetch(`${discordApiBase}/guilds/${process.env.DISCORD_GUILD_ID}/members/${discordUserId}`, {
      method: "PUT",
      headers: {
        Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ access_token: accessToken })
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function grantDiscordRole(discordUserId, roleId) {
  if (!discordUserId) return { ok: false, reason: "missing_discord_user_id" };
  if (!roleId) return { ok: false, reason: "missing_role_id" };
  if (!process.env.DISCORD_GUILD_ID) return { ok: false, reason: "missing_guild_id" };
  if (!process.env.DISCORD_BOT_TOKEN) return { ok: false, reason: "missing_bot_token" };

  const url = `${discordApiBase}/guilds/${process.env.DISCORD_GUILD_ID}/members/${discordUserId}/roles/${roleId}`;

  try {
    const response = await fetch(url, {
      method: "PUT",
      headers: { Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` }
    });

    if (response.ok) {
      console.log(`[discord] role granted user=${discordUserId} role=${roleId} status=${response.status}`);
      return { ok: true, status: response.status };
    }

    const body = await response.text().catch(() => "");
    console.error(`[discord] role grant failed user=${discordUserId} role=${roleId} status=${response.status} body=${body}`);
    return { ok: false, reason: "discord_api_error", status: response.status, body };
  } catch (error) {
    console.error(`[discord] role grant threw user=${discordUserId} role=${roleId} error=${error.message}`);
    return { ok: false, reason: "fetch_error", error: error.message };
  }
}

function verifyWebhookSignature(req, rawBody) {
  const secret = process.env.INVICTUSPAY_WEBHOOK_SECRET;
  if (!secret) {
    return true;
  }

  const provided =
    req.headers["x-invictus-signature"] ||
    req.headers["x-signature"] ||
    req.headers["x-webhook-signature"];

  if (!provided || typeof provided !== "string") {
    return false;
  }

  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readRequestBody(req, acceptForm = false) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const rawBuffer = Buffer.concat(chunks);
  const raw = rawBuffer.toString("utf8");
  const contentType = req.headers["content-type"] || "";

  let body = {};
  if (contentType.includes("application/json")) {
    body = raw ? JSON.parse(raw) : {};
  } else if (acceptForm || contentType.includes("application/x-www-form-urlencoded")) {
    body = Object.fromEntries(new URLSearchParams(raw));
  } else if (raw) {
    body = { raw };
  }

  return { raw, body };
}

async function serveViteHtml(req, res) {
  const url = req.url === "/" ? "/index.html" : req.url;
  const templatePath = path.join(rootDir, "index.html");
  let template = await fs.readFile(templatePath, "utf8");
  template = await vite.transformIndexHtml(url, template);
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(template);
}

async function serveStatic(req, res) {
  const url = new URL(req.url, appUrl);
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.join(rootDir, "dist", pathname);

  try {
    const stat = await fs.stat(filePath);
    if (stat.isFile()) {
      const content = await fs.readFile(filePath);
      res.writeHead(200, { "Content-Type": getMimeType(filePath) });
      res.end(content);
      return;
    }
  } catch {
    // fall through to SPA shell
  }

  const indexFile = path.join(rootDir, "dist", "index.html");
  const html = await fs.readFile(indexFile, "utf8");
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

function getOrdersForUser(userId) {
  return statements.getRecentOrdersForUser.all(userId).map((order) => ({
    externalId: order.external_id,
    status: order.status,
    amount: formatCurrency(order.amount_cents),
    productName: order.product_name,
    productSlug: order.product_slug,
    createdAt: order.created_at,
    paidAt: order.paid_at
  }));
}

function serializeUser(user) {
  return {
    id: user.id,
    discordId: user.discord_id,
    username: user.username,
    globalName: user.global_name,
    avatar: user.avatar,
    email: user.email,
    guildMember: Boolean(user.guild_member)
  };
}

function parseCookies(req) {
  const raw = req.headers.cookie;
  if (!raw) {
    return {};
  }

  return Object.fromEntries(
    raw.split(";").map((part) => {
      const idx = part.indexOf("=");
      const key = part.slice(0, idx).trim();
      const value = decodeURIComponent(part.slice(idx + 1).trim());
      return [key, value];
    })
  );
}

function setCookie(res, key, value, options) {
  const next = `${key}=${encodeURIComponent(value)}; ${options}`;
  const current = res.getHeader("Set-Cookie");
  const cookies = Array.isArray(current) ? current.concat(next) : current ? [current, next] : [next];
  res.setHeader("Set-Cookie", cookies);
}

function clearCookie(res, key) {
  setCookie(res, key, "", "Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
}

function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
  return true;
}

function safeJson(response) {
  return response.text().then((text) => {
    if (!text) {
      return null;
    }
    try {
      return JSON.parse(text);
    } catch {
      return { raw: text };
    }
  });
}

function getInvictusBaseUrl() {
  return (process.env.INVICTUSPAY_BASE_URL || "https://api.invictuspay.app.br/api/public/v1").replace(/\/$/, "");
}

async function fetchInvictusTransaction(hash) {
  const endpoint = new URL(`${getInvictusBaseUrl()}/transactions/${hash}`);
  endpoint.searchParams.set("api_token", process.env.INVICTUSPAY_API_TOKEN);
  const response = await fetch(endpoint);
  const data = await safeJson(response);
  if (!response.ok) {
    return null;
  }
  return data;
}

function sanitizeDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function getPaymentData(order) {
  try {
    const metadata = order.metadata ? JSON.parse(order.metadata) : {};
    return {
      mode: metadata.mode || (metadata.pix_code || metadata.billet_url ? "provider" : "demo"),
      method: metadata.payment_method || "pix",
      pixCode: metadata.pix_code || "",
      qrCode: metadata.qr_code || "",
      billetUrl: metadata.billet_url || ""
    };
  } catch {
    return {
      mode: "demo",
      method: "pix",
      pixCode: "",
      qrCode: "",
      billetUrl: ""
    };
  }
}

function serializeOrderStatus(order) {
  return {
    externalId: order.external_id,
    status: order.status,
    providerStatus: order.provider_status,
    amount: formatCurrency(order.amount_cents),
    paidAt: order.paid_at,
    payment: getPaymentData(order)
  };
}

function formatCurrency(value) {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL"
  }).format(value / 100);
}

function renderDottedQrSvg(payload, { size = 220, dotColor = "#f3f3f3", bgColor = "#060606" } = {}) {
  const text = String(payload || "");
  if (!text) return "";
  const qr = QRCode.create(text, { errorCorrectionLevel: "M" });
  const matrix = qr.modules;
  const count = matrix.size;
  const margin = 2;
  const totalCells = count + margin * 2;
  const cell = size / totalCells;
  const radius = cell * 0.42;
  const dots = [];
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) {
      if (matrix.get(r, c)) {
        const cx = ((c + margin + 0.5) * cell).toFixed(2);
        const cy = ((r + margin + 0.5) * cell).toFixed(2);
        dots.push(`<circle cx="${cx}" cy="${cy}" r="${radius.toFixed(2)}"/>`);
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" style="display:block" shape-rendering="geometricPrecision"><rect width="${size}" height="${size}" fill="${bgColor}"/><g fill="${dotColor}">${dots.join("")}</g></svg>`;
}

function translateStatus(status) {
  const map = {
    pending: "aguardando",
    paid: "pago",
    failed: "recusado",
    cancelled: "cancelado",
    expired: "expirado"
  };
  return map[status] || status;
}

function randomToken(size) {
  return randomBytes(size).toString("hex");
}

function escapeHtml(input) {
  return String(input)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function getMimeType(filePath) {
  if (filePath.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  if (filePath.endsWith(".png")) return "image/png";
  if (filePath.endsWith(".jpg") || filePath.endsWith(".jpeg")) return "image/jpeg";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  return "text/plain; charset=utf-8";
}

async function loadEnvFile(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }
      const separator = trimmed.indexOf("=");
      if (separator === -1) {
        continue;
      }
      const key = trimmed.slice(0, separator).trim();
      const value = trimmed.slice(separator + 1).trim();
      if (!(key in process.env)) {
        process.env[key] = value;
      }
    }
  } catch {
    // .env is optional in local dev
  }
}

function ensureColumn(tableName, columnName, definition) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  if (!columns.some((column) => column.name === columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}
