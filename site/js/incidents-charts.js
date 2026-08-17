// Incident-level charts: how child/youth-involving incidents compare to the
// total national incident volume. Uses site/data/incidents_monthly.json, which
// combines all-ages monthly totals (input/gun-violence-summary (2).csv) with
// child/youth incident flags derived from person-level records in
// input/redacted data.RDS. Both charts use a 6-month rolling sum/ratio, matching
// how this comparison is conventionally shown (raw monthly incident counts are
// too noisy to compare visually at this scale).

(async function () {
  const rows = await loadJSON("data/incidents_monthly.json");
  rows.forEach((d) => (d.month = parseMonth(d.month)));
  rows.sort((a, b) => a.month - b.month);

  const WINDOW = 6;
  const noChildYouth = rollingSum(rows.map((d) => d.incidents_no_child_youth), WINDOW);
  const victimCY = rollingSum(rows.map((d) => d.incidents_victim_child_youth), WINDOW);
  const perpCY = rollingSum(rows.map((d) => d.incidents_perp_child_youth), WINDOW);

  function seriesFor(rolled, group) {
    return rows.map((d, i) => ({ month: d.month, value: rolled[i], group })).filter((d) => d.value != null);
  }

  // ---- Chart: 6-month rolling sum, all-ages vs. child/youth-involving incidents ----
  function chartVolume() {
    const data = [
      ...seriesFor(noChildYouth, "Incidents with no child or youth involved"),
      ...seriesFor(victimCY, "Incidents with a child or youth victim"),
      ...seriesFor(perpCY, "Incidents with a child or youth perpetrator"),
    ];

    const plot = Plot.plot({
      width: Math.min(880, document.getElementById("chart-incident-volume").clientWidth),
      height: 400,
      marginLeft: 70,
      marginRight: 20,
      style: { fontFamily: "inherit" },
      x: { label: null },
      y: { label: "Incidents, 6-month rolling sum" },
      color: {
        domain: [
          "Incidents with a child or youth victim",
          "Incidents with a child or youth perpetrator",
          "Incidents with no child or youth involved",
        ],
        range: [PALETTE.victim, PALETTE.perp, PALETTE.neutral],
        legend: true,
      },
      marks: [
        Plot.ruleY([0]),
        Plot.line(data, {
          x: "month",
          y: "value",
          stroke: "group",
          strokeWidth: 2.5,
          title: (d) => `${d.group}\n${formatMonth(d.month)}: ${Math.round(d.value).toLocaleString()} incidents`,
          tip: true,
        }),
      ],
    });
    document.getElementById("chart-incident-volume").replaceChildren(plot);
  }

  // ---- Chart: total incidents over the full 2017–2026 period, by category ----
  // Categories aren't mutually exclusive (an incident can have both a
  // child/youth victim and perpetrator), so bars are independent totals, not
  // a stacked breakdown — matching how the same three series are shown as
  // separate (not stacked) lines in chartVolume() above. Percentages are each
  // category's share of all incidents nationally over the period.
  function chartVolumeAllTime() {
    const totalIncidents = d3.sum(rows, (d) => d.total_incidents);
    const categories = [
      { group: "No child or youth involved", value: d3.sum(rows, (d) => d.incidents_no_child_youth), fill: PALETTE.neutral },
      { group: "Child or youth victim", value: d3.sum(rows, (d) => d.incidents_victim_child_youth), fill: PALETTE.victim },
      { group: "Child or youth perpetrator", value: d3.sum(rows, (d) => d.incidents_perp_child_youth), fill: PALETTE.perp },
    ].map((d) => ({ ...d, pct: (d.value / totalIncidents) * 100 }));

    const plot = Plot.plot({
      width: Math.min(880, document.getElementById("chart-incident-volume-all-time").clientWidth),
      height: 400,
      marginTop: 30,
      marginLeft: 70,
      style: { fontFamily: "inherit" },
      x: { label: null, type: "band", domain: categories.map((d) => d.group) },
      y: { label: "Total incidents, 2017–2026", grid: false },
      marks: [
        Plot.ruleY([0]),
        Plot.barY(categories, {
          x: "group",
          y: "value",
          fill: "fill",
          title: (d) => `${d.group}\n${Math.round(d.value).toLocaleString()} incidents (${d.pct.toFixed(0)}%)`,
          tip: true,
        }),
        Plot.text(categories, {
          x: "group",
          y: "value",
          text: (d) => `${Math.round(d.value).toLocaleString()} (${d.pct.toFixed(0)}%)`,
          dy: -8,
          fontWeight: 700,
        }),
      ],
    });
    document.getElementById("chart-incident-volume-all-time").replaceChildren(plot);
  }

  chartVolume();
  chartVolumeAllTime();
  window.addEventListener("resize", () => {
    chartVolume();
    chartVolumeAllTime();
  });
})();
