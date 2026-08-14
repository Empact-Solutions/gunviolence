// Renders the narrative charts embedded in the Key Takeaways page, from
// site/data/national_monthly.json. All smoothing happens here, in the browser,
// and is OFF by default — the reader opts in with a "12-month average" toggle.

(async function () {
  const national = await loadJSON("data/national_monthly.json");
  national.forEach((d) => (d.month = parseMonth(d.month)));
  national.sort((a, b) => a.month - b.month);

  const toggle1 = document.getElementById("smoothing-toggle");
  let smoothed1 = toggle1.checked;

  const toggleU18 = document.getElementById("smoothing-toggle-u18");
  let smoothedU18 = toggleU18.checked;

  // Population-normalized values are annualized (×12) — an "annual rate per
  // 100,000" is the standard way this kind of figure is reported, rather than
  // the much smaller, less legible single-month rate.
  function series(valueKey, populationKey, smooth) {
    const base = national.map((d) => ({
      month: d.month,
      value: populationKey ? toRate(d[valueKey], d[populationKey]) * 12 : d[valueKey],
    }));
    if (!smooth) return base;
    const rolled = rollingMean(base.map((d) => d.value));
    return base.map((d, i) => ({ month: d.month, value: rolled[i] })).filter((d) => d.value != null);
  }

  // Same as `series`, but for the combined under-18 population (children
  // 0–11 + youth 12–17) — sums both age groups' counts and populations
  // before computing the rate, rather than reading a single column.
  function seriesU18(base, smooth) {
    const raw = national.map((d) => ({
      month: d.month,
      value: toRate(d[`youth_${base}`] + d[`child_${base}`], d.youth_population + d.child_population) * 12,
    }));
    if (!smooth) return raw;
    const rolled = rollingMean(raw.map((d) => d.value));
    return raw.map((d, i) => ({ month: d.month, value: rolled[i] })).filter((d) => d.value != null);
  }

  function yLabel(populationLabel, smoothed) {
    return smoothed
      ? `Annual rate per 100,000 ${populationLabel} (trailing 12-month)`
      : `Annual rate per 100,000 ${populationLabel} (single month, annualized)`;
  }

  function lineChart(containerId, data, smoothed, populationLabel) {
    const plot = Plot.plot({
      width: Math.min(880, document.getElementById(containerId).clientWidth),
      height: 380,
      marginRight: 90,
      style: { fontFamily: "inherit" },
      x: { label: null },
      y: { label: yLabel(populationLabel, smoothed) },
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
          stroke: "group",
          strokeWidth: smoothed ? 2.5 : 1,
          strokeOpacity: smoothed ? 1 : 0.7,
          title: (d) => `${d.group}\n${formatMonth(d.month)}: ${d.value.toFixed(1)} per 100,000`,
          tip: true,
        }),
      ],
    });
    document.getElementById(containerId).replaceChildren(plot);
  }

  // ---- Chart 1: youth victims vs. perpetrators, annual rate per 100,000 ----
  function chartVictimsPerps() {
    const victims = series("youth_victim", "youth_population", smoothed1).map((d) => ({ ...d, group: "Victims" }));
    const perps = series("youth_perp_minus_possession", "youth_population", smoothed1).map((d) => ({
      ...d,
      group: "Perpetrators",
    }));
    lineChart("chart-victims-perps", victims.concat(perps), smoothed1, "youth");
  }

  // ---- Chart 2: same, but for youth AND children combined (ages 0–17) ----
  function chartVictimsPerpsU18() {
    const victims = seriesU18("victim", smoothedU18).map((d) => ({ ...d, group: "Victims" }));
    const perps = seriesU18("perp_minus_possession", smoothedU18).map((d) => ({ ...d, group: "Perpetrators" }));
    lineChart("chart-victims-perps-u18", victims.concat(perps), smoothedU18, "people under 18");
  }

  chartVictimsPerps();
  chartVictimsPerpsU18();

  toggle1.addEventListener("change", () => {
    smoothed1 = toggle1.checked;
    chartVictimsPerps();
  });

  toggleU18.addEventListener("change", () => {
    smoothedU18 = toggleU18.checked;
    chartVictimsPerpsU18();
  });

  window.addEventListener("resize", () => {
    chartVictimsPerps();
    chartVictimsPerpsU18();
  });
})();
