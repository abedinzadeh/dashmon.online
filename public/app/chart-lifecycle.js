(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory;
    return;
  }

  root.createChartLifecycle = factory;
})(typeof globalThis !== 'undefined' ? globalThis : window, function createChartLifecycle() {
  function resetChartMap(chartMap) {
    for (const chart of chartMap.values()) {
      if (chart && typeof chart.destroy === 'function') {
        chart.destroy();
      }
    }
    chartMap.clear();
  }

  function createRenderGuard() {
    let version = 0;
    return {
      next() {
        version += 1;
        return version;
      },
      isCurrent(candidate) {
        return candidate === version;
      }
    };
  }

  return { resetChartMap, createRenderGuard };
});
