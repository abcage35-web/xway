let highchartsConfigCounter = 0;
let hasAppliedTheme = false;

const highchartsConfigRegistry = new Map();
const reflowHosts = new Set();
let hasWindowResizeListener = false;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function escapeAttr(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function ensureHighcharts() {
  const Highcharts = window.Highcharts;
  if (!Highcharts) {
    return null;
  }
  if (!hasAppliedTheme) {
    Highcharts.setOptions({
      accessibility: {
        enabled: false,
      },
      chart: {
        animation: false,
        backgroundColor: "transparent",
        reflow: false,
        style: {
          fontFamily: '"IBM Plex Sans", sans-serif',
        },
      },
      credits: {
        enabled: false,
      },
      legend: {
        enabled: false,
      },
      title: {
        text: undefined,
      },
      subtitle: {
        text: undefined,
      },
      tooltip: {
        enabled: true,
        useHTML: true,
        outside: false,
        borderWidth: 0,
        backgroundColor: "transparent",
        shadow: false,
        padding: 0,
        hideDelay: 0,
        followPointer: false,
      },
      plotOptions: {
        series: {
          animation: false,
          stickyTracking: true,
          findNearestPointBy: "x",
          states: {
            inactive: {
              opacity: 1,
            },
          },
        },
      },
    });
    hasAppliedTheme = true;
  }
  return Highcharts;
}

function nextConfigId(prefix = "hc") {
  highchartsConfigCounter += 1;
  return `${prefix}-${highchartsConfigCounter}`;
}

function resolveConfig(config, Highcharts, host) {
  if (typeof config === "function") {
    return config(Highcharts, host);
  }
  return config;
}

function indexSeries(chart, host) {
  const seriesMap = new Map();
  (chart.series || []).forEach((series) => {
    const key = series?.options?.custom?.seriesKey;
    if (key) {
      seriesMap.set(String(key), series);
    }
  });
  host.__highchartsSeriesMap = seriesMap;
}

function collectHighchartsHosts(root = document) {
  if (!root) {
    return [];
  }
  const hosts = [];
  if (typeof root.matches === "function" && root.matches("[data-highcharts-id]")) {
    hosts.push(root);
  }
  if (typeof root.querySelectorAll === "function") {
    hosts.push(...root.querySelectorAll("[data-highcharts-id]"));
  }
  return hosts;
}

function queueHostReflow(host) {
  if (!host || host.__highchartsReflowFrame || !host.__highchartsChart?.reflow) {
    return;
  }
  host.__highchartsReflowFrame = window.requestAnimationFrame(() => {
    host.__highchartsReflowFrame = 0;
    const chart = host.__highchartsChart;
    if (!chart || chart.isDestroyed) {
      return;
    }
    try {
      chart.reflow();
    } catch {
      // Ignore transient layout errors while the host is being re-rendered.
    }
  });
}

function windowResizeHandler() {
  reflowHosts.forEach((host) => queueHostReflow(host));
}

function ensureWindowResizeListener() {
  if (hasWindowResizeListener) {
    return;
  }
  window.addEventListener("resize", windowResizeHandler);
  hasWindowResizeListener = true;
}

function releaseWindowResizeListener() {
  if (!hasWindowResizeListener || reflowHosts.size > 0) {
    return;
  }
  window.removeEventListener("resize", windowResizeHandler);
  hasWindowResizeListener = false;
}

function bindHighchartsReflow(host) {
  if (!host) {
    return;
  }
  unbindHighchartsReflow(host);

  const chart = host.__highchartsChart;
  if (!chart) {
    return;
  }

  reflowHosts.add(host);
  ensureWindowResizeListener();

  if (typeof ResizeObserver !== "undefined") {
    const observer = new ResizeObserver(() => {
      queueHostReflow(host);
    });
    observer.observe(host);
    host.__highchartsResizeObserver = observer;
  }

  queueHostReflow(host);
}

function unbindHighchartsReflow(host) {
  if (!host) {
    return;
  }
  if (host.__highchartsResizeObserver) {
    host.__highchartsResizeObserver.disconnect();
    delete host.__highchartsResizeObserver;
  }
  if (host.__highchartsReflowFrame) {
    window.cancelAnimationFrame(host.__highchartsReflowFrame);
    host.__highchartsReflowFrame = 0;
  }
  reflowHosts.delete(host);
  releaseWindowResizeListener();
}

function normalizeTooltipOptions(tooltip) {
  if (tooltip === false) {
    return { enabled: false };
  }
  const base = tooltip && typeof tooltip === "object" ? tooltip : {};
  const normalized = {
    ...base,
    enabled: base.enabled ?? true,
    useHTML: base.useHTML ?? true,
    outside: base.outside ?? false,
    borderWidth: base.borderWidth ?? 0,
    backgroundColor: base.backgroundColor ?? "transparent",
    shadow: base.shadow ?? false,
    padding: base.padding ?? 0,
    hideDelay: base.hideDelay ?? 0,
    followPointer: base.followPointer ?? false,
  };
  normalized.style = {
    pointerEvents: "none",
    ...(base.style || {}),
  };
  return normalized;
}

function normalizeAxisOptions(axis) {
  if (Array.isArray(axis)) {
    return axis.map((item) => ({
      ...(item || {}),
    }));
  }
  if (axis && typeof axis === "object") {
    return { ...axis };
  }
  return axis;
}

function normalizeChartOptions(options = {}) {
  const normalized = { ...options };
  normalized.chart = {
    animation: false,
    backgroundColor: "transparent",
    ...(options.chart || {}),
    animation: false,
    reflow: false,
  };
  normalized.legend = options.legend ? { ...options.legend } : { enabled: false };
  normalized.tooltip = normalizeTooltipOptions(options.tooltip);
  normalized.xAxis = normalizeAxisOptions(options.xAxis);
  normalized.yAxis = normalizeAxisOptions(options.yAxis);
  const seriesStates = options.plotOptions?.series?.states || {};
  const seriesInactive = seriesStates.inactive || {};
  normalized.plotOptions = {
    ...(options.plotOptions || {}),
    series: {
      ...(options.plotOptions?.series || {}),
      animation: false,
      stickyTracking: true,
      findNearestPointBy: "x",
      states: {
        ...seriesStates,
        inactive: {
          opacity: 1,
          ...seriesInactive,
        },
      },
    },
  };
  return normalized;
}

function destroyHighchartsHost(host) {
  if (!host) {
    return;
  }
  unbindHighchartsReflow(host);
  if (host.__highchartsChart?.destroy) {
    try {
      host.__highchartsChart.destroy();
    } catch {
      // Ignore destroy races when the host is already being removed.
    }
  }
  delete host.__highchartsChart;
  delete host.__highchartsSeriesMap;
}

export function renderHighchartsHost(config, options = {}) {
  const id = nextConfigId(options.prefix || "hc");
  highchartsConfigRegistry.set(id, config);
  const classes = ["highcharts-host"];
  if (options.className) {
    classes.push(options.className);
  }
  const styles = [];
  if (options.height) {
    styles.push(`height:${Number(options.height)}px`);
  }
  if (options.minHeight) {
    styles.push(`min-height:${Number(options.minHeight)}px`);
  }
  return `<div class="${escapeAttr(classes.join(" "))}" data-highcharts-id="${escapeAttr(id)}"${styles.length ? ` style="${escapeAttr(styles.join(";"))}"` : ""}></div>`;
}

export function mountHighcharts(root = document) {
  const Highcharts = ensureHighcharts();
  if (!Highcharts) {
    return;
  }

  collectHighchartsHosts(root).forEach((host) => {
    const configId = host.dataset.highchartsId;
    if (!configId) {
      return;
    }
    const config = highchartsConfigRegistry.get(configId);
    if (!config) {
      return;
    }

    destroyHighchartsHost(host);

    const options = resolveConfig(config, Highcharts, host);
    if (!options) {
      return;
    }

    const chart = Highcharts.chart(host, normalizeChartOptions(options));
    host.__highchartsChart = chart;
    indexSeries(chart, host);
    bindHighchartsReflow(host);
  });
}

export function destroyMountedHighcharts(root = document) {
  collectHighchartsHosts(root).forEach((host) => {
    const configId = host.dataset.highchartsId;
    destroyHighchartsHost(host);
    if (configId) {
      highchartsConfigRegistry.delete(configId);
    }
  });
}

export function toggleHighchartsSeries(button) {
  const seriesKey = button?.dataset?.chartToggle;
  if (!seriesKey) {
    return false;
  }
  const card = button.closest(".chart-card, .metric-funnel-tab, .efficiency-mini");
  const host = card?.querySelector?.("[data-highcharts-id]");
  const chart = host?.__highchartsChart;
  if (!chart) {
    return false;
  }
  const series = host.__highchartsSeriesMap?.get(String(seriesKey))
    || chart.series.find((item) => item?.options?.custom?.seriesKey === String(seriesKey));
  if (!series) {
    return false;
  }
  const nextInactive = button.classList.toggle("is-inactive");
  series.setVisible(!nextInactive, false);
  chart.tooltip?.hide?.(0);
  chart.pointer?.reset?.(false, 0);
  chart.redraw();
  return true;
}

export function buildHighchartsTooltipHtml(title, lines = [], renderLine) {
  const safeLines = Array.isArray(lines) ? lines : [];
  const hasTable = safeLines.some(
    (line) => line && typeof line === "object" && (line.type === "cluster-table" || line.type === "metric"),
  );
  const renderFallbackLine = (line) => `<span class="chart-tooltip-line">${escapeAttr(String(line ?? "—"))}</span>`;
  return `
    <div class="chart-tooltip chart-tooltip-embedded${hasTable ? " has-table" : ""}">
      ${title ? `<strong>${escapeAttr(title)}</strong>` : ""}
      ${safeLines.map((line) => (renderLine ? renderLine(line) : renderFallbackLine(line))).join("")}
    </div>
  `;
}
