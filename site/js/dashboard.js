// Interactive state-level dashboard: choropleth map + state trend explorer.
// Mirrors the structure of the original Observable notebook (map metric picker,
// state picker, age-range/status/possession filters, up-to-3 state comparison)
// but adds a counts-vs-rate toggle and computes 12-month rolling averages here,
// in the browser, from raw monthly counts rather than relying on pre-smoothed data.

(async function () {
  const [national, stateRows, us] = await Promise.all([
    loadJSON("data/national_monthly.json"),
    loadJSON("data/state_monthly.json"),
    fetch("https://cdn.jsdelivr.net/npm/us-atlas@3/states-10m.json").then((r) => r.json()),
  ]);

  national.forEach((d) => (d.month = parseMonth(d.month)));
  national.sort((a, b) => a.month - b.month);

  stateRows.forEach((d) => (d.month = parseMonth(d.month)));
  const byState = d3.group(stateRows, (d) => d.state);
  for (const rows of byState.values()) rows.sort((a, b) => a.month - b.month);

  // Real states/DC only — used for the choropleth, which has no shape for a
  // national aggregate.
  const stateNamesGeo = [...byState.keys()].sort();

  // "United States" is a selectable entity like any other, for the state
  // picker and comparisons — but it's never auto-included, and it's pinned
  // first in both lists rather than sorted alphabetically among the states.
  byState.set("United States", national);
  const stateNamesSelectable = ["United States", ...stateNamesGeo];

  // ---- Populate selects ----
  const stateSelect = document.getElementById("ctl-state");
  stateSelect.innerHTML = stateNamesSelectable.map((s) => `<option value="${s}">${s}</option>`).join("");
  stateSelect.value = "United States";

  const compareSelect = document.getElementById("ctl-compare");
  compareSelect.innerHTML = stateNamesSelectable.map((s) => `<option value="${s}">${s}</option>`).join("");

  const ctl = {
    mapMetric: document.getElementById("ctl-map-metric"),
    metricType: document.getElementById("ctl-metric-type"),
    metricTypeTrend: document.getElementById("ctl-metric-type-trend"),
    state: stateSelect,
    population: document.getElementById("ctl-population"),
    status: document.getElementById("ctl-status"),
    possession: document.getElementById("ctl-possession"),
    smoothing: document.getElementById("ctl-smoothing"),
    compare: compareSelect,
    compareClear: document.getElementById("ctl-compare-clear"),
  };

  function updatePossessionEnabled() {
    const disabled = ctl.status.value === "victim";
    ctl.possession.disabled = disabled;
    ctl.possession.style.opacity = disabled ? 0.4 : 1;
  }

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
    const finalVals = smoothing ? rollingMean(vals) : vals;
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

  // ---- Trend chart ----
  function renderTrend() {
    const opts = {
      population: ctl.population.value,
      status: ctl.status.value,
      possessionFilter: ctl.possession.value,
      metricType: ctl.metricTypeTrend.value,
      smoothing: ctl.smoothing.checked,
    };

    const selectedState = ctl.state.value;
    const compared = [...ctl.compare.selectedOptions].map((o) => o.value).slice(0, 3);

    const entities = [
      { name: selectedState, rows: byState.get(selectedState), role: "selected" },
      ...compared
        .filter((s) => s !== selectedState)
        .map((s) => ({ name: s, rows: byState.get(s), role: "compared" })),
    ];

    const data = entities.flatMap(({ name, rows, role }) =>
      buildSeries(rows, opts).map((d) => ({ ...d, entity: name, role }))
    );

    const widthFor = { selected: 2, compared: 1.25 };
    const opacityFor = { selected: 1, compared: 0.65 };
    const dashFor = { selected: null, compared: "4,3" };

    const unit = opts.metricType === "rate" ? "annual rate per 100,000" : "people";
    const populationLabel =
      opts.population === "youth" ? "Youth (12–17)" : opts.population === "child" ? "Children (0–11)" : "Children and youth (0–17)";

    const plot = Plot.plot({
      width: Math.min(880, document.getElementById("dash-trend").clientWidth),
      height: 400,
      marginRight: 40,
      style: { fontFamily: "inherit" },
      x: { label: null },
      y: {
        label: `${populationLabel} — ${unit}${opts.smoothing ? ", trailing 12-month" : ", single month"}`,
      },
      color: {
        domain: ["Victims", "Perpetrators"],
        range: [PALETTE.victim, PALETTE.perp],
        legend: true,
      },
      marks: [
        Plot.ruleY([0]),
        Plot.line(data, {
          x: "month",
          y: "value",
          z: (d) => `${d.entity}-${d.group}`,
          stroke: "group",
          strokeWidth: (d) => widthFor[d.role],
          strokeOpacity: (d) => opacityFor[d.role],
          strokeDasharray: (d) => dashFor[d.role],
          title: (d) => `${d.entity} — ${d.group}\n${formatMonth(d.month)}: ${d.value.toFixed(1)}`,
          tip: true,
        }),
      ],
    });
    document.getElementById("dash-trend").replaceChildren(plot);
  }

  // ---- Map ----
  const topology = us;
  const geoFeatures = topojson.feature(topology, topology.objects.states).features;
  const fipsToName = new Map(geoFeatures.map((f) => [f.id, f.properties.name]));
  const mesh = topojson.mesh(topology, topology.objects.states, (a, b) => a !== b);
  // Interior state-to-state borders only exclude the coastline (an arc used
  // by just one state doesn't satisfy that filter) — the nation object's own
  // mesh supplies that outer/coastal boundary so states like Florida get a
  // border on their sea side too, not just where they touch another state.
  const nationMesh = topojson.mesh(topology, topology.objects.nation);

  const mapTitles = {
    youth_victim: "Youth (12–17) victimization",
    youth_perp_minus_possession: "Youth (12–17) offenses (excl. possession)",
    child_victim: "Children (0–11) victimization",
  };
  // Colored by role (victim/perpetrator), matching every other chart on the
  // site — the age-group split doesn't need its own hue since only one metric
  // is ever shown on the map at a time.
  const mapColors = {
    youth_victim: sequentialRamp(PALETTE.victim, 9),
    youth_perp_minus_possession: sequentialRamp(PALETTE.perp, 9),
    child_victim: sequentialRamp(PALETTE.victim, 9),
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

  function renderMap() {
    const metricKey = ctl.mapMetric.value;
    const metricType = ctl.metricType.value;
    const title = mapTitles[metricKey];
    const colorScheme = mapColors[metricKey];

    const valuesByState = new Map(
      stateNamesGeo.map((s) => [s, latestValueForState(byState.get(s), metricKey, metricType)])
    );

    // DC's tiny population makes its per-capita rate an outlier that would
    // otherwise dominate the quantile breaks — excluded from the domain, but
    // still colored on the map (clamped to the scale's top bin).
    const domainValues = [...valuesByState.entries()]
      .filter(([s, v]) => s !== "District of Columbia" && v != null && !isNaN(v) && v >= 0)
      .map(([, v]) => v);
    const color = d3.scaleQuantile().domain(domainValues).range(colorScheme);
    const quantiles = color.quantiles();
    const extent = d3.extent(domainValues);

    // The projection fills a 960x600 area; the legend gets its own band
    // below that, outside the geographic drawing area entirely, so it can
    // never land on top of a state — Alaska, Hawaii, and Florida all reach
    // close enough to the frame's edges that any position *within* the map
    // risks overlapping one of them.
    const width = 960,
      mapHeight = 600,
      legendBandHeight = 70,
      height = mapHeight + legendBandHeight;
    const projection = d3.geoAlbersUsa().scale(1300).translate([width / 2, mapHeight / 2]);
    const path = d3.geoPath().projection(projection);

    const container = d3.create("div").style("position", "relative");
    const svg = container
      .append("svg")
      .attr("viewBox", `0 0 ${width} ${height}`)
      .style("width", "100%")
      .style("height", "auto");

    const tooltip = container
      .append("div")
      .style("position", "absolute")
      .style("pointer-events", "none")
      .style("background", "white")
      .style("border", "1px solid #ddd")
      .style("border-radius", "6px")
      .style("padding", "8px 12px")
      .style("font-size", "13px")
      .style("line-height", "1.5")
      .style("box-shadow", "0 2px 8px rgba(0,0,0,0.12)")
      .style("opacity", 0)
      .style("transition", "opacity 0.15s");

    const unitLabel = metricType === "rate" ? "annual per 100k" : "people/month";

    svg
      .append("g")
      .selectAll("path")
      .data(geoFeatures)
      .join("path")
      .attr("d", path)
      .attr("fill", (f) => {
        const name = fipsToName.get(f.id);
        const val = valuesByState.get(name);
        return val != null && !isNaN(val) ? color(val) : "#ccc";
      })
      .attr("stroke", "#fff")
      .attr("stroke-width", 0.5)
      .on("mousemove", function (event, f) {
        const name = fipsToName.get(f.id);
        const val = valuesByState.get(name);
        const label =
          val != null && !isNaN(val)
            ? `<strong>${name}</strong><br>${val.toFixed(1)} ${unitLabel}`
            : `<strong>${name}</strong><br>No data`;
        const [mx, my] = d3.pointer(event, container.node());
        tooltip.html(label).style("opacity", 1).style("left", `${mx + 12}px`).style("top", `${my - 28}px`);
        d3.select(this).attr("stroke", "#333").attr("stroke-width", 1.5);
      })
      .on("mouseleave", function () {
        tooltip.style("opacity", 0);
        d3.select(this).attr("stroke", "#fff").attr("stroke-width", 0.5);
      });

    svg.append("path").datum(mesh).attr("fill", "none").attr("stroke", "black").attr("stroke-width", 0.7).attr("d", path);
    svg.append("path").datum(nationMesh).attr("fill", "none").attr("stroke", "black").attr("stroke-width", 0.7).attr("d", path);

    const legendWidth = 260,
      legendHeight = 12,
      legendX = (width - legendWidth) / 2,
      legendY = mapHeight + 30;
    const binWidth = legendWidth / colorScheme.length;
    const fmt = d3.format(".0f");
    // Bins are equal-*count* (quantile), not equal-width in value, so ticks
    // are placed at each swatch boundary (i * binWidth) and labeled with the
    // actual bin-boundary value — a linear value scale would mislabel them.
    const legendTicks = [extent[0], ...quantiles, extent[1]];

    const legend = svg.append("g").attr("transform", `translate(${legendX},${legendY})`);
    legend
      .selectAll("rect")
      .data(colorScheme)
      .join("rect")
      .attr("x", (d, i) => i * binWidth)
      .attr("width", binWidth)
      .attr("height", legendHeight)
      .attr("fill", (d) => d);
    legend
      .selectAll("line.tick-mark")
      .data(legendTicks)
      .join("line")
      .attr("class", "tick-mark")
      .attr("x1", (d, i) => i * binWidth)
      .attr("x2", (d, i) => i * binWidth)
      .attr("y1", legendHeight)
      .attr("y2", legendHeight + 4)
      .attr("stroke", "#444");
    legend
      .selectAll("text.tick-label")
      .data(legendTicks)
      .join("text")
      .attr("class", "tick-label")
      .attr("x", (d, i) => i * binWidth)
      .attr("y", legendHeight + 15)
      .attr("text-anchor", (d, i) => (i === 0 ? "start" : i === legendTicks.length - 1 ? "end" : "middle"))
      .attr("font-size", 10)
      .attr("fill", "#444")
      .text((d) => fmt(d));
    legend.append("text").attr("x", 0).attr("y", -6).attr("font-size", 12).attr("fill", "#444").text(title);

    const periodEnd = national[national.length - 1].month;
    const periodStart = new Date(periodEnd.getFullYear(), periodEnd.getMonth() - 11, 1);

    document.getElementById("dash-map").replaceChildren(container.node());
    document.getElementById("dash-map-caption").textContent =
      `${title} — 12-month average, ${metricType === "rate" ? "annual rate per 100,000" : "raw monthly count"}, ${formatMonth(periodStart)} to ${formatMonth(periodEnd)}.`;
  }

  // ---- Wire up events ----
  ctl.status.addEventListener("change", () => {
    updatePossessionEnabled();
    renderTrend();
  });
  [ctl.population, ctl.possession, ctl.metricTypeTrend, ctl.smoothing, ctl.state, ctl.compare].forEach((el) =>
    el.addEventListener("change", renderTrend)
  );
  [ctl.mapMetric, ctl.metricType].forEach((el) => el.addEventListener("change", renderMap));

  ctl.compareClear.addEventListener("click", () => {
    [...ctl.compare.options].forEach((o) => (o.selected = false));
    renderTrend();
  });

  updatePossessionEnabled();
  renderTrend();
  renderMap();

  window.addEventListener("resize", () => {
    renderTrend();
  });
})();
