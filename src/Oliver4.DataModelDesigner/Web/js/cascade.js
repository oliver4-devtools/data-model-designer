// Cascade impact analysis.
//
// Answers "if I delete one of these records, what else goes?". The relationship inspector shows
// one connector's cascade configuration at a time, which tells you nothing about the chain: Account
// cascades to Contact, Contact cascades on to something else, and three hops out a table nobody
// drew is being deleted too.
//
// The walk is live rather than over the diagram, because a cascade into a table that is not on
// the canvas is exactly the case that matters. Tables in the result that are not on the diagram
// are marked.

import { el, clear, sortBy, plural } from './util.js';
import { host } from './bridge.js';
import { state, tableByLogicalName } from './state.js';
import { openModal, toast, withProgress, select, field } from './ui.js';
import { render } from './render.js';
import { fitToView } from './interact.js';
import { ensureCatalogue } from './sourcepicker.js';

/**
 * The behaviours worth asking about. Merge and Unshare exist in the metadata too, but neither
 * answers a question anyone brings to a data model, and a dropdown of six where two matter makes
 * the two harder to find.
 */
const BEHAVIOURS = [
  { value: 'Delete', label: 'Delete - what else gets deleted' },
  { value: 'Assign', label: 'Assign - what else changes owner' },
  { value: 'Share', label: 'Share - what else gets shared' },
  { value: 'Reparent', label: 'Reparent - what else follows the parent' }
];

const VERBS = {
  Delete: 'deleted',
  Assign: 'reassigned',
  Share: 'shared',
  Reparent: 'reparented'
};

export function openCascadeAnalysis(startLogicalName) {
  if (!state.connection || !state.connection.connected) {
    toast('Cascade analysis reads live relationship metadata, so it needs a Dataverse connection. ' +
      'Use the connection bar at the top of XrmToolBox.', 'warning');
    return;
  }

  const selected = Array.from(state.selection.tables)
    .map(id => state.doc.tables.find(t => t.id === id))
    .filter(t => t && t.logicalName && t.status !== 'Proposed');

  const model = {
    catalogue: [],
    start: startLogicalName || (selected[0] ? selected[0].logicalName : ''),
    behaviour: 'Delete',
    maxDepth: 6,
    result: null
  };

  openModal({
    title: 'Cascade impact',
    subtitle: 'What one record takes with it',
    width: 860,
    height: 640,
    body: dialog => build(dialog, model),
    footer: dialog => footer(dialog, model),
    // Reading the catalogue is not cancellable, so the progress overlay shows no Cancel button -
    // but ui.js's Escape handler is document-level and closes the dialog straight through it. The
    // continuations below must not paint into the detached DOM a dismissal leaves behind.
    onClose: () => { model.closed = true; }
  });

  withProgress('Reading the environment...', ensureCatalogue)
    .then(catalogue => {
      if (model.closed) return;
      model.catalogue = catalogue || [];

      if (!model.start && model.catalogue.length) {
        const account = model.catalogue.find(t => t.logicalName === 'account');
        model.start = account ? account.logicalName : model.catalogue[0].logicalName;
      }

      model.repaint();
      if (startLogicalName) analyse(model);
    })
    .catch(() => {
      if (model.closed) return;
      model.catalogueFailed = true;
      model.repaint();
    });
}

// ------------------------------------------------------------------ body --

function build(dialog, model) {
  const layout = el('div', {
    style: { display: 'grid', gridTemplateColumns: '300px 1fr', height: '100%', minHeight: 0 }
  });

  const side = el('div', {
    style: {
      borderRight: '1px solid var(--line)', background: 'var(--surface-2)',
      padding: '16px', overflow: 'auto'
    }
  });

  const main = el('div', { style: { flex: '1 1 auto', overflow: 'auto', padding: '16px' } });
  layout.append(side, main);

  model.body = main;
  model.repaint = () => {
    // A late repaint after Escape would be drawing into detached DOM.
    if (model.closed) return;
    paintControls(side, model);
    paintResults(model);
    paintFooter(model);
  };
  model.repaint();

  return layout;
}

function paintControls(container, model) {
  clear(container);

  if (model.catalogueFailed) {
    container.appendChild(el('div', {
      class: 'form-error',
      text: 'The table catalogue could not be read. Check the connection and reopen this dialog.'
    }));
    return;
  }

  if (!model.catalogue.length) {
    container.appendChild(el('div', { class: 'empty-note', text: 'Reading the environment...' }));
    return;
  }

  const options = sortBy(model.catalogue, t => t.displayName || t.logicalName)
    .map(t => ({
      value: t.logicalName,
      label: (t.displayName || t.logicalName) + '  (' + t.logicalName + ')'
    }));

  container.appendChild(field('Table', select(options, model.start, value => {
    model.start = value;
    model.result = null;
    paintResults(model);
    paintFooter(model);
  }), null, { required: true }));

  container.appendChild(field('Behaviour', select(BEHAVIOURS, model.behaviour, value => {
    model.behaviour = value;
    model.result = null;
    paintResults(model);
    paintFooter(model);
  }), null, { required: true }));

  container.appendChild(field('Follow at most', select(
    [3, 4, 6, 8, 10].map(n => ({ value: String(n), label: n + ' ' + plural(n, 'hop') })),
    String(model.maxDepth),
    value => { model.maxDepth = Number(value); }),
    'Each hop is one relationship, and one live metadata call per table.'));

  container.appendChild(el('button', {
    class: 'btn primary',
    style: { width: '100%', marginTop: '14px' },
    text: model.result ? 'Analyse again' : 'Analyse',
    onClick: () => analyse(model)
  }));

  container.appendChild(el('div', {
    class: 'small muted',
    style: { marginTop: '12px', lineHeight: '1.5' },
    text: 'This reads relationship metadata only. No record is read, and nothing is changed - in ' +
          'the diagram or in Dataverse.'
  }));
}

// --------------------------------------------------------------- analyse --

async function analyse(model) {
  if (!model.start) {
    toast('Choose a table.', 'warning');
    return;
  }

  let result;
  try {
    result = await withProgress('Following the cascade...',
      () => host.analyseCascade({
        startTable: model.start,
        behaviour: model.behaviour,
        maxDepth: model.maxDepth
      }), { cancellable: true });
  } catch (error) {
    if (model.closed) return;
    model.result = null;
    paintResults(model);
    paintFooter(model);
    return;
  }

  // The dialog can be dismissed with Escape while the analysis is in flight.
  if (model.closed) return;

  model.result = result;
  paintResults(model);
  paintFooter(model);
}

// -------------------------------------------------------------- results ---

function paintResults(model) {
  const body = clear(model.body);
  const result = model.result;

  if (!result) {
    body.appendChild(el('div', {
      class: 'empty-note',
      style: { marginTop: '48px', textAlign: 'center', lineHeight: '1.65' },
      text: 'Pick a table and a behaviour, then choose Analyse. Deleting a record can take other ' +
            'records with it through the relationships that cascade, and this follows that chain ' +
            'as far as it goes.'
    }));
    return;
  }

  const verb = VERBS[result.behaviour] || 'affected';
  const affected = result.affected || [];
  const blockers = result.blockers || [];
  const detached = result.detached || [];

  body.appendChild(el('div', { class: 'cascade-headline' }, [
    el('div', { class: 'cascade-verdict', text: verdict(result, verb) }),
    el('div', {
      class: 'small muted',
      text: 'Starting from one ' + (result.startDisplayName || result.startTable) + ' record.'
    })
  ]));

  if (result.message) {
    body.appendChild(el('div', { class: 'notice', style: { margin: '10px 0' }, text: result.message }));
  }

  // Called out on its own rather than listed as a casualty. A parent-child hierarchy on one table
  // is extremely common, and putting Account in the list of what deleting an Account destroys -
  // directly under a line saying the walk started there - reads as a bug.
  if (result.selfReferencing) {
    body.appendChild(el('div', {
      class: 'notice',
      style: { margin: '10px 0' },
      text: (result.startDisplayName || result.startTable) + ' cascades to itself, so a parent ' +
            'record takes its children in the same table with it, all the way down the hierarchy.'
    }));
  }

  // Restrict comes first when there is any, because it changes the answer to the question rather
  // than adding to it: the operation does not happen at all while those child records exist.
  if (blockers.length) {
    body.appendChild(group(
      'Would refuse the ' + result.behaviour.toLowerCase(),
      blockers.length + ' ' + plural(blockers.length, 'relationship') + ' set to Restrict. While ' +
      'any of these child records exist, Dataverse refuses the operation.',
      blockers, 'is-blocker'));
  }

  if (affected.length) {
    const byHop = new Map();
    for (const step of affected) {
      if (!byHop.has(step.hops)) byHop.set(step.hops, []);
      byHop.get(step.hops).push(step);
    }

    for (const hop of Array.from(byHop.keys()).sort((a, b) => a - b)) {
      const steps = byHop.get(hop);
      body.appendChild(group(
        hop === 1 ? 'Directly ' + verb : hop + ' hops out',
        steps.length + ' ' + plural(steps.length, 'table') +
          (hop === 1
            ? ' whose records are ' + verb + ' with it.'
            : ' reached through the tables above.'),
        steps, 'is-affected'));
    }
  }

  if (detached.length) {
    body.appendChild(group(
      'Keep their records, lose the link',
      detached.length + ' ' + plural(detached.length, 'relationship') + ' set to RemoveLink. ' +
      'Those records survive and their lookup is cleared.',
      detached, 'is-detached'));
  }
}

function verdict(result, verb) {
  const affected = (result.affected || []).length;
  const blockers = (result.blockers || []).length;

  if (blockers && !affected) {
    return 'Nothing is ' + verb + ', and ' + blockers + ' ' + plural(blockers, 'relationship') +
           ' would refuse the operation outright.';
  }

  if (!affected) return 'Nothing else is ' + verb + '.';

  return 'Records in ' + affected + ' other ' + plural(affected, 'table') + ' would be ' + verb +
         (blockers ? ', and ' + blockers + ' ' + plural(blockers, 'relationship') +
           ' would refuse the operation outright' : '') + '.';
}

function group(heading, explanation, steps, kind) {
  const container = el('div', { class: 'cascade-group ' + kind });

  container.appendChild(el('div', { class: 'insp-heading', style: { marginBottom: '4px' }, text: heading }));
  container.appendChild(el('div', {
    class: 'small muted', style: { marginBottom: '8px', lineHeight: '1.45' }, text: explanation
  }));

  // These rows are read, not ticked - there is nothing to select, so they get list semantics
  // rather than the checkbox role the selectable rows elsewhere carry, giving a screen reader a
  // group it can announce and step through.
  const list = el('div', { role: 'list' });
  container.appendChild(list);

  for (const step of steps) {
    const onCanvas = !!tableByLogicalName(step.toTable);

    list.appendChild(el('div', { class: 'row', role: 'listitem', style: { flexDirection: 'column', alignItems: 'flex-start', gap: '2px' } }, [
      el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', width: '100%' } }, [
        el('span', { class: 'row-name', text: step.toDisplayName || step.toTable }),
        el('span', { class: 'tag', text: step.action }),
        el('span', { style: { flex: '1 1 auto' } }),
        onCanvas
          ? null
          : el('span', {
              class: 'row-meta is-orphan',
              title: 'This table is not on the diagram, so the chain reaches further than the diagram shows',
              text: 'not on diagram'
            })
      ]),
      el('div', { class: 'row-sub', style: { paddingLeft: '2px' } },
        'via ' + (step.fromDisplayName || step.fromTable) +
        (step.lookupColumn ? ' → ' + step.lookupColumn : '') +
        (step.relationshipSchemaName ? '  ·  ' + step.relationshipSchemaName : ''))
    ]));
  }

  return container;
}

// --------------------------------------------------------------- footer ---

function footer(dialog, model) {
  const bar = el('div', { style: { display: 'flex', width: '100%', alignItems: 'center', gap: '8px' } });
  model.footerHost = bar;
  model.dialog = dialog;
  paintFooter(model);
  return bar;
}

function paintFooter(model) {
  const container = model.footerHost;
  if (!container) return;
  clear(container);

  const result = model.result;
  const affected = result ? (result.affected || []) : [];

  // How much of the chain the diagram is actually showing. A chain that reaches six tables of
  // which two are drawn is a different thing to look at from one that is fully on screen.
  const onCanvas = affected.filter(step => tableByLogicalName(step.toTable)).length;

  container.appendChild(el('span', {
    class: 'small muted',
    text: affected.length
      ? onCanvas + ' of ' + affected.length + ' affected ' + plural(affected.length, 'table') + ' on this diagram'
      : ''
  }));

  container.appendChild(el('span', { style: { flex: '1 1 auto' } }));

  container.appendChild(el('button', {
    class: 'btn', text: 'Close', onClick: () => model.dialog.close(null)
  }));

  container.appendChild(el('button', {
    class: 'btn primary',
    text: 'Highlight on diagram',
    disabled: !onCanvas,
    title: onCanvas
      ? 'Dim everything except the chain'
      : 'None of the affected tables are on this diagram yet',
    onClick: () => highlight(model)
  }));
}

function highlight(model) {
  const result = model.result;
  if (!result) return;

  const tables = new Set();
  const relationships = new Set();

  const start = tableByLogicalName(result.startTable);
  if (start) tables.add(start.id);

  const schemaNames = new Set();
  for (const step of result.affected || []) {
    const table = tableByLogicalName(step.toTable);
    if (table) tables.add(table.id);
    if (step.relationshipSchemaName) schemaNames.add(step.relationshipSchemaName.toLowerCase());
  }

  for (const relationship of state.doc.relationships) {
    if (schemaNames.has((relationship.schemaName || '').toLowerCase())) relationships.add(relationship.id);
  }

  state.highlightPath = { tables, relationships };
  render();
  fitToView();

  model.dialog.close(null);

  // Counted against the affected list directly rather than a Set size: the start table can also
  // appear in the chain, and a Set would dedupe it.
  const missing = (result.affected || []).filter(step => !tableByLogicalName(step.toTable)).length;
  toast(
    'Cascade chain highlighted. Press Escape to clear.' +
    (missing > 0
      ? ' ' + missing + ' affected ' + plural(missing, 'table') + ' ' +
        (missing === 1 ? 'is' : 'are') + ' not on the diagram and cannot be shown.'
      : ''),
    missing > 0 ? 'warning' : 'info');
}
