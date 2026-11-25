// Interactive state-level dashboard: choropleth map, ranked list of states,
// and a state trend explorer. The numbers are the same as before the redesign:
// rates and 12-month rolling averages are computed here, in the browser, from
// raw monthly counts (see js/utils.js).

(async function () {
  const $ = (id) => document.getElementById(id);
  const radio = (name) => document.querySelector(`input[name="${name}"]:checked`).value;
  const onRadio = (name, fn) =>
    document.querySelectorAll(`input[name="${name}"]`).forEach((el) => el.addEventListener("change", fn));

  let national, stateRows, us, incidents, stateIncidents;
  try {
    // The incident file feeds two charts in one view; if it fails, the rest
    // of the dashboard still works.
    [national, stateRows, us, incidents, stateIncidents] = await Promise.all([
      loadJSON("data/national_monthly.json"),
      loadJSON("data/state_monthly.json"),
      loadJSON("https://cdn.jsdelivr.net/npm/us-atlas@3/states-10m.json"),
      loadJSON("data/incidents_monthly.json").catch((err) => (console.error(err), null)),
      loadJSON("data/state_incident_summary.json").catch((err) => (console.error(err), null)),
    ]);
  } catch (err) {
    console.error(err);
    ["dash-map", "dash-bar", "dash-trend"].forEach((id) => {
      $(id).innerHTML = '<p class="chart-status">The data could not be loaded. Please refresh the page to try again.</p>';
    });
    return;
  }

  national.forEach((d) => (d.month = parseMonth(d.month)));
  national.sort((a, b) => a.month - b.month);

  if (incidents) {
    incidents.forEach((d) => (d.month = parseMonth(d.month)));
    incidents.sort((a, b) => a.month - b.month);
  }

  stateRows.forEach((d) => (d.month = parseMonth(d.month)));
  const byState = d3.group(stateRows, (d) => d.state);
  for (const rows of byState.values()) rows.sort((a, b) => a.month - b.month);

  // Real states/DC only — used for the map and the ranked list, which have no
  // place for a national aggregate.
  const stateNamesGeo = [...byState.keys()].sort();

  // "United States" is a selectable entity like any other, for the state
  // picker and comparisons — but it's never auto-included, and it's pinned
  // first in both lists rather than sorted alphabetically among the states.
  byState.set("United States", national);
  const stateNamesSelectable = ["United States", ...stateNamesGeo];
  const DC = "District of Columbia";
  const MAX_COMPARE = 3;

  const ctl = {
    state: $("ctl-state"),
    population: $("ctl-population"),
    status: $("ctl-status"),
    smoothing: $("ctl-smoothing"),
    compare: $("ctl-compare"),
    compareChips: $("compare-chips"),
    compareClear: $("ctl-compare-clear"),
  };

  const options = stateNamesSelectable.map((s) => `<option value="${s}">${s}</option>`).join("");
  ctl.state.innerHTML = options;
  ctl.state.value = "United States";
  ctl.compare.innerHTML = `<option value="">Add a state…</option>${options}`;

  // The 12 months the map and ranked list cover, taken from the data.
  const periodEnd = national[national.length - 1].month;
  const periodStart = new Date(periodEnd.getFullYear(), periodEnd.getMonth() - 11, 1);

  // ---- Accessors ----
  function baseForPerp(possessionFilter) {
    if (possessionFilter === "excl") return "perp_minus_possession";
    if (possessionFilter === "only") return "possession";
    return "perp";
  }

  function valueFor(row, base, population) {
    if (population === "youth") return row[`youth_${base}`] ?? 0;
    if (population === "child") return row[`child_${base}`] ?? 0;
    return (row[`youth_${base}`] ?? 0) + (row[`child_${base}`] ?? 0);
  }

  function popFor(row, population) {
    if (population === "youth") return row.youth_population;
    if (population === "child") return row.child_population;
    return (row.child_population ?? 0) + (row.youth_population ?? 0);
  }

  function buildOne(rows, base, population, metricType, smoothing, label) {
    const raw = rows.map((r) => valueFor(r, base, population));
    const pop = rows.map((r) => popFor(r, population));
    // Annualized (×12) to match the annual-rate convention used everywhere
    // else on the site (see js/blog-charts.js) — a bare monthly rate is a
    // much smaller, less legible, and non-comparable number.
    const vals = metricType === "rate" ? raw.map((v, i) => toRate(v, pop[i]) * 12) : raw;
    const finalVals = smoothing ? (metricType === "rate" ? rollingMean(vals) : rollingSum(vals)) : vals;
    return rows
      .map((r, i) => ({ month: r.month, value: finalVals[i], group: label }))
      .filter((d) => d.value != null);
  }

  function buildSeries(rows, opts) {
    const { population, status, possessionFilter, metricType, smoothing } = opts;
    const out = [];
    if (status !== "perp") out.push(...buildOne(rows, "victim", population, metricType, smoothing, "Victims"));
    if (status !== "victim")
      out.push(
        ...buildOne(rows, baseForPerp(possessionFilter), population, metricType, smoothing, "Perpetrators")
      );
    return out;
  }

  // ---- Comparisons ----
  const compared = [];

  function addComparison(name) {
    if (!name || name === ctl.state.value || compared.includes(name) || compared.length >= MAX_COMPARE) return;
    compared.push(name);
  }

  function renderCompare() {
    ctl.compareChips.innerHTML = compared
      .map(
        (name) =>
          `<li class="chip"><span>${name}</span><button type="button" data-state="${name}" aria-label="Remove ${name}">×</button></li>`
      )
      .join("");
    ctl.compare.disabled = compared.length >= MAX_COMPARE;
    ctl.compare.value = "";
    ctl.compareClear.hidden = compared.length === 0;
  }

  // ---- Trend chart ----
  // One state gets one large chart. A comparison gets one small chart per
  // state, side by side and on the same y-scale, so a state's own two lines
  // stay readable instead of eight lines sharing one plot.
  const LABEL_COLOR = { Victims: "#003f73", Perpetrators: "#b5481a" };
  const GROUP_COLOR = { Victims: PALETTE.victim, Perpetrators: PALETTE.perp };
  const niceMax = (rows) => d3.scaleLinear().domain([0, d3.max(rows, (d) => d.value) || 1]).nice(5).domain()[1];

  // Nudge end-of-line labels apart so they never overlap, keeping their order.
  function spreadLabels(labels, yMax, innerHeight, gap = 18) {
    const sorted = [...labels].sort((p, q) => q.value - p.value);
    sorted.forEach((d, i) => {
      d.px = innerHeight * (1 - d.value / yMax);
      if (i > 0) d.px = Math.max(d.px, sorted[i - 1].px + gap);
    });
    for (let i = sorted.length - 1; i >= 0; i--)
      sorted[i].px = Math.min(sorted[i].px, innerHeight - (sorted.length - 1 - i) * gap);
    sorted.forEach((d) => (d.labelY = yMax * (1 - d.px / innerHeight)));
    return sorted;
  }

  function trendPlot(rows, { width, height, yMax, directLabels, xTicks, ariaLabel, formatValue = (v) => v.toFixed(1) }) {
    const marginTop = 16,
      marginBottom = 32;
    const labels = directLabels
      ? spreadLabels(
          d3.groups(rows, (d) => d.group).map(([group, r]) => ({ ...r[r.length - 1], text: group })),
          yMax,
          height - marginTop - marginBottom
        )
      : [];
    return Plot.plot({
      width,
      height,
      marginLeft: 40,
      marginRight: directLabels ? 104 : 12,
      marginTop,
      marginBottom,
      ariaLabel,
      style: { fontFamily: "inherit", fontSize: "13px", color: "#5f6062", background: "none" },
      x: { label: null, ticks: xTicks, tickSize: 0, tickPadding: 8 },
      y: { label: null, domain: [0, yMax], ticks: 4, tickSize: 0 },
      color: { domain: ["Victims", "Perpetrators"], range: [PALETTE.victim, PALETTE.perp] },
      marks: [
        Plot.ruleY([0], { stroke: "#acacac" }),
        Plot.line(rows, { x: "month", y: "value", z: "group", stroke: "group", strokeWidth: directLabels ? 3 : 2.5 }),
        Plot.text(labels, {
          x: "month",
          y: "labelY",
          text: "text",
          fill: (d) => LABEL_COLOR[d.group],
          fontWeight: 600,
          fontSize: 13,
          textAnchor: "start",
          dx: 8,
        }),
        Plot.dot(rows, Plot.pointer({ x: "month", y: "value", fill: "group", r: 5, stroke: "#fff", strokeWidth: 2 })),
        Plot.tip(
          rows,
          Plot.pointer({
            x: "month",
            y: "value",
            title: (d) => `${d.entity} — ${d.group}\n${formatMonth(d.month)}: ${formatValue(d.value)}`,
            fontSize: 13,
          })
        ),
      ],
    });
  }

  function renderTrend() {
    const opts = {
      population: ctl.population.value,
      status: ctl.status.value,
      possessionFilter: "excl",
      metricType: radio("metric-type"),
      smoothing: ctl.smoothing.checked,
    };

    const series = [ctl.state.value, ...(comparingOpen() ? compared : [])].map((name) => ({
      name,
      data: buildSeries(byState.get(name), opts).map((d) => ({ ...d, entity: name })),
    }));
    const comparing = series.length > 1;

    const populationLabel =
      opts.population === "youth" ? "Youth (12–17)" : opts.population === "child" ? "Children (0–11)" : "Children and youth (0–17)";
    const isCount = opts.metricType === "count";
    const title = isCount
      ? (opts.smoothing ? `${populationLabel} rolling 12-month total` : `${populationLabel} — single month counts`)
      : (opts.smoothing ? `${populationLabel} — 12-month rolling rate per 100,000` : `${populationLabel} — single month rate per 100,000`);
    $("dash-trend-title").textContent = title;

    const trendNote = $("dash-trend-note");
    const showNote = isCount && opts.smoothing;
    trendNote.textContent = showNote ? "Each point is the sum for that month and the 11 months before it." : "";
    trendNote.hidden = !showNote;

    // On a phone the secondary filters fold away behind one button, which
    // spells out what is currently applied.
    const chosen = (el) => el.selectedOptions[0].text;
    $("filters-summary").textContent = [
      chosen(ctl.population),
      chosen(ctl.status),
      opts.smoothing ? "12-month rolling average or sum" : "Raw monthly data",
    ]
      .filter(Boolean)
      .join(" · ");

    const formatValue = isCount && !opts.smoothing
      ? (v) => Math.round(v).toLocaleString("en-US")
      : (v) => v.toFixed(1);

    const el = $("dash-trend");
    const width = el.clientWidth || 880;
    const narrow = width < 560;

    // A single wide chart names each line where it ends. Small charts and
    // phones have no room for that, so they get a color key instead.
    const directLabels = !comparing && !narrow;
    const groups = ["Victims", "Perpetrators"].filter((g) =>
      g === "Victims" ? opts.status !== "perp" : opts.status !== "victim"
    );
    const legend = $("dash-trend-legend");
    legend.innerHTML = directLabels
      ? ""
      : groups.map((g) => `<li><span class="swatch" style="background:${GROUP_COLOR[g]}"></span>${g}</li>`).join("");
    legend.hidden = directLabels;

    if (!comparing) {
      el.className = "";
      el.replaceChildren(
        trendPlot(series[0].data, {
          width,
          height: narrow ? 320 : 420,
          yMax: niceMax(series[0].data),
          directLabels,
          xTicks: narrow ? 5 : 10,
          ariaLabel: `Line chart. ${title}. ${series[0].name}.`,
          formatValue,
        })
      );
      return;
    }

    const cols = narrow ? 1 : series.length === 3 ? 3 : 2;
    const gap = 40;
    const panelWidth = Math.floor((width - gap * (cols - 1)) / cols);
    const sharedMax = niceMax(series.flatMap((s) => s.data));
    el.className = "trend-grid";
    el.style.setProperty("--cols", cols);
    el.replaceChildren(
      ...series.map((s) => {
        const panel = document.createElement("div");
        panel.className = "trend-panel";
        const name = document.createElement("p");
        name.className = "panel-title";
        name.textContent = s.name;
        panel.append(
          name,
          trendPlot(s.data, {
            width: panelWidth,
            height: 240,
            yMax: sharedMax,
            directLabels: false,
            xTicks: 4,
            ariaLabel: `Line chart. ${title}. ${s.name}.`,
            formatValue,
          })
        );
        return panel;
      })
    );
  }

  // ---- State highlights ----
  // The Key Takeaways findings, restated for whichever state is selected:
  // four numbered statements, each with one piece of evidence under it. The
  // first three come from the state data. The fourth rests on
  // data/incidents_monthly.json, which is national only, so it always
  // reports the United States and says so when a state is selected.
  const hl = { state: $("ctl-hl-state") };
  hl.state.innerHTML = options;
  hl.state.value = ctl.state.value;
  const highlightsOpen = () => !$("panel-highlights").hidden;
  const fmtInt = (v) => Math.round(v).toLocaleString("en-US");
  const fmtPct = (v) => {
    const r = Math.round(v);
    return `${r > 0 ? "+" : r < 0 ? "−" : ""}${Math.abs(r)}%`;
  };
  const placeName = (name) => (name === "United States" ? "the United States" : name);

  // 1. Youth victims per youth perpetrator, over every month in the data.
  // Counts, not rates; perpetrators exclude possession-only offenses. Most
  // states sit above 1; the wording changes for the few that do not, so the
  // sentence never contradicts its own number.
  function renderRatio(name, rows) {
    const victims = d3.sum(rows, (d) => d.youth_victim);
    const perps = d3.sum(rows, (d) => d.youth_perp_minus_possession);
    const place = placeName(name);
    let html;
    let heading;
    if (!perps) {
      heading = "2. Youth and children are more involved in gun violence as victims than as perpetrators.";
      html = `From January 2017 through February 2026, ${fmtInt(victims)} youth in ${place} were victims of gun violence and none were recorded as perpetrators.`;
    } else {
      const ratio = (victims / perps).toFixed(1);
      if (ratio === "1.0") {
        heading = "2. Youth and children are involved in gun violence as both victims and perpetrators.";
        html = `From January 2017 through February 2026, about as many youth in ${place} were victims of gun violence as were perpetrators.`;
      } else if (parseFloat(ratio) < 1.0) {
        heading = "2. Youth and children are more involved in gun violence as perpetrators than as victims.";
        const inverseRatio = (perps / victims).toFixed(1);
        html = `From January 2017 through February 2026, <strong class="hl-ratio-figure">${inverseRatio}×</strong> as many youth in ${place} were perpetrators of gun violence as were victims.`;
      } else {
        heading = "2. Youth and children are more involved in gun violence as victims than as perpetrators.";
        html = `From January 2017 through February 2026, <strong class="hl-ratio-figure">${ratio}×</strong> as many youth in ${place} were victims of gun violence as were perpetrators.`;
      }
    }
    $("hl-ratio-heading").textContent = heading;
    $("hl-ratio-text").innerHTML = html;
  }

  // 2. Youth victims and perpetrators over time: the lines of the Trends
  // view, fixed to youth, to offenses other than possession, and to an
  // annualized count: the 12-month rolling average of raw monthly counts,
  // times 12. That is the number of people in the trailing 12 months, so it
  // matches the totals under statement 3. It does not follow the View switch.
  function renderHighlightTrend(name, rows) {
    const el = $("hl-trend");
    const width = el.clientWidth || 880;
    const narrow = width < 560;
    const metricType = radio("metric-type");
    const data = buildSeries(rows, {
      population: "youth",
      status: "both",
      possessionFilter: "excl",
      metricType,
      smoothing: true,
    }).map((d) => ({ ...d, entity: name }));

    const title = metricType === "rate"
      ? "Youth (12–17) victims and perpetrators — 12-month avg rate per 100,000 per year"
      : "Youth (12–17) victims and perpetrators — rolling 12-month total";
    const caption = metricType === "rate"
      ? "Each point is the average annual rate for that month and the 11 months before it."
      : "Each point is the sum for that month and the 11 months before it.";
    const sub = metricType === "rate" ? `${name}. Per 100,000 per year.` : `${name}. People per year.`;
    $("hl-trend-title").textContent = title;
    $("hl-trend-sub").textContent = sub;
    $("hl-trend-caption").textContent = caption;

    const legend = $("hl-trend-legend");
    legend.innerHTML = narrow
      ? ["Victims", "Perpetrators"]
          .map((g) => `<li><span class="swatch" style="background:${GROUP_COLOR[g]}"></span>${g}</li>`)
          .join("")
      : "";
    legend.hidden = !narrow;
    el.replaceChildren(
      trendPlot(data, {
        width,
        height: narrow ? 320 : 420,
        yMax: niceMax(data),
        directLabels: !narrow,
        xTicks: narrow ? 5 : 10,
        ariaLabel: `Line chart. ${title}. ${name}.`,
      })
    );
  }

  // 3. Change from each group's pandemic-era peak to now, on 12-month totals.
  // The two totals sit under every percentage, because in a small state a
  // large swing can rest on a handful of people.
  const PEAK_GROUPS = [
    { key: "child_victim", label: "Children (0–11) · Victims", cls: "is-victim" },
    { key: "child_perp_minus_possession", label: "Children (0–11) · Perpetrators", cls: "is-perp" },
    { key: "youth_victim", label: "Youth (12–17) · Victims", cls: "is-victim" },
    { key: "youth_perp_minus_possession", label: "Youth (12–17) · Perpetrators", cls: "is-perp" },
  ];
  const statItem = (cls, label, figure, detail) =>
    `<li class="hl-stat ${cls}"><p class="hl-stat-label">${label}</p><p class="hl-stat-figure">${figure}</p>${
      detail ? `<p class="hl-stat-detail">${detail}</p>` : ""
    }</li>`;
  function renderPeakStats(rows) {
    $("hl-peak").innerHTML = PEAK_GROUPS.map((g) => {
      const totals = rollingSum(rows.map((r) => r[g.key] ?? 0), 12);
      const peak = d3.max(totals, (v, i) => {
        const year = rows[i].month.getFullYear();
        return v != null && year >= 2020 && year <= 2024 ? v : undefined;
      });
      const latest = totals[totals.length - 1];
      return peak
        ? statItem(g.cls, g.label, fmtPct(((latest - peak) / peak) * 100), `${fmtInt(peak)} at the peak, ${fmtInt(latest)} now`)
        : statItem(g.cls, g.label, "—", "None recorded at the peak");
    }).join("");
    $("hl-peak-note").textContent =
      `Highest 12-month total between 2020 and 2024, compared with the 12 months ending ${formatMonth(periodEnd)}.`;
  }

  // 4. Share of all incidents with and without a child or youth involved.
  // The three shares overlap: one incident can have both a child or youth
  // victim and a child or youth perpetrator.
  // State-level figures come from state_incident_summary.json. For United
  // States, the monthly national incident file is used as a fallback.
  const INCIDENT_GROUPS = [
    { key: "incidents_no_child_youth", label: "No youth or child involved", cls: "is-neutral" },
    { key: "incidents_victim_child_youth", label: "Youth or child victim", cls: "is-victim" },
    { key: "incidents_perp_child_youth", label: "Youth or child perpetrator", cls: "is-perp" },
  ];
  const STATE_INCIDENT_GROUPS = [
    { pctKey: "pct_no_u18", label: "No youth or child involved", cls: "is-neutral" },
    { pctKey: "pct_victim", label: "Youth or child victim", cls: "is-victim" },
    { pctKey: "pct_perp_excl_possession", label: "Youth or child perpetrator", cls: "is-perp" },
  ];
  function renderIncidents(name) {
    const stateData = stateIncidents && name !== "United States" ? stateIncidents[name] : null;
    $("hl-incidents").hidden = !stateData && !incidents;
    if (!stateData && !incidents) return;
    $("hl-incidents-heading").textContent = `1. Most incidents in ${placeName(name)} do not involve youth.`;
    if (stateData) {
      $("hl-incident-stats").innerHTML = STATE_INCIDENT_GROUPS.map((g) =>
        statItem(g.cls, g.label, `${Math.round(stateData[g.pctKey] * 100)}%`)
      ).join("");
    } else {
      const all = d3.sum(incidents, (d) => d.total_incidents);
      $("hl-incident-stats").innerHTML = INCIDENT_GROUPS.map((g) =>
        statItem(g.cls, g.label, `${Math.round((d3.sum(incidents, (d) => d[g.key]) / all) * 100)}%`)
      ).join("");
    }
    $("hl-incident-note").textContent = "Incidents may total more than 100% because some incidents involve both a victim and perpetrator under age 18.";
    $("hl-incident-note").hidden = false;
  }

  function renderHighlights() {
    if (!highlightsOpen()) return;
    const name = ctl.state.value;
    const rows = byState.get(name);
    renderRatio(name, rows);
    renderHighlightTrend(name, rows);
    renderPeakStats(rows);
    renderIncidents(name);
  }

  // ---- Map and ranked list ----
  const geoFeatures = topojson.feature(us, us.objects.states).features;
  const featureByName = new Map(geoFeatures.map((f) => [f.properties.name, f]));
  const nationMesh = topojson.mesh(us, us.objects.nation);

  const mapTitles = {
    youth_victim: "Youth (12–17) victimization",
    youth_perp_minus_possession: "Youth (12–17) offenses",
    child_victim: "Children (0–11) victimization",
  };
  // Youth metrics take the site's victim and perpetrator colors. Children's
  // victimization gets a hue of its own so no two map metrics look alike
  // (checked against the other two for color-blind separation).
  const CHILD_VICTIM_COLOR = "#a3418f";
  const mapColors = {
    youth_victim: sequentialRamp(PALETTE.victim, 9),
    youth_perp_minus_possession: sequentialRamp(PALETTE.perp, 9),
    child_victim: sequentialRamp(CHILD_VICTIM_COLOR, 9),
  };
  const mapPopulation = {
    youth_victim: "youth",
    youth_perp_minus_possession: "youth",
    child_victim: "child",
  };

  function latestValueForState(rows, metricKey, metricType) {
    const population = mapPopulation[metricKey];
    const base = metricKey.startsWith("youth_") ? metricKey.replace("youth_", "") : metricKey.replace("child_", "");
    const raw = rows.map((r) => valueFor(r, base, population));
    const pop = rows.map((r) => popFor(r, population));
    // Annualized (×12) — see the matching comment in buildOne() above.
    const vals = metricType === "rate" ? raw.map((v, i) => toRate(v, pop[i]) * 12) : raw;
    const rolled = rollingMean(vals);
    for (let i = rolled.length - 1; i >= 0; i--) {
      if (rolled[i] != null) return rolled[i];
    }
    return null;
  }

  const isNum = (v) => v != null && !isNaN(v);
  // One decimal place. Rolling sums can drift a hair below zero, which would
  // otherwise print as "-0.0".
  const fmt1 = (v) => (Math.round(v * 10) / 10 || 0).toFixed(1);
  const unitPhrase = (metricType) =>
    metricType === "rate" ? "per 100,000 (annual rate)" : "people per month (12-month average)";

  // Map scaffolding is built once; only fills and the legend change.
  const mapW = 960,
    mapH = 600;
  const projection = d3.geoAlbersUsa().scale(1280).translate([mapW / 2, mapH / 2]);
  const geoPath = d3.geoPath().projection(projection);

  const mapEl = $("dash-map");
  mapEl.innerHTML = `
    <div class="map-legend">
      <div id="map-legend-scale"></div>
    </div>
    <div class="map-frame"><div class="tip" role="status"></div></div>`;
  const mapFrame = mapEl.querySelector(".map-frame");
  const tip = mapFrame.querySelector(".tip");

  const svg = d3
    .select(mapFrame)
    .append("svg")
    .attr("class", "map")
    .attr("viewBox", `0 0 ${mapW} ${mapH}`)
    .attr("role", "img");
  const statePaths = svg
    .append("g")
    .selectAll("path")
    .data(geoFeatures)
    .join("path")
    .attr("class", "state")
    .attr("d", geoPath)
    .attr("fill", "#d7d7d7");
  svg.append("path").datum(nationMesh).attr("class", "nation").attr("d", geoPath);
  const selectedOutline = svg.append("path").attr("class", "outline outline-selected");
  const hoverOutline = svg.append("path").attr("class", "outline outline-hover");

  const rankEl = $("dash-bar");
  rankEl.innerHTML = `
    <p class="rank-key" id="rank-key"></p>
    <ol class="rank-list" id="rank-list"></ol>
    <button type="button" class="text-button rank-toggle" id="rank-toggle" aria-expanded="false"></button>`;
  const rankList = $("rank-list");
  const rankToggle = $("rank-toggle");
  const rowByName = new Map(
    stateNamesGeo.map((name) => {
      const li = document.createElement("li");
      li.innerHTML = `<button type="button" class="rank-row"><span class="rank-n"></span><span class="rank-name">${name}</span><span class="rank-track"><span class="rank-bar"></span></span><span class="rank-value"></span></button>`;
      const row = li.firstChild;
      row.addEventListener("click", () => selectState(name));
      row.addEventListener("pointerenter", () => setHover(name, false));
      row.addEventListener("pointerleave", () => setHover(null, false));
      return [name, { li, row }];
    })
  );
  function setRankToggle(expanded) {
    rankList.classList.toggle("is-expanded", expanded);
    rankToggle.setAttribute("aria-expanded", expanded);
    rankToggle.textContent = expanded ? "Show fewer states" : `Show all ${stateNamesGeo.length} states`;
  }
  rankToggle.addEventListener("click", () => setRankToggle(!rankList.classList.contains("is-expanded")));
  setRankToggle(false);

  let geo = null; // values behind the current map and ranked list

  function setHover(name, fromMap) {
    const feature = name ? featureByName.get(name) : null;
    hoverOutline.attr("d", feature ? geoPath(feature) : null);
    if (fromMap) rowByName.forEach(({ row }, n) => row.classList.toggle("is-hover", n === name));
  }

  function showTip(event, name) {
    const val = geo.values.get(name);
    tip.innerHTML = isNum(val)
      ? `<strong>${name}</strong>${fmt1(val)} ${unitPhrase(geo.metricType)}`
      : `<strong>${name}</strong>No data`;
    const [mx, my] = d3.pointer(event, mapFrame);
    const flip = mx > mapFrame.clientWidth * 0.6;
    tip.style.left = `${mx + (flip ? -14 : 14)}px`;
    tip.style.top = `${Math.max(0, my - 56)}px`;
    tip.style.transform = flip ? "translateX(-100%)" : "none";
    tip.classList.add("is-visible");
  }
  function hideTip() {
    tip.classList.remove("is-visible");
  }

  statePaths
    .on("pointerenter pointermove", function (event, f) {
      setHover(f.properties.name, true);
      showTip(event, f.properties.name);
    })
    .on("pointerleave", function (event) {
      // A finger lifting should not dismiss the value it just revealed.
      if (event.pointerType !== "mouse") return;
      setHover(null, true);
      hideTip();
    })
    .on("click", (event, f) => selectState(f.properties.name));
  document.addEventListener("pointerdown", (event) => {
    if (!event.target.closest || event.target.closest("#dash-map .state")) return;
    setHover(null, true);
    hideTip();
  });

  function updateSelection() {
    const name = ctl.state.value;
    const feature = featureByName.get(name);
    selectedOutline.attr("d", feature ? geoPath(feature) : null);
    rowByName.forEach(({ row }, n) => {
      row.classList.toggle("is-selected", n === name);
      row.setAttribute("aria-pressed", n === name);
    });
  }

  function selectState(name) {
    ctl.state.value = name;
    onStateChange();
    // Open the state's trend, and make sure the tabs that explain where the
    // reader now is are on screen.
    showView($("tab-trends"));
    const bar = document.querySelector(".view-bar");
    if (bar.getBoundingClientRect().top < 0) bar.scrollIntoView({ block: "start" });
  }

  // ---- Views ----
  // Four views, each doing one thing: the map (or ranked list), one state's
  // trend, a comparison of states, and the Key Takeaways charts for one state. Selecting a state on the map opens its
  // trend. There is one set of trend controls and one chart; they move to
  // whichever of the two trend views is open.
  const tabs = [...document.querySelectorAll(".view-tabs [role=tab]")];
  const comparingOpen = () => !$("panel-compare").hidden;
  function showView(tab, focus) {
    tabs.forEach((t) => {
      const on = t === tab;
      t.setAttribute("aria-selected", on);
      t.tabIndex = on ? 0 : -1;
      $(t.getAttribute("aria-controls")).hidden = !on;
    });
    $(comparingOpen() ? "compare-slot" : "trends-slot").append($("trend-area"));
    if (focus) tab.focus();
    if (tab.id !== "tab-county") setRateDisabled(false);
    else if (countyData && currentCountyGeoid) renderCountySpotlight(currentCountyGeoid);
    renderTrend();
    renderHighlights();
  }
  tabs.forEach((tab, i) => {
    tab.addEventListener("click", () => { showView(tab); pushState(); });
    tab.addEventListener("keydown", (event) => {
      const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
      if (step) { showView(tabs[(i + step + tabs.length) % tabs.length], true); pushState(); }
    });
  });

  // Map or ranked list: the same numbers, one at a time.
  function applyGeoView() {
    const list = radio("geo-view") === "list";
    mapEl.hidden = list;
    rankEl.hidden = !list;
    $("geo-note").hidden = !(list && geo && geo.clipped);
  }

  function onStateChange() {
    const taken = compared.indexOf(ctl.state.value);
    if (taken !== -1) compared.splice(taken, 1);
    renderCompare();
    updateSelection();
    renderTrend();
    // One selected state for the whole dashboard: State highlights follows it.
    hl.state.value = ctl.state.value;
    renderHighlights();
    pushState();
  }

  function renderLegend(colors, ticks) {
    const bin = 34,
      h = 12,
      pad = 14;
    // The fewest decimals that tell every bin boundary apart, so neighbouring
    // ticks never read "0, 0, 1, 1".
    const distinct = (f) => new Set(ticks.map(d3.format(f))).size === ticks.length;
    const fmt = d3.format([".0f", ".1f"].find(distinct) ?? ".2f");
    const w = bin * colors.length + pad * 2;
    $("map-legend-scale").innerHTML = `<svg width="${w}" height="${h + 22}" viewBox="0 0 ${w} ${h + 22}" aria-hidden="true">
      ${colors.map((c, i) => `<rect x="${pad + i * bin}" width="${bin}" height="${h}" fill="${c}"/>`).join("")}
      <rect x="${pad + 0.5}" y="0.5" width="${bin * colors.length - 1}" height="${h - 1}" fill="none" stroke="#acacac"/>
      ${ticks
        .map(
          (t, i) =>
            `<line x1="${pad + i * bin}" x2="${pad + i * bin}" y1="${h}" y2="${h + 4}" stroke="#5f6062"/><text x="${pad + i * bin}" y="${h + 18}" text-anchor="middle">${fmt(t)}</text>`
        )
        .join("")}
    </svg>`;
  }

  function renderGeo() {
    const metricKey = $("ctl-map-metric").value;
    const metricType = radio("metric-type");
    const title = mapTitles[metricKey];
    const colors = mapColors[metricKey];
    const values = new Map(
      stateNamesGeo.map((s) => [s, latestValueForState(byState.get(s), metricKey, metricType)])
    );
    geo = { metricType, values, clipped: false };

    // DC's tiny population makes its per-capita rate an outlier that would
    // otherwise dominate the quantile breaks and flatten every bar — excluded
    // from both scales, but still colored on the map (clamped to the top bin)
    // and listed with its true value.
    const domainValues = [...values.entries()]
      .filter(([s, v]) => s !== DC && isNum(v) && v >= 0)
      .map(([, v]) => v);
    const color = d3.scaleQuantile().domain(domainValues).range(colors);
    const extent = d3.extent(domainValues);

    // --- Map ---
    statePaths.attr("fill", (f) => {
      const v = values.get(f.properties.name);
      return isNum(v) ? color(v) : "#d7d7d7";
    });
    const measure = metricType === "rate" ? "annual rate per 100,000" : "raw monthly count";
    const period = `${formatMonth(periodStart)} to ${formatMonth(periodEnd)}`;
    svg.attr("aria-label", `Map of the United States shaded by ${title}, ${measure}. Each state's value is listed below the map.`);
    // Said once, as the figure's title, for the map and the ranked list alike.
    $("geo-title").textContent = title;
    $("geo-sub").textContent = `${measure[0].toUpperCase()}${measure.slice(1)}, 12-month average, ${period}`;
    // Bins are equal-*count* (quantile), not equal-width in value, so ticks
    // sit at each swatch boundary and carry the actual boundary value.
    renderLegend(colors, [extent[0], ...color.quantiles(), extent[1]]);

    // --- Ranked list ---
    const scaleMax = extent[1] || 1;
    const nationalAvg = latestValueForState(byState.get("United States"), metricKey, metricType);
    const sorted = [...values.entries()].sort((a, b) => (isNum(b[1]) ? b[1] : -1) - (isNum(a[1]) ? a[1] : -1));
    let clipped = false;
    sorted.forEach(([name, v], i) => {
      const { li, row } = rowByName.get(name);
      const bar = row.querySelector(".rank-bar");
      const over = isNum(v) && v > scaleMax;
      clipped = clipped || over;
      row.querySelector(".rank-n").textContent = i + 1;
      row.querySelector(".rank-value").textContent = isNum(v) ? fmt1(v) : "No data";
      // A zero still draws a hairline so the row does not look empty.
      bar.style.transform = `scaleX(${isNum(v) ? Math.max(0.006, Math.min(v / scaleMax, 1)) : 0})`;
      bar.classList.toggle("is-clipped", over);
      rankList.appendChild(li); // re-appending moves the row into rank order
    });
    // Bars rest in a quiet tint; the selected state alone takes the full color.
    rankList.style.setProperty("--bar", colors[colors.length - 1]);
    rankList.style.setProperty("--bar-quiet", colors[4]);
    const showAvg = isNum(nationalAvg) && nationalAvg <= scaleMax;
    rankList.classList.toggle("has-avg", showAvg);
    if (showAvg) rankList.style.setProperty("--avg", `${(nationalAvg / scaleMax) * 100}%`);
    $("rank-key").innerHTML = showAvg ? `<i></i>U.S. avg: ${fmt1(nationalAvg)}` : "";
    geo.clipped = clipped;
    $("geo-note").textContent = "The District of Columbia's bar is shortened to fit; its value is shown beside it.";
    applyGeoView();
  }

  // ---- Deep-link state ----
  // Encodes every user-visible control into a URLSearchParams string so the
  // view can be restored exactly from that string on the next load.
  function encodeState() {
    const activeTab = tabs.find((t) => t.getAttribute("aria-selected") === "true");
    const tabId = activeTab ? activeTab.id.replace("tab-", "") : "map";
    const p = new URLSearchParams();
    p.set("tab", tabId);
    p.set("state", ctl.state.value);
    p.set("metric", radio("metric-type"));
    p.set("pop", ctl.population.value);
    p.set("status", ctl.status.value);
    p.set("smoothing", ctl.smoothing.checked ? "1" : "0");
    p.set("map_metric", $("ctl-map-metric").value);
    p.set("geo_view", radio("geo-view"));
    if (compared.length) p.set("compare", compared.join(","));
    if (currentCountyGeoid) p.set("county", currentCountyGeoid);
    const cmapMetricEl = $("ctl-cmap-metric");
    if (cmapMetricEl) p.set("cmap_metric", cmapMetricEl.value);
    return p.toString();
  }

  // Updates the page URL and notifies the parent frame so it can mirror the
  // state in its own address bar.
  function pushState() {
    const encoded = encodeState();
    history.replaceState(null, "", "?" + encoded);
    if (window.parent !== window) {
      window.parent.postMessage({ type: "gunviolence-dashboard:state", state: encoded }, "*");
    }
  }

  // Reads query params (set by the parent frame on embed, or by pushState on
  // a standalone page) and restores every control to that state.
  function restoreState() {
    const p = new URLSearchParams(window.location.search);
    if (!p.size) return;

    if (p.has("state") && stateNamesSelectable.includes(p.get("state"))) {
      ctl.state.value = p.get("state");
      hl.state.value = p.get("state");
    }
    if (p.has("metric")) {
      const el = document.querySelector(`input[name="metric-type"][value="${p.get("metric")}"]`);
      if (el) el.checked = true;
    }
    if (p.has("pop")) ctl.population.value = p.get("pop");
    if (p.has("status")) ctl.status.value = p.get("status");
    if (p.has("smoothing")) ctl.smoothing.checked = p.get("smoothing") === "1";
    if (p.has("map_metric")) $("ctl-map-metric").value = p.get("map_metric");
    if (p.has("geo_view")) {
      const el = document.querySelector(`input[name="geo-view"][value="${p.get("geo_view")}"]`);
      if (el) el.checked = true;
    }
    if (p.has("compare")) {
      p.get("compare").split(",")
        .filter((s) => stateNamesSelectable.includes(s) && s !== ctl.state.value)
        .slice(0, MAX_COMPARE)
        .forEach(addComparison);
    }
    if (p.has("cmap_metric")) {
      const el = $("ctl-cmap-metric");
      if (el) el.value = p.get("cmap_metric");
    }
    if (p.has("tab")) {
      const tabId = p.get("tab");
      const tabEl = $("tab-" + tabId);
      if (tabEl) showView(tabEl);
      if (tabId === "county-map") {
        ensureCountyData().then(() => buildCountyMap());
      } else if (tabId === "county") {
        if (p.has("county")) {
          const geoid = p.get("county");
          ensureCountyData().then(() => {
            const info = countyData.names[geoid];
            if (!info) return;
            $("ctl-county-search").value = `${fmtCounty(info.county, geoid)}, ${info.state}`;
            renderCountySpotlight(geoid);
            // The startup pushState ran before this data arrived and dropped the county.
            pushState();
          });
        } else {
          ensureCountyData();
        }
      }
    }
  }

  // ---- County spotlight ----
  let countyData = null;

  async function ensureCountyData() {
    if (countyData) return countyData;
    $("county-loading").hidden = false;
    try {
      const [names, topo, summary, ranks, stateSummary, monthlyRaw] = await Promise.all([
        loadJSON("data/county_names.json"),
        loadJSON("data/counties-10m.json"),
        loadJSON("data/county_summary.json"),
        loadJSON("data/county_ranks.json"),
        loadJSON("data/county_state_summary.json"),
        d3.csv("data/county_monthly.csv", (d) => ({
          geoid: d.geoid,
          month: parseMonth(d.month),
          yv: +d.yv,
          yp: +d.yp,
          yvr: +d.yvr,
          ypr: +d.ypr,
        })),
      ]);
      const monthlyByCounty = d3.group(monthlyRaw, (d) => d.geoid);
      addMissingCounties(names, topo);
      countyData = { names, summary, ranks, stateSummary, monthlyByCounty };
      countyList = Object.entries(names)
        .map(([geoid, n]) => ({ geoid, label: `${fmtCounty(n.county, geoid)}, ${n.state}` }))
        .sort((a, b) => a.label.localeCompare(b.label));
      buildCountyTypeahead();
    } finally {
      $("county-loading").hidden = true;
    }
    return countyData;
  }

  let countyList = null;

  // county_names.json lists only counties with incidents; the map file has all.
  // Territories are skipped: their state prefix never appears in the data.
  function addMissingCounties(names, topo) {
    const states = new Map(Object.values(names).map((n) => [n.state_fips, n.state]));
    for (const g of topo.objects.counties.geometries) {
      const geoid = String(g.id).padStart(5, "0");
      const fips = geoid.slice(0, 2);
      if (!names[geoid] && states.has(fips)) {
        names[geoid] = { county: g.properties.name, state: states.get(fips), state_fips: fips };
      }
    }
  }

  function buildCountyTypeahead() {
    const input = $("ctl-county-search");
    const list = $("county-suggestions");
    let activeIdx = -1;

    function highlight(label, q) {
      const i = label.toLowerCase().indexOf(q);
      if (i < 0) return label;
      return label.slice(0, i) + `<mark>${label.slice(i, i + q.length)}</mark>` + label.slice(i + q.length);
    }

    function renderSuggestions(query) {
      const q = query.trim().toLowerCase();
      if (!q) { list.hidden = true; return; }
      const matches = countyList.filter((c) => c.label.toLowerCase().includes(q)).slice(0, 8);
      if (!matches.length) {
        list.innerHTML = `<li class="county-no-results" aria-disabled="true">No matching county.</li>`;
        activeIdx = -1;
        list.hidden = false;
        return;
      }
      list.innerHTML = matches
        .map((c, i) => `<li role="option" data-geoid="${c.geoid}" data-idx="${i}">${highlight(c.label, q)}</li>`)
        .join("");
      activeIdx = -1;
      list.hidden = false;
    }

    function selectCounty(geoid, label) {
      input.value = label;
      list.hidden = true;
      activeIdx = -1;
      renderCountySpotlight(geoid);
      pushState();
    }

    input.addEventListener("input", () => renderSuggestions(input.value));

    input.addEventListener("keydown", (e) => {
      const items = [...list.querySelectorAll("li[data-geoid]")];
      if (e.key === "ArrowDown") {
        e.preventDefault();
        activeIdx = Math.min(activeIdx + 1, items.length - 1);
        items.forEach((el, i) => el.classList.toggle("is-active", i === activeIdx));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        activeIdx = Math.max(activeIdx - 1, -1);
        items.forEach((el, i) => el.classList.toggle("is-active", i === activeIdx));
      } else if (e.key === "Enter" && activeIdx >= 0) {
        e.preventDefault();
        const item = items[activeIdx];
        if (item) selectCounty(item.dataset.geoid, item.textContent);
      } else if (e.key === "Escape") {
        list.hidden = true;
        activeIdx = -1;
      }
    });

    list.addEventListener("mousedown", (e) => {
      const li = e.target.closest("li[data-geoid]");
      if (!li) return;
      e.preventDefault();
      selectCounty(li.dataset.geoid, li.textContent);
    });

    document.addEventListener("click", (e) => {
      if (!input.contains(e.target) && !list.contains(e.target)) list.hidden = true;
    });
  }

  // Returns the display name for a county equivalent, handling the cases where
  // the Census Bureau type is NOT "County":
  //   Louisiana (22) → Parish
  //   Alaska (02) → no suffix (types vary: Borough, Census Area, Municipality)
  //   Virginia independent cities (51, code ≥ 510) → City
  //   Maryland Baltimore City (24510) → City
  //   Missouri St. Louis City (29510) → City
  //   Anything whose TopoJSON name already ends in a type (e.g. "Carson City") → as-is
  function fmtCounty(name, geoid) {
  if (geoid === "11001") return name;
  // Virginia counties whose own names end in "City".
  if (geoid === "51036" || geoid === "51095") return `${name} County`;
    if (/\b(City|Parish|Borough|Municipality|Census Area|District)$/.test(name)) return name;
    const state = geoid ? geoid.slice(0, 2) : "";
    const cty = geoid ? parseInt(geoid.slice(2)) : 0;
    if (state === "22") return `${name} Parish`;
    if (state === "02") return name;
    if (state === "51" && cty >= 510) return `${name} City`;
    if (geoid === "24510" || geoid === "29510") return `${name} City`;
    return `${name} County`;
  }

  // Build a full Jan-2017–Feb-2026 monthly series, filling zeros for months
  // absent from the sparse county_monthly.csv.
  function countyFullSeries(geoid) {
    const { monthlyByCounty } = countyData;
    const sparse = new Map((monthlyByCounty.get(geoid) || []).map((d) => [d.month.getTime(), d]));
    const rows = [];
    for (let d = new Date(2017, 0, 1); d <= new Date(2026, 1, 1); d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) {
      const rec = sparse.get(d.getTime()) || { yv: 0, yp: 0, yvr: 0, ypr: 0 };
      rows.push({ month: new Date(d), yv: rec.yv, yp: rec.yp, yvr: rec.yvr || 0, ypr: rec.ypr || 0 });
    }
    return rows;
  }

  let currentCountyGeoid = null;

  let rateForcedOff = false;

  function setRateDisabled(disabled) {
    const rateRadio = document.querySelector('input[name="metric-type"][value="rate"]');
    if (!rateRadio) return;
    rateRadio.disabled = disabled;
    // If we're disabling and rate is currently selected, switch to count so the
    // radio group stays in a consistent state.
    if (disabled && rateRadio.checked) {
      document.querySelector('input[name="metric-type"][value="count"]').checked = true;
      rateForcedOff = true;
    } else if (!disabled && rateForcedOff) {
      rateRadio.checked = true;
      rateForcedOff = false;
    }
  }

  function renderCountySpotlight(geoid) {
    currentCountyGeoid = geoid;
    const { names, summary, ranks, stateSummary } = countyData;
    const nameInfo = names[geoid];
    const summ = summary[geoid];
    const rank = ranks[geoid];
    const stateSum = stateSummary[nameInfo && nameInfo.state_fips];
    const NAT_YVR = 17.1;
    const NAT_YPR = 12.7;

    $("county-spotlight").hidden = true;
    $("county-empty").hidden = true;

    if (!summ || (summ.yv === 0 && summ.yp === 0)) {
      setRateDisabled(false);
      const place = nameInfo ? `${fmtCounty(nameInfo.county, geoid)}, ${nameInfo.state}` : "this county";
      $("county-empty").querySelector("p").textContent =
        `No incidents recorded for ${place} in the Gun Violence Archive during this period.`;
      $("county-empty").hidden = false;
      return;
    }

    $("county-name-heading").textContent = `${fmtCounty(nameInfo.county, geoid)}, ${nameInfo.state}`;

    const annYvr = (summ.yvr * 12).toFixed(1);
    const annYpr = (summ.ypr * 12).toFixed(1);

    $("county-stats").innerHTML = `
      <div class="county-stat">
        <span class="county-stat-value" style="color:var(--series-victim)">${summ.yv.toLocaleString()}</span>
        <span class="county-stat-label">Youth (12–17) victims</span>
        <span class="county-stat-sub">Jan 2017 – Feb 2026 total</span>
      </div>
      <div class="county-stat">
        <span class="county-stat-value" style="color:var(--series-perp)">${summ.yp.toLocaleString()}</span>
        <span class="county-stat-label">Youth (12–17) offenses</span>
        <span class="county-stat-sub">Jan 2017 – Feb 2026 total</span>
      </div>
      <div class="county-stat">
        <span class="county-stat-value">${annYvr}</span>
        <span class="county-stat-label">Victim rate per 100k / yr</span>
        <span class="county-stat-sub">(annual avg, Jan 2017 – Feb 2026)</span>
      </div>
      <div class="county-stat">
        <span class="county-stat-value">${annYpr}</span>
        <span class="county-stat-label">Offense rate per 100k / yr</span>
        <span class="county-stat-sub">(annual avg, Jan 2017 – Feb 2026)</span>
      </div>`;

    if (rank && stateSum) {
      const sfx = (n) => { const r = n % 10, h = n % 100; return (h >= 11 && h <= 13) ? "th" : r === 1 ? "st" : r === 2 ? "nd" : r === 3 ? "rd" : "th"; };
      const r = rank.rank_yv;
      // Use the state's actual monthly data (same population denominator as the
      // main state dashboard) rather than averaging county-level rates.
      const stateMonthly = byState.get(nameInfo.state) || [];
      const stateYvr = stateMonthly.length
        ? (stateMonthly.reduce((s, row) => s + (row.youth_victim / row.youth_population) * 1e5, 0) / stateMonthly.length * 12).toFixed(1)
        : (stateSum.yvr * 12).toFixed(1);
      $("county-compare").innerHTML = `
        <p class="county-rank-text">
          Among <strong>${rank.n_with_data} counties with recorded incidents in ${nameInfo.state}</strong>,
          ${fmtCounty(nameInfo.county, geoid)} ranks <strong>${r}${sfx(r)}</strong> for total youth victims over this period.
          The ${nameInfo.state} average victim rate is <strong>${stateYvr}</strong> per 100k per year;
          the national average is <strong>${NAT_YVR}</strong>.
        </p>`;
    } else {
      $("county-compare").innerHTML = "";
    }

    // Sparse counties (< 24 total victims): always show counts; rates are
    // meaningless when incidents are single-digit over a decade.
    const isSmall = summ.yv < 24;
    setRateDisabled(isSmall);
    const showRate = radio("metric-type") === "rate" && !isSmall;

    const rows = countyFullSeries(geoid);
    let plotRows, chartTitle, fmtVal, noteText;

    if (showRate) {
      // 12-month rolling mean of the annualized monthly rates (yvr/ypr × 12).
      const yvRateRolling = rollingMean(rows.map((r) => r.yvr * 12));
      const ypRateRolling = rollingMean(rows.map((r) => r.ypr * 12));
      plotRows = [
        ...rows.map((r, i) => ({ month: r.month, value: yvRateRolling[i], group: "Victims", entity: nameInfo.county })),
        ...rows.map((r, i) => ({ month: r.month, value: ypRateRolling[i], group: "Perpetrators", entity: nameInfo.county })),
      ].filter((d) => d.value != null);
      chartTitle = "Youth (12–17) — 12-month avg rate per 100,000 per year";
      fmtVal = (v) => v.toFixed(1);
      noteText = "Each point is the average annual rate for that month and the 11 months before it.";
    } else {
      plotRows = [
        ...rows.map((r) => ({ month: r.month, value: r.yv, group: "Victims", entity: nameInfo.county })),
        ...rows.map((r) => ({ month: r.month, value: r.yp, group: "Perpetrators", entity: nameInfo.county })),
      ].filter((d) => d.value != null);
      chartTitle = "Youth (12–17) — monthly counts";
      fmtVal = (v) => Math.round(v).toLocaleString("en-US");
      if (isSmall) {
        noteText = `This county had ${summ.yv} victim${summ.yv !== 1 ? "s" : ""} and ${summ.yp} offense${summ.yp !== 1 ? "s" : ""} recorded over the full period.`;
      } else {
        noteText = "Each point is the number of incidents in that month.";
      }
    }

    $("county-chart-title").textContent = chartTitle;
    const container = $("county-chart");
    container.innerHTML = "";
    const width = container.getBoundingClientRect().width || 600;
    const yMax = niceMax(plotRows) || 1;
    container.appendChild(
      trendPlot(plotRows, {
        width,
        height: 220,
        yMax,
        directLabels: true,
        xTicks: null,
        ariaLabel: `${chartTitle} — ${nameInfo.county} County`,
        formatValue: fmtVal,
      })
    );

    const noteEl = $("county-chart-note");
    noteEl.textContent = noteText;
    noteEl.hidden = false;
    $("county-spotlight").hidden = false;
  }

  $("tab-county").addEventListener("click", async () => {
    if (!countyData) await ensureCountyData();
  });

  // ---- County map ----
  let countyMapBuilt = false;
  let redrawCountyMap = null;

  function openCountySpotlight(geoid) {
    ensureCountyData().then(() => {
      const info = countyData.names[geoid];
      if (!info) return;
      $("ctl-county-search").value = `${fmtCounty(info.county, geoid)}, ${info.state}`;
      currentCountyGeoid = geoid;
      showView($("tab-county"));
      pushState();
      const bar = document.querySelector(".view-bar");
      if (bar.getBoundingClientRect().top < 0) bar.scrollIntoView({ block: "start" });
    });
  }

  async function buildCountyMap() {
    if (countyMapBuilt) return;
    $("county-map-loading").hidden = false;

    const [cmapSummary, cmapNames, cTopo] = await Promise.all([
      countyData ? Promise.resolve(countyData.summary) : loadJSON("data/county_summary.json"),
      countyData ? Promise.resolve(countyData.names) : loadJSON("data/county_names.json"),
      loadJSON("data/counties-10m.json"),
    ]);

    $("county-map-loading").hidden = true;

    const cFeatures = topojson.feature(cTopo, cTopo.objects.counties).features;
    const stateMesh = topojson.mesh(cTopo, cTopo.objects.states, (a, b) => a !== b);
    const nationMesh = topojson.mesh(cTopo, cTopo.objects.nation);

    const cmapW = 960, cmapH = 600;
    const cProjection = d3.geoAlbersUsa().scale(1280).translate([cmapW / 2, cmapH / 2]);
    const cPath = d3.geoPath().projection(cProjection);

    const cmapFrame = $("county-map-frame");
    const cmapTip = $("county-map-tip");

    const cSvg = d3.select(cmapFrame)
      .append("svg")
      .attr("class", "map")
      .attr("viewBox", `0 0 ${cmapW} ${cmapH}`)
      .attr("role", "img")
      .attr("aria-label", "County-level youth gun violence map");

    // Draw background for all counties first. No-data counties get events here.
    const countyBgPaths = cSvg.append("g")
      .selectAll("path")
      .data(cFeatures)
      .join("path")
      .attr("class", "county-bg")
      .attr("d", cPath)
      .attr("fill", "#e8e8e8");

    // Colored fills for counties with data; drawn on top, events live here too.
    const countyPaths = cSvg.append("g")
      .attr("class", "county-fills")
      .selectAll("path")
      .data(cFeatures.filter((f) => cmapSummary[String(f.id).padStart(5, "0")]))
      .join("path")
      .attr("class", "county")
      .attr("d", cPath)
      .attr("fill", "#e8e8e8");

    cSvg.append("path").datum(stateMesh)
      .attr("class", "state-borders")
      .attr("d", cPath)
      .attr("fill", "none")
      .attr("stroke", "#fff")
      .attr("stroke-width", 0.5)
      .attr("pointer-events", "none");
    cSvg.append("path").datum(nationMesh)
      .attr("class", "nation")
      .attr("d", cPath)
      .attr("fill", "none")
      .attr("stroke", "#8a8a8a")
      .attr("stroke-width", 0.8)
      .attr("pointer-events", "none");

    const cmapHoverOutline = cSvg.append("path")
      .attr("class", "outline outline-hover")
      .attr("fill", "none")
      .attr("stroke", "var(--ink)")
      .attr("stroke-width", 1.5)
      .attr("pointer-events", "none");

    function getMetric() { return $("ctl-cmap-metric").value; }

    // The View switch picks annualized rates or whole-period totals.
    function countyValue(geoid) {
      const s = cmapSummary[geoid];
      if (!s) return null;
      const field = getMetric();
      if (radio("metric-type") === "count") return s[field === "yvr" ? "yv" : "yp"];
      return s[field] * 12;
    }

    function renderCountyMap() {
      const field = getMetric(); // "yvr" or "ypr"
      const color = field === "yvr"
        ? sequentialRamp(PALETTE.victim, 9)
        : sequentialRamp(PALETTE.perp, 9);

      const isCount = radio("metric-type") === "count";
      const fmt = (v) => (isCount ? Math.round(v).toLocaleString("en-US") : v.toFixed(1));
      const vals = cFeatures
        .map((f) => countyValue(String(f.id).padStart(5, "0")))
        .filter((v) => v != null && v > 0);

      const scale = d3.scaleQuantile().domain(vals).range(color);

      countyPaths.attr("fill", (f) => {
        const v = countyValue(String(f.id).padStart(5, "0"));
        return v != null && v > 0 ? scale(v) : "#e8e8e8";
      });

      // Legend.
      const breaks = scale.quantiles();
      const legendEl = $("county-map-legend-scale");
      const swatches = [...color].map((c, i) => {
        const lo = i === 0 ? 0 : breaks[i - 1];
        const hi = i < breaks.length ? breaks[i] : null;
        const label = hi != null ? `${fmt(lo)}–${fmt(hi)}` : `>${fmt(lo)}`;
        return `<span class="legend-swatch" style="background:${c}" title="${label}"></span>`;
      });
      const people = field === "yvr" ? "victims" : "perpetrators";
      const metricLabel = isCount ? `Youth ${people}` : `Youth ${people} per 100k/yr`;
      const period = isCount ? "total" : "annual avg";
      for (const option of $("ctl-cmap-metric").options) {
        const word = option.value === "yvr" ? "victim" : "offense";
        option.textContent = isCount ? `Youth (12–17) ${word}s` : `Youth (12–17) ${word} rate`;
      }
      legendEl.innerHTML = `
        <span class="legend-label">Low</span>
        ${swatches.join("")}
        <span class="legend-label">High</span>
        <span class="legend-metric">${metricLabel} (${period}, Jan 2017 – Feb 2026)</span>`;
    }

    function cmapShowTip(event, geoid, f) {
      const n = cmapNames[geoid];
      const field = getMetric();
      const val = countyValue(geoid);
      const name = (n ? `${fmtCounty(n.county, geoid)}, ${n.state}` : f.properties.name) || geoid;
      const noun = field === "yvr" ? "victim" : "offense";
      const text = radio("metric-type") === "count"
        ? `${Math.round(val).toLocaleString("en-US")} youth ${noun}${val === 1 ? "" : "s"}`
        : `${Number(val).toFixed(1)} per 100k/yr (${noun} rate)`;
      cmapTip.innerHTML = val > 0
        ? `<strong>${name}</strong>${text}`
        : `<strong>${name}</strong>No incidents recorded`;
      const [mx, my] = d3.pointer(event, cmapFrame);
      const flip = mx > cmapFrame.clientWidth * 0.6;
      cmapTip.style.left = `${mx + (flip ? -14 : 14)}px`;
      cmapTip.style.top = `${Math.max(0, my - 56)}px`;
      cmapTip.style.transform = flip ? "translateX(-100%)" : "none";
      cmapTip.classList.add("is-visible");
    }

    function attachMapEvents(selection) {
      selection
        .on("pointerenter pointermove", function (event, f) {
          const geoid = String(f.id).padStart(5, "0");
          cmapHoverOutline.attr("d", cPath(f));
          cmapShowTip(event, geoid, f);
        })
        .on("pointerleave", function (event) {
          if (event.pointerType !== "mouse") return;
          cmapHoverOutline.attr("d", null);
          cmapTip.classList.remove("is-visible");
        })
        .on("click", (event, f) => {
          const geoid = String(f.id).padStart(5, "0");
          openCountySpotlight(geoid);
        });
    }

    // Data counties: events on the colored fill layer (drawn on top).
    attachMapEvents(countyPaths);
    // Zero-incident counties: events on the bg layer (no fill layer above them).
    attachMapEvents(countyBgPaths.filter((f) => !cmapSummary[String(f.id).padStart(5, "0")]));

    document.addEventListener("pointerdown", (event) => {
      if (!event.target.closest) return;
      if (event.target.closest("#county-map-frame .county") ||
          event.target.closest("#county-map-frame .county-bg")) return;
      cmapHoverOutline.attr("d", null);
      cmapTip.classList.remove("is-visible");
    });

    $("ctl-cmap-metric").addEventListener("change", () => { renderCountyMap(); pushState(); });

    renderCountyMap();
    redrawCountyMap = renderCountyMap;
    countyMapBuilt = true;
  }

  $("tab-county-map").addEventListener("click", async () => {
    if (!countyData) await ensureCountyData();
    buildCountyMap();
  });

  // ---- Wire up events ----
  ctl.status.addEventListener("change", () => { renderTrend(); pushState(); });
  [ctl.population, ctl.smoothing].forEach((el) => el.addEventListener("change", () => { renderTrend(); pushState(); }));
  $("ctl-map-metric").addEventListener("change", () => { renderGeo(); pushState(); });
  onRadio("geo-view", () => { applyGeoView(); pushState(); });
  onRadio("metric-type", () => {
    renderGeo();
    renderTrend();
    renderHighlights();
    if (redrawCountyMap) redrawCountyMap();
    if (!$("panel-county").hidden && currentCountyGeoid && countyData) renderCountySpotlight(currentCountyGeoid);
    pushState();
  });
  ctl.state.addEventListener("change", onStateChange);
  hl.state.addEventListener("change", () => {
    ctl.state.value = hl.state.value;
    onStateChange();
  });
  $("filters-toggle").addEventListener("click", (event) => {
    const open = $("trend-area").classList.toggle("filters-open");
    event.currentTarget.setAttribute("aria-expanded", open);
  });

  ctl.compare.addEventListener("change", () => {
    addComparison(ctl.compare.value);
    renderCompare();
    renderTrend();
    pushState();
  });
  ctl.compareChips.addEventListener("click", (event) => {
    const btn = event.target.closest("button[data-state]");
    if (!btn) return;
    compared.splice(compared.indexOf(btn.dataset.state), 1);
    renderCompare();
    renderTrend();
    ctl.compare.focus();
    pushState();
  });
  ctl.compareClear.addEventListener("click", () => {
    compared.length = 0;
    renderCompare();
    renderTrend();
    ctl.compare.focus();
    pushState();
  });

  renderCompare();
  restoreState();
  renderGeo();
  updateSelection();
  renderTrend();
  pushState();

  let resizeFrame;
  window.addEventListener("resize", () => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
      renderTrend();
      renderHighlights();
    });
  });

  // Embedded in another page (aecf.org): open links outside the frame, and
  // tell the host page how tall the content is so it can size the iframe
  // without an inner scrollbar.
  if (document.documentElement.classList.contains("is-embedded")) {
    document.querySelectorAll("a[href]").forEach((a) => {
      a.target = "_blank";
      a.rel = "noopener";
    });
    if (window.parent !== window && "ResizeObserver" in window) {
      new ResizeObserver(() => {
        window.parent.postMessage(
          { type: "gunviolence-dashboard:height", height: Math.ceil(document.documentElement.scrollHeight) },
          "*"
        );
      }).observe(document.body);
    }
  }
})();
