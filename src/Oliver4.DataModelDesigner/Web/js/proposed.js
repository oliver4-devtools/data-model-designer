// Proposed / external / deprecated object editor.
//
// Nothing in this dialog touches Dataverse. It records design intent so a single diagram can show
// the current model and the intended one side by side, with the difference visible at a glance.
//
// Two editors live here: the whole-table one, and a single-column one used to propose or edit a
// column on any table - including a real one.

import { el, clear, uid } from './util.js';
import {
  state, mutate, tableById, relationshipById, removeRelationship, syncProposedLookupColumn,
  clearManualRoute, lookupColumnName
} from './state.js';
import {
  openModal, modalFooter, toast, field, textInput, textArea, select, checkbox,
  cellInput, markRequired
} from './ui.js';
import { render } from './render.js';
import { renderPanels } from './panels.js';
import { statusStyle, invalidateSizes } from './geometry.js';
import { positionNewTables } from './layout.js';

const TYPE_OPTIONS = [
  'Unique identifier', 'Text', 'Text area', 'Whole number', 'Decimal', 'Currency',
  'Date only', 'Date and time', 'Yes/No', 'Choice', 'Lookup', 'Customer', 'Owner', 'File', 'Image'
];

const LOOKUP_TYPES = ['Lookup', 'Customer', 'Owner'];

/**
 * The types a column editor offers.
 *
 * Lookup, Customer and Owner are absent. A lookup is not a column with a type - it is the near end
 * of a relationship, and everything that matters about it (which table it points at, what happens
 * on delete, on assign, on reparent) lives on the relationship rather than on the column. Proposing
 * a relationship writes its lookup column, so a lookup row is never drawn without a connector.
 */
const COLUMN_TYPE_OPTIONS = TYPE_OPTIONS.filter(type => !LOOKUP_TYPES.includes(type));

/**
 * The type list for one column, keeping whatever it is already set to.
 *
 * A column proposed before tool 1.6.0 - or one written by the relationship editor - can be a
 * lookup. Dropping the value from the list would make the select fall back to its first option and
 * quietly change the column's type just because the dialog was opened to read it.
 */
export function typeOptionsFor(column) {
  const current = column && column.typeName;
  const options = COLUMN_TYPE_OPTIONS.slice();

  if (current && !options.includes(current)) options.unshift(current);
  return options.map(type => ({ value: type, label: type }));
}

/** Refreshes the inspector without importing it, which would close a module cycle. */
function inspectorNeedsRepaint() {
  window.dispatchEvent(new CustomEvent('dmd:refresh-inspector'));
}

// ==========================================================================
// Propose hub
// ==========================================================================

/**
 * One entry point for every kind of design work: a proposed table, a proposed column on any table,
 * and a proposed relationship between any two tables, including two real ones.
 */
export function openProposeHub(worldPoint) {
  const tables = state.doc.tables;

  const api = openModal({
    title: 'Propose a change',
    subtitle: 'Design only - nothing is created in Dataverse',
    width: 620,
    padded: true,
    body: () => el('div', {}, [
      el('div', { class: 'small muted', style: { marginBottom: '14px', lineHeight: '1.55' } },
        'Everything here is recorded on the diagram as intent. It is drawn in the proposed style ' +
        'so the difference between what exists today and what you are proposing stays obvious, ' +
        'and the next refresh checks whether any of it has since been built.'),

      choice(
        'A new table',
        'A table that does not exist yet, with the columns you expect it to have.',
        () => { api.close(null); openProposedTableEditor(null, worldPoint); }),

      choice(
        'A column on an existing table',
        tables.length
          ? 'Add a proposed column to any table on the canvas, real or proposed. Not a lookup - ' +
            'those come from a relationship.'
          : 'Needs at least one table on the canvas.',
        () => { api.close(null); openColumnTargetPicker(); },
        !tables.length),

      choice(
        'A relationship',
        tables.length >= 2
          ? 'Between any two tables on the canvas, including two that already exist in Dataverse. ' +
            'A one-to-many writes its lookup column onto the table at the many end.'
          : 'Needs at least two tables on the canvas.',
        () => { api.close(null); openProposedRelationshipEditor(); },
        tables.length < 2),

      choice(
        'An external system',
        'A box for something outside Dataverse - an ERP, a warehouse, an API-owned store - so ' +
        'the diagram can show where the integration boundary is.',
        () => { api.close(null); openProposedTableEditor(null, worldPoint, { status: 'External' }); }),

      el('div', {
        class: 'small muted',
        style: { marginTop: '14px', paddingTop: '12px', borderTop: '1px solid var(--line)', lineHeight: '1.5' }
      }, 'To mark something already on the diagram as deprecated, right-click it and use the ' +
         'status commands, or use the Status control in the inspector.')
    ]),
    footer: dialog => modalFooter(dialog, {
      primaryLabel: 'Close', hideCancel: true, onPrimary: () => dialog.close(null)
    })
  });
}

function choice(title, detail, onPick, disabled) {
  return el('button', {
    class: 'choice-card' + (disabled ? ' is-disabled' : ''),
    disabled: !!disabled,
    onClick: () => { if (!disabled) onPick(); }
  }, [
    el('div', { class: 'choice-title', text: title }),
    el('div', { class: 'choice-detail', text: detail })
  ]);
}

/** Which table should the proposed column go on. Skipped when only one table is on the canvas. */
function openColumnTargetPicker() {
  const tables = state.doc.tables;
  if (tables.length === 1) { openProposedColumnEditor(tables[0].id); return; }

  const selected = Array.from(state.selection.tables)[0];
  let target = selected && tableById(selected) ? selected : tables[0].id;

  const api = openModal({
    title: 'Propose a column',
    width: 520,
    padded: true,
    body: () => el('div', {}, [
      el('div', { class: 'small muted', style: { marginBottom: '12px' } },
        'Which table should the column go on?'),
      field('Table', select(
        tables.map(t => ({
          value: t.id,
          label: (t.displayName || t.logicalName) + (t.status === 'Existing' ? '' : '  (' + t.status.toLowerCase() + ')')
        })),
        target,
        value => { target = value; }), null, { required: true })
    ]),
    footer: dialog => modalFooter(dialog, {
      primaryLabel: 'Continue',
      onPrimary: () => { dialog.close(null); openProposedColumnEditor(target); }
    })
  });

  return api;
}

// ==========================================================================
// Whole-table editor
// ==========================================================================

export function openProposedTableEditor(existingTableId, worldPoint, options) {
  const editing = existingTableId ? tableById(existingTableId) : null;
  const seedStatus = (options && options.status) || 'Proposed';

  const model = editing
    ? {
        id: editing.id,
        displayName: editing.displayName || '',
        schemaName: editing.schemaName || '',
        status: editing.status === 'Existing' ? 'Proposed' : editing.status,
        owner: editing.owner || '',
        notes: editing.notes || '',
        // Relationship-owned lookups are left out. They are edited through the relationship that
        // created them, as the other two ways in enforce: edits here would be undone by
        // syncProposedLookupColumn, and the PK chip would leave the table naming a primary key no
        // column claims.
        columns: (editing.columns || [])
          .filter(column => column.status === 'Proposed' && !column.fromRelationshipId)
          .map(column => Object.assign({}, column)),
        relationships: relationshipDraftsFor(editing.id)
      }
    : {
        id: null,
        displayName: '',
        schemaName: '',
        status: seedStatus,
        owner: '',
        notes: '',
        // Seeded blank rather than with an example name, which would tend to be committed
        // unchanged.
        //
        // An external system is not a Dataverse table, so it does not get handed a primary key.
        columns: seedStatus === 'External'
          ? []
          : [newColumn({ typeName: 'Unique identifier', isPrimaryId: true, isRequired: true })],
        relationships: []
      };

  // Assigned before openModal, not after.
  //
  // openModal calls the body builder synchronously, and build() calls model.validate() to put the
  // dialog into its initial state, so validate must already exist. The api reference is still set
  // afterwards because openModal is what produces it; validateTable tolerates its absence for this
  // first call.
  model.validate = () => validateTable(model);

  const api = openModal({
    title: editing
      ? 'Edit ' + model.status.toLowerCase() + ' table'
      : (seedStatus === 'External' ? 'Add an external system' : 'Propose a table'),
    subtitle: 'Design only - nothing is created in Dataverse',
    width: 1000,
    height: 620,
    body: dialog => build(dialog, model),
    footer: dialog => modalFooter(dialog, {
      primaryLabel: editing ? 'Apply changes' : 'Add to diagram',
      primaryDisabled: true,
      onPrimary: () => commit(model, dialog, worldPoint)
    })
  });

  model.api = api;

  // Run again now the api exists, so the primary button starts out enabled when an existing
  // design is being edited and everything mandatory is already filled in.
  model.validate();
}

function newColumn(overrides) {
  return Object.assign({
    id: uid('c'),
    displayName: '',
    logicalName: '',
    typeName: 'Text',
    isPrimaryId: false,
    isLookup: false,
    isRequired: false,
    status: 'Proposed',
    selected: true,
    notes: '',
    targets: []
  }, overrides || {});
}

/** Everything mandatory that is still blank, as a short sentence for the dialog footer. */
function missingFrom(model) {
  const missing = [];
  if (!model.displayName.trim()) missing.push('the table display name');

  const blankColumns = model.columns.filter(column => !String(column.displayName || '').trim()).length;
  if (blankColumns) missing.push(blankColumns + (blankColumns === 1 ? ' column name' : ' column names'));

  return missing;
}

function validateTable(model) {
  const missing = missingFrom(model);

  if (model.api) model.api.setPrimaryEnabled(missing.length === 0);

  if (model.errorNode) {
    clear(model.errorNode);
    if (missing.length) {
      model.errorNode.appendChild(el('span', { class: 'req', text: '*' }));
      model.errorNode.appendChild(el('span', { text: 'Still to complete: ' + missing.join(' and ') + '.' }));
    }
  }

  if (model.paintRequired) model.paintRequired();
}

/**
 * Existing proposed relationships touching this table, in the shape the editor's controls read.
 *
 * The controls are bound to `otherTableId` and `direction`, so those are what has to come back -
 * not the raw fromTableId/toTableId pair - or a saved draft would reopen with the wrong ends and
 * Apply would rewire it.
 */
function relationshipDraftsFor(tableId) {
  return state.doc.relationships
    .filter(r => r.status === 'Proposed' && (r.fromTableId === tableId || r.toTableId === tableId))
    .map(r => {
      const pointsAway = r.fromTableId === tableId;

      return {
        id: r.id,
        schemaName: r.schemaName || '',
        kind: r.kind,
        otherTableId: pointsAway ? r.toTableId : r.fromTableId,
        direction: r.kind === 'ManyToMany' ? 'manyToMany' : (pointsAway ? 'fromThis' : 'toThis'),
        referencingAttribute: r.referencingAttribute || '',
        cascadeNotes: r.cascadeNotes || ''
      };
    });
}

// ------------------------------------------------------------------ body --

function build(dialog, model) {
  const layout = el('div', {
    style: { display: 'grid', gridTemplateColumns: '1fr 300px', height: '100%', minHeight: 0 }
  });

  const main = el('div', { style: { overflow: 'auto', padding: '16px' } });
  const side = el('div', {
    style: {
      borderLeft: '1px solid var(--line)', background: 'var(--surface-2)',
      padding: '16px', overflow: 'auto', display: 'flex', flexDirection: 'column', gap: '14px'
    }
  });

  layout.append(main, side);

  const repaintPreview = () => paintPreview(side, model);

  const nameInput = textInput(model.displayName, value => {
    model.displayName = value;
    model.validate();
    repaintPreview();
  });

  main.appendChild(el('div', { class: 'field-row' }, [
    field('Display name', nameInput, null, { required: true }),
    field('Intended schema name', textInput(model.schemaName, value => {
      model.schemaName = value;
      repaintPreview();
    }), 'Optional. Used on refresh to spot whether the table now exists.')
  ]));

  main.appendChild(el('div', { class: 'field-row' }, [
    field('Status', select([
      { value: 'Proposed', label: 'Proposed - intended future Dataverse table' },
      { value: 'External', label: 'External - outside Dataverse' },
      { value: 'Deprecated', label: 'Deprecated - planned for retirement' }
    ], model.status, value => {
      model.status = value;
      repaintPreview();
    }), null, { required: true }),
    field('Owner or workstream', textInput(model.owner, value => { model.owner = value; }))
  ]));

  const columnsSection = el('div', { style: { marginTop: '6px' } });
  main.appendChild(columnsSection);

  const relationshipsSection = el('div', { style: { marginTop: '18px' } });
  main.appendChild(relationshipsSection);

  main.appendChild(el('div', { style: { marginTop: '18px' } }, [
    field('Design notes', textArea(model.notes, value => { model.notes = value; }))
  ]));

  model.errorNode = el('div', { class: 'form-error' });
  main.appendChild(el('div', { style: { marginTop: '12px' } }, [model.errorNode]));

  model.paintRequired = () => {
    markRequired(nameInput, !model.displayName.trim());
    if (model.markColumns) model.markColumns();
  };

  paintColumns(columnsSection, model, repaintPreview);
  paintRelationships(relationshipsSection, model);
  repaintPreview();
  model.validate();

  return layout;
}

function paintColumns(container, model, repaintPreview) {
  clear(container);

  container.appendChild(el('div', {
    style: { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' }
  }, [
    el('div', { class: 'insp-heading', style: { margin: 0 },
      text: 'Proposed columns · ' + model.columns.length }),
    el('span', { style: { flex: '1 1 auto' } }),
    el('button', {
      class: 'text-btn', text: '+ Add column',
      onClick: () => {
        model.columns.push(newColumn());
        paintColumns(container, model, repaintPreview);
        repaintPreview();
        model.validate();
      }
    })
  ]));

  container.appendChild(el('div', {
    class: 'small muted', style: { margin: '-2px 0 8px', lineHeight: '1.45' },
    text: 'Lookup, Customer and Owner are not in the type list. A lookup is the near end of a ' +
          'relationship, so it is created by adding one under Proposed relationships below - the ' +
          'column appears on this card with the connector already pointing at it.'
  }));

  const table = el('table', { class: 'grid-table' });
  table.appendChild(el('thead', {}, [
    el('tr', {}, [
      el('th', {}, ['Display name', el('span', { class: 'req', text: '*' })]),
      el('th', { text: 'Schema name' }),
      el('th', {}, ['Type', el('span', { class: 'req', text: '*' })]),
      el('th', { text: 'Key' }),
      el('th', { text: 'Req.' }),
      el('th', {})
    ])
  ]));

  const body = el('tbody');
  const nameInputs = [];

  model.columns.forEach((column, index) => {
    const nameBox = cellInput(column.displayName, value => {
      column.displayName = value;
      model.validate();
      repaintPreview();
    });

    nameInputs.push({ column, node: nameBox });

    body.appendChild(el('tr', {}, [
      el('td', {}, [nameBox]),
      el('td', {}, [cellInput(column.logicalName, value => {
        column.logicalName = value;
        repaintPreview();
      }, { mono: true })]),
      el('td', {}, [(() => {
        const node = select(
          typeOptionsFor(column),
          column.typeName || 'Text',
          value => {
            column.typeName = value;
            column.isLookup = LOOKUP_TYPES.includes(value);
            repaintPreview();
          });
        node.style.padding = '3px 4px';
        node.style.border = '1px solid var(--line)';
        node.style.borderRadius = '5px';
        node.style.width = '100%';
        node.style.background = 'var(--surface-input)';
        return node;
      })()]),
      el('td', { class: 'tight' }, [
        el('button', {
          class: 'chip' + (column.isPrimaryId ? ' is-on' : ''),
          text: column.isPrimaryId ? 'PK' : column.isLookup ? 'FK' : '-',
          title: 'Mark as the primary key',
          onClick: () => {
            if (column.isPrimaryId) {
              column.isPrimaryId = false;
            } else {
              model.columns.forEach(c => { c.isPrimaryId = false; });
              column.isPrimaryId = true;
            }
            paintColumns(container, model, repaintPreview);
            repaintPreview();
          }
        })
      ]),
      el('td', { class: 'tight' }, [
        el('button', {
          class: 'chip' + (column.isRequired ? ' is-on' : ''),
          text: column.isRequired ? 'Yes' : 'No',
          title: 'Business required in Dataverse',
          onClick: () => {
            column.isRequired = !column.isRequired;
            paintColumns(container, model, repaintPreview);
          }
        })
      ]),
      el('td', { class: 'tight' }, [
        el('button', {
          class: 'icon-btn', html: '&times;', title: 'Remove column',
          onClick: () => {
            model.columns.splice(index, 1);
            paintColumns(container, model, repaintPreview);
            repaintPreview();
            model.validate();
          }
        })
      ])
    ]));
  });

  table.appendChild(body);
  container.appendChild(table);

  if (!model.columns.length) {
    container.appendChild(el('div', {
      class: 'empty-note',
      text: 'No columns yet. Use "+ Add column" to describe the fields this table should have.'
    }));
  }

  // Re-marking happens from validate() so a newly added blank row is flagged straight away
  // rather than only after the user has typed somewhere else.
  model.markColumns = () => {
    for (const entry of nameInputs) {
      markRequired(entry.node, !String(entry.column.displayName || '').trim());
    }
  };

  model.markColumns();
}

function paintRelationships(container, model) {
  clear(container);

  const others = state.doc.tables.filter(t => t.id !== model.id);

  container.appendChild(el('div', {
    style: { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' }
  }, [
    el('div', { class: 'insp-heading', style: { margin: 0 },
      text: 'Proposed relationships · ' + model.relationships.length }),
    el('span', { style: { flex: '1 1 auto' } }),
    el('button', {
      class: 'text-btn', text: '+ Add relationship',
      disabled: !others.length,
      onClick: () => {
        model.relationships.push({
          id: uid('r'),
          schemaName: '',
          kind: 'OneToMany',
          otherTableId: others[0].id,
          direction: 'toThis',
          referencingAttribute: '',
          cascadeNotes: ''
        });
        paintRelationships(container, model);
      }
    })
  ]));

  if (!others.length) {
    container.appendChild(el('div', {
      class: 'empty-note',
      text: 'Add at least one other table to the diagram before drawing a relationship to it.'
    }));
    return;
  }

  if (!model.relationships.length) {
    container.appendChild(el('div', {
      class: 'empty-note',
      text: 'None yet. A proposed relationship records the intended cardinality, lookup column and cascade behaviour without validating any of it against Dataverse.'
    }));
  }

  model.relationships.forEach((relationship, index) => {
    const card = el('div', { class: 'proposed-card' });

    card.appendChild(el('div', { class: 'field-row' }, [
      field('Relationship with', select(
        others.map(t => ({ value: t.id, label: t.displayName || t.logicalName })),
        relationship.otherTableId || others[0].id,
        value => { relationship.otherTableId = value; }), null, { required: true }),
      field('Direction', select([
        { value: 'toThis', label: 'Other table 1 → N this table' },
        { value: 'fromThis', label: 'This table 1 → N other table' },
        { value: 'manyToMany', label: 'Many-to-many' }
      ], relationship.direction || 'toThis', value => {
        relationship.direction = value;
        relationship.kind = value === 'manyToMany' ? 'ManyToMany' : 'OneToMany';
      }), null, { required: true })
    ]));

    card.appendChild(el('div', { class: 'field-row' }, [
      field('Schema name', textInput(relationship.schemaName, value => { relationship.schemaName = value; })),
      field('Lookup column', textInput(relationship.referencingAttribute,
        value => { relationship.referencingAttribute = value; }))
    ]));

    card.appendChild(field('Intended cascade behaviour',
      textInput(relationship.cascadeNotes, value => { relationship.cascadeNotes = value; }),
      'Recorded as intent. Not validated against Dataverse.'));

    card.appendChild(el('button', {
      class: 'text-btn', text: 'Remove relationship',
      onClick: () => { model.relationships.splice(index, 1); paintRelationships(container, model); }
    }));

    container.appendChild(card);
  });
}

function paintPreview(container, model) {
  clear(container);

  const style = statusStyle(model.status);

  container.appendChild(el('div', {}, [
    el('div', { class: 'insp-heading', text: 'Canvas preview' }),
    el('div', {
      style: {
        border: '1px solid ' + style.stroke, borderRadius: '7px', overflow: 'hidden',
        background: style.fill, boxShadow: 'var(--shadow-sm)'
      }
    }, [
      el('div', {
        style: {
          display: 'flex', alignItems: 'center', gap: '6px', padding: '7px 9px',
          background: style.head, borderBottom: '1px solid ' + style.headLine
        }
      }, [
        el('span', { style: { width: '6px', height: '6px', borderRadius: '2px', background: style.mark } }),
        el('span', { style: { fontSize: '12px', fontWeight: 600, color: style.ink },
          text: model.displayName || 'Untitled table' }),
        el('span', { style: { marginLeft: 'auto' }, class: 'badge badge-' + model.status.toLowerCase(),
          text: model.status.toUpperCase() })
      ]),
      ...model.columns.slice(0, 8).map(column => el('div', {
        style: {
          display: 'grid', gridTemplateColumns: '18px 1fr auto', gap: '8px', alignItems: 'center',
          padding: '4px 9px', borderBottom: '1px solid var(--line)'
        }
      }, [
        el('span', { class: 'mono', style: { fontSize: '8.5px', color: 'var(--proposed-ink)' },
          text: column.isPrimaryId ? 'PK' : column.isLookup ? 'FK' : '' }),
        el('span', { class: 'mono', style: { fontSize: '10.5px', color: 'var(--ink-2)' },
          text: column.logicalName || column.displayName || '(unnamed)' }),
        el('span', { style: { fontSize: '9.5px', color: 'var(--ink-5)' }, text: column.typeName || '' })
      ]))
    ])
  ]));

  container.appendChild(el('div', {
    style: {
      background: 'var(--surface-raised)', border: '1px solid var(--line)', borderRadius: '8px',
      padding: '10px 12px', fontSize: '11.5px', color: 'var(--ink-3)', lineHeight: '1.5'
    }
  }, [
    el('strong', { text: 'Nothing here changes Dataverse. ' }),
    'On the next refresh the tool checks whether a matching table exists and offers to promote it.'
  ]));
}

// ---------------------------------------------------------------- commit --

function commit(model, dialog, worldPoint) {
  if (missingFrom(model).length) return;

  mutate(model.id ? 'edit proposed table' : 'add proposed table', () => {
    let table = model.id ? tableById(model.id) : null;

    if (!table) {
      table = {
        id: uid('t'),
        logicalName: null,
        schemaName: model.schemaName,
        displayName: model.displayName,
        status: model.status,
        x: worldPoint ? worldPoint.x : 0,
        y: worldPoint ? worldPoint.y : 0,
        collapsed: false,
        detailOverride: null,
        highlight: null,
        columns: [],
        alternateKeys: []
      };
      state.doc.tables.push(table);
      if (!worldPoint) positionNewTables([table]);
    }

    table.displayName = model.displayName;
    table.schemaName = model.schemaName;
    table.status = model.status;
    table.owner = model.owner;
    table.notes = model.notes;

    // Keep any real metadata columns if this started life as an existing table the user
    // reclassified; only replace the proposed ones the grid above was actually editing.
    // Relationship-owned lookups are kept for the same reason they are kept out of the grid: they
    // belong to a connector, not to this dialog, and rebuilding the column list without them would
    // delete a lookup whose relationship is still on the canvas.
    const keep = (table.columns || []).filter(c => c.status !== 'Proposed' || c.fromRelationshipId);

    const drafted = model.columns.map(column => Object.assign({}, column, {
      status: 'Proposed',
      selected: true,
      logicalName: column.logicalName || slug(column.displayName)
    }));

    table.columns = keep.concat(drafted);

    // Only claim the primary key when this editor actually names one. A reclassified real table
    // keeps whatever Dataverse said its primary key was.
    const primary = drafted.find(column => column.isPrimaryId);
    if (primary) table.primaryIdAttribute = primary.logicalName;
    else if (!keep.some(column => column.isPrimaryId)) table.primaryIdAttribute = table.primaryIdAttribute || null;

    applyRelationshipDrafts(model, table);
  });

  invalidateSizes();
  render();
  renderPanels();
  inspectorNeedsRepaint();
  dialog.close(null);

  toast((model.id ? 'Updated ' : 'Added ') + model.displayName + '.', 'success');
}

function applyRelationshipDrafts(model, table) {
  const existingIds = new Set(model.relationships.map(r => r.id));

  // Drop proposed relationships the user removed in the editor. Through removeRelationship rather
  // than a filter, so the lookup column each one wrote goes with it rather than being left as an
  // orphaned FK row.
  const dropped = state.doc.relationships.filter(r =>
    r.status === 'Proposed' && (r.fromTableId === table.id || r.toTableId === table.id) &&
    !existingIds.has(r.id));

  for (const relationship of dropped) removeRelationship(relationship.id);

  for (const draft of model.relationships) {
    const other = draft.otherTableId;
    if (!other || other === table.id) continue;

    const direction = draft.direction || 'toThis';
    const kind = direction === 'manyToMany' ? 'ManyToMany' : 'OneToMany';

    const fromTableId = direction === 'fromThis' ? table.id : other;
    const toTableId = direction === 'fromThis' ? other : table.id;

    const stored = state.doc.relationships.find(r => r.id === draft.id);
    const otherTable = tableById(other);

    // Presentation is not in here. highlight, notes and waypoints belong to how the user has
    // arranged and annotated the diagram, not to the design this editor describes, and this dialog
    // cannot read them back - relationshipDraftsFor does not carry them - so writing them would
    // wipe them whenever Apply is pressed. The sibling editor follows the same rule.
    const payload = {
      id: draft.id,
      // Named from both ends, like the other editor, so two relationships added from the same card
      // get different schema names.
      schemaName: draft.schemaName ||
        defaultRelationshipName(
          direction === 'fromThis' ? table : (otherTable || table),
          direction === 'fromThis' ? (otherTable || table) : table),
      displayName: draft.schemaName,
      kind,
      status: 'Proposed',
      fromTableId,
      toTableId,
      referencingAttribute: draft.referencingAttribute,
      cascadeNotes: draft.cascadeNotes,
      included: true,
      hidden: false,
      lookupTargets: []
    };

    if (stored) {
      // See the sibling editor: hand-placed corners survive an edit to the design, but not a change
      // of which two cards the connector joins.
      const repointed = stored.fromTableId !== payload.fromTableId ||
        stored.toTableId !== payload.toTableId;

      Object.assign(stored, payload);
      if (repointed) clearManualRoute(stored);
    } else {
      state.doc.relationships.push(Object.assign({ highlight: null, notes: '', waypoints: [] }, payload));
    }

    // The lookup column the relationship implies, on the table at the many end.
    syncProposedLookupColumn(state.doc.relationships.find(r => r.id === draft.id));
  }
}

/**
 * A logical-name-shaped version of something the user typed.
 *
 * Keeps the underscore for the same reason `lookupColumnName` does: it is the separator after a
 * publisher prefix. Everything else that is not a letter, a digit or an underscore is stripped.
 */
function slug(value) {
  return String(value || 'table').toLowerCase().replace(/[^a-z0-9_]+/g, '');
}

// ==========================================================================
// Single-column editor
// ==========================================================================

/**
 * Proposes a column on any table, or edits one already proposed. Real columns are never editable
 * here: they are what Dataverse says they are, and pretending otherwise would make the diagram
 * disagree with the environment it claims to describe.
 */
export function openProposedColumnEditor(tableId, columnId) {
  const table = tableById(tableId);
  if (!table) return;

  const existing = columnId
    ? (table.columns || []).find(column => column.id === columnId)
    : null;

  if (columnId && !existing) return;

  if (existing && existing.status !== 'Proposed') {
    toast('Only proposed columns can be edited. This column comes from Dataverse metadata.', 'warning');
    return;
  }

  // A lookup column written by a proposed relationship is that relationship's, and editing it here
  // would let the two disagree - a column renamed on the card while the connector still points at
  // the old name. The relationship editor is where all of it is decided.
  //
  // Only while both are still proposals. A column that has been settled - because the relationship
  // was marked existing, or promoted by a refresh - is an ordinary column again and is edited here,
  // since the relationship editor refuses non-proposed relationships.
  const owner = existing && existing.fromRelationshipId
    ? relationshipById(existing.fromRelationshipId)
    : null;

  if (existing && existing.status === 'Proposed' && owner && owner.status === 'Proposed') {
    toast('This lookup belongs to a proposed relationship, so it is edited there.', 'info');
    openProposedRelationshipEditor({ relationshipId: owner.id });
    return;
  }

  const model = existing
    ? Object.assign({}, existing)
    : newColumn();

  let api = null;
  let nameInput = null;
  let errorNode = null;

  const validate = () => {
    const blank = !String(model.displayName || '').trim();
    markRequired(nameInput, blank);
    if (api) api.setPrimaryEnabled(!blank);
    if (errorNode) errorNode.textContent = blank ? 'A display name is required.' : '';
  };

  api = openModal({
    title: existing ? 'Edit proposed column' : 'Propose a column',
    subtitle: table.displayName || table.logicalName,
    width: 560,
    padded: true,
    body: () => {
      nameInput = textInput(model.displayName, value => { model.displayName = value; validate(); });
      errorNode = el('div', { class: 'form-error', style: { marginTop: '4px' } });

      return el('div', {}, [
        el('div', { class: 'small muted', style: { marginBottom: '12px', lineHeight: '1.5' } },
          table.status === 'Existing'
            ? 'This adds a proposed column to a real table. It is drawn on the card in the proposed ' +
              'style so the difference between what exists and what is intended stays obvious. ' +
              'Dataverse is not changed.'
            : 'A column on a table that does not exist yet. Nothing here is validated against Dataverse.'),

        // A lookup cannot be designed here. Everything that decides what it means - the table at
        // the other end, the cardinality, and the cascade behaviour on delete, assign and reparent
        // - belongs to the relationship, and a lookup column drawn without one would be an FK row
        // with no connector attached.
        el('div', { class: 'notice', style: { marginBottom: '14px' } }, [
          el('div', { style: { marginBottom: '8px' } },
            'Looking for a lookup? Lookups are made by proposing a relationship, not a column. ' +
            'The relationship editor asks which table it points at and how it should cascade, ' +
            'then puts the lookup column on this card for you and draws the connector to it.'),
          el('button', {
            class: 'btn',
            text: 'Propose a relationship instead...',
            onClick: () => {
              api.close(null);
              // This table is the one that would carry the lookup, so it is the many end.
              openProposedRelationshipEditor({ toTableId: table.id });
            }
          })
        ]),

        el('div', { class: 'field-row' }, [
          field('Display name', nameInput, null, { required: true }),
          field('Intended schema name', textInput(model.logicalName, value => { model.logicalName = value; }),
            'Optional. A refresh promotes the column automatically when a real one with this name appears.')
        ]),

        field('Data type', select(
          typeOptionsFor(model),
          model.typeName || 'Text',
          value => {
            model.typeName = value;
            model.isLookup = LOOKUP_TYPES.includes(value);
          }), null, { required: true }),

        checkbox('Business required', !!model.isRequired, value => { model.isRequired = value; }),
        checkbox('Primary key for this table', !!model.isPrimaryId, value => { model.isPrimaryId = value; }),

        field('Note', textArea(model.notes, value => { model.notes = value; })),

        errorNode
      ]);
    },
    footer: dialog => modalFooter(dialog, {
      primaryLabel: existing ? 'Apply changes' : 'Add column',
      primaryDisabled: true,
      secondary: existing
        ? el('button', {
            class: 'btn danger', text: 'Remove column',
            onClick: () => { removeProposedColumn(table.id, existing.id); dialog.close(null); }
          })
        : null,
      onPrimary: () => {
        if (!String(model.displayName || '').trim()) return;

        mutate(existing ? 'edit proposed column' : 'propose column', () => {
          const target = tableById(table.id);
          if (!target) return;

          const payload = Object.assign({}, model, {
            status: 'Proposed',
            selected: true,
            logicalName: model.logicalName || slug(model.displayName)
          });

          if (payload.isPrimaryId) {
            (target.columns || []).forEach(column => {
              if (column.id !== payload.id) column.isPrimaryId = false;
            });
            target.primaryIdAttribute = payload.logicalName;
          }

          const index = (target.columns || []).findIndex(column => column.id === payload.id);
          if (index >= 0) target.columns[index] = payload;
          else target.columns = (target.columns || []).concat([payload]);
        });

        invalidateSizes();
        render();
        renderPanels();
        inspectorNeedsRepaint();
        dialog.close(null);

        toast((existing ? 'Updated ' : 'Proposed ') + model.displayName + ' on ' +
          (table.displayName || table.logicalName) + '. Dataverse is unchanged.', 'success');
      }
    })
  });

  validate();
}

export function removeProposedColumn(tableId, columnId) {
  const table = tableById(tableId);
  if (!table) return;

  const column = (table.columns || []).find(entry => entry.id === columnId);
  if (!column || column.status !== 'Proposed') return;

  // A relationship's lookup column goes when the relationship goes, and not before. Removing it on
  // its own would leave a connector anchored to a row that is no longer on the card.
  //
  // Guarded on the relationship still being a live proposal, so a column whose relationship has
  // been settled or has gone is deletable like any other rather than stuck on the card for ever.
  const owner = column.fromRelationshipId ? relationshipById(column.fromRelationshipId) : null;

  if (owner && owner.status === 'Proposed') {
    toast('This lookup belongs to a proposed relationship. Remove the relationship and the column ' +
      'goes with it.', 'warning');
    return;
  }

  mutate('remove proposed column', () => {
    const target = tableById(tableId);
    target.columns = (target.columns || []).filter(entry => entry.id !== columnId);
    if (target.primaryIdAttribute === column.logicalName) target.primaryIdAttribute = null;
  });

  invalidateSizes();
  render();
  renderPanels();
  inspectorNeedsRepaint();

  toast('Removed the proposed column ' + (column.displayName || column.logicalName) + '.', 'info');
}

// ==========================================================================
// Proposed relationship editor
// ==========================================================================

/**
 * The table selected on the canvas, when it can honestly be called "the" table.
 *
 * A card is selected because it is the one being worked on, so opening the relationship editor
 * from the toolbar or the Propose hub with a table selected starts from that table rather than
 * from whatever happens to sit first in the document. The caller's own seed always wins - canvas
 * drag-to-connect and "propose a lookup on this table" both know more than the selection does.
 *
 * Only a single selection counts. With five cards marquee-selected there is no "the" table, and
 * picking one of them would be less predictable than the first in the list, not more. A selection
 * that is already the other end of the relationship is ignored, as it would open the dialog with
 * both ends set to the same table.
 */
function selectedTableSeed(excluded) {
  if (state.selection.tables.size !== 1) return null;

  const [id] = state.selection.tables;
  const table = tableById(id);

  return table && table.id !== excluded ? table.id : null;
}

/**
 * Designs one proposed relationship between any two tables on the canvas.
 *
 * Either end can have any status. The commonest future-state change in a real design is a new
 * lookup between two tables that both already exist, and this expresses it without reclassifying
 * a real table as proposed.
 *
 * Pass fromTableId/toTableId to seed it - that is what canvas drag-to-connect does.
 */
export function openProposedRelationshipEditor(options) {
  const opts = options || {};
  const tables = state.doc.tables;

  if (tables.length < 2) {
    toast('A relationship needs two tables. Add another one to the canvas first.', 'warning');
    return;
  }

  const existing = opts.relationshipId ? relationshipById(opts.relationshipId) : null;

  if (existing && existing.status !== 'Proposed') {
    toast('This relationship comes from Dataverse metadata, so its design cannot be edited here. ' +
      'Everything it actually does is in the inspector.', 'warning');
    return;
  }

  const seedFrom = existing ? existing.fromTableId : opts.fromTableId;
  const seedTo = existing ? existing.toTableId : opts.toTableId;

  // Each end defaults to the first table that is not the other one, so arriving from "propose a
  // lookup on this table" - which names the many end and nothing else - does not open with both
  // ends set to the same table.
  const firstOther = excluded => (tables.find(t => t.id !== excluded) || tables[0]).id;

  const fromTableId = seedFrom || selectedTableSeed(seedTo) || firstOther(seedTo);
  const toTableId = seedTo || firstOther(fromTableId);

  const model = {
    id: existing ? existing.id : uid('r'),
    fromTableId,
    toTableId,
    kind: existing ? existing.kind : 'OneToMany',
    schemaName: existing ? (existing.schemaName || '') : '',
    // Seeded with the derived name rather than left blank. The lookup column is mandatory - it is
    // what the connector anchors to, and what the proposed lookup column on the "many" end card is
    // called - so a blank box would open every new relationship in an error state.
    referencingAttribute: (existing && existing.referencingAttribute) ||
      lookupColumnName(null, tableById(fromTableId)),
    cascadeNotes: existing ? (existing.cascadeNotes || '') : '',
    notes: existing ? (existing.notes || '') : ''
  };

  let api = null;
  let errorNode = null;
  let summaryNode = null;
  let lookupInput = null;
  let lookupField = null;

  // True once the user has typed in the lookup box. Until then the name follows the table at the
  // one end, so changing that end - or pressing Swap - renames it too rather than leaving behind a
  // name derived from the other table.
  let lookupEdited = !!(existing && existing.referencingAttribute);

  const syncDerivedLookupName = () => {
    if (lookupEdited) return;
    model.referencingAttribute = lookupColumnName(null, tableById(model.fromTableId));
    if (lookupInput) lookupInput.value = model.referencingAttribute;
  };

  const tableOptions = () => tables.map(t => ({
    value: t.id,
    label: (t.displayName || t.logicalName) +
           (t.status === 'Existing' ? '' : '  (' + t.status.toLowerCase() + ')')
  }));

  const validate = () => {
    // A many-to-many has no lookup column at all, so the requirement cannot apply to it. The field
    // is hidden in that case rather than left sitting there empty and mandatory.
    const needsLookup = model.kind !== 'ManyToMany';
    const lookupBlank = needsLookup && !String(model.referencingAttribute || '').trim();

    const problem = model.fromTableId === model.toTableId
      ? 'Choose two different tables. A table cannot look up to itself here - a self-referencing ' +
        'hierarchy is modelled as a proposed lookup column instead.'
      : lookupBlank
        ? 'The intended lookup column needs a name. It is the column the connector is drawn to, ' +
          'and it is what the proposed lookup column on the "many" end card is called.'
        : '';

    if (lookupField) lookupField.hidden = !needsLookup;
    if (lookupInput) markRequired(lookupInput, lookupBlank);
    if (errorNode) errorNode.textContent = problem;
    if (api) api.setPrimaryEnabled(!problem);
    if (summaryNode) paintSummary();
  };

  const paintSummary = () => {
    clear(summaryNode);

    const from = tableById(model.fromTableId);
    const to = tableById(model.toTableId);
    if (!from || !to) return;

    const fromName = from.displayName || from.logicalName;
    const toName = to.displayName || to.logicalName;

    // Cardinality in words. "1:N with the lookup on the many side" is exactly the thing people
    // get backwards on a whiteboard, so the dialog says it rather than leaving it to the arrow.
    summaryNode.appendChild(el('div', { class: 'insp-heading', text: 'What this will draw' }));
    summaryNode.appendChild(el('div', { style: { lineHeight: '1.6' } },
      model.kind === 'ManyToMany'
        ? 'Any number of ' + fromName + ' records related to any number of ' + toName +
          ' records, through an intersect table Dataverse would create.'
        : 'One ' + fromName + ' to many ' + toName + ' records. A proposed lookup column ' +
          '"' + lookupColumnName(model, from) + '" is added to ' + toName +
          ' and the connector is drawn to it.'));

    // A column of that name may already be on the card. If it is a lookup, that is the point - the
    // design is describing something that already exists and the connector anchors to it. If it is
    // not, the relationship will claim a column that is not a lookup at all, which is worth saying
    // rather than leaving to be discovered on the drawing.
    if (model.kind !== 'ManyToMany') {
      const wanted = lookupColumnName(model, from).toLowerCase();
      const clash = (to.columns || []).find(column =>
        String(column.logicalName || '').toLowerCase() === wanted);

      if (clash && !clash.isLookup) {
        summaryNode.appendChild(el('div', {
          class: 'form-error', style: { marginTop: '8px' },
          text: toName + ' already has a column called "' + (clash.logicalName || wanted) +
                '", and it is not a lookup. The relationship will point at that column. Give the ' +
                'lookup a different name if that is not what you mean.'
        }));
      }
    }
  };

  api = openModal({
    title: existing ? 'Edit proposed relationship' : 'Propose a relationship',
    subtitle: 'Design only - nothing is created in Dataverse',
    width: 620,
    padded: true,
    body: () => {
      errorNode = el('div', { class: 'form-error', style: { marginTop: '8px' } });
      summaryNode = el('div', {
        style: {
          marginTop: '14px', padding: '10px 12px', borderRadius: '8px',
          background: 'var(--surface-raised)', border: '1px solid var(--line)',
          fontSize: '11.5px', color: 'var(--ink-3)'
        }
      });

      const fromSelect = select(tableOptions(), model.fromTableId, value => {
        model.fromTableId = value;
        syncDerivedLookupName();
        validate();
      });

      const toSelect = select(tableOptions(), model.toTableId, value => {
        model.toTableId = value;
        validate();
      });

      // A real <button>, so it is in the tab order and draws the browser's focus ring without any
      // extra styling.
      const swapButton = el('button', {
        class: 'btn',
        type: 'button',
        title: 'Swap the two ends: the table at the "one" end becomes the "many" end, and the ' +
               'lookup column moves to the other card with it.',
        // The two pickers each carry .field's 10px bottom margin, and flex-end aligns margin
        // boxes - without the same margin here the button would sit 10px below the selects.
        style: {
          flex: '0 0 auto', display: 'inline-flex', alignItems: 'center',
          gap: '6px', marginBottom: '10px'
        },
        // Swaps the two select values in place, so every field the user has typed is kept and an
        // existing relationship's ends are not reseeded from the saved one.
        onClick: () => {
          const swap = model.fromTableId;
          model.fromTableId = model.toTableId;
          model.toTableId = swap;

          fromSelect.value = model.fromTableId;
          toSelect.value = model.toTableId;
          syncDerivedLookupName();
          validate();
        }
      }, [
        el('span', { class: 'btn-glyph', text: '⇄', 'aria-hidden': 'true' }),
        el('span', { class: 'btn-label', text: 'Swap' })
      ]);

      const fromField = field('From (the "one" end)', fromSelect, null, { required: true });
      const toField = field('To (the "many" end)', toSelect, null, { required: true });

      // A flex row rather than .field-row, which is a two-column grid with no place to put a third
      // thing between its cells.
      for (const node of [fromField, toField]) {
        node.style.flex = '1 1 0';
        node.style.minWidth = '0';
      }

      lookupInput = textInput(model.referencingAttribute, value => {
        model.referencingAttribute = value;
        // The user has taken the name over, so it stops following the table at the one end.
        lookupEdited = true;
        validate();
      });

      lookupField = field('Intended lookup column', lookupInput,
        'Added to the "many" table as a proposed lookup column, with the connector drawn to it. ' +
        'Defaults to a name derived from the table at the one end. Not used for many-to-many.',
        { required: true });

      const body = el('div', {}, [
        el('div', { style: { display: 'flex', alignItems: 'flex-end', gap: '10px' } }, [
          fromField,
          swapButton,
          toField
        ]),

        el('div', { class: 'field-row' }, [
          field('Cardinality', select([
            { value: 'OneToMany', label: 'One to many (1:N)' },
            { value: 'ManyToMany', label: 'Many to many (N:N)' }
          ], model.kind, value => { model.kind = value; validate(); }), null, { required: true }),
          field('Intended schema name', textInput(model.schemaName, value => { model.schemaName = value; }),
            'Optional. A refresh offers to promote this when a relationship with the same schema name appears.')
        ]),

        lookupField,

        field('Intended cascade behaviour', textInput(model.cascadeNotes,
          value => { model.cascadeNotes = value; }),
          'Recorded as intent, for example "Delete: Cascade, Assign: Cascade". Not validated against Dataverse.'),

        field('Note', textArea(model.notes, value => { model.notes = value; })),

        summaryNode,
        errorNode
      ]);

      return body;
    },
    footer: dialog => modalFooter(dialog, {
      primaryLabel: existing ? 'Apply changes' : 'Add to diagram',
      secondary: existing
        ? el('button', {
            class: 'btn danger', text: 'Remove relationship',
            onClick: () => {
              // removeRelationship, not a filter: it takes the lookup column this relationship
              // put on the many-side card with it.
              mutate('remove proposed relationship', () => removeRelationship(existing.id));
              invalidateSizes();
              render();
              renderPanels();
              inspectorNeedsRepaint();
              dialog.close(null);
              toast('Removed the proposed relationship.', 'info');
            }
          })
        : null,
      onPrimary: () => {
        if (model.fromTableId === model.toTableId) return;

        // Same belt and braces as the line above: the primary button is already disabled while
        // either of these holds, but the dialog should never write a relationship it just told
        // the user was not valid.
        if (model.kind !== 'ManyToMany' && !String(model.referencingAttribute || '').trim()) return;

        const from = tableById(model.fromTableId);
        const to = tableById(model.toTableId);

        // Checked once, up here, rather than inside the mutation, so a missing table produces no
        // empty undo entry and the success toast never dereferences null.
        if (!from || !to) {
          toast('One of those tables is no longer on the diagram. Close this and try again.',
            'warning');
          return;
        }

        mutate(existing ? 'edit proposed relationship' : 'propose relationship', () => {
          const payload = {
            id: model.id,
            schemaName: model.schemaName || defaultRelationshipName(from, to),
            displayName: model.schemaName || null,
            kind: model.kind,
            status: 'Proposed',
            fromTableId: from.id,
            toTableId: to.id,
            referencingAttribute: model.kind === 'ManyToMany' ? '' : model.referencingAttribute,
            cascadeNotes: model.cascadeNotes,
            notes: model.notes,
            included: true,
            hidden: false,
            lookupTargets: []
          };

          const target = state.doc.relationships.find(r => r.id === model.id);

          if (target) {
            // Presentation is left alone. highlight and waypoints belong to how the user has
            // arranged the diagram, not to the design being edited here, so editing a connector
            // keeps its emphasis colour and any route the user dragged.
            //
            // Unless the ends have changed - Swap is a button on this very dialog - because then
            // the corners are placed around a shape the connector no longer has, and the route
            // visits them in the reverse order and draws back over itself.
            const repointed = target.fromTableId !== payload.fromTableId ||
              target.toTableId !== payload.toTableId;

            Object.assign(target, payload);
            if (repointed) clearManualRoute(target);
          } else {
            state.doc.relationships.push(Object.assign({ highlight: null, waypoints: [] }, payload));
          }

          // Writes the lookup column onto the table at the many end, renames it if the lookup name
          // has changed, moves it if the many end has, and removes it if this is now an N:N. The
          // connector then anchors to that row rather than to the middle of the card header.
          syncProposedLookupColumn(state.doc.relationships.find(r => r.id === model.id));
        });

        invalidateSizes();
        render();
        renderPanels();
        inspectorNeedsRepaint();
        dialog.close(null);

        toast('Proposed ' + (from.displayName || from.logicalName) + ' → ' +
          (to.displayName || to.logicalName) + '. Dataverse is unchanged.', 'success');
      }
    })
  });

  validate();
}

function defaultRelationshipName(from, to) {
  return 'proposed_' + slug(from.schemaName || from.displayName) + '_' +
         slug(to.schemaName || to.displayName);
}

/**
 * Quick "mark as deprecated" path for an existing table, used from the context menu.
 * The wording makes explicit that this is a diagram annotation, not an environment change.
 */
export function setTableStatus(tableId, status) {
  const table = tableById(tableId);
  if (!table) return;

  mutate('status', () => { table.status = status; });

  // The measured width of a card depends on its status: a non-existing one reserves room for a
  // status badge, and only an existing or deprecated one is given an ownership pill, so the size
  // cache has to be told.
  invalidateSizes();

  render();
  renderPanels();

  // The inspector may be showing this very table, and its Status select is read from the table on
  // build, so it is refreshed to match the card.
  inspectorNeedsRepaint();

  toast(
    (table.displayName || table.logicalName) + ' marked ' + status.toLowerCase() +
    ' on this diagram. Dataverse is unchanged.',
    'info');
}
