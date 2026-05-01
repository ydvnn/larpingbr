import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer } from "vite";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = __dirname;
await loadEnvFile(path.join(rootDir, ".env"));
const isProd = process.argv.includes("--prod");
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "127.0.0.1";
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
  console.log(`Larping Brasil running at ${appUrl}`);
});

resumePendingOrderPollers();

async function handleApi(req, res) {
  const url = new URL(req.url, appUrl);
  const pathname = url.pathname;

  if (pathname === "/api/health" && req.method === "GET") {
    return sendJson(res, 200, { ok: true, now: Date.now() });
  }

  if (pathname === "/api/storefront" && req.method === "GET") {
    return sendJson(res, 200, getStorefrontPayload());
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
      return sendJson(res, 401, { error: "unauthorized", message: "Faça login com o Discord." });
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
      res.end("<h1>Pedido nao encontrado.</h1>");
      return true;
    }

    const paymentData = getPaymentData(order);
    const amount = formatCurrency(order.amount_cents);
    const qrSource = paymentData.qrCode || (paymentData.pixCode ? buildQrCodeUrl(paymentData.pixCode) : "");
    const statusLabel = translateStatus(order.status);
    const methodLabel = (paymentData.method || "pix").toUpperCase();
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`
      <!doctype html>
      <html lang="pt-BR">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>Checkout Larper+</title>
          <style>
            @import url("https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Manrope:wght@400;500;600;700;800&display=swap");
            :root {
              color-scheme: dark;
              --bg: #030405;
              --panel: rgba(12, 13, 16, .92);
              --panel-soft: rgba(255, 255, 255, .04);
              --line: rgba(232, 197, 121, .16);
              --line-strong: rgba(232, 197, 121, .32);
              --text: #f7f1e6;
              --muted: #b8b3aa;
              --gold: #e8c579;
              --gold-strong: #f3d999;
              --success: #7bd389;
              --shadow: 0 28px 90px rgba(0, 0, 0, .42);
            }
            * { box-sizing: border-box; }
            html, body { height: auto; }
            body {
              min-width: 320px;
              min-height: 100vh;
              margin: 0;
              font-family: Manrope, system-ui, sans-serif;
              color: var(--text);
              background:
                radial-gradient(circle at 50% -10%, rgba(232, 197, 121, .08), transparent 28rem),
                linear-gradient(180deg, #020304, #050608 48%, #08090c);
            }
            a { color: inherit; text-decoration: none; }
            button, textarea { font: inherit; }
            p { margin: 0; color: var(--muted); line-height: 1.6; }
            .page-shell {
              width: min(720px, calc(100vw - 32px));
              margin: 0 auto;
              padding: 20px 0 56px;
              display: flex;
              flex-direction: column;
              gap: 28px;
            }
            .topbar {
              display: flex;
              align-items: center;
              justify-content: space-between;
              gap: 18px;
              padding: 14px 18px;
              border: 1px solid var(--line);
              border-radius: 20px;
              background: rgba(5, 6, 8, .82);
              backdrop-filter: blur(22px);
              box-shadow: var(--shadow);
            }
            .brand {
              display: flex;
              align-items: center;
              gap: 12px;
              min-width: 0;
              font-weight: 800;
            }
            .brand-mark {
              width: 40px;
              height: 40px;
              display: grid;
              place-items: center;
              flex: 0 0 auto;
              border: 1px solid var(--line-strong);
              border-radius: 12px;
              background: linear-gradient(145deg, rgba(232, 197, 121, .24), rgba(58, 61, 68, .46));
              color: #fff2cd;
            }
            .brand-mark svg { width: 24px; height: 24px; }
            .back-link {
              color: var(--muted);
              font-size: .85rem;
              font-weight: 600;
            }
            .back-link:hover { color: var(--text); }
            .header-block {
              text-align: center;
              display: flex;
              flex-direction: column;
              gap: 10px;
            }
            .eyebrow {
              margin: 0;
              color: var(--gold);
              font-size: .72rem;
              font-weight: 800;
              letter-spacing: .14em;
              text-transform: uppercase;
            }
            h1 {
              margin: 0;
              font-family: "Instrument Serif", serif;
              font-size: clamp(2.2rem, 5vw, 3rem);
              font-weight: 400;
              letter-spacing: -.03em;
              line-height: 1.05;
              color: var(--text);
            }
            .lead {
              max-width: 52ch;
              margin: 0 auto;
              font-size: .98rem;
            }
            .card {
              border: 1px solid var(--line);
              border-radius: 20px;
              background: linear-gradient(180deg, rgba(12, 13, 16, .92), rgba(5, 6, 8, .97));
              box-shadow: var(--shadow);
              padding: 24px;
              display: flex;
              flex-direction: column;
              gap: 18px;
            }
            .card-title {
              display: flex;
              align-items: center;
              justify-content: space-between;
              gap: 12px;
              margin: 0;
              font-size: 1rem;
              font-weight: 700;
              color: var(--text);
            }
            .summary-list {
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
              align-items: baseline;
              gap: 16px;
              padding: 14px 16px;
              border-top: 1px solid var(--line);
            }
            .summary-row:first-child { border-top: 0; }
            .summary-row span {
              color: var(--muted);
              font-size: .88rem;
            }
            .summary-row strong {
              color: var(--text);
              text-align: right;
              font-weight: 700;
              word-break: break-all;
            }
            .summary-row.total strong {
              color: var(--gold-strong);
              font-size: 1.6rem;
              letter-spacing: -.02em;
            }
            .pill {
              display: inline-flex;
              align-items: center;
              padding: 4px 10px;
              border: 1px solid var(--line);
              border-radius: 999px;
              background: rgba(255, 255, 255, .04);
              color: var(--text);
              font-size: .68rem;
              font-weight: 800;
              letter-spacing: .1em;
              text-transform: uppercase;
            }
            .pill.pending { color: var(--gold-strong); border-color: var(--line-strong); }
            .pill.paid { color: var(--success); border-color: rgba(123, 211, 137, .4); }
            .pix-grid {
              display: grid;
              grid-template-columns: auto 1fr;
              gap: 22px;
              align-items: center;
            }
            .qr-wrap {
              display: grid;
              place-items: center;
              padding: 12px;
              border: 1px solid var(--line);
              border-radius: 16px;
              background: #fff;
              flex: 0 0 auto;
            }
            .qr-wrap img {
              width: 200px;
              height: 200px;
              display: block;
              object-fit: contain;
            }
            .pix-instructions {
              display: flex;
              flex-direction: column;
              gap: 10px;
              min-width: 0;
            }
            .pix-instructions ol {
              margin: 0;
              padding-left: 20px;
              display: flex;
              flex-direction: column;
              gap: 6px;
              color: var(--muted);
              font-size: .92rem;
              line-height: 1.5;
            }
            .pix-instructions ol::marker { color: var(--gold); }
            .copy-block {
              display: flex;
              flex-direction: column;
              gap: 10px;
            }
            .copy-block label {
              color: var(--muted);
              font-size: .8rem;
              font-weight: 600;
              letter-spacing: .04em;
            }
            textarea {
              width: 100%;
              min-height: 96px;
              resize: vertical;
              padding: 14px;
              border: 1px solid var(--line);
              border-radius: 12px;
              background: rgba(3, 4, 5, .76);
              color: var(--text);
              font-family: ui-monospace, "SF Mono", Menlo, monospace;
              font-size: .82rem;
              line-height: 1.45;
              word-break: break-all;
            }
            textarea:focus { outline: 1px solid var(--line-strong); }
            .btn {
              width: 100%;
              min-height: 46px;
              display: inline-flex;
              align-items: center;
              justify-content: center;
              gap: 10px;
              padding: 0 18px;
              border: 1px solid transparent;
              border-radius: 12px;
              background: linear-gradient(135deg, #f9e5b8, var(--gold));
              color: #151009;
              cursor: pointer;
              font-weight: 800;
              text-align: center;
              transition: transform .15s ease, filter .15s ease;
            }
            .btn:hover { filter: brightness(1.05); }
            .btn:active { transform: translateY(1px); }
            .btn.ghost {
              background: transparent;
              color: var(--text);
              border-color: var(--line);
            }
            .status-line {
              display: flex;
              align-items: center;
              gap: 10px;
              padding: 12px 16px;
              border: 1px solid var(--line);
              border-radius: 12px;
              background: rgba(255, 255, 255, .03);
              color: var(--gold-strong);
              font-weight: 700;
              font-size: .9rem;
            }
            .status-dot {
              width: 8px;
              height: 8px;
              border-radius: 50%;
              background: var(--gold);
              box-shadow: 0 0 0 4px rgba(232, 197, 121, .15);
              animation: pulse 1.6s ease-in-out infinite;
            }
            .status-line.paid { color: var(--success); }
            .status-line.paid .status-dot { background: var(--success); box-shadow: 0 0 0 4px rgba(123, 211, 137, .18); animation: none; }
            @keyframes pulse {
              0%, 100% { opacity: 1; }
              50% { opacity: .35; }
            }
            .help {
              text-align: center;
              font-size: .85rem;
            }
            @media (max-width: 640px) {
              .page-shell { width: min(100vw - 24px, 720px); padding-top: 12px; gap: 22px; }
              .card { padding: 20px; }
              .pix-grid { grid-template-columns: 1fr; gap: 18px; }
              .qr-wrap { justify-self: center; }
              .qr-wrap img { width: 220px; height: 220px; }
              .summary-row.total strong { font-size: 1.4rem; }
            }
          </style>
        </head>
        <body>
          <div class="page-shell">
            <header class="topbar">
              <a class="brand" href="/" aria-label="Voltar para a Larping Brasil">
                <span class="brand-mark">
                  <svg viewBox="0 0 36 36" aria-hidden="true">
                    <path d="M18 4 L29 18 L7 18 Z" fill="currentColor" fill-opacity="0.18" />
                    <g stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" fill="none">
                      <path d="M18 4 L29 18 L18 32 L7 18 Z" stroke-width="1.9" />
                      <path d="M7 18 L29 18" stroke-width="1.5" />
                      <path d="M18 4 L18 32" stroke-width="1" stroke-opacity="0.45" />
                    </g>
                  </svg>
                </span>
                <span>Larping Brasil</span>
              </a>
              <a class="back-link" href="/">&larr; Voltar</a>
            </header>

            <section class="header-block">
              <p class="eyebrow">${paymentData.mode === "demo" ? "Ambiente de teste" : "Checkout seguro"}</p>
              <h1>Finalize seu pagamento</h1>
              <p class="lead">Pague com PIX em segundos. Assim que o pagamento for confirmado, seu acesso ao Larper+ é liberado automaticamente no Discord.</p>
            </section>

            <section class="card" aria-label="Resumo do pedido">
              <h2 class="card-title">
                Resumo do pedido
                <span class="pill ${order.status === "paid" ? "paid" : "pending"}">${escapeHtml(statusLabel)}</span>
              </h2>
              <div class="summary-list">
                <div class="summary-row">
                  <span>Produto</span>
                  <strong>${escapeHtml(order.product_name)}</strong>
                </div>
                <div class="summary-row">
                  <span>Método</span>
                  <strong>${escapeHtml(methodLabel)}</strong>
                </div>
                <div class="summary-row">
                  <span>Identificador</span>
                  <strong>${escapeHtml(order.external_id)}</strong>
                </div>
                <div class="summary-row total">
                  <span>Total a pagar</span>
                  <strong>${amount}</strong>
                </div>
              </div>
            </section>

            ${
              qrSource || paymentData.pixCode
                ? `<section class="card" aria-label="Pagamento via PIX">
                    <h2 class="card-title">Pagamento via PIX</h2>
                    <div class="pix-grid">
                      ${qrSource ? `<div class="qr-wrap"><img src="${escapeHtml(qrSource)}" alt="QR Code PIX" /></div>` : ""}
                      <div class="pix-instructions">
                        <ol>
                          <li>Abra o app do seu banco e escolha pagar via PIX.</li>
                          <li>Escaneie o QR Code ao lado ou use a opção PIX Copia e Cola.</li>
                          <li>Confirme o pagamento. A liberação no Discord é automática.</li>
                        </ol>
                      </div>
                    </div>
                    ${
                      paymentData.pixCode
                        ? `<div class="copy-block">
                            <label for="pix-code">PIX Copia e Cola</label>
                            <textarea id="pix-code" readonly>${escapeHtml(paymentData.pixCode)}</textarea>
                            <button id="copy-pix" class="btn" type="button">Copiar código PIX</button>
                          </div>`
                        : ""
                    }
                  </section>`
                : ""
            }

            ${paymentData.billetUrl ? `<a class="btn ghost" href="${escapeHtml(paymentData.billetUrl)}" target="_blank" rel="noreferrer">Abrir boleto em nova aba</a>` : ""}

            ${
              paymentData.mode === "demo"
                ? `<section class="card">
                    <h2 class="card-title">Modo demonstração</h2>
                    <p>Esta tela está no modo de teste local. Use o botão abaixo para simular um pagamento aprovado e validar o fluxo antes de conectar as credenciais reais.</p>
                    <button id="pay" class="btn">Simular pagamento aprovado</button>
                  </section>`
                : ""
            }

            <div id="status-line" class="status-line">
              <span class="status-dot"></span>
              <span id="status-text">Aguardando confirmação do pagamento…</span>
            </div>

            <p class="help">Dúvidas? Entre em contato pelo nosso Discord oficial.</p>
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
                copyPixButton.textContent = "Código PIX copiado!";
                setTimeout(() => { copyPixButton.textContent = original; }, 2200);
              });
            }

            if (payButton) {
              payButton.addEventListener("click", async () => {
                payButton.disabled = true;
                payButton.textContent = "Processando…";
                await fetch("/api/dev/orders/${order.external_id}/pay", { method: "POST" });
                location.href = "/?payment=approved";
              });
            }

            const statusLabels = {
              pending: "Aguardando confirmação do pagamento…",
              paid: "Pagamento confirmado! Redirecionando…",
              failed: "Pagamento recusado. Tente novamente.",
              cancelled: "Pagamento cancelado.",
              expired: "Pagamento expirado."
            };

            const poll = async () => {
              try {
                const response = await fetch("/api/orders/${order.external_id}/status", { credentials: "include" });
                if (!response.ok) return;
                const data = await response.json();
                const label = statusLabels[data.status] || ("Status: " + data.status);
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

function getStorefrontPayload() {
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

  return {
    authConfigured: isDiscordConfigured(),
    paymentConfigured: isInvictusConfigured(),
    guildConfigured: Boolean(process.env.DISCORD_GUILD_ID && process.env.DISCORD_BOT_TOKEN),
    hero: {
      eyebrow: "Larping Brasil premium membership",
      title: "Larper+ concentra o acesso da comunidade em uma única oferta de entrada.",
      description:
        "O foco agora é converter em um pagamento único de R$30, com checkout simples, acesso premium e liberação automática no Discord."
    },
    stats: [
      { label: "Membros ativos", value: `${Math.max(stats.sales_count, 120)}+` },
      { label: "Liberação de acesso", value: "Em segundos" },
      { label: "Oferta principal", value: "R$ 30 único" }
    ],
    product: primaryProduct,
    products,
    topBuyers:
      topBuyers.length > 0
        ? topBuyers.map((buyer) => ({
            name: buyer.name,
            username: buyer.username,
            avatar: buyer.avatar,
            total: formatCurrency(buyer.total_spent)
          }))
        : [
            { name: "Lootier", total: "R$ 3.180,00" },
            { name: "Carter_royall", total: "R$ 150,00" },
            { name: "Charlieatk2", total: "R$ 120,00" }
          ],
    recentBuyers:
      recentBuyers.length > 0
        ? recentBuyers.map((buyer) => ({
            name: buyer.name,
            username: buyer.username,
            avatar: buyer.avatar,
            product: buyer.product_name
          }))
        : [
            { name: "Q_4", product: "Larper+" },
            { name: "Lootier", product: "Larper+" },
            { name: "aoq", product: "Larper+" }
          ]
  };
}

function seedProducts() {
  const items = [
    {
      slug: "larper-plus",
      name: "Larper+",
      description: "Acesso oficial da comunidade fechada.",
      price_cents: 3000,
      role_id: process.env.DISCORD_ROLE_LARPER_PLUS_ID || process.env.DISCORD_ROLE_CLUB_ID || "",
      invictus_offer_hash: process.env.INVICTUSPAY_OFFER_HASH_LARPER_PLUS || process.env.INVICTUSPAY_OFFER_HASH_CLUB || "",
      invictus_product_hash:
        process.env.INVICTUSPAY_PRODUCT_HASH_LARPER_PLUS || process.env.INVICTUSPAY_PRODUCT_HASH_CLUB || "",
      badge: "Pagamento único",
      accent: "gold",
      benefits: JSON.stringify([
        "Acesso aos canais e benefícios premium",
        "Acesso a materiais, métodos e mídias exclusivas",
        "Atualizações recorrentes incluídas no acesso",
        "Entrega automática vinculada ao Discord"
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
    throw new Error("O pagamento por cartao exige dados adicionais no backend. Nesta base o fluxo esta pronto para PIX e boleto.");
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
  const data = rawResponse?.data || {};

  return {
    mode: "provider",
    checkoutUrl: `${origin}/checkout-local/${order.external_id}`,
    providerPaymentId: data.hash || null,
    providerStatus: data.status || "pending",
    rawResponse: {
      mode: "provider",
      ...data
    }
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
    status = String(remoteTransaction?.data?.status || "").toLowerCase();
    body = {
      ...body,
      data: remoteTransaction?.data || body?.data
    };
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
  if (!remoteTransaction?.data) {
    return order;
  }

  const remote = remoteTransaction.data;
  const status = String(remote.status || "").toLowerCase();
  const nextStatus = ["paid", "approved", "success", "completed", "confirmed", "settled"].includes(status)
    ? "paid"
    : mapProviderStatus(status);
  const paidAt = nextStatus === "paid" ? order.paid_at || Date.now() : order.paid_at;

  statements.updateOrderStatus.run(
    nextStatus,
    remote.hash || order.provider_payment_id,
    status || order.provider_status,
    JSON.stringify({ mode: "provider", ...remote }),
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

function buildQrCodeUrl(payload) {
  const data = encodeURIComponent(String(payload || ""));
  return `https://api.qrserver.com/v1/create-qr-code/?size=240x240&margin=8&qzone=1&data=${data}`;
}

function translateStatus(status) {
  const map = {
    pending: "Aguardando",
    paid: "Pago",
    failed: "Recusado",
    cancelled: "Cancelado",
    expired: "Expirado"
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
