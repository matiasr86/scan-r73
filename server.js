import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import helmet from "helmet";
import compression from "compression";
import morgan from "morgan";
import dotenv from "dotenv";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

const ODOO_BASE = process.env.ODOO_BASE;
const ODOO_TOKEN = process.env.ODOO_TOKEN;
const PRICELIST_ID_ENV = process.env.PRICELIST_ID ?? "";
const INCLUDE_TAXES = String(process.env.INCLUDE_TAXES ?? "true").toLowerCase() === "true";

if (!ODOO_BASE || !ODOO_TOKEN) {
  console.error("[server] Faltan ODOO_BASE u ODOO_TOKEN en .env");
  process.exit(1);
}

app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(morgan("tiny"));

app.use("/vendor", express.static(
  path.join(__dirname, "node_modules", "@ericblade", "quagga2", "dist")
));
app.use(express.static(path.join(__dirname, "public"), { etag: true, maxAge: "1h" }));

/* ---------- helpers ---------- */
function cleanParam(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (!s) return null;
  // Sanea casos raros que vimos: "", '' , null, undefined
  if (s === '""' || s === "''") return null;
  if (s.toLowerCase() === "null" || s.toLowerCase() === "undefined") return null;
  return s;
}

function buildUrl(base, pathname, params = {}) {
  const u = new URL(pathname, base);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    const sv = String(v);
    if (sv === "") continue;
    u.searchParams.set(k, sv);
  }
  return u.toString();
}

/* ---------- API ---------- */

// health
app.get("/healthz", (_req, res) => res.type("text/plain").send("ok"));

// ping (proxy)
app.get("/api/ping", async (_req, res) => {
  const url = buildUrl(ODOO_BASE, "/r73/ping", { _: Date.now() });
  try {
    console.log("[ping] ->", url);
    const r = await fetch(url, { cache: "no-store" });
    const txt = await r.text();
    console.log("[ping] <-", r.status, txt);
    res.status(r.status).type("text/plain").send(txt);
  } catch (e) {
    console.error("[ping] ERROR", e);
    res.status(502).json({ error: "bad_gateway", detail: String(e) });
  }
});

// scan (proxy)
app.get("/api/scan", async (req, res) => {
  try {
    // originales que vienen del browser
    const q = req.query || {};
    console.log("[scan] req.query =", q);

    // saneo fuerte
    const barcode = cleanParam(q.barcode);
    const include_taxes = cleanParam(q.include_taxes) ?? (INCLUDE_TAXES ? "true" : "false");

    // OJO con estas dos: solo las pasamos si quedan válidas
    const pricelist_id_q = cleanParam(q.pricelist_id);
    const pricelist_id_env = cleanParam(PRICELIST_ID_ENV);
    const pricelist_id = pricelist_id_q ?? pricelist_id_env; // opcional

    const web_pricelist_id = cleanParam(q.web_pricelist_id); // opcional

    if (!barcode) return res.status(400).json({ error: "missing_barcode" });

    const params = { barcode, include_taxes, token: ODOO_TOKEN, _: Date.now() };
    if (pricelist_id) params.pricelist_id = pricelist_id;
    if (web_pricelist_id) params.web_pricelist_id = web_pricelist_id;

    const url = buildUrl(ODOO_BASE, "/r73/scan", params);
    console.log("[scan] ->", url);

    const r = await fetch(url, { cache: "no-store" });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    console.log("[scan] <-", r.status, data);

    res.status(r.status).type("application/json").send(text);
  } catch (e) {
    console.error("[scan] ERROR", e);
    res.status(502).json({ error: "bad_gateway", detail: String(e) });
  }
});

// image (proxy stream)
app.get("/api/image", async (req, res) => {
  try {
    const pid = cleanParam(req.query.product_id);
    if (!pid) return res.status(400).type("text/plain").send("missing product_id");
    const url = buildUrl(ODOO_BASE, `/r73/image/${pid}`, { token: ODOO_TOKEN, _: Date.now() });
    console.log("[image] ->", url);

    const r = await fetch(url);
    if (!r.ok) {
      const txt = await r.text();
      console.warn("[image] <-", r.status, txt);
      return res.status(r.status).type("text/plain").send(txt);
    }

    res.setHeader("Content-Type", r.headers.get("content-type") || "image/png");
    res.setHeader("Cache-Control", "public, max-age=60");

    const reader = r.body.getReader();
    const stream = new ReadableStream({
      start(controller) {
        (function pump() {
          reader.read().then(({ done, value }) => {
            if (done) { controller.close(); return; }
            controller.enqueue(value); pump();
          });
        })();
      }
    });

    return new Response(stream).body.pipeTo(new WritableStream({
      write(chunk) { res.write(Buffer.from(chunk)); },
      close() { res.end(); },
      abort() { res.end(); }
    }));
  } catch (e) {
    console.error("[image] ERROR", e);
    res.status(502).type("text/plain").send(String(e));
  }
});

// SPA fallback
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`[server] http://localhost:${PORT}`);
  console.log("[server] ODOO_BASE =", ODOO_BASE);
  console.log("[server] PRICELIST_ID_ENV =", PRICELIST_ID_ENV);
});
