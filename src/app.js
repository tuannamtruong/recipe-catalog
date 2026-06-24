// Cooking app — single-page vanilla JS.
// State lives in memory; the API (or baked data in static build) is the source of truth.

(() => {
  "use strict";

  // ----- data source -----

  // When built into a single self-contained recipes.html, build.py replaces the
  // line below with: const BAKED = [...]; otherwise BAKED is null and we fetch.
  const BAKED = (typeof __BAKED_RECIPES__ !== "undefined") ? __BAKED_RECIPES__ : null;
  const STATIC_MODE = Array.isArray(BAKED);
  const BAKED_CONVERSIONS = (typeof __BAKED_CONVERSIONS__ !== "undefined") ? __BAKED_CONVERSIONS__ : null;

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

  async function loadConversions() {
    if (STATIC_MODE) return BAKED_CONVERSIONS;
    const r = await fetch("/api/conversions");
    if (!r.ok) throw new Error("failed to load conversions");
    return r.json();
  }

  async function saveConversions(cupGramsObj) {
    if (STATIC_MODE) throw new Error("Read-only mode (no server)");
    const r = await fetch("/api/conversions", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cup_grams: cupGramsObj }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || `save failed (${r.status})`);
    return body;
  }

  // Overwrite the in-memory table used by convert-on-save. Ignores junk so a
  // failed/empty load just leaves the built-in defaults in place.
  function applyConversions(data) {
    if (data && data.cup_grams && typeof data.cup_grams === "object") {
      cupGrams = { ...data.cup_grams };
    }
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

  // Per-cup weights (grams) for known dry ingredients. Editable via the
  // reference panel and persisted to conversions.json; loadConversions()
  // overwrites these defaults at startup. Anything not listed here converts
  // to a flat 240 ml (a cup is a fixed volume).
  let cupGrams = {
    flour: 120,
    sugar: 200,
    oat: 90,
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
    const keys = Object.keys(cupGrams).sort((a, b) => b.length - a.length);
    for (const k of keys) {
      const re = new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
      if (re.test(r)) return { unit: "g", per: cupGrams[k] };
    }
    return { unit: "ml", per: 240 }; // default: a cup is 240 ml
  }

  // Each entry: { re, replace(match) => string }
  // Conversion REPLACES the imperial portion with metric (does not keep both).
  const CONVERTERS = [
    // °F or 350F  ->  °C  ("350°F" -> "177 °C")
    {
      re: /(\d+(?:[.,]\d+)?)\s*°?\s*F\b/g,
      replace: (m, q) => {
        const f = parseQty(q); if (f == null) return m;
        const c = Math.round(((f - 32) * 5) / 9);
        return `${c} °C`;
      },
    },
    // oz  ->  g  ("3 oz cream cheese" -> "85 g cream cheese")
    {
      re: /(\d+(?:[.,]\d+)?(?:\s*-\s*\d+(?:[.,]\d+)?)?(?:\s+\d+\s*\/\s*\d+)?|\d+\s*\/\s*\d+)\s*oz\b/gi,
      replace: (m, q) => {
        const n = parseQty(q.split(/\s*-\s*/)[0]); if (n == null) return m;
        return `${fmtNum(n * 28.35)} g`;
      },
    },
    // lb / lbs / pound / pounds  ->  g
    {
      re: /(\d+(?:[.,]\d+)?(?:\s*-\s*\d+(?:[.,]\d+)?)?(?:\s+\d+\s*\/\s*\d+)?|\d+\s*\/\s*\d+)\s*(?:lbs?|pounds?)\b/gi,
      replace: (m, q) => {
        const n = parseQty(q.split(/\s*-\s*/)[0]); if (n == null) return m;
        return `${fmtNum(n * 453.6)} g`;
      },
    },
    // cup / cups  ->  keep original, append metric in parens
    //   "1 cup of milk"   -> "1 cup (240 ml) of milk"
    //   "2 cups flour"    -> "2 cups (240 g) flour"
    {
      re: /(\d+(?:[.,]\d+)?(?:\s+\d+\s*\/\s*\d+)?|\d+\s*\/\s*\d+)\s*cups?\b/gi,
      replace: (m, q, offset, full) => {
        const n = parseQty(q); if (n == null) return m;
        const rest = full.slice(offset + m.length);
        // Skip if already annotated: " (240 ml)" or " (240 g)"
        if (/^\s*\(\s*\d+(?:[.,]\d+)?\s*(?:ml|g)\b/i.test(rest)) return m;
        const { unit, per } = pickCupConversion(rest);
        return `${m} (${fmtNum(n * per)} ${unit})`;
      },
    },
  ];

  function convertImperialLine(line) {
    if (!line) return line;
    let out = line;
    for (const { re, replace } of CONVERTERS) {
      out = out.replace(re, replace);
    }
    return out;
  }

  function convertImperialList(lines) {
    return (lines || []).map(convertImperialLine);
  }

  // Builds the imperial -> metric reference panel shown beside the add/edit
  // form. Generated from the same constants used by the converters above so
  // it never drifts from what saving actually does. The per-cup dry-ingredient
  // table is editable and persisted to conversions.json via the API.
  function buildConversionRef() {
    const aside = document.createElement("aside");
    aside.className = "convert-ref";
    aside.innerHTML = `
      <h3>Imperial → Metric</h3>
      <p class="convert-note">Applied automatically when you save.</p>
      <table>
        <tbody>
          <tr><th>1 oz</th><td>28 g</td></tr>
          <tr><th>1 lb</th><td>454 g</td></tr>
          <tr><th>°F</th><td>(°F − 32) × 5⁄9 °C</td></tr>
          <tr><th>1 cup</th><td>240 ml</td></tr>
        </tbody>
      </table>
      <p class="convert-note">tsp / tbs are left unchanged.</p>
      <h4>Per cup of dry ingredient (g)</h4>
    `;

    const list = document.createElement("div");
    list.className = "cup-grams-list";
    aside.appendChild(list);

    const makeRow = (name = "", grams = "") => {
      const row = document.createElement("div");
      row.className = "cup-grams-row";
      row.innerHTML = `
        <input class="cg-name" type="text" placeholder="ingredient" value="${escapeAttr(name)}">
        <input class="cg-grams" type="number" min="1" placeholder="g" value="${grams === "" ? "" : escapeAttr(String(grams))}">
        <button class="cg-remove" type="button" title="Remove" aria-label="Remove">×</button>
      `;
      $(".cg-remove", row).addEventListener("click", () => row.remove());
      return row;
    };

    for (const [name, grams] of Object.entries(cupGrams).sort((a, b) => a[0].localeCompare(b[0]))) {
      list.appendChild(makeRow(name, grams));
    }

    // Static build has no server to persist to (and the add/edit form is
    // hidden anyway) — show the table read-only.
    if (STATIC_MODE) {
      $$("input", list).forEach((el) => { el.disabled = true; });
      $$(".cg-remove", list).forEach((el) => { el.hidden = true; });
      return aside;
    }

    const status = document.createElement("p");
    status.className = "cg-status convert-note";

    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "cg-add";
    addBtn.textContent = "+ Add ingredient";
    addBtn.addEventListener("click", () => list.appendChild(makeRow()));

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "cg-save";
    saveBtn.textContent = "Save table";
    saveBtn.addEventListener("click", async () => {
      const next = {};
      for (const row of $$(".cup-grams-row", list)) {
        const name = $(".cg-name", row).value.trim().toLowerCase();
        if (!name) continue;
        const grams = Number($(".cg-grams", row).value);
        if (!Number.isFinite(grams) || grams <= 0) {
          status.textContent = `"${name || "?"}" needs grams > 0.`;
          return;
        }
        next[name] = Math.round(grams);
      }
      status.textContent = "Saving…";
      try {
        applyConversions(await saveConversions(next));
        status.textContent = "Saved.";
      } catch (err) {
        status.textContent = err.message;
      }
    });

    const actions = document.createElement("div");
    actions.className = "cup-grams-actions";
    actions.appendChild(addBtn);
    actions.appendChild(saveBtn);
    aside.appendChild(actions);
    aside.appendChild(status);
    return aside;
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
    view: "flat", // "flat" | "grouped"
    collapsed: new Set(), // category names collapsed in grouped view
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const main = $("#main");

  function categoriesOf(rec) {
    const cs = rec.frontmatter?.categories;
    if (!Array.isArray(cs)) return [];
    return cs.filter((c) => typeof c === "string" && c.trim()).map((c) => c.trim());
  }

  function allCategories() {
    const seen = new Set();
    for (const r of state.recipes) {
      for (const c of categoriesOf(r)) seen.add(c);
    }
    return Array.from(seen).sort((a, b) => a.localeCompare(b));
  }

  function refreshCategoryFilter() {
    const select = $("#category-filter");
    const cats = allCategories();
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
          (r.frontmatter?.source_url || "") + "\n" +
          (r.body || "") + "\n" +
          categoriesOf(r).join(" ")
        ).toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  // ----- views -----

  function makeCard(r) {
    const node = $("#tpl-card").content.firstElementChild.cloneNode(true);
    $(".title", node).textContent = r.frontmatter?.title || r.slug;
    $(".meta", node).textContent = metaLine(r);
    const img = $(".thumb", node);
    const imgName = r.frontmatter?.image;
    if (typeof imgName === "string" && imgName) {
      img.src = `recipe_images/${encodeURIComponent(imgName)}`;
      img.alt = r.frontmatter?.title || "";
    }
    node.href = `#/r/${r.slug}`;
    return node;
  }

  function makeGrid(recipes) {
    const grid = document.createElement("div");
    grid.className = "cards";
    for (const r of recipes) grid.appendChild(makeCard(r));
    return grid;
  }

  // Total active time in minutes, e.g. "45 min" (omitted when unknown).
  function timeLabel(r) {
    const prep = r.frontmatter?.prep_minutes;
    const cook = r.frontmatter?.cook_minutes;
    let total = 0;
    if (Number.isFinite(prep)) total += prep;
    if (Number.isFinite(cook)) total += cook;
    return total > 0 ? `${total} min` : "";
  }

  // Compact one-line row used inside category groups: "Name - Time".
  // The category is omitted (it is the group heading).
  function makeLine(r) {
    const a = document.createElement("a");
    a.className = "recipe-line";
    a.href = `#/r/${r.slug}`;
    const name = document.createElement("span");
    name.className = "recipe-line-name";
    name.textContent = r.frontmatter?.title || r.slug;
    const time = document.createElement("span");
    time.className = "recipe-line-time";
    time.textContent = timeLabel(r);
    a.appendChild(name);
    a.appendChild(time);
    return a;
  }

  function makeLineList(recipes) {
    const list = document.createElement("div");
    list.className = "recipe-lines";
    for (const r of recipes) list.appendChild(makeLine(r));
    return list;
  }

  function emptyMessage() {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = state.recipes.length ? "No recipes match the current filter." : "No recipes yet.";
    return p;
  }

  function showList() {
    if (state.view === "grouped") return showGrouped();
    const recipes = filteredRecipes();
    main.innerHTML = "";
    if (!recipes.length) { main.appendChild(emptyMessage()); return; }
    main.appendChild(makeGrid(recipes));
  }

  // Grouped view: one section per category, recipes listed under each. A recipe
  // with multiple categories appears under each; uncategorized ones go last.
  const UNCATEGORIZED = "Uncategorized";

  function showGrouped() {
    const recipes = filteredRecipes();
    main.innerHTML = "";
    if (!recipes.length) { main.appendChild(emptyMessage()); return; }

    const groups = new Map();
    for (const r of recipes) {
      const cats = categoriesOf(r);
      const keys = cats.length ? cats : [UNCATEGORIZED];
      for (const c of keys) {
        if (!groups.has(c)) groups.set(c, []);
        groups.get(c).push(r);
      }
    }

    const names = Array.from(groups.keys()).sort((a, b) => {
      if (a === UNCATEGORIZED) return 1;
      if (b === UNCATEGORIZED) return -1;
      return a.localeCompare(b);
    });

    for (const name of names) {
      const items = groups.get(name);
      const section = document.createElement("section");
      section.className = "category-group";
      if (state.collapsed.has(name)) section.classList.add("collapsed");

      const h = document.createElement("button");
      h.className = "category-heading";
      h.type = "button";
      const chevron = document.createElement("span");
      chevron.className = "chevron";
      chevron.setAttribute("aria-hidden", "true");
      const label = document.createElement("span");
      label.className = "category-name";
      label.textContent = name;
      const count = document.createElement("span");
      count.className = "category-count";
      count.textContent = items.length;
      h.append(chevron, label, count);
      h.addEventListener("click", () => {
        if (state.collapsed.has(name)) state.collapsed.delete(name);
        else state.collapsed.add(name);
        section.classList.toggle("collapsed");
        updateCollapseAllBtn();
      });

      section.appendChild(h);
      section.appendChild(makeLineList(items));
      main.appendChild(section);
    }
    updateCollapseAllBtn();
  }

  // Names of the category groups currently shown (mirrors showGrouped's keys).
  function currentGroupNames() {
    const names = new Set();
    for (const r of filteredRecipes()) {
      const cats = categoriesOf(r);
      if (cats.length) cats.forEach((c) => names.add(c));
      else names.add(UNCATEGORIZED);
    }
    return Array.from(names);
  }

  // The collapse-all button only matters in grouped view; its label reflects
  // whether the next click will collapse everything or expand everything.
  function updateCollapseAllBtn() {
    const btn = $("#toggle-collapse");
    if (!btn) return;
    if (state.view !== "grouped") { btn.hidden = true; return; }
    const names = currentGroupNames();
    btn.hidden = names.length === 0;
    const allCollapsed = names.length > 0 && names.every((n) => state.collapsed.has(n));
    btn.textContent = allCollapsed ? "Expand all" : "Collapse all";
    btn.dataset.state = allCollapsed ? "collapsed" : "expanded";
  }

  function metaLine(r) {
    const cats = categoriesOf(r).join(", ");
    const prep = r.frontmatter?.prep_minutes;
    const cook = r.frontmatter?.cook_minutes;
    const bits = [];
    if (cats) bits.push(cats);
    if (Number.isFinite(prep)) bits.push(`Prep ${prep} min`);
    if (Number.isFinite(cook)) bits.push(`Cook ${cook} min`);
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
    let firstGroup = true;
    for (const i of ingredients) {
      const li = document.createElement("li");
      // A line ending in ":" (e.g. "Salad:", "Sauce:") is a group label, not an
      // ingredient — render it as a sub-heading with the items listed under it.
      const groupMatch = i.match(/^(.+?):\s*$/);
      if (groupMatch) {
        li.className = "ingredient-group";
        if (firstGroup) li.classList.add("first");
        li.textContent = groupMatch[1];
        firstGroup = false;
      } else {
        li.textContent = i;
      }
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

    // Category field: free text plus a dropdown of existing categories that
    // opens on focus and filters as you type.
    const catInput = form.elements.categories;
    const catList = $(".combo-list", form);
    if (catInput && catList) attachCombobox(catInput, catList, allCategories);

    if (editing) {
      const fm = r.frontmatter || {};
      form.elements.title.value = fm.title || "";
      form.elements.categories.value = categoriesOf(r).join(", ");
      form.elements.prep_minutes.value = Number.isFinite(fm.prep_minutes) ? fm.prep_minutes : "";
      form.elements.cook_minutes.value = Number.isFinite(fm.cook_minutes) ? fm.cook_minutes : "";
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
      const prepRaw = (data.get("prep_minutes") || "").toString().trim();
      const prep = prepRaw === "" ? null : Number(prepRaw);
      const cookRaw = (data.get("cook_minutes") || "").toString().trim();
      const cook = cookRaw === "" ? null : Number(cookRaw);
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
          prep_minutes: prep,
          cook_minutes: cook,
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
    const layout = document.createElement("div");
    layout.className = "form-layout";
    layout.appendChild(buildConversionRef());
    layout.appendChild(form);
    main.appendChild(layout);
  }

  // Free-text combobox over a comma-separated field. The dropdown opens on
  // focus (showing every option) and filters by the token after the last comma.
  function attachCombobox(input, listEl, getOptions) {
    let items = [];
    let activeIndex = -1;

    const tokens = () => input.value.split(",").map((s) => s.trim());
    const currentToken = () => tokens().pop() || "";
    const taken = () => new Set(tokens().slice(0, -1).filter(Boolean).map((s) => s.toLowerCase()));

    function open() {
      const tok = currentToken().toLowerCase();
      const used = taken();
      items = getOptions().filter((c) => !used.has(c.toLowerCase()) && c.toLowerCase().includes(tok));
      render();
    }

    function render() {
      if (!items.length) { close(); return; }
      listEl.innerHTML = items
        .map((c, i) => `<li role="option" class="${i === activeIndex ? "active" : ""}">${escapeHtml(c)}</li>`)
        .join("");
      listEl.hidden = false;
      input.setAttribute("aria-expanded", "true");
    }

    function close() {
      listEl.hidden = true;
      listEl.innerHTML = "";
      activeIndex = -1;
      input.setAttribute("aria-expanded", "false");
    }

    function choose(value) {
      const parts = tokens();
      parts[parts.length - 1] = value;
      input.value = parts.join(", ");
      close();
      input.focus();
    }

    input.addEventListener("focus", () => { activeIndex = -1; open(); });
    input.addEventListener("input", () => { activeIndex = -1; open(); });
    input.addEventListener("blur", () => setTimeout(close, 120));
    input.addEventListener("keydown", (e) => {
      if (listEl.hidden) return;
      if (e.key === "ArrowDown") { e.preventDefault(); activeIndex = Math.min(activeIndex + 1, items.length - 1); render(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); activeIndex = Math.max(activeIndex - 1, 0); render(); }
      else if (e.key === "Enter" && activeIndex >= 0) { e.preventDefault(); choose(items[activeIndex]); }
      else if (e.key === "Escape") { close(); }
    });
    listEl.addEventListener("mousedown", (e) => {
      const li = e.target.closest("li");
      if (!li) return;
      e.preventDefault();
      const idx = Array.prototype.indexOf.call(listEl.children, li);
      if (idx >= 0) choose(items[idx]);
    });
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

  // Icon for the view toggle. The button shows the view it will switch *to*.
  const VIEW_ICONS = {
    // grouped: stacked sections (offered while in flat view)
    grouped: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><rect x="3" y="3" width="8" height="2" rx="1"/><rect x="3" y="7" width="14" height="2" rx="1"/><rect x="3" y="14" width="8" height="2" rx="1"/><rect x="3" y="18" width="14" height="2" rx="1"/></svg>',
    // flat grid: four tiles (offered while in grouped view)
    flat: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="3" width="8" height="8" rx="1"/><rect x="3" y="13" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/></svg>',
  };

  function renderViewToggle(btn) {
    const next = state.view === "grouped" ? "flat" : "grouped";
    const label = next === "grouped" ? "Group by category" : "Flat list";
    btn.innerHTML = VIEW_ICONS[next];
    btn.dataset.view = state.view;
    btn.title = label;
    btn.setAttribute("aria-label", label);
  }

  function wireBar() {
    const home = $("#home");
    home.addEventListener("click", () => { location.hash = "#/"; });
    home.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); location.hash = "#/"; }
    });
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
    const viewBtn = $("#toggle-view");
    renderViewToggle(viewBtn);
    viewBtn.addEventListener("click", () => {
      state.view = state.view === "grouped" ? "flat" : "grouped";
      renderViewToggle(viewBtn);
      updateCollapseAllBtn();
      if ((location.hash || "#/") === "#/") showList();
    });
    $("#toggle-collapse").addEventListener("click", () => {
      const names = currentGroupNames();
      const allCollapsed = names.length > 0 && names.every((n) => state.collapsed.has(n));
      if (allCollapsed) state.collapsed.clear();
      else names.forEach((n) => state.collapsed.add(n));
      if ((location.hash || "#/") === "#/") showList();
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
    try {
      applyConversions(await loadConversions());
    } catch {
      /* keep built-in defaults */
    }
    route();
  })();
})();
