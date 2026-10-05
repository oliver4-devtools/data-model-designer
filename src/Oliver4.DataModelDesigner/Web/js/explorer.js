// Relationship-depth discovery.
//
// The question this answers is "what is Account connected to, and what are those connected to?".
// You pick one table, and depth 1 lists everything one relationship away. Raise the depth and the
// walk goes another hop out from what it found, grouping each hop under its own heading so the
// shape of the neighbourhood stays legible instead of arriving as one long list.
//
// The walk is live: every table in the frontier is one RetrieveEntityRequest, which is why the
// progress overlay names the table it is reading. Metadata is cached for the life of the
// connection, so going from depth 2 to depth 3 only pays for the new outer ring - and coming back
// down to depth 1 costs nothing at all.

import { el, clear, sortBy, matchesSearch, plural, debounce } from './util.js';
import { host } from './bridge.js';
import { state, mutate, setDocument, newDocument, addTablesFromMetadata, addRelationshipsFromMetadata,
         tableByLogicalName } from './state.js';
import { openModal, toast, withProgress, checkbox, select, field } from './ui.js';
import { render } from './render.js';
import { renderPanels } from './panels.js';
import { fitToView } from './interact.js';
import { applyLayout, positionNewTables } from './layout.js';
import { invalidateSizes } from './geometry.js';
import { ensureCatalogue } from './sourcepicker.js';

const DEPTHS = [
  { value: '1', label: '1 hop - directly related tables' },
  { value: '2', label: '2 hops' },
  { value: '3', label: '3 hops' },
  { value: '4', label: '4 hops' },
  { value: '0', label: 'Unrestricted - until nothing new is found' }
];

/**
 * Relationship kinds to traverse. Dataverse reports every 1:N twice, once from each end, so
 * "one to many" and "many to one" are the same physical relationship walked in opposite
 * directions - and that distinction is exactly what makes them useful as separate filters here.
 * Leaving only "many to one" on answers "what does this table look up to?"; leaving only
 * "one to many" on answers "what looks up to this table?".
 */
const KINDS = [
  ['includeManyToOne', 'Lookups on the tables being walked (N:1)'],
  ['includeOneToMany', 'Tables that look up to them (1:N)'],
  ['includeManyToMany', 'Many-to-many (N:N)']
];

const CATEGORIES = [
  ['includeSystemTables', 'Microsoft-supplied tables', 'Contact, Incident, Product and the rest of the standard model.'],
  ['hidePlatformTables', 'Hide platform plumbing', 'Async operations, audit, sync errors, sharing, duplicate detection. Every record relates to these, so they swamp the result.'],
  ['includeActivityTables', 'Activity tables', 'Task, Email, Phone Call and other activity types.'],
  ['includeIntersectTables', 'N:N intersect tables', 'The hidden join tables behind many-to-many relationships.']
];

let lastOptions = null;

export function openExplorer(startLogicalName) {
  if (!state.connection || !state.connection.connected) {
    toast('Exploring relationships reads live metadata, so it needs a Dataverse connection. ' +
      'Use the connection bar at the top of XrmToolBox.', 'warning');
    return;
  }

  const selected = Array.from(state.selection.tables)
    .map(id => state.doc.tables.find(t => t.id === id))
    .filter(t => t && t.logicalName && t.status !== 'Proposed');

  const model = {
    catalogue: [],
    start: startLogicalName || (selected[0] ? selected[0].logicalName : ''),
    filter: '',
    result: null,
    // Which discovered tables the user has ticked. Keyed by logical name so it survives a
    // re-walk at a different depth: raising the depth should not silently undo your choices.
    chosen: new Set(),
    // Hop groups the user has folded away, so a hop that returned eighty tables can be collapsed
    // rather than scrolled past.
    collapsed: new Set(),
    options: Object.assign({
      depth: 1,
      includeOneToMany: true,
      includeManyToOne: true,
      includeManyToMany: true,
      includeSystemTables: true,
      hidePlatformTables: true,
      includeActivityTables: false,
      includeIntersectTables: false,
      maxTables: 150
    }, lastOptions || {})
  };

  const api = openModal({
    title: 'Explore relationships',
    subtitle: 'Start from one table and walk outwards',
    width: 940,
    height: 660,
    body: dialog => build(dialog, model),
    footer: dialog => footer(dialog, model),
    // Reading the catalogue is not cancellable, so the progress overlay shows no Cancel button -
    // but ui.js's Escape handler is document-level and closes the dialog straight through it. Every
    // continuation below therefore has to check that the dialog it is painting into still exists,
    // or the walk runs against detached DOM and setSubtitle rewrites whatever modal opened next.
    onClose: () => { model.closed = true; }
  });

  model.api = api;

  // The catalogue is needed for the start-table picker. It is cached for the life of the
  // connection, so this is usually instant after the first use.
  withProgress('Reading the environment...', ensureCatalogue)
    .then(catalogue => {
      if (model.closed) return;
      model.catalogue = catalogue || [];
      if (!model.start && model.catalogue.length) {
        const account = model.catalogue.find(t => t.logicalName === 'account');
        model.start = account ? account.logicalName : model.catalogue[0].logicalName;
      }
      model.repaint();

      // Walking straight away when the caller named a start table means "explore from here" on a
      // table's context menu produces an answer rather than a form to fill in.
      if (startLogicalName) walk(model);
    })
    .catch(() => {
      if (model.closed) return;
      model.catalogueFailed = true;
      model.repaint();
    });
}

// ------------------------------------------------------------------ body --

/**
 * Two screens, not one.
 *
 * The settings get the whole dialog and Explore is the primary button in the footer, which is
 * pinned and cannot be scrolled away from. The results replace the settings, with one control back.
 */
function build(dialog, model) {
  const root = el('div', {
    style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }
  });

  model.dialog = dialog;
  model.root = root;
  model.step = 'setup';

  model.repaint = () => paintStep(model);
  model.repaintResults = () => { paintResults(model); paintFooter(model); };

  model.repaint();
  return root;
}

function paintStep(model) {
  // Painting a dismissed dialog is at best wasted work on detached DOM, and setSubtitle below
  // reaches into the shared modal root - so a late repaint here would retitle whichever dialog is
  // open by then, and disable its primary button through paintFooter.
  if (model.closed) return;

  const root = clear(model.root);

  if (model.step === 'results') {
    // The results pane is split into a head that is built once per walk and a list that is
    // repainted. The filter box lives in the head, so the input being typed into and its caret
    // survive every keystroke - the same pattern as every other search box in this codebase.
    //
    // Two rows, not one: the way back to the settings gets a row of its own rather than sharing
    // one with a filter box that takes every pixel left over. See paintResultsHead.
    const head = el('div', {
      style: {
        padding: '10px 16px 12px', borderBottom: '1px solid var(--line)',
        display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: '9px',
        flex: '0 0 auto'
      }
    });

    const body = el('div', {
      style: { flex: '1 1 auto', overflow: 'auto', padding: '8px 16px 16px' }
    });

    root.append(head, body);
    model.resultsHead = head;
    model.resultsBody = body;

    paintResultsHead(model);
    paintResults(model);
  } else {
    const panel = el('div', {
      style: { flex: '1 1 auto', overflow: 'auto', padding: '18px 20px', minHeight: 0 }
    });

    root.appendChild(panel);
    model.resultsHead = null;
    model.resultsBody = null;

    paintControls(panel, model);
  }

  if (model.api) {
    model.api.setSubtitle(model.step === 'results'
      ? 'Tick what you want and add it to a diagram'
      : 'Start from one table and walk outwards');
  }

  paintFooter(model);
}

/** The filter box, the bulk-selection buttons and the way back to the settings. */
function paintResultsHead(model) {
  if (!model.resultsHead) return;

  const head = clear(model.resultsHead);
  if (!model.result) return;

  const startEntry = (model.result.tables || []).find(entry => entry.hops === 0);

  // A row of its own, above the filter, with a border and real padding round it, so it reads as a
  // control rather than a caption. It stays in the head, which is flex: 0 0 auto outside the
  // scrolling result list, so it cannot be scrolled away from.
  head.appendChild(el('div', { class: 'results-nav' }, [
    el('button', {
      class: 'text-btn back-btn',
      text: '◀  Change settings',
      title: 'Go back to the start table, depth and filters',
      onClick: () => { model.step = 'setup'; model.repaint(); }
    })
  ]));

  const tools = el('div', { class: 'results-tools' });
  head.appendChild(tools);

  // wizard-search, not a bare input. Nothing else in this file styles it, and `html, body` turns
  // text selection off for the whole app, so without the class it would be near-white text on
  // the browser's own white field in dark mode, and its text could not be selected.
  const filterBox = el('input', {
    type: 'search',
    class: 'wizard-search',
    placeholder: 'Filter these results...',
    value: model.filter,
    style: { flex: '1 1 auto' },
    onInput: debounce(event => {
      model.filter = event.target.value;
      paintResults(model);
      paintFooter(model);
    }, 120)
  });

  tools.appendChild(filterBox);

  // "shown", not "all": both buttons act on visibleEntries, which is filter-scoped, while commit()
  // sends the whole of model.chosen. The labels say so, and the footer below states both scopes,
  // so clearing a filtered list is not mistaken for emptying the whole selection.
  tools.appendChild(el('button', {
    class: 'text-btn', text: 'Select all shown',
    onClick: () => {
      for (const entry of visibleEntries(model)) model.chosen.add(entry.summary.logicalName);
      model.repaintResults();
    }
  }));

  tools.appendChild(el('button', {
    class: 'text-btn', text: 'Clear shown',
    onClick: () => {
      for (const entry of visibleEntries(model)) model.chosen.delete(entry.summary.logicalName);
      // The start table is the one thing that always comes along: a walk out of Account that
      // added everything except Account would make no sense as a diagram.
      if (startEntry) model.chosen.add(startEntry.summary.logicalName);
      model.repaintResults();
    }
  }));
}

function paintControls(container, model) {
  clear(container);

  if (model.catalogueFailed) {
    container.appendChild(el('div', {
      class: 'form-error',
      text: 'The table catalogue could not be read, so there is nothing to start from. ' +
            'Check the connection and reopen this dialog.'
    }));
    return;
  }

  if (!model.catalogue.length) {
    container.appendChild(el('div', { class: 'empty-note', text: 'Reading the environment...' }));
    return;
  }

  container.appendChild(el('div', {
    class: 'small', style: { marginBottom: '16px', lineHeight: '1.55', color: 'var(--ink-3)' }
  }, [
    el('div', { style: { fontWeight: 600, color: 'var(--ink)', marginBottom: '3px' },
      text: 'What is this table connected to?' }),
    'Depth 1 lists everything one relationship away from the table you pick. Raise the depth and ' +
    'the walk goes another hop out from what it found. Every table it expands is one live ' +
    'metadata read, so the filters below are worth setting before you press Explore.'
  ]));

  const columns = el('div', { class: 'explore-columns' });
  const left = el('div', {});
  const right = el('div', {});
  columns.append(left, right);
  container.appendChild(columns);

  const options = sortBy(model.catalogue, t => t.displayName || t.logicalName)
    .map(t => ({
      value: t.logicalName,
      label: (t.displayName || t.logicalName) + '  (' + t.logicalName + ')'
    }));

  left.appendChild(field('Start from', select(options, model.start, value => {
    model.start = value;
    // The previous answer describes a different table, so it is dropped rather than kept behind
    // the settings and shown again for a table it has nothing to do with.
    model.result = null;
    model.chosen.clear();
    paintFooter(model);
  }), null, { required: true }));

  left.appendChild(field('Depth', select(DEPTHS, String(model.options.depth), value => {
    model.options.depth = Number(value);
  }), 'Each hop is one relationship. Raising this walks outwards from what the last one found.'));

  left.appendChild(field('Stop after', select(
    [50, 100, 150, 250, 400].map(n => ({ value: String(n), label: n + ' tables' })),
    String(model.options.maxTables),
    value => { model.options.maxTables = Number(value); }),
    'A safety net. Every table the walk expands is one live metadata call.'));

  left.appendChild(el('div', {
    class: 'small muted',
    style: { marginTop: '14px', lineHeight: '1.5' },
    text: 'Nothing is added to the diagram until you choose to add it, and nothing here changes ' +
          'Dataverse.'
  }));

  right.appendChild(el('div', { class: 'insp-heading', text: 'Follow' }));
  for (const [key, label] of KINDS) {
    right.appendChild(checkbox(label, !!model.options[key], value => {
      model.options[key] = value;
    }));
  }

  right.appendChild(el('div', { class: 'insp-heading', style: { marginTop: '14px' }, text: 'Include' }));
  for (const [key, label, hint] of CATEGORIES) {
    right.appendChild(checkbox(label, !!model.options[key], value => {
      model.options[key] = value;
    }));
    right.appendChild(el('div', {
      class: 'small muted',
      style: { margin: '-4px 0 8px 26px', lineHeight: '1.45' },
      text: hint
    }));
  }
}

// ----------------------------------------------------------------- walk ---

async function walk(model) {
  if (!model.start) {
    toast('Choose a table to start from.', 'warning');
    return;
  }

  if (!model.options.includeOneToMany && !model.options.includeManyToOne && !model.options.includeManyToMany) {
    toast('Choose at least one kind of relationship to follow, or there is nothing to walk.', 'warning');
    return;
  }

  const options = Object.assign({}, model.options, { startTables: [model.start] });

  let result;
  try {
    result = await withProgress('Walking the relationship graph...',
      () => host.exploreGraph(options), { cancellable: true });
  } catch (error) {
    // withProgress has already shown the message. Leaving the previous result behind would imply
    // the new walk succeeded, so it is cleared and the settings stay on screen to be corrected.
    model.result = null;
    model.step = 'setup';
    model.repaint();
    return;
  }

  // Escape can dismiss the dialog while the walk is in flight, and the walk is also kicked off
  // straight from the catalogue continuation above.
  if (model.closed) return;

  lastOptions = Object.assign({}, model.options);
  model.result = result;
  model.collapsed.clear();
  model.filter = '';

  // Everything found is ticked by default: the common case is "show me this neighbourhood", and
  // unticking the handful you do not want is less work than ticking the twenty you do.
  model.chosen = new Set((result.tables || []).map(entry => entry.summary.logicalName));

  model.step = 'results';
  model.repaint();

  if (!result.tables || result.tables.length <= 1) {
    toast('Nothing else is related to that table with these filters. Try turning on activity ' +
      'tables, or the platform plumbing, to widen it.', 'info');
  }
}

// -------------------------------------------------------------- results ---

function paintResults(model) {
  if (!model.resultsBody) return;

  const body = clear(model.resultsBody);
  if (!model.result) return;

  if (model.result.message) {
    body.appendChild(el('div', {
      class: 'notice',
      style: { marginBottom: '10px' },
      text: model.result.message
    }));
  }

  if (model.result.filteredOut > 0) {
    body.appendChild(el('div', {
      class: 'small muted',
      style: { marginBottom: '10px', lineHeight: '1.5' },
      text: model.result.filteredOut + ' ' + plural(model.result.filteredOut, 'table') +
            (model.result.filteredOut === 1 ? ' was' : ' were') +
            ' left out by the Include filters. Choose "Change settings" above to loosen them.'
    }));
  }

  const shown = visibleEntries(model);

  if (!shown.length) {
    body.appendChild(el('div', { class: 'empty-note', text: 'Nothing here matches that filter.' }));
    return;
  }

  const hops = Array.from(new Set(shown.map(entry => entry.hops))).sort((a, b) => a - b);

  for (const hop of hops) {
    const group = shown.filter(entry => entry.hops === hop);
    body.appendChild(hopGroup(model, hop, group));
  }
}

/**
 * What the footer says about the selection.
 *
 * The total is the whole walk, because that is what commit() sends, but the rows on screen are
 * filter-scoped. The filtered count leads and the total follows it as context.
 */
function selectionSummary(model, count) {
  const total = (model.result.tables || []).length;
  if (!model.filter) return count + ' of ' + total + ' tables selected';

  const shown = visibleEntries(model);
  const shownChosen = shown.filter(entry => model.chosen.has(entry.summary.logicalName)).length;

  return shownChosen + ' of ' + shown.length + ' shown selected - ' +
    count + ' of ' + total + ' in total will be added';
}

function visibleEntries(model) {
  const all = (model.result && model.result.tables) || [];
  if (!model.filter) return all;

  return all.filter(entry => matchesSearch(
    [entry.summary.displayName, entry.summary.logicalName, entry.summary.schemaName].join(' '),
    model.filter));
}

function hopGroup(model, hop, entries) {
  const collapsed = model.collapsed.has(hop);
  const chosenHere = entries.filter(entry => model.chosen.has(entry.summary.logicalName)).length;

  const heading = hop === 0
    ? 'Starting table'
    : 'Hop ' + hop + ' · ' + entries.length + ' ' + plural(entries.length, 'table');

  const group = el('div', { style: { marginBottom: '14px' } });

  group.appendChild(el('div', {
    class: 'group-head',
    style: { cursor: 'pointer', userSelect: 'none' },
    onClick: () => {
      if (collapsed) model.collapsed.delete(hop);
      else model.collapsed.add(hop);
      model.repaintResults();
    }
  }, [
    el('span', {}, [
      el('span', { style: { display: 'inline-block', width: '14px' }, text: collapsed ? '▸' : '▾' }),
      heading
    ]),
    el('span', { class: 'row-meta', text: chosenHere + ' selected' })
  ]));

  if (collapsed) return group;

  if (hop > 0) {
    group.appendChild(el('div', {
      class: 'small muted',
      style: { margin: '2px 0 6px 14px' },
      text: hop === 1
        ? 'Directly related to the starting table.'
        : hop + ' relationships away from the starting table.'
    }));
  }

  for (const entry of sortBy(entries, e => -e.degree, e => e.summary.displayName || '')) {
    group.appendChild(entryRow(model, entry));
  }

  return group;
}

function entryRow(model, entry) {
  const summary = entry.summary;
  const name = summary.logicalName;
  const isStart = entry.hops === 0;
  const chosen = model.chosen.has(name);
  const already = !!tableByLogicalName(name);

  const check = el('span', {
    class: 'chk' + (chosen ? ' is-on' : ''),
    html: chosen ? '&#10003;' : ''
  });

  const kinds = [];
  if (summary.isCustom) kinds.push('Custom'); else kinds.push('System');
  if (summary.isActivity) kinds.push('Activity');
  if (summary.isIntersect) kinds.push('Intersect');

  const toggle = () => {
    if (isStart) {
      toast('The starting table always comes along.', 'info');
      return;
    }
    if (chosen) model.chosen.delete(name);
    else model.chosen.add(name);
    model.repaintResults();
  };

  return el('div', {
    class: 'row' + (chosen ? ' is-selected' : ''),
    style: { alignItems: 'flex-start', flexDirection: 'column', gap: '2px' },
    // The tick is a styled span rather than an input, so the row carries the role and the focus
    // stop itself - otherwise the whole result list is mouse-only, and everything in it arrives
    // pre-ticked. The start table is announced as disabled because its tick cannot be removed.
    role: 'checkbox',
    tabindex: isStart ? '-1' : '0',
    'aria-checked': chosen ? 'true' : 'false',
    'aria-disabled': isStart ? 'true' : null,
    onClick: toggle,
    onKeyDown: event => {
      if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return;
      event.preventDefault();
      toggle();
    }
  }, [
    el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', width: '100%' } }, [
      check,
      el('span', { class: 'row-name', text: summary.displayName || name }),
      // The same badge the path finder uses for the same fact, in the same colour.
      already ? el('span', { class: 'badge badge-oncanvas', text: 'ON CANVAS' }) : null,
      el('span', { style: { flex: '1 1 auto' } }),
      el('span', {
        class: 'row-meta',
        title: 'Relationships joining this table to the rest of the result',
        text: entry.degree + ' ' + plural(entry.degree, 'link')
      })
    ]),
    el('div', { class: 'row-sub', style: { paddingLeft: '22px' } }, [
      summary.logicalName + ' · ' + kinds.join(', ') +
      (entry.via && entry.via.length ? ' · joins ' + entry.via.slice(0, 4).join(', ') : '')
    ])
  ]);
}

// --------------------------------------------------------------- footer ---

function footer(dialog, model) {
  // Not called `host`: that name is the bridge import at the top of this module, and this
  // function also needs it.
  const bar = el('div', {
    style: { display: 'flex', width: '100%', alignItems: 'center', gap: '8px' }
  });

  model.footerHost = bar;
  model.dialog = dialog;
  paintFooter(model);
  return bar;
}

function paintFooter(model) {
  const container = model.footerHost;
  if (!container) return;
  clear(container);

  const count = model.chosen.size;
  const hasDiagram = state.doc.tables.length > 0;

  // On the settings screen the footer carries the one button the whole dialog exists for. It is
  // pinned to the bottom of the modal, so it cannot be scrolled out of sight however long the
  // list of filters gets.
  if (model.step !== 'results') {
    const startName = startLabel(model);

    container.appendChild(el('span', {
      class: 'small muted',
      text: startName ? 'Walking out from ' + startName : ''
    }));

    container.appendChild(el('span', { style: { flex: '1 1 auto' } }));

    if (model.result) {
      container.appendChild(el('button', {
        class: 'btn',
        text: 'Back to results',
        onClick: () => { model.step = 'results'; model.repaint(); }
      }));
    }

    container.appendChild(el('button', {
      class: 'btn', text: 'Cancel', onClick: () => model.dialog.close(null)
    }));

    container.appendChild(el('button', {
      class: 'btn primary',
      text: model.result ? 'Walk again' : 'Explore',
      disabled: !model.start,
      onClick: () => walk(model)
    }));

    return;
  }

  container.appendChild(el('span', {
    class: 'small muted',
    text: model.result ? selectionSummary(model, count) : ''
  }));

  container.appendChild(el('span', { style: { flex: '1 1 auto' } }));

  container.appendChild(el('button', {
    class: 'btn', text: 'Cancel', onClick: () => model.dialog.close(null)
  }));

  if (hasDiagram) {
    container.appendChild(el('button', {
      class: 'btn',
      text: 'Add to this diagram',
      disabled: !count,
      onClick: () => commit(model, 'add')
    }));
  }

  container.appendChild(el('button', {
    class: 'btn primary',
    text: hasDiagram ? 'New diagram from these' : 'Create diagram',
    disabled: !count,
    onClick: () => commit(model, 'new')
  }));
}

/** The chosen start table in words, for the settings footer. */
function startLabel(model) {
  if (!model.start) return '';

  const entry = (model.catalogue || []).find(t => t.logicalName === model.start);
  return entry ? (entry.displayName || entry.logicalName) : model.start;
}

// --------------------------------------------------------------- commit ---

async function commit(model, mode) {
  const names = Array.from(model.chosen);
  if (!names.length) return;

  if (mode === 'new' && state.dirty) {
    const proceed = await host.confirm(
      'Unsaved changes', 'This diagram has unsaved changes. Discard them?');
    if (!proceed) return;
  }

  // The relationship set is derived from the final table set rather than reused from the walk.
  // The walk stops expanding at the outermost hop, so two tables that both sit on the edge of the
  // result can be related without the walk having seen it. Asking for every relationship inside
  // the committed set closes that gap - and in "add" mode it is also what finds the relationships
  // between the new tables and the ones already on the canvas.
  const scope = mode === 'add'
    ? Array.from(new Set(names.concat(
        state.doc.tables.filter(t => t.logicalName && t.status !== 'Proposed').map(t => t.logicalName))))
    : names;

  let loaded;
  let relationships;

  try {
    loaded = await withProgress('Loading table metadata...',
      () => host.loadTables(names), { cancellable: true });
    relationships = await withProgress('Finding relationships between them...',
      () => host.discoverRelationships(scope), { cancellable: true });
  } catch (error) {
    return;
  }

  const tables = (loaded && loaded.tables) || [];
  const unreadable = (loaded && loaded.unreadable) || [];

  if (!tables.length) {
    toast('None of the selected tables could be read. The connection may have dropped - ' +
      'reconnect in XrmToolBox and try again.', 'error', { sticky: true });
    return;
  }

  // Captured before the document is replaced. Reading it afterwards would read the *new*
  // document's freshly defaulted settings, so a user who had turned automatic positioning off
  // would silently get it back on every diagram the explorer created.
  const autoPosition = state.doc.settings.autoLayoutOnAdd !== false;
  const layoutMode = state.doc.settings.layoutMode;

  if (mode === 'new') {
    const created = newDocument((startName(model) || 'Data model') + ' neighbourhood');

    created.source = {
      environmentUrl: state.connection.environmentUrl,
      organizationFriendlyName: state.connection.organizationFriendlyName,
      organizationId: state.connection.organizationId,
      organizationVersion: state.connection.organizationVersion,
      lastRefreshUtc: new Date().toISOString()
    };

    setDocument(created, null);
  }

  mutate(mode === 'new' ? 'create diagram from exploration' : 'add explored tables', () => {
    const added = addTablesFromMetadata(tables);
    addRelationshipsFromMetadata(relationships, { included: true });

    if (mode === 'new' && autoPosition) {
      // A brand new diagram is always laid out, even when the saved layout mode is Manual -
      // "never move anything" is about not disturbing positions the user has set, and a diagram
      // created a moment ago has none.
      applyLayout(!layoutMode || layoutMode === 'Manual' ? 'Auto' : layoutMode);
    } else {
      // Either adding to an existing diagram, or automatic positioning is off. New cards go clear
      // of everything already placed and are left for the user to arrange - which is manual
      // placement, as opposed to a pile of cards stacked on the origin.
      positionNewTables(added);
    }
  });

  invalidateSizes();
  render();
  renderPanels();
  fitToView();

  if (model.dialog) model.dialog.close(null);

  const parts = [
    (mode === 'new' ? 'Created a diagram with ' : 'Added ') + tables.length + ' ' +
    plural(tables.length, 'table') + ' and ' + relationships.length + ' ' +
    plural(relationships.length, 'relationship') + '.'
  ];

  if (unreadable.length) {
    parts.push(unreadable.length + ' could not be read: ' + unreadable.join(', ') + '.');
  }

  toast(parts.join(' '), unreadable.length ? 'warning' : 'success',
    unreadable.length ? { timeout: 12000 } : undefined);
}

function startName(model) {
  const entry = (model.result && (model.result.tables || []).find(t => t.hops === 0));
  return entry ? (entry.summary.displayName || entry.summary.logicalName) : model.start;
}
