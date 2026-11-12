const path = require('path');

function windowOptions({ platform, dark }) {
  return {
    width: 1500, height: 940, minWidth: 720, minHeight: 600,
    title: 'Codeome',
    titleBarStyle: platform === 'darwin' ? 'hiddenInset' : 'default',
    ...(platform === 'darwin' ? { trafficLightPosition: { x: 14, y: 14 } } : {}),
    backgroundColor: dark ? '#1b1c1f' : '#f6f5f2',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  };
}

module.exports = { windowOptions };
