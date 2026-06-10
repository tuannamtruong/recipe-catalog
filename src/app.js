// Cooking app — single-page vanilla JS.
// State lives in memory; the API (or baked data in static build) is the source of truth.

(() => {
  "use strict";

  // ----- data source -----

  // When built into a single self-contained recipes.html, build.py replaces the
  // line below with: const BAKED = [...]; otherwise BAKED is null and we fetch.
  const BAKED = (typeof __BAKED_RECIPES__ !== "undefined") ? __BAKED_RECIPES__ : null;
  const STATIC_MODE = Array.isArray(BAKED);

  /** Returns Promise<RecipeRecord[]> */
  async function loadRecipes() {
    if (STATIC_MODE) return BAKED.slice();
    const r = await fetch("/api/recipes");
    if (!r.ok) throw new Error("failed to load recipes");
    return r.json();
  }

  async function saveRecipe(rec, mode /* "create" | "update" */) {
    if (STATIC_MODE) throw new Error("Read-only mode (no server)");
    const url = mode === "update"
      ? `/api/recipes/${encodeURIComponent(rec.slug)}`
      : "/api/recipes";
    const method = mode === "update" ? "PUT" : "POST";
    const r = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(rec),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || `save failed (${r.status})`);
    return body;
  }

  async function deleteRecipe(slug) {
    if (STATIC_MODE) throw new Error("Read-only mode (no server)");
    const r = await fetch(`/api/recipes/${encodeURIComponent(slug)}`, { method: "DELETE" });
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      throw new Error(body.error || `delete failed (${r.status})`);
    }
  }

  async function uploadImage(file, slug) {
    if (STATIC_MODE) throw new Error("Read-only mode (no server)");
    const ext = (file.name.match(/\.[A-Za-z0-9]+$/) || [".jpg"])[0].toLowerCase();
    const safeSlug = slug.replace(/[^a-zA-Z0-9_-]/g, "");
    const filename = `${safeSlug || "image"}-${Date.now()}${ext}`;
    const data = await file.arrayBuffer();
    const b64 = bytesToBase64(new Uint8Array(data));
    const r = await fetch("/api/images", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename, data_base64: b64 }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || `upload failed (${r.status})`);
    return body.filename;
  }

  function bytesToBase64(bytes) {
    let s = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(s);
  }

  // ----- imperial -> metric conversion -----
  //
  // Applied on save (create or edit). Inline format: keep the original text,
  // append metric in parentheses. tsp/tbs are intentionally left alone.

  // Per-cup weights (grams) for common ingredients. Liquids are in mL.
  // Source: the conversion table at the top of Cooking.docx.
  const CUP_GRAMS = {
    flour: 120, "all-purpose flour": 120, "ap flour": 120,
    sugar: 200, "brown sugar": 220, "powdered sugar": 120,
    butter: 227, "cocoa": 85, "cocoa powder": 85,
    salt: 288, honey: 340, "baking powder": 192, "baking soda": 220,
    oat: 90, oats: 90, rice: 185,
  };
  const CUP_ML = {
    water: 237, milk: 240, "almond milk": 240, "coconut milk": 240,
    cream: 240, "heavy cream": 240, "sour cream": 240,
    broth: 240, stock: 240, juice: 240, vinegar: 240,
    oil: 218, "olive oil": 218, "vegetable oil": 218,
    syrup: 320, "maple syrup": 320,
    yogurt: 245, "greek yogurt": 245,
    sữa: 240, nước: 237,
  };

  function parseQty(s) {
    s = s.trim().replace(",", ".");
    // mixed numeral like "1 1/2"
    let m = s.match(/^(\d+)\s+(\d+)\s*\/\s*(\d+)$/);
    if (m) return Number(m[1]) + Number(m[2]) / Number(m[3]);
    m = s.match(/^(\d+)\s*\/\s*(\d+)$/);
    if (m) return Number(m[1]) / Number(m[2]);
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }

  function fmtNum(n) {
    if (n >= 100) return String(Math.round(n));
    if (n >= 10) return String(Math.round(n));
    return n.toFixed(1).replace(/\.0$/, "");
  }

  function pickCupConversion(rest) {
    const r = rest.toLowerCase();
    // longest keyword first
    const keys = Object.keys({ ...CUP_GRAMS, ...CUP_ML }).sort((a, b) => b.length - a.length);
    for (const k of keys) {
      const re = new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
      if (re.test(r)) {
        if (k in CUP_ML) return { unit: "ml", per: CUP_ML[k] };
        return { unit: "g", per: CUP_GRAMS[k] };
      }
    }
    return { unit: "ml", per: 237 }; // default to volume
  }

  // Each entry: { re, replace(match) => string }
  const CONVERTERS = [
    // °F or 350F  ->  °C
    {
      re: /(\d+(?:[.,]\d+)?)\s*°?\s*F\b/g,
      replace: (m, q) => {
        const f = parseQty(q); if (f == null) return m;
        const c = Math.round(((f - 32) * 5) / 9);
        return `${m} (${c} °C)`;
      },
    },
    // oz  ->  g  (28.35 g/oz)
    {
      re: /(\d+(?:[.,]\d+)?(?:\s*-\s*\d+(?:[.,]\d+)?)?(?:\s+\d+\s*\/\s*\d+)?|\d+\s*\/\s*\d+)\s*oz\b/gi,
      replace: (m, q) => {
        const first = q.split(/\s*-\s*/)[0];
        const n = parseQty(first); if (n == null) return m;
        return `${m} (${fmtNum(n * 28.35)} g)`;
      },
    },
    // lb / lbs / pound / pounds  ->  g  (453.6 g/lb)
    {
      re: /(\d+(?:[.,]\d+)?(?:\s*-\s*\d+(?:[.,]\d+)?)?(?:\s+\d+\s*\/\s*\d+)?|\d+\s*\/\s*\d+)\s*(?:lbs?|pounds?)\b/gi,
      replace: (m, q) => {
        const n = parseQty(q.split(/\s*-\s*/)[0]); if (n == null) return m;
        return `${m} (${fmtNum(n * 453.6)} g)`;
      },
    },
    // cup / cups  ->  ml or g depending on ingredient
    {
      re: /(\d+(?:[.,]\d+)?(?:\s+\d+\s*\/\s*\d+)?|\d+\s*\/\s*\d+)\s*cups?\b([^\n]*)/gi,
      replace: (m, q, rest) => {
        const n = parseQty(q); if (n == null) return m;
        const { unit, per } = pickCupConversion(rest || "");
        // Reconstruct: only annotate the cup portion, keep `rest` as-is.
        const cupPart = m.slice(0, m.length - (rest ? rest.length : 0));
        return `${cupPart} (${fmtNum(n * per)} ${unit})${rest || ""}`;
      },
    },
  ];

  function convertImperialLine(line) {
    if (!line) return line;
    // Skip if there's already a metric annotation right after a unit.
    let out = line;
    for (const { re, replace } of CONVERTERS) {
      out = out.replace(re, (match, ...groups) => {
        // Don't double-annotate: if a `( ... g)` or `( ... ml)` already follows,
        // leave the match alone.
        const afterIdx = out.indexOf(match) + match.length;
        const tail = out.slice(afterIdx, afterIdx + 16);
        if (/^\s*\([^)]*\b(?:g|ml|°C|C)\b/.test(tail)) return match;
        return replace(match, ...groups);
      });
    }
    return out;
  }

  function convertImperialList(lines) {
    return (lines || []).map(convertImperialLine);
  }

  // ----- markdown body parsing -----

  /** Pull "## Ingredients" / "## Steps" / leftover from the body text. */
  function parseBody(body) {
    const sections = { ingredients: [], steps: [], notes: [] };
    let current = "notes";
    for (const raw of (body || "").split(/\r?\n/)) {
      const line = raw.trim();
      if (/^##\s+ingredients\b/i.test(line)) { current = "ingredients"; continue; }
      if (/^##\s+steps\b/i.test(line)) { current = "steps"; continue; }
      if (/^##\s+notes\b/i.test(line)) { current = "notes"; continue; }
      if (!line) continue;
      const cleaned = line.replace(/^[-*]\s+/, "").replace(/^\d+\.\s+/, "");
      sections[current].push(cleaned);
    }
    return sections;
  }

  function buildBody({ ingredients, steps, notes }) {
    const parts = [];
    parts.push("## Ingredients");
    if (ingredients.length) {
      for (const i of ingredients) parts.push(`- ${i}`);
    } else {
      parts.push("- ");
    }
    parts.push("");
    parts.push("## Steps");
    if (steps.length) {
      steps.forEach((s, i) => parts.push(`${i + 1}. ${s}`));
    } else {
      parts.push("1. ");
    }
    if (notes && notes.length) {
      parts.push("");
      parts.push("## Notes");
      for (const n of notes) parts.push(n);
    }
    return parts.join("\n") + "\n";
  }

  // ----- state + view glue -----

  const state = {
    recipes: [],
    query: "",
    category: "",
    showImages: false,
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const main = $("#main");

  function categoriesOf(rec) {
    const cs = rec.frontmatter?.categories;
    if (!Array.isArray(cs)) return [];
    return cs.filter((c) => typeof c === "string" && c.trim()).map((c) => c.trim());
  }

  function refreshCategoryFilter() {
    const select = $("#category-filter");
    const seen = new Set();
    for (const r of state.recipes) {
      for (const c of categoriesOf(r)) seen.add(c);
    }
    const cats = Array.from(seen).sort((a, b) => a.localeCompare(b));
    const current = state.category;
    select.innerHTML = '<option value="">All categories</option>' +
      cats.map((c) => `<option value="${escapeAttr(c)}">${escapeHtml(c)}</option>`).join("");
    select.value = current;
  }

  function filteredRecipes() {
    const q = state.query.trim().toLowerCase();
    return state.recipes.filter((r) => {
      if (state.category) {
        const cats = categoriesOf(r);
        if (!cats.includes(state.category)) return false;
      }
      if (q) {
        const hay = (
          (r.frontmatter?.title || "") + "\n" +
          (r.body || "") + "\n" +
          categoriesOf(r).join(" ")
        ).toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  // ----- views -----

  function showList() {
    const recipes = filteredRecipes();
    main.innerHTML = "";
    if (!recipes.length) {
      const p = document.createElement("p");
      p.className = "empty";
      p.textContent = state.recipes.length ? "No recipes match the current filter." : "No recipes yet.";
      main.appendChild(p);
      return;
    }
    const grid = document.createElement("div");
    grid.className = "cards";
    const tpl = $("#tpl-card");
    for (const r of recipes) {
      const node = tpl.content.firstElementChild.cloneNode(true);
      $(".title", node).textContent = r.frontmatter?.title || r.slug;
      $(".meta", node).textContent = metaLine(r);
      const img = $(".thumb", node);
      const imgName = r.frontmatter?.image;
      if (typeof imgName === "string" && imgName) {
        img.src = `recipe_images/${encodeURIComponent(imgName)}`;
        img.alt = r.frontmatter?.title || "";
      }
      node.addEventListener("click", () => { location.hash = `#/r/${r.slug}`; });
      grid.appendChild(node);
    }
    main.appendChild(grid);
  }

  function metaLine(r) {
    const cats = categoriesOf(r).join(", ");
    const dur = r.frontmatter?.duration_minutes;
    const bits = [];
    if (cats) bits.push(cats);
    if (Number.isFinite(dur)) bits.push(`${dur} min`);
    return bits.join(" · ");
  }

  function showDetail(slug) {
    const r = state.recipes.find((x) => x.slug === slug);
    if (!r) { main.innerHTML = '<p class="empty">Recipe not found.</p>'; return; }
    const node = $("#tpl-detail").content.firstElementChild.cloneNode(true);
    $(".title", node).textContent = r.frontmatter?.title || r.slug;
    $(".meta", node).textContent = metaLine(r);
    const img = $(".hero", node);
    const imgName = r.frontmatter?.image;
    if (typeof imgName === "string" && imgName) {
      img.src = `recipe_images/${encodeURIComponent(imgName)}`;
      img.alt = r.frontmatter?.title || "";
    }
    const { ingredients, steps } = parseBody(r.body);
    const ul = $(".ingredients ul", node);
    for (const i of ingredients) {
      const li = document.createElement("li");
      li.textContent = i;
      ul.appendChild(li);
    }
    const ol = $(".steps ol", node);
    for (const s of steps) {
      const li = document.createElement("li");
      li.textContent = s;
      ol.appendChild(li);
    }
    const src = r.frontmatter?.source_url;
    if (typeof src === "string" && src) {
      const p = $(".source", node);
      p.innerHTML = "Source: ";
      const a = document.createElement("a");
      a.href = src;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = src;
      p.appendChild(a);
    }
    $(".back", node).addEventListener("click", () => history.back());
    $(".edit", node).addEventListener("click", () => { location.hash = `#/edit/${r.slug}`; });
    $(".delete", node).addEventListener("click", async () => {
      if (!confirm(`Delete "${r.frontmatter?.title || r.slug}"?`)) return;
      try {
        await deleteRecipe(r.slug);
        await refreshData();
        location.hash = "#/";
      } catch (e) {
        alert(e.message);
      }
    });

    if (STATIC_MODE) {
      $(".edit", node).hidden = true;
      $(".delete", node).hidden = true;
    }

    main.innerHTML = "";
    main.appendChild(node);
  }

  function showForm(slug) {
    const editing = !!slug;
    const r = editing ? state.recipes.find((x) => x.slug === slug) : null;
    if (editing && !r) { main.innerHTML = '<p class="empty">Recipe not found.</p>'; return; }
    const form = $("#tpl-form").content.firstElementChild.cloneNode(true);
    $(".form-title", form).textContent = editing ? "Edit recipe" : "Add recipe";

    if (editing) {
      const fm = r.frontmatter || {};
      form.elements.title.value = fm.title || "";
      form.elements.categories.value = categoriesOf(r).join(", ");
      form.elements.duration_minutes.value = Number.isFinite(fm.duration_minutes) ? fm.duration_minutes : "";
      form.elements.source_url.value = fm.source_url || "";
      const sections = parseBody(r.body);
      form.elements.ingredients.value = sections.ingredients.join("\n");
      form.elements.steps.value = sections.steps.join("\n");
      form.elements.notes.value = sections.notes.join("\n");
    }

    $(".back", form).addEventListener("click", () => history.back());
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const errEl = $(".form-error", form);
      errEl.textContent = "";
      const data = new FormData(form);
      const title = (data.get("title") || "").toString().trim();
      if (!title) { errEl.textContent = "Title is required."; return; }
      const cats = (data.get("categories") || "").toString()
        .split(",").map((s) => s.trim()).filter(Boolean);
      const durRaw = (data.get("duration_minutes") || "").toString().trim();
      const dur = durRaw === "" ? null : Number(durRaw);
      const src = (data.get("source_url") || "").toString().trim() || null;
      const ingredients = convertImperialList(
        (data.get("ingredients") || "").toString()
          .split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
      );
      const steps = convertImperialList(
        (data.get("steps") || "").toString()
          .split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
      );
      const notes = (data.get("notes") || "").toString()
        .split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

      let image = editing ? (r.frontmatter?.image || null) : null;
      const file = form.elements.image.files[0];
      const newSlug = editing ? r.slug : slugify(title);
      if (file) {
        try {
          image = await uploadImage(file, newSlug);
        } catch (err) {
          errEl.textContent = err.message;
          return;
        }
      }

      const payload = {
        slug: newSlug,
        frontmatter: {
          title,
          categories: cats,
          duration_minutes: dur,
          image,
          source_url: src,
        },
        body: buildBody({ ingredients, steps, notes }),
      };

      try {
        const res = await saveRecipe(payload, editing ? "update" : "create");
        await refreshData();
        location.hash = `#/r/${res.slug || newSlug}`;
      } catch (err) {
        errEl.textContent = err.message;
      }
    });

    main.innerHTML = "";
    main.appendChild(form);
  }

  function slugify(title) {
    return title
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[đĐ]/g, "d")
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase() || "untitled";
  }

  // ----- escape helpers -----

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }
  function escapeAttr(s) { return escapeHtml(s); }

  // ----- routing -----

  function route() {
    const hash = location.hash || "#/";
    if (hash.startsWith("#/r/")) return showDetail(decodeURIComponent(hash.slice(4)));
    if (hash === "#/add") {
      if (STATIC_MODE) { location.hash = "#/"; return; }
      return showForm(null);
    }
    if (hash.startsWith("#/edit/")) {
      if (STATIC_MODE) { location.hash = "#/"; return; }
      return showForm(decodeURIComponent(hash.slice(7)));
    }
    return showList();
  }

  // ----- bootstrap -----

  async function refreshData() {
    state.recipes = await loadRecipes();
    refreshCategoryFilter();
  }

  function wireBar() {
    $("#search").addEventListener("input", (e) => {
      state.query = e.target.value;
      if ((location.hash || "#/") === "#/") showList();
    });
    $("#category-filter").addEventListener("change", (e) => {
      state.category = e.target.value;
      if ((location.hash || "#/") === "#/") showList();
    });
    $("#toggle-images").addEventListener("click", (e) => {
      state.showImages = !state.showImages;
      document.body.classList.toggle("show-images", state.showImages);
      e.target.textContent = state.showImages ? "Hide images" : "Show images";
      e.target.dataset.state = state.showImages ? "shown" : "hidden";
    });
    $("#random").addEventListener("click", () => {
      const pool = filteredRecipes();
      if (!pool.length) { alert("No recipes to pick from."); return; }
      const pick = pool[Math.floor(Math.random() * pool.length)];
      location.hash = `#/r/${pick.slug}`;
    });
    const addBtn = $("#add");
    if (STATIC_MODE) {
      addBtn.hidden = true;
    } else {
      addBtn.addEventListener("click", () => { location.hash = "#/add"; });
    }
  }

  window.addEventListener("hashchange", route);

  (async () => {
    wireBar();
    try {
      await refreshData();
    } catch (e) {
      main.innerHTML = `<p class="empty">Failed to load recipes: ${escapeHtml(e.message)}</p>`;
      return;
    }
    route();
  })();
})();
