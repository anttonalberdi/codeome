// Load Monaco through its AMD loader, then start the app.
(function () {
  const vs = new URL('../node_modules/monaco-editor/min/vs', location.href).href;
  // Run language workers from blob URLs so they load under file://.
  window.MonacoEnvironment = {
    getWorkerUrl: function () {
      return URL.createObjectURL(new Blob([`self.MonacoEnvironment={baseUrl:'${vs}/../'};importScripts('${vs}/base/worker/workerMain.js');`], { type: 'text/javascript' }));
    }
  };
  require.config({ paths: { vs } });
  require(['vs/editor/editor.main'], function () {
    App.start().catch((e) => { console.error(e); App.err('Startup failed: ' + e.message); });
  }, function (err) {
    console.error(err);
    document.body.innerHTML = '<pre style="padding:20px">Could not load the editor: ' + String(err && err.message || err) + '</pre>';
  });
})();
