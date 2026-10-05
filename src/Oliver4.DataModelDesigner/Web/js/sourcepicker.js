// "New diagram" and "Add tables", as a guided sequence.
//
// The dialog asks one question at a time. Step one is only ever "where should this come from";
// everything else - which solution, which tables, which relationships - appears once that is answered.

import { el, clear, matchesSearch, sortBy, plural, debounce, productName } from './util.js';
import { host } from './bridge.js';
import {
  state, mutate, newDocument, setDocument, addTablesFromMetadata, addRelationshipsFromMetadata
} from './state.js';
import { openModal, toast, withProgress } from './ui.js';
import { currentTheme } from './theme.js';
import { render } from './render.js';
import { applyLayout, positionNewTables } from './layout.js';
import { resetView } from './interact.js';
import { renderPanels } from './panels.js';

// How many rows each long list actually renders. Named because "select all shown" and the
// "showing the first N" notice both have to agree with the render loop.
const ROW_LIMIT = 1200;
const SOLUTION_LIMIT = 400;

// Ticking the whole list for you is right for a solution with thirty tables in it and wrong for an
// environment with three thousand, so the table chooser only does it below this many. The value
// sits well under ROW_LIMIT on purpose: every table it ticks is therefore a row that is actually
// rendered, so the auto-tick and "Select all shown" can never come to mean two different sets.
const AUTO_TICK_LIMIT = 200;

// Past this many ticked tables, "Next: relationships" asks whether that is really the intention.
// The next step reads live metadata for every ticked table, one request each, so clicking straight
// through a list that was ticked for you is slow as well as unreadable once it is drawn.
const CONFIRM_SELECTION_LIMIT = 20;

const STEPS = {
  start: { index: 0, name: 'Starting point' },
  solution: { index: 1, name: 'Solution' },
  tables: { index: 2, name: 'Tables' },
  relationships: { index: 3, name: 'Relationships' }
};

let catalogue = null;
let solutions = null;
let activeWizard = null;

export async function ensureCatalogue() {
  if (catalogue) return catalogue;
  catalogue = await host.listTables(null);

  // Also parked on state so the left panel can offer environment-wide search results without
  // importing this module. This module already imports panels.js; a static import back would close
  // the loop, and a cycle is how a binding ends up undefined at load rather than at first click.
  state.catalogue = catalogue;
  return catalogue;
}

async function ensureSolutions() {
  if (solutions) return solutions;
  solutions = await host.listSolutions();
  return solutions;
}

export function invalidateCatalogue() {
  catalogue = null;
  solutions = null;
  state.catalogue = null;
}

/**
 * Repaints an open wizard. The tool usually opens before the user has connected, so the dialog
 * has to notice when a connection arrives rather than sit there with everything greyed out.
 */
export function refreshSourcePicker() {
  if (activeWizard && activeWizard.step === 'start') activeWizard.repaint();
}

export function openSourcePicker(options) {
  const opts = options || {};
  const mode = opts.mode || 'new';

  const model = {
    mode,
    step: 'start',
    source: null,
    solutionId: null,
    solutionName: null,
    filter: '',
    typeFilter: 'all',
    selected: new Set(),
    // Whether the table chooser has already offered its default ticks for the current list. Kept
    // apart from selected.size so that clearing every tick, stepping forward and stepping back
    // does not read as "nothing chosen yet" and silently re-tick the lot.
    selectionSeeded: false,
    tables: [],
    relationships: [],
    alreadyOnDiagram: 0,
    includedRelationships: new Set(),
    relationshipFilter: 'all',
    autoLayout: state.doc.settings.autoLayoutOnAdd !== false
  };

  let bodyHost = null;
  let footHost = null;
  let api = null;

  // No subtitle: the step name is already the current pill in the progress bar directly below.
  api = openModal({
    title: mode === 'add' ? 'Add tables to this diagram' : 'New diagram',
    width: 900,
    height: 620,
    body: () => {
      bodyHost = el('div', { class: 'wizard' });
      return bodyHost;
    },
    footer: () => {
      footHost = el('div', { style: { display: 'flex', width: '100%', alignItems: 'center', gap: '8px' } });
      return footHost;
    },
    onClose: () => { activeWizard = null; }
  });

  model.goTo = step => { model.step = step; paint(); };
  model.repaint = () => paint();
  model.refreshFooter = () => paintFooter();

  activeWizard = model;
  paint();

  return api;

  // ---------------------------------------------------------------- paint --

  function paint() {
    if (!bodyHost || bodyHost.isConnected === false) return;

    clear(bodyHost);
    bodyHost.appendChild(brandHead());
    bodyHost.appendChild(stepBar(model));

    const panel = el('div', { class: 'wizard-panel' });
    bodyHost.appendChild(panel);

    if (model.step === 'start') renderStart(panel, model, api);
    else if (model.step === 'solution') renderSolutions(panel, model);
    else if (model.step === 'tables') renderTableChooser(panel, model);
    else renderRelationshipChooser(panel, model);

    paintFooter();
  }

  function paintFooter() {
    if (!footHost) return;
    clear(footHost);

    if (model.step === 'start') {
      footHost.appendChild(el('div', { class: 'small muted' }, connectionNote()));
      footHost.appendChild(el('span', { style: { flex: '1 1 auto' } }));
      // Cancelling leaves whatever is already on the canvas alone. The dialog opens on every
      // start, so dismissing it has to be a no-op rather than a destructive "start blank".
      footHost.appendChild(el('button', {
        class: 'btn', text: 'Cancel',
        onClick: () => api.close(null)
      }));
      return;
    }

    footHost.appendChild(el('button', { class: 'btn', text: 'Back', onClick: () => back() }));

    if (model.step === 'relationships') {
      footHost.appendChild(autoLayoutToggle(model));
    }

    footHost.appendChild(el('span', { style: { flex: '1 1 auto' } }));
    footHost.appendChild(el('button', { class: 'btn', text: 'Cancel', onClick: () => api.close(null) }));

    if (model.step === 'tables') {
      footHost.appendChild(el('button', {
        class: 'btn primary',
        text: 'Next: relationships',
        disabled: model.selected.size === 0,
        onClick: () => goToRelationships(model)
      }));
    }

    if (model.step === 'relationships') {
      footHost.appendChild(el('button', {
        class: 'btn primary',
        text: model.mode === 'add' ? 'Add to diagram' : 'Create diagram',
        disabled: model.selected.size === 0,
        onClick: async () => {
          // Closes first, because the point of the button is to get to the canvas.
          api.close(null);
          await commit(model);
        }
      }));
    }
  }

  function back() {
    if (model.step === 'relationships') { model.step = 'tables'; paint(); return; }
    if (model.step === 'tables') { model.step = model.source === 'solution' ? 'solution' : 'start'; paint(); return; }
    model.step = 'start';
    paint();
  }

  async function goToRelationships(target) {
    if (!target.selected.size) return;
    if (!(await confirmLargeSelection(target.selected.size))) return;

    try {
      // The scope is the tables being added *plus* everything already on the canvas, so relationships
      // between a new table and an existing one are found. Metadata for the tables already on the
      // canvas is cached from when they were added, so widening the scope costs nothing.
      const adding = Array.from(target.selected);
      const onCanvas = state.doc.tables
        .filter(t => t.logicalName && t.status !== 'Proposed')
        .map(t => t.logicalName);

      const scope = Array.from(new Set(adding.concat(onCanvas)));

      const found = await withProgress(
        onCanvas.length
          ? 'Finding relationships to the tables already on the canvas...'
          : 'Finding relationships between the selected tables...',
        () => host.discoverRelationships(scope), { cancellable: true });

      // Relationships already in the document are not re-offered: unticking one here would silently
      // exclude a connector the user is already looking at.
      const known = new Set(state.doc.relationships
        .map(r => (r.schemaName || '').toLowerCase())
        .filter(Boolean));

      target.relationships = found.filter(r =>
        !known.has((r.schemaName || '').toLowerCase()));

      target.alreadyOnDiagram = found.length - target.relationships.length;
      target.includedRelationships = new Set(target.relationships.map(r => r.schemaName));
      target.relationshipsLoaded = true;
    } catch (error) {
      return;
    }

    target.step = 'relationships';
    paint();
  }
}

function connectionNote() {
  return state.connection && state.connection.connected
    ? 'Connected to ' + (state.connection.organizationFriendlyName || state.connection.host || 'Dataverse')
    : 'Not connected. Use the XrmToolBox connection bar to pick an environment.';
}

/**
 * The "did you mean that many?" gate in front of the relationships step. Resolves true when the
 * selection should go ahead, which includes every selection small enough not to be asked about.
 *
 * host.confirm, not ui.js openModal: openModal opens by calling dismissActiveModal, so a second
 * dialog does not stack on the wizard, it replaces it - the wizard's onClose would run, its DOM
 * would be cleared out of the shared modal root and the whole selection would go with it.
 * host.confirm sits over the wizard, as the unsaved-changes and different-environment gates do.
 */
async function confirmLargeSelection(count) {
  if (count <= CONFIRM_SELECTION_LIMIT) return true;

  return host.confirm(
    'That is a lot of tables',
    'You have ' + count + ' tables ticked.\n\n' +
    'Each one is read from Dataverse on its own, and a diagram that size is hard to read once it ' +
    'is drawn.\n\n' +
    'Add all ' + count + '? Choose No to go back to the list and change the selection.');
}

// ---------------------------------------------------------------- brand --

/**
 * The product lockup at the top of the wizard - the same logo, eyebrow and tool name the About box
 * and the feature guide build, from the same artwork and the same theme. The tool opens straight
 * into this dialog, so it is the first thing anyone sees of the product.
 *
 * Built here rather than imported: app.js and dialogs.js both import this module, so reaching back
 * into either for their helper would close the loop, and a cycle is how a binding ends up undefined
 * at load rather than at first click. The tool name is written out for the same reason - app.info
 * is held in app.js and never parked on state - which is safe because PluginInfo.ToolName is a
 * constant on the C# side.
 *
 * Above the progress bar, so it is the first thing on the first step, and sized down by app.css
 * through `.wizard > .guide-head`: the About box grows to fit its content while this dialog is a
 * fixed height whatever step it is on, so the full 88px lockup would come straight off the table
 * list two steps later.
 */
function brandHead() {
  return el('div', { class: 'guide-head' }, [
    el('img', {
      class: 'guide-logo',
      src: currentTheme() === 'dark' ? 'img/logo-dark-256.png' : 'img/logo-256.png',
      alt: 'Oliver4'
    }),
    el('div', {}, [
      el('div', { class: 'brand-eyebrow', text: 'OLIVER4' }),
      productName()
    ])
  ]);
}

// ------------------------------------------------------------- step bar --

function stepBar(model) {
  const sequence = model.source === 'solution'
    ? ['start', 'solution', 'tables', 'relationships']
    : ['start', 'tables', 'relationships'];

  const current = STEPS[model.step].index;

  return el('div', { class: 'wizard-steps' }, sequence.map((key, position) => {
    const step = STEPS[key];
    const stateClass = step.index === current ? ' is-current' : step.index < current ? ' is-done' : '';

    return el('div', { class: 'wizard-step' + stateClass }, [
      el('span', { class: 'wizard-step-number', text: String(position + 1) }),
      el('span', { text: step.name })
    ]);
  }));
}

// ---------------------------------------------------------------- start --

function renderStart(container, model, api) {
  const connected = !!(state.connection && state.connection.connected);

  container.appendChild(el('div', { class: 'wizard-lead' }, [
    el('h2', { text: model.mode === 'add' ? 'Where should the extra tables come from?' : 'What should this diagram be built from?' }),
    el('p', { text: 'Pick a starting point. The next step asks only for what that choice needs.' })
  ]));

  const grid = el('div', { class: 'start-grid' });

  grid.appendChild(startCard(
    'A solution',
    'Pick a solution, then choose which of its tables to draw.',
    'Best when the diagram should describe one deliverable.',
    !connected,
    async () => {
      model.source = 'solution';
      model.selected.clear();
      // A different starting point means a different list of tables, so the default ticks are owed
      // again. Every place that empties the selection has to say so, or the chooser decides the
      // user has already chosen and offers nothing.
      model.selectionSeeded = false;
      try {
        await withProgress('Reading solutions...', ensureSolutions);
      } catch (error) { return; }
      model.goTo('solution');
    }));

  grid.appendChild(startCard(
    'Selected tables',
    'Search the whole environment and tick the tables you want.',
    'Best when the diagram spans solutions, or you already know the names.',
    !connected,
    async () => {
      model.source = 'catalogue';
      model.solutionId = null;
      model.solutionName = null;
      model.selected.clear();
      model.selectionSeeded = false;
      try {
        model.tables = await withProgress('Reading the environment catalogue...', ensureCatalogue);
      } catch (error) { return; }
      model.goTo('tables');
    }));

  if (model.mode !== 'add') {
    grid.appendChild(startCard(
      'Blank canvas',
      'Start with nothing and design proposed tables first.',
      'Best for future-state design before anything exists.',
      false,
      () => { api.close(null); startBlank(); }));

    grid.appendChild(startCard(
      'Open a saved diagram',
      'Reopen a .dvmd file and refresh it against Dataverse.',
      'Best for picking up work you or a colleague saved earlier.',
      false,
      () => { api.close(null); window.dispatchEvent(new CustomEvent('dmd:open-diagram')); }));
  }

  container.appendChild(grid);

  if (!connected) {
    container.appendChild(el('div', {
      class: 'wizard-warning',
      text: 'The first two options need a Dataverse connection. Connect using the XrmToolBox connection bar and this dialog will pick it up.'
    }));
  }

  const recent = model.mode === 'add' ? [] : ((state.settings && state.settings.recentFiles) || []).slice(0, 4);
  if (recent.length) {
    container.appendChild(el('div', { class: 'wizard-recent' }, [
      el('div', { class: 'insp-heading', text: 'Recent diagrams' }),
      ...recent.map(path => el('button', {
        class: 'text-btn',
        style: { display: 'block', textAlign: 'left', width: '100%', padding: '3px 0' },
        text: shortPath(path),
        onClick: () => {
          api.close(null);
          window.dispatchEvent(new CustomEvent('dmd:open-diagram', { detail: { path, fromRecent: true } }));
        }
      }))
    ]));
  }
}

function startCard(title, sub, why, disabled, onClick) {
  return el('button', { class: 'start-card', disabled, onClick }, [
    el('div', { class: 'start-card-title', text: title }),
    el('div', { class: 'start-card-sub', text: sub }),
    el('div', { class: 'start-card-why', text: why })
  ]);
}

function shortPath(path) {
  const parts = String(path).split(/[\\/]/);
  return parts.length <= 2 ? path : parts.slice(-2).join('\\');
}

// ------------------------------------------------------------ solutions --

function renderSolutions(container, model) {
  container.appendChild(el('div', { class: 'wizard-lead' }, [
    el('h2', { text: 'Which solution?' }),
    el('p', { text: 'Its tables become the list you choose from in the next step.' })
  ]));

  const search = el('input', {
    type: 'search', placeholder: 'Filter by name, unique name or publisher...',
    class: 'wizard-search',
    onInput: event => paint(event.target.value)
  });

  const list = el('div', { class: 'wizard-list' });
  container.append(search, list);
  paint('');

  function paint(filter) {
    clear(list);

    const matching = (solutions || []).filter(solution =>
      matchesSearch(
        solution.friendlyName + ' ' + solution.uniqueName + ' ' + (solution.publisher || ''),
        filter));

    if (!matching.length) {
      list.appendChild(el('div', { class: 'empty-note', text: 'No solutions match.' }));
      return;
    }

    const sorted = sortBy(matching, s => s.friendlyName || s.uniqueName || '');

    for (const solution of sorted.slice(0, SOLUTION_LIMIT)) {
      const choose = async () => {
        model.solutionId = solution.id;
        model.solutionName = solution.friendlyName || solution.uniqueName;
        model.selected.clear();
        model.selectionSeeded = false;
        model.filter = '';

        try {
          model.tables = await withProgress('Reading the tables in ' + model.solutionName + '...',
            () => host.listTables(solution.id));
        } catch (error) { return; }

        model.goTo('tables');
      };

      list.appendChild(el('div', {
        class: 'row' + (model.solutionId === solution.id ? ' is-selected' : ''),
        style: { flexDirection: 'column', alignItems: 'flex-start', gap: '1px' },
        // A div is not focusable and reports no selected state, so the row carries its own role, tab
        // stop and keys. Enter and Space share the click path rather than duplicating it.
        role: 'option',
        tabindex: '0',
        'aria-selected': model.solutionId === solution.id ? 'true' : 'false',
        onClick: choose,
        onKeyDown: event => {
          if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return;
          event.preventDefault();
          choose();
        }
      }, [
        el('div', { class: 'row-name', text: solution.friendlyName || solution.uniqueName }),
        el('div', { class: 'row-sub' },
          (solution.version || '') + (solution.isManaged ? ' · managed' : '') +
          (solution.publisher ? ' · ' + solution.publisher : ''))
      ]));
    }

    // Same notice the table chooser renders, so a list cut at ROW_LIMIT says it has been truncated.
    if (sorted.length > SOLUTION_LIMIT) {
      list.appendChild(el('div', {
        class: 'empty-note',
        text: 'Showing the first ' + SOLUTION_LIMIT + ' of ' + sorted.length +
          ' solutions. Filter by name, unique name or publisher to see the rest.'
      }));
    }
  }
}

// --------------------------------------------------------------- tables --

/**
 * The default ticks, offered once per list of tables.
 *
 * A short list is ticked outright: picking a solution and then ticking its fourteen tables one by
 * one is work the dialog can do, and the step after this one is where the real choices are. A long
 * list is left alone - ticking a whole environment is never what was meant, and the step after
 * this one reads metadata for every ticked table one request at a time.
 *
 * Two guards, and they are not the same guard. selectionSeeded says the offer has already been
 * made for this list, so going forward to the relationships step and back again cannot re-tick
 * what the user has just cleared. The size check says the user has already chosen something, so a
 * selection carried in from anywhere else is left as it is.
 */
function seedTableSelection(model, available) {
  if (model.selectionSeeded) return;
  model.selectionSeeded = true;

  if (model.selected.size) return;
  if (!available.length || available.length >= AUTO_TICK_LIMIT) return;

  // Below AUTO_TICK_LIMIT every available table is also a rendered row, so this ticks exactly the
  // set "Select all shown" would tick from an empty filter. See the comment on the constant.
  for (const table of available) {
    if (table.logicalName) model.selected.add(table.logicalName);
  }
}

function renderTableChooser(container, model) {
  const available = model.tables || [];

  seedTableSelection(model, available);

  // Whether the list was short enough to tick for you. Stated as the rule rather than as a count of
  // what is ticked right now, because the count in the actions row below tracks that.
  const tooManyToTick = available.length >= AUTO_TICK_LIMIT;

  container.appendChild(el('div', { class: 'wizard-lead' }, [
    el('h2', { text: model.source === 'solution'
      ? 'Which tables from ' + (model.solutionName || 'this solution') + '?'
      : 'Which tables?' }),
    el('p', { text: available.length + ' ' + plural(available.length, 'table') + ' available. ' +
      (available.length && !tooManyToTick
        ? 'Everything is ticked by default; untick anything that would clutter the picture.'
        : 'Tick the ones the diagram should show.') }),
    tooManyToTick
      ? el('p', { text: 'That is too many to tick for you, so nothing is ticked to start with. ' +
          'Narrow the list with the filter below, then use "Select all shown".' })
      : null
  ]));

  const controls = el('div', { class: 'wizard-controls' }, [
    el('input', {
      type: 'search',
      placeholder: 'Filter by display or schema name...',
      value: model.filter,
      class: 'wizard-search',
      style: { flex: '1 1 auto', margin: 0 },
      // Debounced at the same 120ms explorer.js uses. Every keystroke re-filters the whole
      // catalogue and rebuilds up to ROW_LIMIT rows synchronously, which lags behind typing on a
      // large environment.
      onInput: debounce(event => { model.filter = event.target.value; paint(); }, 120)
    }),
    el('div', { class: 'segmented' }, ['all', 'custom', 'system'].map(kind => el('button', {
      class: 'seg' + (model.typeFilter === kind ? ' is-active' : ''),
      text: kind === 'all' ? 'All' : kind === 'custom' ? 'Custom' : 'System',
      onClick: () => { model.typeFilter = kind; paint(); }
    })))
  ]);

  const actions = el('div', { class: 'wizard-actions' });
  const listWrap = el('div', { class: 'wizard-list grow' });

  // Sorted once, not per paint: the sort key is the display name, which cannot change while the
  // dialog is open, and filtering preserves order. Declared before the first paint() below, which
  // reads it.
  const sortedAvailable = sortBy(available, t => t.displayName || t.logicalName || '');

  container.append(controls, actions, listWrap);
  paint();

  function filtered() {
    return sortedAvailable.filter(table => {
      if (model.typeFilter === 'custom' && !table.isCustom) return false;
      if (model.typeFilter === 'system' && table.isCustom) return false;
      return matchesSearch(
        (table.displayName || '') + ' ' + (table.logicalName || '') + ' ' + (table.schemaName || ''),
        model.filter);
    });
  }

  function paint() {
    const rows = filtered();
    // Ticks only the rendered slice. The "showing the first N" notice sits below ROW_LIMIT rows
    // inside a scrolling list, so it is never on screen when this button is pressed, and the button
    // must not tick rows nobody can see.
    const shown = rows.slice(0, ROW_LIMIT);

    clear(actions);
    actions.append(
      el('button', {
        class: 'text-btn', text: 'Select all shown',
        onClick: () => { shown.forEach(t => model.selected.add(t.logicalName)); refresh(); }
      }),
      el('button', {
        class: 'text-btn', text: 'Clear',
        onClick: () => { model.selected.clear(); refresh(); }
      }),
      el('span', { style: { flex: '1 1 auto' } }),
      el('span', { class: 'small muted', text: model.selected.size + ' selected' })
    );

    clear(listWrap);

    // The empty case is tested before the filter case. Picking a solution resets model.filter to
    // '', so a solution that simply contains no tables must not be reported as "no tables match the
    // current filter" beside an empty filter box.
    if (!available.length) {
      listWrap.appendChild(el('div', {
        class: 'empty-note',
        text: model.source === 'solution'
          ? (model.solutionName || 'That solution') + ' contains no tables. Use Back to pick a ' +
            'different solution, or start from the whole environment instead.'
          : 'There are no tables to choose from in this environment.'
      }));
      return;
    }

    if (!rows.length) {
      listWrap.appendChild(el('div', {
        class: 'empty-note',
        text: model.filter
          ? 'No tables match the current filter.'
          : 'No ' + (model.typeFilter === 'custom' ? 'custom' : 'system') + ' tables here. ' +
            'Switch the filter above to All.'
      }));
      return;
    }

    const table = el('table', { class: 'grid-table' });
    table.appendChild(el('thead', {}, [
      el('tr', {}, [
        el('th', { style: { width: '28px' } }),
        el('th', { text: 'Display name' }),
        el('th', { text: 'Schema name' }),
        el('th', { text: 'Type' }),
        el('th', { text: 'On canvas' })
      ])
    ]));

    const body = el('tbody');

    // One lowercased Set per paint instead of a linear scan of the canvas per row, so the cost
    // grows with the query rather than with the diagram.
    const onCanvasNames = new Set(state.doc.tables
      .map(t => (t.logicalName || '').toLowerCase())
      .filter(Boolean));

    for (const row of shown) {
      const isSelected = model.selected.has(row.logicalName);
      const alreadyOnCanvas = onCanvasNames.has((row.logicalName || '').toLowerCase());

      const toggle = () => {
        if (isSelected) model.selected.delete(row.logicalName);
        else model.selected.add(row.logicalName);
        refresh();
      };

      body.appendChild(el('tr', {
        class: isSelected ? 'is-selected' : '',
        // A tr is not focusable and has no implicit role a screen reader can report as ticked, so
        // the row needs all of this by hand to be reachable without a mouse. Enter and Space share
        // the click path rather than duplicating it.
        role: 'checkbox',
        tabindex: '0',
        'aria-checked': isSelected ? 'true' : 'false',
        onClick: toggle,
        onKeyDown: event => {
          if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return;
          event.preventDefault();
          toggle();
        }
      }, [
        el('td', { class: 'tight' }, [
          el('span', { class: 'chk' + (isSelected ? ' is-on' : ''), html: isSelected ? '&#10003;' : '' })
        ]),
        el('td', { text: row.displayName || row.logicalName }),
        el('td', { class: 'mono', text: row.logicalName }),
        el('td', { class: 'tight' }, [
          el('span', { class: 'small muted' },
            (row.isCustom ? 'Custom' : 'System') +
            (row.isActivity ? ' · activity' : '') +
            (row.isIntersect ? ' · intersect' : ''))
        ]),
        el('td', { class: 'tight small muted', text: alreadyOnCanvas ? 'yes' : '' })
      ]));
    }

    table.appendChild(body);
    listWrap.appendChild(table);

    if (rows.length > ROW_LIMIT) {
      listWrap.appendChild(el('div', {
        class: 'empty-note',
        text: 'Showing the first ' + ROW_LIMIT + ' of ' + rows.length + ' matches - "Select all ' +
          'shown" ticks these ' + ROW_LIMIT + '. Narrow the filter to see the rest.'
      }));
    }
  }

  // Only the list and the footer change when a row is ticked. Repainting the whole step would
  // throw away the filter box's focus and the scroll position on every click.
  function refresh() {
    paint();
    model.refreshFooter();
  }
}

// -------------------------------------------------------- relationships --

function renderRelationshipChooser(container, model) {
  container.appendChild(el('div', { class: 'wizard-lead' }, [
    el('h2', { text: 'Which relationships should be drawn?' }),
    el('p', { text: model.relationships.length
      ? model.relationships.length + ' new ' + plural(model.relationships.length, 'relationship') +
        (model.mode === 'add'
          ? ' join the tables you are adding, either to each other or to what is already on the canvas.'
          : ' exist between the ' + model.selected.size + ' selected ' + plural(model.selected.size, 'table') + '.') +
        ' Everything is ticked by default; untick anything that would clutter the picture.'
      : (model.mode === 'add'
          ? 'Nothing new to draw - the tables you are adding have no relationships to each other or to the canvas that are not already on the diagram.'
          : 'No relationships exist between the selected tables. You can still create the diagram and draw proposed relationships yourself.') })
  ]));

  if (model.alreadyOnDiagram > 0) {
    container.appendChild(el('div', {
      class: 'small muted', style: { padding: '0 2px 8px' },
      text: model.alreadyOnDiagram + ' further ' + plural(model.alreadyOnDiagram, 'relationship') +
            ' between these tables ' + (model.alreadyOnDiagram === 1 ? 'is' : 'are') +
            ' already on the diagram and ' + (model.alreadyOnDiagram === 1 ? 'is' : 'are') +
            ' left as ' + (model.alreadyOnDiagram === 1 ? 'it is' : 'they are') + '.'
    }));
  }

  if (!model.relationships.length) return;

  const bar = el('div', { class: 'wizard-controls' });
  const list = el('div', { class: 'wizard-list grow' });

  container.append(bar, list);

  container.appendChild(el('div', {
    class: 'small muted', style: { padding: '8px 2px 0' },
    text: 'Anything left out is still recorded in the diagram file, so it can be switched back on later from the Relationships tab.'
  }));

  paint();

  function paint() {
    clear(bar);
    clear(list);

    bar.append(
      el('div', { class: 'filter-chips', style: { padding: 0 } }, ['all', 'OneToMany', 'ManyToMany'].map(kind =>
        el('button', {
          class: 'chip' + (model.relationshipFilter === kind ? ' is-on' : ''),
          text: kind === 'all' ? 'All' : kind === 'OneToMany' ? '1:N' : 'N:N',
          onClick: () => { model.relationshipFilter = kind; paint(); }
        })
      )),
      el('span', { style: { flex: '1 1 auto' } }),
      el('button', {
        class: 'text-btn', text: 'Include all',
        onClick: () => {
          model.relationships.forEach(r => model.includedRelationships.add(r.schemaName));
          paint();
        }
      }),
      el('button', {
        class: 'text-btn', text: 'Include none',
        onClick: () => { model.includedRelationships.clear(); paint(); }
      }),
      el('span', { class: 'small muted', text: model.includedRelationships.size + ' included' })
    );

    const shown = model.relationships.filter(relationship =>
      model.relationshipFilter === 'all' ||
      relationship.kind === model.relationshipFilter ||
      (model.relationshipFilter === 'OneToMany' && relationship.kind === 'ManyToOne'));

    if (!shown.length) {
      list.appendChild(el('div', { class: 'empty-note', text: 'No relationships of this type.' }));
      return;
    }

    for (const relationship of shown) {
      const included = model.includedRelationships.has(relationship.schemaName);

      const toggle = () => {
        if (included) model.includedRelationships.delete(relationship.schemaName);
        else model.includedRelationships.add(relationship.schemaName);
        paint();
      };

      list.appendChild(el('div', {
        class: 'row',
        style: { flexDirection: 'column', alignItems: 'flex-start', gap: '2px' },
        // The tick is a styled span, not an input, so without this the row is invisible to the
        // keyboard and reports no checked state. Enter and Space share the click path.
        role: 'checkbox',
        tabindex: '0',
        'aria-checked': included ? 'true' : 'false',
        onClick: toggle,
        onKeyDown: event => {
          if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return;
          event.preventDefault();
          toggle();
        }
      }, [
        el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', width: '100%' } }, [
          el('span', { class: 'chk' + (included ? ' is-on' : ''), html: included ? '&#10003;' : '' }),
          el('span', { class: 'row-name', text: relationship.referencedEntity + ' → ' + relationship.referencingEntity }),
          el('span', { class: 'row-meta', text: relationship.kind === 'ManyToMany' ? 'N:N' : '1:N' })
        ]),
        el('div', { class: 'row-sub', style: { paddingLeft: '22px' } },
          relationship.schemaName +
          (relationship.referencingAttribute ? ' · ' + relationship.referencingAttribute : '') +
          (relationship.intersectEntity ? ' · via ' + relationship.intersectEntity : ''))
      ]));
    }
  }
}

function autoLayoutToggle(model) {
  const box = el('span', {
    class: 'chk' + (model.autoLayout ? ' is-on' : ''),
    html: model.autoLayout ? '&#10003;' : ''
  });

  return el('span', {
    class: 'toggle',
    style: { display: 'inline-flex', alignItems: 'center', gap: '8px', margin: 0 },
    onClick: () => {
      model.autoLayout = !model.autoLayout;
      box.classList.toggle('is-on', model.autoLayout);
      box.innerHTML = model.autoLayout ? '&#10003;' : '';
    }
  }, [box, el('span', { class: 'small', text: 'Arrange automatically' })]);
}

// ---------------------------------------------------------------- commit --

async function commit(model) {
  const names = Array.from(model.selected);
  if (!names.length) return;

  const mode = model.mode;
  let loaded;

  try {
    loaded = await withProgress('Loading table metadata...',
      () => host.loadTables(names), { cancellable: true });
  } catch (error) {
    return;
  }

  const tables = (loaded && loaded.tables) || [];
  const unreadable = (loaded && loaded.unreadable) || [];

  if (!tables.length) {
    toast('None of the selected tables could be read from the environment. The connection may ' +
      'have dropped - reconnect in XrmToolBox and try again.', 'error', { sticky: true });
    return;
  }

  const relationships = model.relationships || [];
  const included = relationships.filter(r => model.includedRelationships.has(r.schemaName));
  const excluded = relationships.filter(r => !model.includedRelationships.has(r.schemaName));

  if (mode === 'new') {
    const document = newDocument(
      model.solutionName ? model.solutionName + ' data model' : 'Untitled diagram');

    document.source = {
      environmentUrl: state.connection.environmentUrl,
      organizationFriendlyName: state.connection.organizationFriendlyName,
      organizationId: state.connection.organizationId,
      organizationVersion: state.connection.organizationVersion,
      solutionUniqueName: model.solutionName,
      lastRefreshUtc: new Date().toISOString()
    };

    setDocument(document, null);
  }

  mutate(mode === 'new' ? 'create diagram' : 'add tables', () => {
    const added = addTablesFromMetadata(tables);
    addRelationshipsFromMetadata(included, { hidden: false });

    // The ones the user did not tick are still recorded so they can change their mind later
    // without rebuilding the diagram. They arrive hidden rather than excluded: there is no Exclude
    // control, so a connector created excluded would be unreachable - not drawn, and reported as
    // visible by Hide.
    addRelationshipsFromMetadata(excluded, { hidden: true });

    if (model.autoLayout) {
      // "Manual" as the saved layout mode means "do not rearrange what I have placed", not "pile
      // every new card on the origin". A brand new diagram therefore still gets laid out; only an
      // existing one is left alone.
      if (mode === 'new') {
        const layout = state.doc.settings.layoutMode;
        applyLayout(!layout || layout === 'Manual' ? 'Auto' : layout);
      } else {
        positionNewTables(added);
      }
    } else {
      // Automatic arrangement is switched off. New cards are still placed clear of everything else
      // rather than stacked on top of one another at 0,0.
      positionNewTables(added);
    }
  });

  render();
  renderPanels();

  // A new diagram opens at 100%; adding to one that already exists leaves the view exactly where
  // the user had it, because moving it is disorienting when the point was to add to what is
  // already on screen. positionNewTables places the additions clear of everything else.
  if (mode === 'new') resetView();

  const summary =
    (mode === 'new' ? 'Created ' : 'Added ') + tables.length + ' ' + plural(tables.length, 'table') +
    ' with ' + included.length + ' ' + plural(included.length, 'relationship') + '.';

  if (unreadable.length) {
    toast(summary + ' ' + unreadable.length + ' ' + plural(unreadable.length, 'table') +
      ' could not be read and ' + (unreadable.length === 1 ? 'was' : 'were') + ' left out: ' +
      unreadable.join(', ') + '.', 'warning', { timeout: 12000 });
  } else {
    toast(summary, 'success');
  }
}

function startBlank() {
  const document = newDocument('Future-state model');

  document.source = state.connection && state.connection.connected
    ? {
        environmentUrl: state.connection.environmentUrl,
        organizationFriendlyName: state.connection.organizationFriendlyName,
        organizationId: state.connection.organizationId
      }
    : {};

  setDocument(document, null);
  render();
  renderPanels();
  resetView();
  toast('Blank canvas ready. Use Propose to design a table.', 'info');
}
