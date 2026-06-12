/* global matterbridge-homematic channel configuration UI */
(function () {
  'use strict';

  const API_BASE = '/plugins/matterbridge-homematic/api';

  let allChannels = [];
  let editingChannel = null;

  // ── DOM refs ──
  const tbody = document.getElementById('channel-tbody');
  const searchInput = document.getElementById('search');
  const statusBar = document.getElementById('status-bar');
  const modalOverlay = document.getElementById('modal-overlay');
  const modalTitle = document.getElementById('modal-title');
  const modalAddress = document.getElementById('modal-address');
  const modalForm = document.getElementById('modal-form');
  const modalNote = document.getElementById('modal-note');
  const fieldSwitchMatterType = document.getElementById('field-switchMatterType');
  const fieldExposeHumidity = document.getElementById('field-exposeHumidity');
  const inputEnabled = document.getElementById('input-enabled');
  const inputSwitchMatterType = document.getElementById('input-switchMatterType');
  const inputExposeHumidity = document.getElementById('input-exposeHumidity');

  // ── Init ──
  loadChannels();
  searchInput.addEventListener('input', renderTable);
  document.getElementById('btn-cancel').addEventListener('click', closeModal);
  document.getElementById('btn-reset').addEventListener('click', handleReset);
  modalForm.addEventListener('submit', handleSave);
  modalOverlay.addEventListener('click', function (e) {
    if (e.target === modalOverlay) closeModal();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeModal();
  });

  // Handle hash-based deep links: #<selectSerial>
  window.addEventListener('hashchange', applyHashHighlight);

  // ── Data loading ──
  async function loadChannels() {
    try {
      const res = await fetch(API_BASE + '/channels');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      allChannels = data.channels ?? [];
    } catch (err) {
      allChannels = [];
      showStatus('Failed to load channels: ' + String(err), 'error');
    }
    renderTable();
    applyHashHighlight();
  }

  // ── Table rendering ──
  function renderTable() {
    const filter = searchInput.value.trim().toLowerCase();
    const visible = filter
      ? allChannels.filter(function (ch) {
          return (
            ch.address.toLowerCase().includes(filter) ||
            (ch.displayName ?? '').toLowerCase().includes(filter) ||
            (ch.name ?? '').toLowerCase().includes(filter) ||
            ch.channelType.toLowerCase().includes(filter)
          );
        })
      : allChannels;

    if (visible.length === 0) {
      tbody.innerHTML = '<tr class="loading-row"><td colspan="9">' + (filter ? 'No channels match the filter.' : 'No channels discovered.') + '</td></tr>';
      showStatus('');
      return;
    }

    showStatus(visible.length + ' of ' + allChannels.length + ' channels');

    const rows = visible.map(function (ch) {
      const matterType = resolveMatterType(ch);
      const humidityCell = ch.capabilities.exposeHumidity ? badge(ch.override && ch.override.exposeHumidity === false ? 'no' : 'yes') : '<span class="badge-na">—</span>';
      return (
        '<tr data-address="' +
        escHtml(ch.address) +
        '">' +
        '<td>' +
        escHtml(ch.displayName ?? ch.address) +
        '</td>' +
        '<td class="cell-address">' +
        escHtml(ch.address) +
        '</td>' +
        '<td class="cell-type">' +
        escHtml(ch.channelType) +
        '</td>' +
        '<td class="cell-type">' +
        escHtml(ch.interfaceName) +
        '</td>' +
        '<td>' +
        (matterType ? escHtml(matterType) : '<span class="badge-na">—</span>') +
        '</td>' +
        '<td>' +
        humidityCell +
        '</td>' +
        '<td>' +
        badge(ch.enabled ? 'yes' : 'no') +
        '</td>' +
        '<td>' +
        badge(ch.registered ? 'yes' : 'no') +
        '</td>' +
        '<td><button class="btn-edit" data-address="' +
        escHtml(ch.address) +
        '">Edit</button></td>' +
        '</tr>'
      );
    });

    tbody.innerHTML = rows.join('');

    tbody.querySelectorAll('.btn-edit').forEach(function (btn) {
      btn.addEventListener('click', function () {
        openModal(btn.dataset.address);
      });
    });

    applyHashHighlight();
  }

  function badge(val) {
    if (val === 'yes') return '<span class="badge badge-yes">yes</span>';
    if (val === 'no') return '<span class="badge badge-no">no</span>';
    return '<span class="badge-na">—</span>';
  }

  function resolveMatterType(ch) {
    if (!ch.capabilities.switchMatterType) return null;
    return (ch.override && ch.override.switchMatterType) || 'light';
  }

  function escHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ── Hash highlight ──
  // Extracts the channel address from a selectSerial "<iface>:<typeLabel>:<address>"
  function addressFromSerial(serial) {
    var first = serial.indexOf(':');
    if (first < 0) return serial;
    var second = serial.indexOf(':', first + 1);
    if (second < 0) return serial;
    return serial.slice(second + 1);
  }

  var hashAutoOpened = false;

  function applyHashHighlight() {
    var rawHash = decodeURIComponent(location.hash.slice(1));
    tbody.querySelectorAll('tr').forEach(function (tr) {
      tr.classList.remove('highlighted');
    });
    if (!rawHash) return;
    var channelAddress = addressFromSerial(rawHash);
    var target = tbody.querySelector('tr[data-address="' + CSS.escape(channelAddress) + '"]');
    if (target) {
      target.classList.add('highlighted');
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      if (!hashAutoOpened) {
        hashAutoOpened = true;
        openModal(channelAddress);
      }
    }
  }

  // ── Status bar ──
  function showStatus(msg, type) {
    statusBar.textContent = msg ?? '';
    statusBar.style.color = type === 'error' ? 'var(--danger)' : 'var(--text-muted)';
  }

  // ── Modal ──
  function openModal(address) {
    const ch = allChannels.find(function (c) {
      return c.address === address;
    });
    if (!ch) return;
    editingChannel = ch;

    modalTitle.textContent = ch.displayName ?? ch.address;
    modalAddress.textContent = ch.address;

    // Enabled checkbox
    inputEnabled.checked = ch.enabled;

    // switchMatterType
    if (ch.capabilities.switchMatterType) {
      fieldSwitchMatterType.classList.remove('hidden');
      inputSwitchMatterType.value = (ch.override && ch.override.switchMatterType) || 'light';
    } else {
      fieldSwitchMatterType.classList.add('hidden');
    }

    // exposeHumidity
    if (ch.capabilities.exposeHumidity) {
      fieldExposeHumidity.classList.remove('hidden');
      inputExposeHumidity.checked = !(ch.override && ch.override.exposeHumidity === false);
    } else {
      fieldExposeHumidity.classList.add('hidden');
    }

    // Note
    const needsRestart = ch.channelType === 'HEATING_CLIMATECONTROL_TRANSCEIVER';
    if (needsRestart) {
      modalNote.textContent = 'Changes to thermostat channel configuration take effect after a plugin restart.';
      modalNote.classList.remove('hidden');
    } else {
      modalNote.classList.add('hidden');
    }

    modalOverlay.classList.remove('hidden');
    inputEnabled.focus();
  }

  function closeModal() {
    editingChannel = null;
    modalOverlay.classList.add('hidden');
  }

  // ── Save ──
  async function handleSave(e) {
    e.preventDefault();
    if (!editingChannel) return;

    const body = {};
    body.enabled = inputEnabled.checked;

    if (editingChannel.capabilities.switchMatterType) {
      body.switchMatterType = inputSwitchMatterType.value;
    }

    if (editingChannel.capabilities.exposeHumidity) {
      body.exposeHumidity = inputExposeHumidity.checked;
    }

    const address = editingChannel.address;
    closeModal();

    try {
      const res = await fetch(API_BASE + '/channels/' + encodeURIComponent(address) + '/override', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const result = await res.json();
      if (result.error) {
        showToast('Error: ' + result.error, 'error');
        return;
      }
      if (result.restartRequired) {
        showToast('Saved. A plugin restart is required for changes to take effect.', 'warning');
      } else {
        showToast('Channel configuration applied.', 'success');
      }
      await loadChannels();
    } catch (err) {
      showToast('Save failed: ' + String(err), 'error');
    }
  }

  // ── Reset ──
  async function handleReset() {
    if (!editingChannel) return;
    const address = editingChannel.address;
    closeModal();

    try {
      const res = await fetch(API_BASE + '/channels/' + encodeURIComponent(address) + '/override', {
        method: 'DELETE',
      });
      const result = await res.json();
      if (result.error) {
        showToast('Error: ' + result.error, 'error');
        return;
      }
      if (result.restartRequired) {
        showToast('Override removed. A plugin restart is required.', 'warning');
      } else {
        showToast('Override removed.', 'success');
      }
      await loadChannels();
    } catch (err) {
      showToast('Reset failed: ' + String(err), 'error');
    }
  }

  // ── Toasts ──
  function showToast(message, type) {
    const container = document.getElementById('toasts');
    const el = document.createElement('div');
    el.className = 'toast toast-' + (type ?? 'success');
    el.textContent = message;
    container.appendChild(el);
    setTimeout(function () {
      el.remove();
    }, type === 'error' || type === 'warning' ? 6000 : 3500);
  }
})();
