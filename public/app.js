/* Bulgaria drone no-fly zones — interactive Leaflet map. */
(function () {
  "use strict";

  const I18N = window.I18N;
  const RESTRICTIONS = ["PROHIBITED", "REQ_AUTHORISATION", "CONDITIONAL"];
  const REASONS = ["SENSITIVE", "PRIVACY", "AIR_TRAFFIC", "FOREIGN_TERRITORY", "NATURE"];

  // Colour per restriction level.
  const COLORS = {
    PROHIBITED: "#dc2626",
    REQ_AUTHORISATION: "#d97706",
    CONDITIONAL: "#2563eb",
    UNKNOWN: "#6b7280",
  };

  const state = {
    lang: localStorage.getItem("lang") || "bg",
    restrictions: new Set(RESTRICTIONS),
    reasons: new Set(REASONS),
    features: [],
    layers: new Map(), // feature id -> leaflet layer
    total: 0,
  };

  const el = (id) => document.getElementById(id);
  const t = () => I18N[state.lang];

  /* ---------------------------------------------------------------- Map ---- */
  const map = L.map("map", {
    center: [42.75, 25.4],
    zoom: 7,
    zoomControl: true,
    preferCanvas: true, // canvas renderer: far faster for ~900 vector shapes
  });

  L.control.scale({ imperial: false }).addTo(map);

  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);

  const zoneLayer = L.layerGroup().addTo(map);
  let locationMarker = null;
  let locationCircle = null;

  /* ------------------------------------------------------------ Styling ---- */
  function styleFor(restriction, highlight) {
    const color = COLORS[restriction] || COLORS.UNKNOWN;
    return {
      color,
      weight: highlight ? 3 : 1,
      opacity: 1,
      fillColor: color,
      fillOpacity: highlight ? 0.45 : 0.22,
    };
  }

  /* ------------------------------------------------------------- Popups ---- */
  function esc(s) {
    return String(s == null ? "" : s).replace(
      /[&<>"']/g,
      (c) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
    );
  }

  function altitudeText(p) {
    if (p.lower == null && p.upper == null) return "—";
    const ref = (r) => (r === "AMSL" ? t().amsl : t().agl);
    const lo = p.lower != null ? `${p.lower} m ${ref(p.lowerRef)}` : "0 m";
    const hi = p.upper != null ? `${p.upper} m ${ref(p.upperRef)}` : "—";
    return `${lo} – ${hi}`;
  }

  function isoToDate(s) {
    if (!s) return "";
    const d = new Date(s);
    if (isNaN(d)) return s;
    return d.toLocaleDateString(state.lang === "bg" ? "bg-BG" : "en-GB");
  }

  // "P07DT00H00M" -> "7 days"
  function leadTimeText(iso) {
    if (!iso) return "";
    const m = /P(?:(\d+)D)?T?/.exec(iso);
    if (m && m[1]) return `${parseInt(m[1], 10)} ${t().days}`;
    return iso;
  }

  function popupHtml(p) {
    const L = t();
    const rLabel = L.restriction[p.restriction] || p.restriction;
    const color = COLORS[p.restriction] || COLORS.UNKNOWN;
    const reasons = (p.reasons || [])
      .map((r) => L.reason[r] || r)
      .map((r) => `<span class="chip">${esc(r)}</span>`)
      .join(" ");

    const rows = [];
    rows.push(
      `<tr><th>${esc(L.altitude)}</th><td>${esc(altitudeText(p))}</td></tr>`,
    );
    if (reasons)
      rows.push(`<tr><th>${esc(L.reasons)}</th><td>${reasons}</td></tr>`);

    if (p.permanent === "YES") {
      rows.push(`<tr><th>${esc(L.applicability)}</th><td>${esc(L.permanent)}</td></tr>`);
    } else if (p.startDateTime || p.endDateTime) {
      rows.push(
        `<tr><th>${esc(L.period)}</th><td>${esc(isoToDate(p.startDateTime))} – ${esc(
          isoToDate(p.endDateTime),
        )}</td></tr>`,
      );
    }
    if (p.intervalBefore) {
      rows.push(
        `<tr><th>${esc(L.leadTime)}</th><td>${esc(leadTimeText(p.intervalBefore))}</td></tr>`,
      );
    }
    if (p.authorityName)
      rows.push(`<tr><th>${esc(L.authority)}</th><td>${esc(p.authorityName)}</td></tr>`);

    const contactBits = [];
    if (p.email)
      contactBits.push(`<a href="mailto:${esc(p.email)}">${esc(p.email)}</a>`);
    if (p.phone)
      contactBits.push(
        `<a href="tel:${esc(p.phone.replace(/\s+/g, ""))}">${esc(p.phone)}</a>`,
      );
    if (contactBits.length)
      rows.push(`<tr><th>${esc(L.contact)}</th><td>${contactBits.join("<br>")}</td></tr>`);

    const note = p.otherReasonInfo
      ? `<p class="popup-note"><strong>${esc(L.note)}:</strong> ${esc(p.otherReasonInfo)}</p>`
      : "";
    const message = p.message ? `<p class="popup-msg">${esc(p.message)}</p>` : "";

    return `
      <div class="popup">
        <div class="popup-head" style="--c:${color}">
          <span class="popup-badge">${esc(rLabel)}</span>
          <h3>${esc(p.name || p.id)}</h3>
          <span class="popup-id">${esc(L.zone)} ${esc(p.id)}</span>
        </div>
        <table class="popup-table">${rows.join("")}</table>
        ${message}
        ${note}
      </div>`;
  }

  /* -------------------------------------------------------- Build layers --- */
  function makeLayer(feature) {
    const p = feature.properties;
    const style = styleFor(p.restriction, false);
    let layer;
    if (p.shape === "circle") {
      const [lng, lat] = feature.geometry.coordinates;
      layer = L.circle([lat, lng], { radius: p.radius || 0, ...style });
    } else {
      layer = L.geoJSON(feature, { style }).getLayers()[0];
    }
    layer.feature = feature;
    layer.bindPopup(() => popupHtml(p), { maxWidth: 340, autoPan: true });
    layer.on("popupopen", () => layer.setStyle(styleFor(p.restriction, true)));
    layer.on("popupclose", () => layer.setStyle(styleFor(p.restriction, false)));
    return layer;
  }

  function matchesFilters(p) {
    if (!state.restrictions.has(p.restriction)) return false;
    // A zone with multiple reasons is shown if ANY of its reasons is enabled.
    const rs = p.reasons && p.reasons.length ? p.reasons : ["UNKNOWN"];
    return rs.some((r) => state.reasons.has(r));
  }

  function applyFilters() {
    let shown = 0;
    for (const feature of state.features) {
      const p = feature.properties;
      const layer = state.layers.get(p.id);
      const visible = matchesFilters(p);
      if (visible) {
        if (!zoneLayer.hasLayer(layer)) zoneLayer.addLayer(layer);
        shown++;
      } else if (zoneLayer.hasLayer(layer)) {
        zoneLayer.removeLayer(layer);
      }
    }
    el("counter").textContent = t().counterShown(shown, state.total);
  }

  /* --------------------------------------------------------- Filters UI ---- */
  function renderFilterGroups() {
    const rWrap = el("restriction-filters");
    const reWrap = el("reason-filters");
    rWrap.innerHTML = "";
    reWrap.innerHTML = "";

    RESTRICTIONS.forEach((key) => {
      rWrap.appendChild(
        buildToggle(key, COLORS[key], state.restrictions, () => {
          if (state.restrictions.has(key)) state.restrictions.delete(key);
          else state.restrictions.add(key);
          applyFilters();
        }, "restriction"),
      );
    });

    REASONS.forEach((key) => {
      reWrap.appendChild(
        buildToggle(key, null, state.reasons, () => {
          if (state.reasons.has(key)) state.reasons.delete(key);
          else state.reasons.add(key);
          applyFilters();
        }, "reason"),
      );
    });
  }

  function buildToggle(key, swatch, set, onToggle, kind) {
    const label = document.createElement("label");
    label.className = "toggle";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = set.has(key);
    input.addEventListener("change", onToggle);
    const span = document.createElement("span");
    span.className = "toggle-label";
    span.dataset.enum = kind + ":" + key;
    span.textContent = t()[kind][key] || key;
    if (swatch) {
      const dot = document.createElement("span");
      dot.className = "swatch";
      dot.style.background = swatch;
      label.appendChild(input);
      label.appendChild(dot);
      label.appendChild(span);
    } else {
      label.appendChild(input);
      label.appendChild(span);
    }
    return label;
  }

  /* ------------------------------------------------------------ Search ----- */
  let searchTimer = null;
  function onSearchInput(e) {
    clearTimeout(searchTimer);
    const q = e.target.value.trim().toLowerCase();
    searchTimer = setTimeout(() => runSearch(q), 120);
  }

  function runSearch(q) {
    const box = el("search-results");
    if (!q) {
      box.hidden = true;
      box.innerHTML = "";
      return;
    }
    const hits = state.features
      .filter((f) => {
        const p = f.properties;
        return (
          (p.name && p.name.toLowerCase().includes(q)) ||
          (p.id && p.id.toLowerCase().includes(q))
        );
      })
      .slice(0, 30);

    box.innerHTML = "";
    if (!hits.length) {
      const li = document.createElement("li");
      li.className = "search-empty";
      li.textContent = t().noResults;
      box.appendChild(li);
      box.hidden = false;
      return;
    }
    hits.forEach((f) => {
      const p = f.properties;
      const li = document.createElement("li");
      li.tabIndex = 0;
      li.innerHTML = `<span class="dot" style="background:${
        COLORS[p.restriction] || COLORS.UNKNOWN
      }"></span><span class="s-name">${esc(p.name || p.id)}</span><span class="s-id">${esc(
        p.id,
      )}</span>`;
      const go = () => focusFeature(f);
      li.addEventListener("click", go);
      li.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") go();
      });
      box.appendChild(li);
    });
    box.hidden = false;
  }

  function focusFeature(f) {
    const p = f.properties;
    // Make sure its filters are on so the layer is present.
    state.restrictions.add(p.restriction);
    (p.reasons || []).forEach((r) => state.reasons.add(r));
    syncFilterCheckboxes();
    applyFilters();

    const layer = state.layers.get(p.id);
    if (!layer) return;
    if (p.shape === "circle") {
      map.setView(layer.getLatLng(), 13, { animate: true });
    } else {
      map.fitBounds(layer.getBounds(), { maxZoom: 14, padding: [40, 40] });
    }
    layer.openPopup();
    el("search-results").hidden = true;
    el("search-input").value = "";
    closeSidebarOnMobile();
  }

  function syncFilterCheckboxes() {
    document.querySelectorAll("#restriction-filters input").forEach((input, i) => {
      input.checked = state.restrictions.has(RESTRICTIONS[i]);
    });
    document.querySelectorAll("#reason-filters input").forEach((input, i) => {
      input.checked = state.reasons.has(REASONS[i]);
    });
  }

  /* ------------------------------------------------------------ Locate ----- */
  function locate() {
    if (!navigator.geolocation) {
      alert(t().locateError);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude, accuracy } = pos.coords;
        const latlng = [latitude, longitude];
        if (locationMarker) map.removeLayer(locationMarker);
        if (locationCircle) map.removeLayer(locationCircle);
        locationCircle = L.circle(latlng, {
          radius: accuracy || 50,
          color: "#0ea5e9",
          weight: 1,
          fillColor: "#0ea5e9",
          fillOpacity: 0.15,
        }).addTo(map);
        locationMarker = L.marker(latlng).addTo(map).bindPopup(t().you);
        map.setView(latlng, 13, { animate: true });
        locationMarker.openPopup();
        closeSidebarOnMobile();
      },
      (err) => {
        alert(err.code === err.PERMISSION_DENIED ? t().locateDenied : t().locateError);
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 },
    );
  }

  function reset() {
    state.restrictions = new Set(RESTRICTIONS);
    state.reasons = new Set(REASONS);
    syncFilterCheckboxes();
    applyFilters();
    el("search-input").value = "";
    el("search-results").hidden = true;
  }

  /* --------------------------------------------------------- Language ------ */
  function applyLanguage() {
    const L = t();
    document.documentElement.lang = state.lang;
    document.querySelectorAll("[data-i18n]").forEach((node) => {
      const key = node.getAttribute("data-i18n");
      if (typeof L[key] === "string") node.textContent = L[key];
    });
    document.querySelectorAll("[data-i18n-attr]").forEach((node) => {
      const [attr, key] = node.getAttribute("data-i18n-attr").split(":");
      if (typeof L[key] === "string") node.setAttribute(attr, L[key]);
    });
    // Enum labels in filter toggles.
    document.querySelectorAll(".toggle-label[data-enum]").forEach((node) => {
      const [kind, key] = node.dataset.enum.split(":");
      node.textContent = L[kind][key] || key;
    });
    document.querySelectorAll(".lang-btn").forEach((b) => {
      b.classList.toggle("is-active", b.dataset.lang === state.lang);
    });
    if (state.total) el("counter").textContent = null; // recompute below
    applyFilters();
    updateDatasetMeta();
    // Re-open any popup so its content picks up the new language.
    map.closePopup();
  }

  function setLanguage(lang) {
    if (!I18N[lang]) return;
    state.lang = lang;
    localStorage.setItem("lang", lang);
    applyLanguage();
  }

  let datasetMeta = null;
  function updateDatasetMeta() {
    const node = el("dataset-meta");
    if (!datasetMeta) return;
    const d = new Date(datasetMeta.generatedAt);
    const version = esc(datasetMeta.title || "");
    node.innerHTML = `${version}<br>${state.total} ${
      state.lang === "bg" ? "зони" : "zones"
    }`;
  }

  /* -------------------------------------------------------- Sidebar UI ----- */
  function openSidebar() {
    el("sidebar").classList.add("is-open");
    el("backdrop").hidden = false;
    el("menu-toggle").setAttribute("aria-expanded", "true");
  }
  function closeSidebar() {
    el("sidebar").classList.remove("is-open");
    el("backdrop").hidden = true;
    el("menu-toggle").setAttribute("aria-expanded", "false");
  }
  function closeSidebarOnMobile() {
    if (window.matchMedia("(max-width: 768px)").matches) closeSidebar();
  }
  function toggleSidebar() {
    if (el("sidebar").classList.contains("is-open")) closeSidebar();
    else openSidebar();
  }

  /* ------------------------------------------------------------- Boot ------ */
  function wireEvents() {
    el("search-input").addEventListener("input", onSearchInput);
    el("search-input").addEventListener("focus", (e) => runSearch(e.target.value.trim().toLowerCase()));
    document.addEventListener("click", (e) => {
      if (!e.target.closest(".search")) el("search-results").hidden = true;
    });
    el("locate-btn").addEventListener("click", locate);
    el("reset-btn").addEventListener("click", reset);
    el("menu-toggle").addEventListener("click", toggleSidebar);
    el("backdrop").addEventListener("click", closeSidebar);
    document.querySelectorAll(".lang-btn").forEach((b) =>
      b.addEventListener("click", () => setLanguage(b.dataset.lang)),
    );
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        el("search-results").hidden = true;
        closeSidebar();
      }
    });
  }

  async function load() {
    wireEvents();
    renderFilterGroups();
    applyLanguage();
    try {
      const [zonesRes, metaRes] = await Promise.all([
        fetch("data/zones.geojson"),
        fetch("data/meta.json"),
      ]);
      const geojson = await zonesRes.json();
      datasetMeta = await metaRes.json();
      state.features = geojson.features;
      state.total = state.features.length;

      for (const feature of state.features) {
        const layer = makeLayer(feature);
        state.layers.set(feature.properties.id, layer);
      }
      applyFilters();
      updateDatasetMeta();
    } catch (err) {
      console.error(err);
      el("loading").innerHTML =
        '<span style="color:#dc2626">⚠ ' +
        (state.lang === "bg" ? "Грешка при зареждане на данните." : "Failed to load data.") +
        "</span>";
      return;
    }
    el("loading").classList.add("is-hidden");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", load);
  } else {
    load();
  }
})();
