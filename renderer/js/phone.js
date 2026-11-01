// Phone companion status in the title bar.
(function () {
  function describePhone(status) {
    if (!status?.enabled) return { hidden: true, tone: 'neutral', label: '', title: '', labels: [] };
    if (!status.listening) {
      const error = typeof status.error === 'string' && status.error.trim() ? status.error : null;
      return { hidden: false, tone: error ? 'error' : 'neutral', label: error ? 'Phone: error' : 'Phone: starting',
        title: error || 'Phone companion is starting.', labels: [] };
    }

    const devices = Array.isArray(status.devices) ? status.devices : [];
    const labels = devices.filter((device) => device?.connected).map((device) =>
      typeof device.label === 'string' && device.label.trim() ? device.label : 'Unnamed phone');
    if (labels.length) return { hidden: false, tone: 'connected',
      label: labels.length > 1 ? `Phone connected (${labels.length})` : 'Phone connected',
      title: `Connected ${labels.length === 1 ? 'phone' : 'phones'}: ${labels.join(', ')}`, labels };
    return { hidden: false, tone: 'neutral', label: 'Phone: listening',
      title: 'Waiting for a phone to connect.', labels: [] };
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { describePhone };
  if (typeof window === 'undefined') return;
  window.PhoneIndicator = { describePhone };

  const indicator = document.getElementById('phone-indicator');
  const remote = window.codeome?.remote;
  if (!indicator || typeof remote?.status !== 'function' || typeof remote.onStatus !== 'function') return;
  const label = indicator.querySelector('.phone-label');
  let revision = 0;
  const render = (status) => {
    revision++;
    const view = describePhone(status);
    indicator.hidden = view.hidden;
    indicator.classList.toggle('connected', view.tone === 'connected');
    indicator.classList.toggle('error', view.tone === 'error');
    label.textContent = view.label;
    indicator.title = view.title;
  };
  indicator.addEventListener('click', () => window.App.views.settings.open('phone'));
  remote.onStatus(render);
  const initialRevision = revision;
  remote.status().then((status) => { if (revision === initialRevision) render(status); }).catch(() => {});
})();
