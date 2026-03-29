const EASE_OUT = [0.22, 1, 0.36, 1];
const EASE_SPRING = [0.19, 1, 0.22, 1];
const BLOCK_SELECTORS = [
  ".product-panel",
  ".warning-strip",
  ".metrics-grid > *",
  ".signal-item",
  ".section-panel",
  ".metric-funnel-tab",
  ".campaign-card",
  ".campaign-schedule-card",
  ".chart-card",
  ".campaign-inline-heatmap-panel",
  ".campaign-charts-panel",
  ".catalog-shop-group",
  ".catalog-article-item",
  ".article-chip",
  ".empty-state",
];
const GRAPH_SELECTORS = [
  ".highcharts-host",
  ".campaign-activity-overview",
  ".chart-status-strip",
  ".schedule-grid-card",
];
const FILL_SELECTORS = [
  ".campaign-budget-progress-fill",
];
const OBSERVED_ROOTS = new WeakMap();

function prefersReducedMotion() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
}

function motionApi() {
  return window.Motion && typeof window.Motion.animate === "function"
    ? window.Motion
    : null;
}

function collectUniqueElements(root, selectors) {
  if (!root?.querySelectorAll) {
    return [];
  }
  const seen = new Set();
  const items = [];
  selectors.forEach((selector) => {
    if (root.matches?.(selector) && !root.hasAttribute("hidden") && !seen.has(root)) {
      seen.add(root);
      items.push(root);
    }
  });
  selectors.forEach((selector) => {
    root.querySelectorAll(selector).forEach((node) => {
      if (seen.has(node) || node.hasAttribute("hidden")) {
        return;
      }
      seen.add(node);
      items.push(node);
    });
  });
  return items;
}

function cancelExistingAnimations(root) {
  if (!root?.querySelectorAll) {
    return;
  }
  root.querySelectorAll("[data-motion-enter]").forEach((node) => {
    node.getAnimations?.().forEach((animation) => animation.cancel());
  });
}

function markElements(elements = []) {
  elements.forEach((element) => {
    element.dataset.motionEnter = "1";
  });
}

function observeRenderedRoot(root, animateRenderedRoot) {
  if (!root?.querySelectorAll || OBSERVED_ROOTS.has(root) || typeof MutationObserver === "undefined") {
    return;
  }

  const pendingRoots = new Set();
  let frameId = 0;
  const flush = () => {
    frameId = 0;
    const roots = Array.from(pendingRoots);
    pendingRoots.clear();
    roots.forEach((candidate) => animateRenderedRoot(candidate));
  };
  const schedule = (candidate) => {
    if (!candidate?.isConnected) {
      return;
    }
    pendingRoots.add(candidate);
    if (!frameId) {
      frameId = window.requestAnimationFrame(flush);
    }
  };

  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      mutation.addedNodes.forEach((node) => {
        if (!(node instanceof Element) || node.hasAttribute("hidden")) {
          return;
        }
        schedule(node);
      });
    });
  });

  observer.observe(root, {
    childList: true,
    subtree: true,
  });

  OBSERVED_ROOTS.set(root, observer);
}

export function createAnimationService() {
  function animateRenderedRoot(root) {
    if (!root?.querySelectorAll) {
      return;
    }

    const Motion = motionApi();

    cancelExistingAnimations(root);
    const blockElements = collectUniqueElements(root, BLOCK_SELECTORS);
    const graphElements = collectUniqueElements(root, GRAPH_SELECTORS);
    const fillElements = collectUniqueElements(root, FILL_SELECTORS);

    markElements([...blockElements, ...graphElements, ...fillElements]);

    if (prefersReducedMotion()) {
      [...blockElements, ...graphElements].forEach((node) => {
        node.style.opacity = "1";
        node.style.transform = "none";
        node.style.filter = "none";
      });
      fillElements.forEach((node) => {
        node.style.transformOrigin = "left center";
        node.style.transform = "none";
      });
      return;
    }

    if (!Motion) {
      [...blockElements, ...graphElements].forEach((node) => {
        node.animate?.(
          [
            { opacity: 0, transform: "translateY(16px)", filter: "blur(8px)" },
            { opacity: 1, transform: "translateY(0px)", filter: "blur(0px)" },
          ],
          {
            duration: 520,
            easing: "cubic-bezier(0.22, 1, 0.36, 1)",
            fill: "both",
          },
        );
      });
      fillElements.forEach((node) => {
        node.style.transformOrigin = "left center";
        node.animate?.(
          [
            { opacity: 0.45, transform: "scaleX(0)" },
            { opacity: 1, transform: "scaleX(1)" },
          ],
          {
            duration: 760,
            easing: "cubic-bezier(0.19, 1, 0.22, 1)",
            fill: "both",
          },
        );
      });
      return;
    }

    if (blockElements.length) {
      Motion.animate(
        blockElements,
        {
          opacity: [0, 1],
          y: [20, 0],
          filter: ["blur(10px)", "blur(0px)"],
        },
        {
          duration: 0.56,
          easing: EASE_OUT,
          delay: Motion.stagger(0.035, { startDelay: 0.02 }),
        },
      );
    }

    if (graphElements.length) {
      Motion.animate(
        graphElements,
        {
          opacity: [0, 1],
          y: [16, 0],
          scale: [0.985, 1],
        },
        {
          duration: 0.62,
          easing: EASE_OUT,
          delay: Motion.stagger(0.045, { startDelay: 0.1 }),
        },
      );
    }

    if (fillElements.length) {
      fillElements.forEach((node) => {
        node.style.transformOrigin = "left center";
      });
      Motion.animate(
        fillElements,
        {
          opacity: [0.45, 1],
          scaleX: [0, 1],
        },
        {
          duration: 0.78,
          easing: EASE_SPRING,
          delay: Motion.stagger(0.08, { startDelay: 0.18 }),
        },
      );
    }
  }

  function installAutoAnimations(root = document.body) {
    observeRenderedRoot(root, animateRenderedRoot);
  }

  return {
    animateRenderedRoot,
    installAutoAnimations,
  };
}
