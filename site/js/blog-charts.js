// Renders the narrative charts embedded in the Key Takeaways page, from
// site/data/national_monthly.json. All smoothing happens here, in the browser,
// and is OFF by default — the reader opts in with a "12-month average" toggle.

(async function () {
  const national = await loadJSON("data/national_monthly.json");
  national.forEach((d) => (d.month = parseMonth(d.month)));
  national.sort((a, b) => a.month - b.month);

  const toggle1 = document.getElementById("smoothing-toggle");
  let smoothed1 = toggle1.checked;

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

  function yLabel(populationLabel, smoothed) {
    return smoothed
      ? `Annual rate per 100,000 ${populationLabel} (trailing 12-month)`
      : `Annual rate per 100,000 ${populationLabel} (single month, annualized)`;
  }

  // Peak-and-latest annotation pair for one (already smoothed) series.
  // `peakDy`/`latestDy` control which side of each point the tip sits on
  // (negative = tip above/"bottom"-anchored, positive = tip below/"top"-
  // anchored — see tipAnchor) and let the caller pull the two series' tips
  // apart when their points are close together (see chartVictimsPerps).
  function peakAndLatestAnnotations(data, group, color, { peakDy = -10, latestDy = -10, peakAnchor: peakAnchorOverride } = {}) {
    const peak = data.reduce((a, b) => (b.value > a.value ? b : a));
    const latest = data[data.length - 1];
    const declinePct = ((peak.value - latest.value) / peak.value) * 100;

    // Anchor away from whichever edge of the date range the point is near,
    // so the wrapped text doesn't run off the side of the chart — unless the
    // caller pins it explicitly (e.g. "middle" to center the tip).
    const firstMonth = data[0].month.getTime();
    const lastMonth = data[data.length - 1].month.getTime();
    const mid = (firstMonth + lastMonth) / 2;
    const peakAnchor = peakAnchorOverride ?? (peak.month.getTime() < mid ? "start" : "end");

    const base = { group, fill: color, fontWeight: 600, fontSize: 11, lineWidth: 15 };
    return [
      {
        ...base,
        month: peak.month,
        value: peak.value,
        dy: peakDy,
        textAnchor: peakAnchor,
        text: `Peak of ${peak.value.toFixed(1)} per 100k in ${formatMonth(peak.month)}`,
      },
      {
        ...base,
        month: latest.month,
        value: latest.value,
        dy: latestDy,
        textAnchor: "end",
        text: `${formatMonth(latest.month)}: ${latest.value.toFixed(1)} per 100k (-${declinePct.toFixed(0)}%)`,
      },
    ];
  }

  // Maps an annotation's dy sign + textAnchor to the nearest Plot.tip
  // `anchor` — the corner of the tip box that touches its data point.
  function tipAnchor(dy, textAnchor) {
    const vert = dy < 0 ? "bottom" : "top";
    if (textAnchor === "middle") return vert;
    const horiz = textAnchor === "start" ? "left" : "right";
    return `${vert}-${horiz}`;
  }

  // ---- Chart 1: youth victims vs. perpetrators, annual rate per 100,000 ----
  // Peak/latest annotations only appear with the 12-month average on — a
  // "peak" on the raw monthly series would just be whichever month was
  // noisiest, not a meaningful point.
  function chartVictimsPerps() {
    const victims = series("youth_victim", "youth_population", smoothed1).map((d) => ({ ...d, group: "Victims" }));
    const perps = series("youth_perp_minus_possession", "youth_population", smoothed1).map((d) => ({
      ...d,
      group: "Perpetrators",
    }));
    const data = victims.concat(perps);

    const annotations = smoothed1
      ? [
          // Victims' latest tip now sits below its point ("top"-anchored)
          // rather than above; perpetrators' peak tip does the same. Both
          // series' latest tips land in the same bottom-right corner of the
          // chart, so perpetrators' is pushed further down to clear victims'.
          ...peakAndLatestAnnotations(victims, "Victims", PALETTE.victim, { peakDy: -10, latestDy: 30, peakAnchor: "middle" }),
          ...peakAndLatestAnnotations(perps, "Perpetrators", PALETTE.perp, { peakDy: 20, latestDy: 60 }),
        ]
      : [];

    const plot = Plot.plot({
      width: Math.min(880, document.getElementById("chart-victims-perps").clientWidth),
      height: 380,
      marginRight: 90,
      marginTop: 70,
      style: { fontFamily: "inherit" },
      x: { label: null },
      y: { label: yLabel("youth", smoothed1) },
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
          strokeWidth: smoothed1 ? 2.5 : 1,
          strokeOpacity: smoothed1 ? 1 : 0.7,
        }),
           ...annotations.map((a) =>
          Plot.tip([a], {
            x: (d) => d.month,
            y: (d) => d.value,
            title: (d) => d.text,
            anchor: tipAnchor(a.dy, a.textAnchor),
            format: { x: null, y: null },
            fill: "white",
            fontSize: a.fontSize,
            lineHeight: 1.3,
          })
        ),
      ],
    });
    document.getElementById("chart-victims-perps").replaceChildren(plot);
  }

  // ---- Chart 2: ratio of youth victims to youth perpetrators, by calendar
  // year. Raw counts (not rates), per the site's convention of excluding
  // possession-only offenses from perpetrator figures. Full calendar years
  // only — 2026 has just two months in the data, which would be a
  // misleadingly noisy partial-year ratio next to nine full years.
  function chartVictimYouthRatio() {
    const byYear = d3.rollup(
      national,
      (rows) => ({
        victim: d3.sum(rows, (d) => d.youth_victim),
        perp: d3.sum(rows, (d) => d.youth_perp_minus_possession),
        months: rows.length,
      }),
      (d) => d.month.getFullYear()
    );

    const rows = [...byYear]
      .filter(([, v]) => v.months === 12)
      .map(([year, v]) => ({ year: String(year), victim: v.victim, perp: v.perp, ratio: v.victim / v.perp }))
      .sort((a, b) => a.year.localeCompare(b.year));

    const totalVictim = d3.sum(rows, (d) => d.victim);
    const totalPerp = d3.sum(rows, (d) => d.perp);
    const avgRatio = totalVictim / totalPerp;
    // Anchor the average label at whichever end has more headroom above the
    // dashed line, so it doesn't collide with that bar's own value label.
    const firstBar = rows[0],
      lastBar = rows[rows.length - 1];
    const labelYear = firstBar.ratio <= lastBar.ratio ? firstBar.year : lastBar.year;
    const labelAnchor = labelYear === firstBar.year ? "start" : "end";

    const plot = Plot.plot({
      width: Math.min(880, document.getElementById("chart-victim-perp-ratio").clientWidth),
      height: 380,
      marginTop: 30,
      style: { fontFamily: "inherit" },
      x: { label: null, type: "band" },
      y: { label: "Youth victims per perpetrator (ratio)", grid: false },
      marks: [
        Plot.ruleY([0]),
        Plot.barY(rows, {
          x: "year",
          y: "ratio",
          fill: PALETTE.victim,
          title: (d) => `${d.year}\nVictims: ${d.victim.toLocaleString()}\nPerpetrators: ${d.perp.toLocaleString()}\nRatio: ${d.ratio.toFixed(2)}×`,
          tip: true,
        }),
        Plot.text(rows, {
          x: "year",
          y: "ratio",
          text: (d) => `${d.ratio.toFixed(1)}×`,
          dy: -8,
          fontWeight: 700,
        }),
        Plot.ruleY([avgRatio], { stroke: "#000", strokeDasharray: "4,3", strokeWidth: 1.5 }),
        Plot.text([{ year: labelYear, ratio: avgRatio }], {
          x: "year",
          y: "ratio",
          text: () => `All years average: ${avgRatio.toFixed(1)}×`,
          dy: -10,
          textAnchor: labelAnchor,
          fontWeight: 700,
        }),
      ],
    });
    document.getElementById("chart-victim-perp-ratio").replaceChildren(plot);
  }

  chartVictimsPerps();
  chartVictimYouthRatio();

  toggle1.addEventListener("change", () => {
    smoothed1 = toggle1.checked;
    chartVictimsPerps();
  });

  window.addEventListener("resize", () => {
    chartVictimsPerps();
    chartVictimYouthRatio();
  });
})();
