// public/app.js
// Frontend con Quagga2 + sonidos + modo kiosco + precios promo desde /api/scan
(function () {
  const CFG = window.APP_CONFIG || {};

  /* ---------------- Esperar a Quagga ---------------- */
  function whenQuaggaReady(cb) {
    const t = setInterval(() => {
      if (window.Quagga && typeof window.Quagga.init === "function") { clearInterval(t); cb(); }
    }, 100);
    setTimeout(() => clearInterval(t), 8000);
  }
  whenQuaggaReady(boot);

  /* ---------------- App ---------------- */
  function boot() {
    const els = {
      ping: document.getElementById("ping"),
      reader: document.getElementById("reader"),
      cameraWrap: document.getElementById("videoWrap"),
      cameraSelect: document.getElementById("cameraSelect"),
      toggleScan: document.getElementById("toggleScan"),
      status: document.getElementById("status"),
      manual: document.getElementById("manual"),
      buscar: document.getElementById("buscar"),
      iva: document.getElementById("iva"),
      result: document.getElementById("result"),
      inappWarning: document.getElementById("inappWarning"),
    };

    let scanning = false;
    let lastCode = null;
    let debounce = false;

    /* ---------------- Audio suave ---------------- */
    let audioCtx = null;
    function ensureAudio() {
      if (!audioCtx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        audioCtx = new AC();
      }
      if (audioCtx.state === "suspended") audioCtx.resume();
    }
    function beep(freq = 880, ms = 120, vol = 0.05, type = "sine") {
      if (!audioCtx) return;
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      gain.gain.value = vol;
      osc.connect(gain); gain.connect(audioCtx.destination);
      const now = audioCtx.currentTime;
      osc.start(now); osc.stop(now + ms / 1000);
    }
    function successChime() { beep(1175, 90, 0.045); setTimeout(() => beep(1568, 110, 0.045), 90); if (navigator.vibrate) navigator.vibrate(25); }
    function errorBuzz()   { beep(220, 120, 0.06, "square"); setTimeout(() => beep(196, 160, 0.06, "square"), 140); if (navigator.vibrate) navigator.vibrate(120); }

    /* ---------------- Utils ---------------- */
    function setStatus(text, isError = false) {
      els.status.textContent = text || "";
      els.status.className = "status " + (isError ? "err" : "ok");
    }
    const isInApp = /(Instagram|FBAN|FBAV|Line|Wechat|WhatsApp)/i.test(navigator.userAgent || "");

    function focusManual(clear = false) {
      if (clear) els.manual.value = "";
      setTimeout(() => { els.manual.focus(); els.manual.select?.(); }, 30);
    }

    function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
    function fmtMoney(value, currency) {
      try {
        return new Intl.NumberFormat("es-AR", { style: "currency", currency: currency || CFG.CURRENCY || "ARS" }).format(value || 0);
      } catch { return "$ " + (Number(value || 0).toFixed(2)); }
    }

    /* ---------------- Backend (proxy /api) ---------------- */
    async function ping() {
      try {
        const r = await fetch("/api/ping?_= " + Date.now(), { cache: "no-store" });
        const ok = r.ok && (await r.text()).trim().startsWith("ok");
        els.ping.textContent = ok ? "Conectado" : "Sin conexión";
        els.ping.className = "muted " + (ok ? "ok" : "err");
      } catch {
        els.ping.textContent = "Sin conexión";
        els.ping.className = "muted err";
      }
    }

    function buildScanUrl(barcode) {
      const u = new URL("/api/scan", window.location.origin);
      u.searchParams.set("barcode", String(barcode || "").trim());
      u.searchParams.set("include_taxes", els.iva?.checked ? "true" : "false");

      // ¡Importante! Enviar web_pricelist_id sólo si es numérico no vacío (evita 500 en Odoo por int(""))
      const webId = (CFG.PRICELIST_WEB_ID || "").trim();
      if (webId && /^\d+$/.test(webId)) {
        u.searchParams.set("web_pricelist_id", webId);
      }
      return u.toString();
    }

    function buildImageUrl(productId) {
      const u = new URL("/api/image", window.location.origin);
      u.searchParams.set("product_id", productId);
      return u.toString();
    }

    async function fetchJson(url) {
      const r = await fetch(url, { cache: "no-store" });
      const ct = r.headers.get("content-type") || "";
      if (!r.ok) {
        if (ct.includes("application/json")) {
          const j = await r.json().catch(() => ({}));
          throw new Error(JSON.stringify(j));
        } else {
          const t = await r.text().catch(() => "");
          throw new Error(t || ("HTTP " + r.status));
        }
      }
      return ct.includes("application/json") ? r.json() : r.text();
    }

    async function fetchAndRender(barcode) {
      try {
        setStatus("Buscando " + barcode + "…");
        const url = buildScanUrl(barcode);
        const data = await fetchJson(url);
        renderResult(data, barcode);
      } catch (e) {
        const msg = (e && e.message) ? e.message : String(e);
        setStatus("Error del servidor: " + msg, true);
        els.result.innerHTML = `<p class="muted">Error del servidor al consultar el código <b>${barcode}</b>.<br/><small>${escapeHtml(msg)}</small></p>`;
        errorBuzz();
      } finally {
        // Kiosco: siempre listos para el próximo
        focusManual(true);
      }
    }

    function escapeHtml(s) {
      return String(s || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    }

    function renderResult(data, code) {
    if (!data || data.error) {
      setStatus("Error: " + (data && data.error ? data.error : "respuesta inválida"), true);
      els.result.innerHTML = `<p class="muted">No se pudo consultar <b>${escapeHtml(code)}</b>.</p>`;
      errorBuzz();
      return;
    }
    if (!data.found) {
      els.result.innerHTML = `<p class="muted">No se encontró el código: <b>${escapeHtml(code)}</b></p>`;
      setStatus("");
      errorBuzz();
      return;
    }

    // Base y promo (el backend ya respeta include_taxes)
    const currency   = data.currency || CFG.CURRENCY || "ARS";
    const basePrice  = Number(data.price_with_taxes ?? data.price ?? 0);
    const webPrice   = (data.web_price_with_taxes ?? data.web_price);
    const hasWeb     = typeof webPrice === "number" && !Number.isNaN(webPrice);
    const isPromo    = hasWeb && Number(webPrice) > 0 && Number(webPrice) < basePrice;
    const effective  = isPromo ? Number(webPrice) : basePrice;

    const imgUrl = buildImageUrl(data.id);

    // === REGLAS DE PAGO (ACTUALIZADAS) =========================
    // 3 cuotas sin interés: se mantiene como antes (aplica también a promo si supera el umbral)
    const can3     = effective >= (CFG.THRESHOLDS?.THREE_INSTALLMENTS || 100000);

    // 6 cuotas:
    // - Si NO es precio promocional y el monto >= 350.000 => 6 sin interés
    // - Si NO es precio promocional y el monto >= 200.000 (umbral) => 6 con +5%
    // - Si es promocional => no aplica 6 cuotas
    const can6Free = (!isPromo) && (effective >= 350000);
    const can6Paid = (!isPromo) && !can6Free &&
                    (effective >= (CFG.THRESHOLDS?.SIX_INSTALLMENTS || 200000));

    const cash     = (!isPromo) ? round2(effective * (1 - (CFG.CASH_DISCOUNT_PCT || 0.05))) : null;
    const three    = can3 ? round2(effective / 3) : null;
    const sixFree  = can6Free ? round2(effective / 6) : null;
    const sixPaid  = can6Paid ? round2((effective * (1 + (CFG.INTEREST?.SIX_INSTALLMENTS || 0.05))) / 6) : null;
    // ===========================================================

    const topPriceHtml = isPromo
      ? `<div class="price"><span class="price-old">${fmtMoney(basePrice, currency)}</span> <span class="price-promo">${fmtMoney(effective, currency)}</span></div>`
      : `<div class="price">${fmtMoney(effective, currency)}</div>`;

    // Fila de 6 cuotas según la nueva lógica
    let sixRow;
    if (isPromo) {
      sixRow = `<div class="row"><span>6 cuotas</span><b>No aplica (precio promocional)</b></div>`;
    } else if (can6Free) {
      sixRow = `<div class="row"><span>6 cuotas sin interés</span><b>6 × ${fmtMoney(sixFree, currency)}</b></div>`;
    } else {
      sixRow = `<div class="row"><span>6 cuotas (+5%)</span><b>${can6Paid ? `6 × ${fmtMoney(sixPaid, currency)}` : "No aplica"}</b></div>`;
    }

    const payRows = [
      isPromo
        ? `<div class="row"><span>Débito / Efectivo / Transferencia</span><b>No aplica (precio promocional)</b></div>`
        : `<div class="row"><span>Débito / Efectivo / Transferencia (-5%)</span><b>${fmtMoney(cash, currency)}</b></div>`,
      `<div class="row"><span>3 cuotas sin interés</span><b>${can3 ? `3 × ${fmtMoney(three, currency)}` : "No aplica"}</b></div>`,
      sixRow
    ].join("");

    els.result.innerHTML = `
      <article class="card">
        <img src="${imgUrl}" alt="Imagen" />
        <div>
          <div class="sku">${escapeHtml(data.default_code || '')} · ${escapeHtml(data.barcode || '')}</div>
          <div class="name">${escapeHtml(data.name || '')}</div>
          ${topPriceHtml}
          <div class="sku">Moneda: ${escapeHtml(currency)}</div>
          <div class="paygrid">${payRows}</div>
        </div>
      </article>
    `;

    setStatus("OK");
    successChime();
  }


    /* ---------------- Cámara / Quagga2 ---------------- */
    async function ensurePermission() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        setStatus("Tu navegador no soporta cámara. Probá Safari/Chrome.", true);
        return false;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        stream.getTracks().forEach(t => t.stop());
        return true;
      } catch {
        setStatus("Permiso de cámara denegado/bloqueado. Permití cámara.", true);
        return false;
      }
    }

    async function listCameras() {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const cams = devices.filter(d => d.kind === "videoinput");
        els.cameraSelect.innerHTML = cams.map((d, i) =>
          `<option value="${d.deviceId}">${d.label || "Cámara " + (i + 1)}</option>`
        ).join("");
      } catch { els.cameraSelect.innerHTML = ""; }
    }

    function quaggaConfig(deviceId) {
      return {
        inputStream: {
          name: "Live",
          type: "LiveStream",
          target: els.reader,
          constraints: deviceId
            ? { deviceId: { exact: deviceId } }
            : { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } },
        },
        frequency: 10,
        locate: true,
        numOfWorkers: (typeof navigator.hardwareConcurrency === "number" && navigator.hardwareConcurrency > 1)
          ? Math.min(4, navigator.hardwareConcurrency) : 0,
        decoder: {
          readers: [
            "ean_reader", "ean_8_reader",
            "upc_reader", "upc_e_reader",
            "code_128_reader",
          ],
          multiple: false
        }
      };
    }

    function startQuagga(deviceId) {
      return new Promise((resolve, reject) => {
        const cfg = quaggaConfig(deviceId);
        Quagga.init(cfg, (err) => {
          if (err) { reject(err); return; }
          Quagga.start(); resolve();
        });
      });
    }

    async function startScan() {
      if (scanning) return;
      if (isInApp) els.inappWarning?.classList?.remove("hidden");
      const ok = await ensurePermission(); if (!ok) return;

      try {
        setStatus("Inicializando cámara…");
        await startQuagga(els.cameraSelect.value || null);
        scanning = true;
        els.toggleScan.textContent = "Detener";
        els.cameraWrap.classList.remove("hidden");
        setStatus("Escaneando…");
        Quagga.offDetected(onDetected);
        Quagga.onDetected(onDetected);
      } catch (e) {
        setStatus("No se pudo iniciar el lector: " + (e.message || e), true);
        scanning = false;
        els.toggleScan.textContent = "Iniciar escaneo";
        els.cameraWrap.classList.add("hidden");
      }
    }

    async function stopScan() {
      if (!scanning) return;
      try { Quagga.offDetected(onDetected); Quagga.stop(); } catch {}
      scanning = false;
      els.toggleScan.textContent = "Iniciar escaneo";
      els.cameraWrap.classList.add("hidden");
      setStatus("");
      focusManual();
    }

    function onDetected(result) {
      const code = result && result.codeResult && result.codeResult.code;
      if (!code || debounce) return;
      debounce = true;
      if (code !== lastCode) {
        lastCode = code;
        fetchAndRender(code).finally(() => setTimeout(() => (debounce = false), 700));
      } else {
        setTimeout(() => (debounce = false), 300);
      }
    }

    /* ---------------- Eventos ---------------- */
    els.toggleScan.addEventListener("click", () => { ensureAudio(); (scanning ? stopScan() : startScan()); });
    els.buscar.addEventListener("click", () => { ensureAudio(); const v = els.manual.value.trim(); if (v) fetchAndRender(v); });
    els.manual.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { ensureAudio(); const v = els.manual.value.trim(); if (v) fetchAndRender(v); }
    });
    els.cameraSelect.addEventListener("change", async () => { if (!scanning) return; await stopScan(); await startScan(); });
    window.addEventListener("beforeunload", () => { if (scanning) Quagga.stop(); });

    /* ---------------- Init (kiosco por defecto) ---------------- */
    (async function init() {
      await ping();
      await ensurePermission();
      await listCameras();
      els.cameraWrap.classList.add("hidden"); // kiosco: cámara oculta al inicio
      focusManual(true);                      // foco listo para lector USB
    })();
  }
})();
