(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.simulationSwitchStyles = api.simulationSwitchStyles;
    root.simulationModeFromUpdate = api.simulationModeFromUpdate;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const MODE_COLORS = {
    sim: {
      background: 'rgba(0, 212, 255, 0.12)',
      color: '#00d4ff',
      border: '1px solid rgba(0, 212, 255, 0.25)'
    },
    live: {
      background: 'rgba(244, 63, 94, 0.22)',
      color: '#fecdd3',
      border: '1px solid rgba(244, 63, 94, 0.7)'
    },
    muted: {
      background: 'transparent',
      color: '#546e7a',
      border: '1px solid transparent'
    }
  };

  function simulationSwitchStyles(isSim) {
    const live = isSim === false;
    const simStyle = live ? MODE_COLORS.muted : MODE_COLORS.sim;
    const liveStyle = live ? MODE_COLORS.live : MODE_COLORS.muted;
    return {
      sim: { pressed: !live, background: simStyle.background, color: simStyle.color, border: simStyle.border },
      live: { pressed: live, background: liveStyle.background, color: liveStyle.color, border: liveStyle.border },
      badge: {
        display: live ? 'inline-flex' : 'none',
        text: live ? 'LIVE' : '',
        background: live ? MODE_COLORS.live.background : 'transparent',
        color: live ? MODE_COLORS.live.color : MODE_COLORS.muted.color,
        border: live ? MODE_COLORS.live.border : MODE_COLORS.muted.border
      },
      simBanner: live ? 'none' : 'flex',
      liveBanner: live ? 'block' : 'none'
    };
  }

  // CONNECTED, SIMULATION_TOGGLED, and HEARTBEAT carry payload.simulation.
  // /api/status carries simulationMode. Anything else leaves the switch alone.
  function simulationModeFromUpdate(message) {
    if (!message || typeof message !== 'object') return null;
    if (message.type === 'CONNECTED' || message.type === 'SIMULATION_TOGGLED' || message.type === 'HEARTBEAT') {
      const value = message.payload && message.payload.simulation;
      return value === true || value === false ? value : null;
    }
    if (message.simulationMode === true || message.simulationMode === false) return message.simulationMode;
    return null;
  }

  return { MODE_COLORS, simulationSwitchStyles, simulationModeFromUpdate };
});
