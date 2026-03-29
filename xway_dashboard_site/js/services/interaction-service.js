export function createInteractionService(deps) {
  const {
    articlePickerShell,
    buildModalContent,
    clamp,
    destroyMountedHighcharts,
    mountHighcharts,
    modalBody,
    modalNote,
    modalShell,
    modalTitle,
    parseChartTooltipLines,
    productStore,
    renderChartTooltipLine,
    setArticleSelectorOpen,
    syncModalLock,
    toggleHighchartsSeries,
  } = deps;

  function hideChartTooltips() {
    document.querySelectorAll(".chart-tooltip").forEach((tooltip) => {
      tooltip.hidden = true;
    });
  }

  function showChartTooltip(target, event) {
    const shell = target.closest(".chart-shell");
    if (!shell) {
      return;
    }
    const tooltip = shell.querySelector(".chart-tooltip");
    if (!tooltip) {
      return;
    }

    const title = target.dataset.chartTitle || "";
    const lines = parseChartTooltipLines(target.dataset.chartLines || "");
    const hasTable = lines.some((line) => line && typeof line === "object" && (line.type === "cluster-table" || line.type === "metric"));
    tooltip.classList.toggle("has-table", hasTable);
    tooltip.innerHTML = `
      ${title ? `<strong>${title}</strong>` : ""}
      ${lines.map((line) => renderChartTooltipLine(line)).join("")}
    `;
    tooltip.hidden = false;

    requestAnimationFrame(() => {
      const viewportPadding = 12;
      const maxLeft = Math.max(window.innerWidth - tooltip.offsetWidth - viewportPadding, viewportPadding);
      const desiredLeft = event.clientX + 16;
      const left = clamp(desiredLeft, viewportPadding, maxLeft);
      const topAbove = event.clientY - tooltip.offsetHeight - 14;
      const topBelow = event.clientY + 14;
      const desiredTop = topAbove >= viewportPadding ? topAbove : topBelow;
      const maxTop = Math.max(window.innerHeight - tooltip.offsetHeight - viewportPadding, viewportPadding);
      const top = clamp(desiredTop, viewportPadding, maxTop);
      tooltip.style.left = `${left}px`;
      tooltip.style.top = `${top}px`;
    });
  }

  function toggleChartSeries(button) {
    if (toggleHighchartsSeries?.(button)) {
      hideChartTooltips();
      return;
    }
    const card = button.closest(".chart-card");
    const seriesKey = button.dataset.chartToggle;
    if (!card || !seriesKey) {
      return;
    }
    const isInactive = button.classList.toggle("is-inactive");
    const escapeSelector = (value) => {
      if (window.CSS && typeof window.CSS.escape === "function") {
        return window.CSS.escape(value);
      }
      return String(value).replace(/["\\]/g, "\\$&");
    };
    card.querySelectorAll(`[data-series-key="${escapeSelector(seriesKey)}"]`).forEach((node) => {
      node.classList.toggle("series-hidden", isInactive);
    });
    hideChartTooltips();
  }

  function openModal(article, type) {
    const product = productStore.get(article);
    if (!product) {
      return;
    }
    const config = buildModalContent(product, type);
    modalTitle.textContent = config.title;
    modalNote.textContent = config.note;
    destroyMountedHighcharts?.(modalBody);
    modalBody.innerHTML = config.body;
    mountHighcharts?.(modalBody);
    modalShell.hidden = false;
    syncModalLock();
  }

  function closeModal() {
    modalShell.hidden = true;
    destroyMountedHighcharts?.(modalBody);
    modalBody.innerHTML = "";
    syncModalLock();
  }

  function closeAllMenus(except = null) {
    document.querySelectorAll(".menu-wrap").forEach((wrap) => {
      const menu = wrap.querySelector(".floating-menu");
      const button = wrap.querySelector('[data-action="toggle-menu"]');
      if (!menu) {
        return;
      }
      if (except && wrap === except) {
        return;
      }
      menu.hidden = true;
      if (button) {
        button.setAttribute("aria-expanded", "false");
      }
    });
    if (except !== articlePickerShell) {
      setArticleSelectorOpen(false);
    }
  }

  return {
    closeAllMenus,
    closeModal,
    hideChartTooltips,
    openModal,
    showChartTooltip,
    toggleChartSeries,
  };
}
