/* Homematic channel config page - loads one channel from the URL hash */
(function () {
  'use strict';

  var API_BASE = '/plugins/matterbridge-homematic/api';

  var titleEl      = document.getElementById('title');
  var subtitleEl   = document.getElementById('subtitle');
  var fieldSwitch  = document.getElementById('field-switchMatterType');
  var inputSwitch  = document.getElementById('input-switchMatterType');
  var fieldHumid   = document.getElementById('field-exposeHumidity');
  var inputHumid   = document.getElementById('input-exposeHumidity');
  var noteEl       = document.getElementById('note');
  var saveBtn      = document.getElementById('btn-save');
  var resetBtn     = document.getElementById('btn-reset');
  var statusEl     = document.getElementById('status');

  var channel = null;

  // Extract channel address from selectSerial "iface:typeLabel:address"
  function addressFromSerial(serial) {
    var first = serial.indexOf(':');
    if (first < 0) return serial;
    var second = serial.indexOf(':', first + 1);
    if (second < 0) return serial;
    return serial.slice(second + 1);
  }

  // Load channel from API and render
  async function init() {
    var rawHash = decodeURIComponent(location.hash.slice(1));
    if (!rawHash) {
      titleEl.textContent = 'No channel selected';
      setStatus('Open this page from the gear icon next to a device.', '');
      return;
    }

    var address = addressFromSerial(rawHash);

    try {
      var res = await fetch(API_BASE + '/channels');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var data = await res.json();
      channel = (data.channels || []).find(function (c) { return c.address === address; });
    } catch (err) {
      titleEl.textContent = 'Error';
      setStatus('Failed to load channel data: ' + String(err), 'error');
      return;
    }

    if (!channel) {
      titleEl.textContent = 'Channel not found';
      setStatus('Address: ' + address, 'error');
      return;
    }

    // Render
    titleEl.textContent = channel.displayName || channel.address;
    subtitleEl.textContent = channel.address + ' - ' + channel.channelType + ' - ' + channel.interfaceName;

    // Reset fields
    fieldSwitch.classList.add('hidden');
    fieldHumid.classList.add('hidden');
    noteEl.classList.add('hidden');
    saveBtn.disabled = true;

    var hasOptions = false;

    if (channel.capabilities.switchMatterType) {
      fieldSwitch.classList.remove('hidden');
      inputSwitch.value = (channel.override && channel.override.switchMatterType) || 'light';
      hasOptions = true;
    }

    if (channel.capabilities.exposeHumidity) {
      fieldHumid.classList.remove('hidden');
      inputHumid.checked = !(channel.override && channel.override.exposeHumidity === false);
      hasOptions = true;
    }

    if (!hasOptions) {
      setStatus('This channel has no configurable options.', '');
      return;
    }

    if (channel.channelType === 'HEATING_CLIMATECONTROL_TRANSCEIVER') {
      noteEl.textContent = 'Changes take effect after a plugin restart.';
      noteEl.classList.remove('hidden');
    }

    setStatus('', '');
    saveBtn.disabled = false;
  }

  // Save
  saveBtn.addEventListener('click', async function () {
    if (!channel) return;
    var body = {};
    if (channel.capabilities.switchMatterType) body.switchMatterType = inputSwitch.value;
    if (channel.capabilities.exposeHumidity)   body.exposeHumidity   = inputHumid.checked;

    saveBtn.disabled = true;
    setStatus('Saving...', '');

    try {
      var res = await fetch(API_BASE + '/channel-override', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ address: channel.address }, body)),
      });
      var result = await res.json();
      if (result.error) { setStatus('Error: ' + result.error, 'error'); saveBtn.disabled = false; return; }
      var savedMsg = result.restartRequired ? 'Saved. Plugin restart required to apply changes.' : 'Saved and applied.';
      var savedType = result.restartRequired ? 'warning' : 'success';
      await init();
      setStatus(savedMsg, savedType);
    } catch (err) {
      setStatus('Save failed: ' + String(err), 'error');
      saveBtn.disabled = false;
    }
  });

  // Reset to default
  resetBtn.addEventListener('click', async function () {
    if (!channel) return;
    resetBtn.disabled = true;
    setStatus('Resetting...', '');

    try {
      var res = await fetch(API_BASE + '/channel-reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: channel.address }),
      });
      var result = await res.json();
      if (result.error) { setStatus('Error: ' + result.error, 'error'); resetBtn.disabled = false; return; }
      var resetMsg = result.restartRequired ? 'Reset. Plugin restart required to apply changes.' : 'Override removed.';
      var resetType = result.restartRequired ? 'warning' : 'success';
      await init();
      setStatus(resetMsg, resetType);
    } catch (err) {
      setStatus('Reset failed: ' + String(err), 'error');
      resetBtn.disabled = false;
    }
  });

  function setStatus(msg, type) {
    statusEl.textContent = msg;
    statusEl.className = 'status' + (type ? ' ' + type : '');
  }

  init();
})();
