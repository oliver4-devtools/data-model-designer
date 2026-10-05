// Refresh against Dataverse and review the differences.

import { el, clear, plural, formatDateTime } from './util.js';
import { host } from './bridge.js';
import { state, setDocument, setDirty, mutate, notify } from './state.js';
import { openModal, modalFooter, toast, withProgress } from './ui.js';
import { render } from './render.js';
import { renderPanels } from './panels.js';
import { invalidateSizes } from './geometry.js';
import { invalidateCatalogue } from './sourcepicker.js';

export async function runRefresh() {
  if (!state.connection || !state.connection.connected) {
    toast('Connect to a Dataverse environment in XrmToolBox first.', 'warning');
    return;
  }

  if (!state.doc.tables.length) {
    toast('There is nothing on the canvas to refresh.', 'warning');
    return;
  }

  const source = state.doc.source || {};
  if (source.organizationId && state.connection.organizationId &&
      source.organizationId !== state.connection.organizationId) {
    const proceed = await host.confirm(
      'Different environment',
      'This diagram was built against ' + (source.organizationFriendlyName || source.environmentUrl || 'another environment') +
      '.\n\nYou are connected to ' + (state.connection.organizationFriendlyName || state.connection.host) +
      '.\n\nRefreshing will compare the diagram against the connected environment. Continue?');

    if (!proceed) return;
  }

  invalidateCatalogue();

  let outcome;
  try {
    outcome = await withProgress('Comparing the diagram with the environment...',
      () => host.refreshDiagram(state.doc), { cancellable: true });
  } catch (error) {
    // withProgress has already said what happened: the host's own message for a failure, a quiet
    // acknowledgement for a cancellation. Letting the rejection through would have the command-bar
    // handler in app.js report the same thing a second time in different words.
    return;
  }

  openReviewDialog(outcome);
}

function openReviewDialog(outcome) {
  const report = outcome.report || {};
  // A column id is only unique within its table, so candidates are tracked by table + object.
  const promotions = new Set(
    (report.promotionCandidates || [])
      .filter(candidate => candidate.confidence === 'high')
      .map(promotionKey));

  const changed = report.changed || [];
  const missing = report.missing || [];
  const found = report.found || [];
  const candidates = report.promotionCandidates || [];

  const nothingChanged = !changed.length && !missing.length && !candidates.length;

  openModal({
    title: 'Refresh review',
    subtitle: state.connection.organizationFriendlyName || '',
    width: 760,
    height: nothingChanged ? 'auto' : 560,
    body: () => build(outcome, report, promotions, nothingChanged),
    footer: api => modalFooter(api, {
      primaryLabel: 'Apply',
      cancelLabel: 'Discard refresh',
      onPrimary: () => apply(outcome, promotions, api)
    })
  });
}

function promotionKey(candidate) {
  return (candidate.parentTableId || '') + '|' + candidate.diagramObjectId;
}

function build(outcome, report, promotions, nothingChanged) {
  const container = el('div');

  container.appendChild(el('div', {
    style: { padding: '14px 16px', borderBottom: '1px solid var(--line)' }
  }, [
    el('div', { style: { display: 'flex', gap: '18px', flexWrap: 'wrap' } }, [
      stat((report.found || []).length, 'unchanged'),
      stat((report.changed || []).length, 'changed', '#c98a12'),
      stat((report.missing || []).length, 'not found', '#c0392f'),
      stat((report.promotionCandidates || []).length, 'possible matches', '#1f5fe0')
    ]),
    el('div', { class: 'small muted', style: { marginTop: '8px' } },
      'Your layout, emphasis colours, proposed objects and anything drawn on the canvas - sticky ' +
      'notes, text boxes and arrows - are all preserved. Nothing is applied until you choose Apply.')
  ]));

  if (nothingChanged) {
    container.appendChild(el('div', {
      class: 'empty-note',
      text: 'Everything on the diagram still matches the environment. Applying will just stamp the refresh date.'
    }));
    return container;
  }

  const body = el('div', { style: { overflow: 'auto', maxHeight: '410px' } });

  if ((report.promotionCandidates || []).length) {
    body.appendChild(el('div', { class: 'group-head', text: 'Proposed objects that may now exist' }));
    body.appendChild(el('div', {
      class: 'small muted', style: { padding: '0 14px 8px', lineHeight: '1.5' },
      text: 'Only matches on schema name are pre-ticked. Anything matched on display name alone needs your confirmation, because two tables can easily share one.'
    }));

    for (const candidate of report.promotionCandidates) {
      const ticked = promotions.has(promotionKey(candidate));

      const toggle = () => {
        const key = promotionKey(candidate);
        if (promotions.has(key)) promotions.delete(key);
        else promotions.add(key);
        check.classList.toggle('is-on');
        check.innerHTML = promotions.has(key) ? '&#10003;' : '';
        row.setAttribute('aria-checked', promotions.has(key) ? 'true' : 'false');
      };

      const row = el('div', {
        class: 'row',
        style: { flexDirection: 'column', alignItems: 'flex-start', gap: '3px' },
        // The tick is a styled span, not an input, so the row itself carries the role and the
        // focus stop. High-confidence matches arrive pre-ticked and the copy just above tells the
        // user to untick anything they are not sure of, which has to work by keyboard too.
        role: 'checkbox',
        tabindex: '0',
        'aria-checked': ticked ? 'true' : 'false',
        onClick: toggle,
        onKeyDown: event => {
          if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return;
          event.preventDefault();
          toggle();
        }
      });

      const check = el('span', { class: 'chk' + (ticked ? ' is-on' : ''), html: ticked ? '&#10003;' : '' });

      row.append(
        el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', width: '100%' } }, [
          check,
          // The kind is named, as every other group in this dialog does, so a table can be told apart
          // from a connector's lookup column before ticking it.
          el('span', { class: 'row-meta', text: candidate.objectKind || 'object' }),
          el('span', { class: 'row-name', text: candidate.proposedName + ' → ' + (candidate.matchedDisplayName || candidate.matchedLogicalName) }),
          el('span', {
            class: 'badge ' + (candidate.confidence === 'high' ? 'badge-external' : 'badge-proposed'),
            text: candidate.confidence.toUpperCase()
          })
        ]),
        el('div', { class: 'row-sub', style: { paddingLeft: '22px' }, text: candidate.matchReason })
      );

      body.appendChild(row);
    }
  }

  appendChangeGroup(body, 'Changed', report.changed, '#c98a12');
  appendChangeGroup(body, 'Not found in this environment', report.missing, '#c0392f');

  if ((report.found || []).length) {
    body.appendChild(el('div', { class: 'group-head', text: 'Unchanged · ' + report.found.length }));
    body.appendChild(el('div', {
      class: 'small muted', style: { padding: '0 14px 12px' },
      text: report.found.map(entry => entry.name).join(', ')
    }));
  }

  container.appendChild(body);
  return container;
}

function appendChangeGroup(container, title, entries, colour) {
  if (!entries || !entries.length) return;

  container.appendChild(el('div', { class: 'group-head', text: title + ' · ' + entries.length }));

  for (const entry of entries) {
    container.appendChild(el('div', {
      class: 'row',
      style: { flexDirection: 'column', alignItems: 'flex-start', gap: '2px' }
    }, [
      el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } }, [
        el('span', { class: 'status-mark', style: { background: colour } }),
        el('span', { class: 'row-name', text: entry.name }),
        el('span', { class: 'row-meta', text: entry.objectKind })
      ]),
      el('div', { class: 'row-sub', style: { paddingLeft: '15px', whiteSpace: 'normal' }, text: entry.detail })
    ]));
  }
}

function stat(count, label, colour) {
  return el('div', {}, [
    el('div', { style: { fontSize: '20px', fontWeight: 600, color: colour || 'var(--ink)' }, text: String(count) }),
    el('div', { class: 'small muted', text: label })
  ]);
}

async function apply(outcome, promotions, api) {
  let document = outcome.document;

  const instructions = (outcome.report.promotionCandidates || [])
    .filter(candidate => promotions.has(promotionKey(candidate)))
    .map(candidate => ({
      diagramObjectId: candidate.diagramObjectId,
      // A column id is only unique inside its table, so the host needs the parent as well.
      parentTableId: candidate.parentTableId || null,
      objectKind: candidate.objectKind,
      matchedLogicalName: candidate.matchedLogicalName
    }));

  if (instructions.length) {
    try {
      document = await withProgress('Promoting confirmed objects...',
        () => host.promote(document, instructions));
    } catch (error) {
      // Nothing has been applied yet, so the diagram is exactly as it was and the review dialog is
      // still open behind the message withProgress raised. Leaving it open is the useful outcome:
      // the user can try again without rebuilding their choices.
      return;
    }
  }

  // Positions and view state live in the document the host returned, so nothing is recalculated.
  const path = state.path;
  setDocument(document, path);

  // Through setDirty, not by writing state.dirty. setDirty is the only thing that tells the host,
  // which is what makes XrmToolBox prompt on close - and because it early-returns when the value
  // has not changed, setting the field by hand would also stop every later edit in the session
  // from notifying the host.
  setDirty(true);

  // Every other path that replaces the document does this. A refreshed document can carry the same
  // column count and the same ticks as the one it replaced - a promoted column, a column Dataverse
  // has renamed - so without it the size cache answers from the document just discarded.
  invalidateSizes();

  render();
  renderPanels();
  notify('refresh');

  api.close(null);

  const parts = [];
  if ((outcome.report.changed || []).length) parts.push((outcome.report.changed.length) + ' changed');
  if ((outcome.report.missing || []).length) parts.push((outcome.report.missing.length) + ' not found');
  if (instructions.length) parts.push(instructions.length + ' promoted');

  toast('Refreshed' + (parts.length ? ': ' + parts.join(', ') : ' - no changes') + '.', 'success');
}
