// The right-hand inspector: relationship detail, table detail and note editing.

import { el, clear, $, formatDateTime } from './util.js';
import {
  state, mutate, setDirty, tableById, relationshipById, annotationById, subscribe,
  removeTable, removeRelationship, removeAnnotation, clearSelection, effectiveDetail,
  annotationKind, annotationBehind, syncProposedLookupColumn, clearManualRoute, NOTE_DEFAULT_SIZE
} from './state.js';
import { render } from './render.js';
import { renderPanels } from './panels.js';
import { field, textInput, textArea, select, checkbox, statusBadge, toast } from './ui.js';
import { focusTable } from './interact.js';
import { EMPHASIS_COLOURS, emphasisHead, emphasisName } from './theme.js';
import { openProposedTableEditor, openProposedColumnEditor, removeProposedColumn } from './proposed.js';
import { invalidateSizes, visibleColumns, orderedColumns, stickyTilt } from './geometry.js';

export function initInspector() {
  $('#inspector-close').addEventListener('click', hideInspector);

  // The inspector holds a reference to an object in the outgoing document, so every path that
  // replaces the document - Open, New from the wizard, and New from the relationship explorer -
  // closes it here.
  subscribe(reason => { if (reason === 'document-replacing') hideInspector(); });
}

export function hideInspector() {
  $('#inspector').hidden = true;
  markInspectorOpen(false);
}

export function refreshInspector() {
  const panel = $('#inspector');
  const body = clear($('#inspector-body'));

  const relationshipId = firstOf(state.selection.relationships);
  const tableId = firstOf(state.selection.tables);
  const annotationId = firstOf(state.selection.annotations);

  const total = state.selection.tables.size + state.selection.relationships.size + state.selection.annotations.size;

  if (!total) { panel.hidden = true; markInspectorOpen(false); return; }

  panel.hidden = false;
  markInspectorOpen(true);

  if (total > 1) {
    $('#inspector-title').textContent = 'Selection';
    body.appendChild(multiSelectionBody(total));
    return;
  }

  if (relationshipId) {
    $('#inspector-title').textContent = 'Relationship inspector';
    body.appendChild(relationshipBody(relationshipById(relationshipId)));
  } else if (tableId) {
    $('#inspector-title').textContent = 'Table inspector';
    body.appendChild(tableBody(tableById(tableId)));
  } else if (annotationId) {
    const annotation = annotationById(annotationId);
    const kind = annotationKind(annotation);

    $('#inspector-title').textContent =
      kind === 'arrow' ? 'Arrow' : kind === 'text' ? 'Text box' : 'Sticky note';

    body.appendChild(annotationBody(annotation));
  }
}

function firstOf(set) {
  for (const value of set) return value;
  return null;
}

// ------------------------------------------------------------ text fields --

/**
 * A text field whose typing reaches the canvas immediately but the undo history once.
 *
 * mutate() clones the whole document onto the undo stack, so typing is written through silently
 * instead: the card, the connector and the panels update as the user types, and the whole edit is
 * committed as one history entry on change or blur. The commit puts the pre-typing value back
 * first because mutate clones the document *before* it runs its function: that clone is what undo
 * restores, so it has to be the state the user started from rather than the state one keystroke
 * ago.
 *
 * @param build       textInput or textArea from ui.js
 * @param options.label  history label for the single coalesced entry
 * @param options.value  the model's current value
 * @param options.write  applies a value to the model
 * @param options.live   called after every keystroke - keeps the canvas in step while typing
 * @param options.inside optional extra work inside the committing mutation, so it shares the one
 *                       history entry: a lookup rename has to reconcile the column it owns, and
 *                       doing that per keystroke would fight the user's typing
 * @param options.done   optional work after the commit, for what only matters once the edit is final
 * @param options.attrs  passed through to the control
 */
function liveText(build, options) {
  const { label, value, write, live, inside, done, attrs } = options;

  let before = value === undefined || value === null ? '' : String(value);
  let pending = false;

  const control = build(value, next => {
    pending = true;
    mutate(label, () => write(next), { silent: true });

    // Silent means "not a history entry", not "not a change": the diagram really has been edited,
    // and the asterisk has to say so before the field is left rather than after.
    setDirty(true);
    if (live) live();
  }, attrs);

  const finish = () => {
    if (!pending) return;
    pending = false;

    const after = control.value;
    if (after === before) return;

    write(before);
    mutate(label, () => { write(after); if (inside) inside(); });
    before = after;

    if (live) live();
    if (done) done();
  };

  control.addEventListener('change', finish);
  control.addEventListener('blur', finish);

  return control;
}

// ------------------------------------------------------- multi selection --

function multiSelectionBody(total) {
  return el('div', {}, [
    el('div', { class: 'insp-section' }, [
      el('div', { class: 'insp-headline', text: total + ' objects selected' }),
      el('div', { class: 'small muted', style: { marginTop: '6px' } },
        state.selection.tables.size + ' tables, ' +
        state.selection.relationships.size + ' relationships, ' +
        // Not "notes": three arrows selected would read as "3 notes", which misdescribes what the
        // Delete key is about to remove.
        state.selection.annotations.size + ' drawn items')
    ]),
    el('div', { class: 'insp-section' }, [
      el('div', { class: 'insp-heading', text: 'Emphasis' }),
      highlightSwatches(colour => {
        mutate('highlight', () => {
          for (const id of state.selection.tables) { const t = tableById(id); if (t) t.highlight = colour; }
          for (const id of state.selection.relationships) { const r = relationshipById(id); if (r) r.highlight = colour; }
        });
        render();
      })
    ]),
    el('div', { class: 'insp-section' }, [
      el('div', { class: 'insp-actions' }, [
        el('button', {
          class: 'btn danger', text: 'Remove from diagram',
          onClick: () => {
            mutate('remove selection', () => {
              for (const id of Array.from(state.selection.tables)) removeTable(id);
              for (const id of Array.from(state.selection.relationships)) removeRelationship(id);
              for (const id of Array.from(state.selection.annotations)) removeAnnotation(id);
            });
            clearSelection();
            render();
            renderPanels();
            refreshInspector();
          }
        })
      ]),
      el('div', { class: 'small muted', style: { marginTop: '8px' } },
        'Removing objects changes this diagram only. Nothing is deleted from Dataverse.')
    ])
  ]);
}

// -------------------------------------------------------- relationship ----

function relationshipBody(relationship) {
  if (!relationship) return el('div');

  const from = tableById(relationship.fromTableId);
  const to = tableById(relationship.toTableId);
  const isProposed = relationship.status === 'Proposed';

  const container = el('div');

  container.appendChild(el('div', { class: 'insp-section' }, [
    el('div', { class: 'insp-headline' },
      (from ? from.displayName || from.logicalName : '?') + ' → ' + (to ? to.displayName || to.logicalName : '?')),
    el('div', { class: 'insp-schema selectable', text: relationship.schemaName || '(no schema name)' }),
    el('div', { class: 'insp-tags' }, [
      el('span', { class: 'tag accent', text: relationship.kind === 'ManyToMany' ? 'N:N' : '1:N' }),
      el('span', { class: 'tag', text: relationship.isCustom ? 'Custom' : 'System' }),
      relationship.isManaged ? el('span', { class: 'tag', text: 'Managed' }) : null,
      relationship.isHierarchical ? el('span', { class: 'tag', text: 'Hierarchical' }) : null,
      relationship.isPolymorphic ? el('span', { class: 'tag', text: 'Polymorphic lookup' }) : null,
      statusBadge(relationship.status),
      // Hidden or Visible, and nothing else. `included` is no longer written, but it is still read
      // here because a .dvmd file written before tool 1.7.0 can carry included: false.
      el('span', {
        class: 'tag',
        text: relationship.hidden || relationship.included === false ? 'Hidden' : 'Visible'
      }),
      relationship.missingSinceRefresh ? el('span', { class: 'badge badge-missing', text: 'NOT FOUND' }) : null
    ])
  ]));

  if (isProposed) {
    container.appendChild(proposedRelationshipEditor(relationship));
  } else {
    container.appendChild(el('div', { class: 'insp-section' }, [
      el('dl', { class: 'kv' }, [
        el('dt', { text: 'Primary table' }),
        el('dd', {}, [
          from ? (from.displayName || from.logicalName) : '(not on diagram)',
          from && from.logicalName ? el('span', { class: 'mono selectable', text: from.logicalName }) : null
        ]),
        el('dt', { text: 'Related table' }),
        el('dd', {}, [
          to ? (to.displayName || to.logicalName) : '(not on diagram)',
          to && to.logicalName ? el('span', { class: 'mono selectable', text: to.logicalName }) : null
        ]),
        el('dt', { text: 'Primary key' }),
        el('dd', { class: 'mono selectable', text: relationship.referencedAttribute || '-' }),
        el('dt', { text: relationship.kind === 'ManyToMany' ? 'Intersect table' : 'Lookup column' }),
        el('dd', { class: 'mono selectable', text: relationship.kind === 'ManyToMany'
          ? (relationship.intersectEntity || '-')
          : (relationship.referencingAttribute || '-') })
      ])
    ]));

    if (relationship.isPolymorphic && (relationship.lookupTargets || []).length > 1) {
      container.appendChild(el('div', { class: 'insp-section' }, [
        el('div', { class: 'insp-heading', text: 'Polymorphic lookup' }),
        el('div', { class: 'small' },
          'The column ' + relationship.referencingAttribute + ' can point at ' +
          relationship.lookupTargets.length + ' tables, so Dataverse defines a separate relationship for each. ' +
          'Targets: ' + relationship.lookupTargets.join(', ') + '.')
      ]));
    }

    container.appendChild(cascadeSection(relationship));
  }

  container.appendChild(el('div', { class: 'insp-section' }, [
    el('div', { class: 'insp-heading', text: 'On this diagram' }),
    el('div', { class: 'insp-actions' }, [
      el('button', {
        class: 'btn', text: 'Highlight path',
        onClick: () => {
          state.highlightPath = {
            tables: new Set([relationship.fromTableId, relationship.toTableId]),
            relationships: new Set([relationship.id])
          };
          render();
        }
      }),
      el('button', {
        class: 'btn',
        text: relationship.hidden ? 'Show connector' : 'Hide connector',
        onClick: () => {
          mutate('toggle visibility', () => { relationship.hidden = !relationship.hidden; });
          render();
          renderPanels();
          refreshInspector();
        }
      })
    ]),
    el('div', { style: { marginTop: '10px' } }, [
      el('div', { class: 'insp-heading', text: 'Emphasis' }),
      highlightSwatches(colour => {
        mutate('highlight', () => { relationship.highlight = colour; });
        render();
      }, relationship.highlight)
    ]),
    el('div', { style: { marginTop: '10px' } }, [
      field('Status', select([
        { value: 'Existing', label: 'Existing' },
        { value: 'Proposed', label: 'Proposed' },
        { value: 'Deprecated', label: 'Deprecated' }
      ], relationship.status, value => {
        mutate('status', () => {
          relationship.status = value;

          // Hands over, or takes back, the lookup column a proposed relationship owns, so a
          // proposal marked existing leaves a column that can be edited and deleted.
          syncProposedLookupColumn(relationship);
        });

        invalidateSizes();
        render();
        renderPanels();
        refreshInspector();
      }), 'Diagram status only. Nothing here changes Dataverse.')
    ])
  ]));

  container.appendChild(el('div', { class: 'insp-section' }, [
    field('Note', liveText(textArea, {
      label: 'note',
      value: relationship.notes,
      write: value => { relationship.notes = value; },
      live: () => renderPanels(),
      attrs: { placeholder: 'Why this relationship matters, or what is planned for it...' }
    }))
  ]));

  return container;
}

function cascadeSection(relationship) {
  const cascade = relationship.cascade;

  if (!cascade) {
    return el('div', { class: 'insp-section' }, [
      el('div', { class: 'insp-heading', text: 'Cascade behaviour' }),
      el('div', { class: 'small muted' },
        relationship.kind === 'ManyToMany'
          ? 'N:N relationships have no cascade configuration.'
          : 'Cascade configuration was not returned for this relationship.')
    ]);
  }

  const entries = [
    ['Assign', cascade.assign],
    ['Delete', cascade.delete],
    ['Merge', cascade.merge],
    ['Reparent', cascade.reparent],
    ['Share', cascade.share],
    ['Unshare', cascade.unshare]
  ];

  return el('div', { class: 'insp-section' }, [
    el('div', { class: 'insp-heading', text: 'Cascade behaviour' }),
    el('div', { class: 'cascade-grid' }, entries.map(([label, value]) =>
      el('div', { class: 'cascade-cell' + (isNotable(label, value) ? ' is-notable' : '') }, [
        el('span', { text: label }),
        el('span', { text: friendlyCascade(value) })
      ])
    )),
    cascade.rollupView
      ? el('div', { class: 'small muted', style: { marginTop: '7px' } }, 'Roll-up view: ' + friendlyCascade(cascade.rollupView))
      : null,
    el('div', { class: 'small muted', style: { marginTop: '7px' } },
      'Delete behaviour decides what happens to related rows when the primary row is deleted. ' +
      'Cascade removes them, Remove link clears the lookup, Restrict blocks the delete.')
  ]);
}

/** Highlights the settings most likely to surprise someone reviewing a design. */
function isNotable(label, value) {
  if (label === 'Delete' && (value === 'Cascade' || value === 'Restrict')) return true;
  if (label === 'Reparent' && value === 'Cascade') return true;
  return false;
}

function friendlyCascade(value) {
  switch (value) {
    case 'Cascade': return 'Cascade all';
    case 'NoCascade': return 'None';
    case 'Active': return 'Cascade active';
    case 'UserOwned': return 'Cascade user-owned';
    case 'RemoveLink': return 'Remove link';
    case 'Restrict': return 'Restrict';
    case null: case undefined: return '-';
    default: return value;
  }
}

function proposedRelationshipEditor(relationship) {
  const tables = state.doc.tables.map(t => ({ value: t.id, label: t.displayName || t.logicalName }));

  /**
   * Everything this editor changes about a proposed relationship also changes the lookup column
   * that relationship owns on the card at the many end, as the modal editor in proposed.js does.
   * Renaming the lookup renames the column, changing the many end moves it, and switching to N:N
   * removes it, so no column is left behind owned by a living relationship that every removal route
   * would refuse.
   *
   * invalidateSizes because a card that gains or loses a row is a different size.
   */
  const applied = () => {
    invalidateSizes();
    render();
    renderPanels();
    refreshInspector();
  };

  return el('div', { class: 'insp-section' }, [
    el('div', { class: 'insp-heading', text: 'Proposed relationship' }),

    field('Schema name', liveText(textInput, {
      label: 'rename relationship',
      value: relationship.schemaName,
      write: value => { relationship.schemaName = value; },
      live: () => { render(); renderPanels(); }
    })),

    el('div', { class: 'field-row' }, [
      field('Relationship type', select([
        { value: 'OneToMany', label: 'One-to-many (1:N)' },
        { value: 'ManyToMany', label: 'Many-to-many (N:N)' }
      ], relationship.kind, value => {
        mutate('cardinality', () => {
          relationship.kind = value;
          syncProposedLookupColumn(relationship);
        });
        applied();
      })),
      // On change and blur, never on input. lookupColumnName falls back to a derived name when
      // referencingAttribute is empty, so syncing per keystroke would rewrite the box the instant
      // the user cleared it to retype.
      field('Lookup column', liveText(textInput, {
        label: 'lookup',
        value: relationship.referencingAttribute,
        write: value => { relationship.referencingAttribute = value; },
        live: () => render(),
        inside: () => syncProposedLookupColumn(relationship),
        done: applied
      }))
    ]),

    el('div', { class: 'field-row' }, [
      field('Primary table (one)', select(tables, relationship.fromTableId, value => {
        mutate('relationship end', () => {
          relationship.fromTableId = value;
          syncProposedLookupColumn(relationship);

          // The corners the user placed were placed around the cards this connector used to join.
          clearManualRoute(relationship);
        });
        applied();
      })),
      field('Related table (many)', select(tables, relationship.toTableId, value => {
        mutate('relationship end', () => {
          relationship.toTableId = value;
          syncProposedLookupColumn(relationship);
          clearManualRoute(relationship);
        });
        applied();
      }))
    ]),

    field('Intended cascade behaviour', liveText(textArea, {
      label: 'cascade note',
      value: relationship.cascadeNotes,
      write: value => { relationship.cascadeNotes = value; }
    }),
      'Recorded as design intent. It has not been validated against Dataverse.')
  ]);
}

// --------------------------------------------------------------- table ----

function tableBody(table) {
  if (!table) return el('div');

  const container = el('div');
  const relationshipCount = state.doc.relationships.filter(
    r => r.fromTableId === table.id || r.toTableId === table.id).length;

  container.appendChild(el('div', { class: 'insp-section' }, [
    el('div', { class: 'insp-headline', text: table.displayName || table.logicalName }),
    table.logicalName ? el('div', { class: 'insp-schema selectable', text: table.logicalName }) : null,
    el('div', { class: 'insp-tags' }, [
      statusBadge(table.status),
      table.status === 'Existing' ? el('span', { class: 'tag', text: table.isCustom ? 'Custom' : 'System' }) : null,
      table.isActivity ? el('span', { class: 'tag', text: 'Activity' }) : null,
      table.isIntersect ? el('span', { class: 'tag', text: 'Intersect' }) : null,
      table.isManaged ? el('span', { class: 'tag', text: 'Managed' }) : null,
      el('span', { class: 'tag', text: (table.columns || []).length + ' columns' }),
      el('span', { class: 'tag', text: relationshipCount + ' relationships' }),
      table.missingSinceRefresh ? el('span', { class: 'badge badge-missing', text: 'NOT FOUND' }) : null
    ]),
    table.description ? el('div', { class: 'small muted', style: { marginTop: '9px' } }, table.description) : null
  ]));

  if (table.status !== 'Proposed' && table.status !== 'External') {
    container.appendChild(el('div', { class: 'insp-section' }, [
      el('dl', { class: 'kv' }, [
        el('dt', { text: 'Primary key' }),
        el('dd', { class: 'mono selectable', text: table.primaryIdAttribute || '-' }),
        el('dt', { text: 'Primary name' }),
        el('dd', { class: 'mono selectable', text: table.primaryNameAttribute || '-' }),
        el('dt', { text: 'Ownership' }),
        el('dd', { text: describeOwnership(table.ownershipType) }),
        el('dt', { text: 'Object type code' }),
        el('dd', { text: table.objectTypeCode !== undefined && table.objectTypeCode !== null ? String(table.objectTypeCode) : '-' })
      ])
    ]));

    if ((table.alternateKeys || []).length) {
      container.appendChild(el('div', { class: 'insp-section' }, [
        el('div', { class: 'insp-heading', text: 'Alternate keys' }),
        el('div', {}, table.alternateKeys.map(key => el('div', {
          class: 'small', style: { marginBottom: '5px' }
        }, [
          el('strong', { text: key.displayName || key.schemaName }),
          el('div', { class: 'mono muted', text: (key.columns || []).join(', ') }),
          key.state && key.state !== 'Active'
            ? el('div', { class: 'small', style: { color: 'var(--proposed-ink)' }, text: 'Index state: ' + key.state })
            : null
        ])))
      ]));
    }
  }

  container.appendChild(el('div', { class: 'insp-section' }, [
    el('div', { class: 'insp-heading', text: 'Display' }),

    checkbox('Collapse this card', !!table.collapsed, value => {
      mutate('collapse', () => { table.collapsed = value; });
      render();
    }),

    el('div', { style: { marginTop: '10px' } }, [
      el('div', { class: 'insp-heading', text: 'Emphasis' }),
      highlightSwatches(colour => {
        mutate('highlight', () => { table.highlight = colour; });
        render();
      }, table.highlight)
    ])
  ]));

  container.appendChild(el('div', { class: 'insp-section' }, [
    el('div', { class: 'insp-heading', text: 'Status and ownership' }),

    field('Status', select([
      { value: 'Existing', label: 'Existing' },
      { value: 'Proposed', label: 'Proposed' },
      { value: 'External', label: 'External' },
      { value: 'Deprecated', label: 'Deprecated' }
    ], table.status, value => {
      // The card's measured width depends on its status - a non-existing card reserves room for a
      // badge, and only an existing or deprecated one gets an ownership pill - so the size cache
      // has to be told.
      mutate('status', () => { table.status = value; });
      invalidateSizes();
      render();
      renderPanels();
      refreshInspector();
    }), 'Diagram status only. Marking a table deprecated never changes Dataverse.'),

    field('Owner or workstream', liveText(textInput, {
      label: 'owner',
      value: table.owner,
      write: value => { table.owner = value; }
    })),

    table.status !== 'Existing'
      ? el('button', {
          class: 'btn', style: { marginTop: '4px' }, text: 'Edit this table design...',
          onClick: () => openProposedTableEditor(table.id)
        })
      : null
  ]));

  container.appendChild(proposedColumnSection(table));
  container.appendChild(columnSelector(table));

  container.appendChild(el('div', { class: 'insp-section' }, [
    field('Note', liveText(textArea, {
      label: 'note',
      value: table.notes,
      write: value => { table.notes = value; },
      live: () => { render(); renderPanels(); },
      attrs: { placeholder: 'Design decision, assumption, migration instruction...' }
    }))
  ]));

  container.appendChild(el('div', { class: 'insp-section' }, [
    el('div', { class: 'insp-actions' }, [
      el('button', { class: 'btn', text: 'Centre on canvas', onClick: () => focusTable(table.id) }),
      el('button', { class: 'btn danger', text: 'Remove from diagram', onClick: () => {
        mutate('remove table', () => removeTable(table.id));
        render();
        renderPanels();
        refreshInspector();
      }})
    ])
  ]));

  return container;
}

/**
 * Proposed columns on this table, whatever the table's own status. This is where a design that
 * adds a field to a real table lives: the column is drawn on the card in the proposed style, and
 * only ever exists on the diagram.
 */
function proposedColumnSection(table) {
  const section = el('div', { class: 'insp-section' });
  const proposed = (table.columns || []).filter(column => column.status === 'Proposed');

  section.appendChild(el('div', {
    class: 'insp-heading', style: { display: 'flex', alignItems: 'center', gap: '8px' }
  }, [
    el('span', { text: 'Proposed columns' + (proposed.length ? ' · ' + proposed.length : '') }),
    el('span', { style: { flex: '1 1 auto' } }),
    el('button', {
      class: 'text-btn', style: { textTransform: 'none', letterSpacing: '0' }, text: '+ Propose',
      onClick: () => openProposedColumnEditor(table.id)
    })
  ]));

  if (!proposed.length) {
    section.appendChild(el('div', {
      class: 'small muted', style: { lineHeight: '1.5' },
      text: table.status === 'Existing'
        ? 'None. Proposing a column records a field this table should gain, drawn in the proposed style alongside the real ones.'
        : 'None yet. Use "Edit this table design" to describe several at once, or propose them one at a time here.'
    }));
    return section;
  }

  for (const column of proposed) {
    // A lookup a proposed relationship owns is listed - it is on the card and the user should see
    // it - but it is not this list's to edit or delete, so it gets no cross or pencil.
    const owner = livingOwner(column);

    section.appendChild(el('div', { class: 'proposed-row' }, [
      el('span', {
        class: 'mono small',
        text: column.isPrimaryId ? 'PK' : column.isLookup ? 'FK' : '  '
      }),
      el('span', { class: 'pr-name', text: column.displayName || column.logicalName || '(unnamed)' }),
      el('span', { class: 'pr-type', text: column.typeName || '' }),
      el('button', {
        class: 'icon-btn', html: '&#9998;',
        title: owner
          ? 'Edit the proposed relationship this lookup belongs to'
          : 'Edit this proposed column',
        onClick: () => openProposedColumnEditor(table.id, column.id)
      }),
      owner
        ? el('span', {
            class: 'pr-type', style: { flex: '0 0 auto' },
            title: 'Created by the proposed relationship ' + (owner.schemaName || '') +
                   '. It goes when that relationship does.',
            text: 'from a relationship'
          })
        : el('button', {
            class: 'icon-btn', html: '&times;', title: 'Remove this proposed column',
            onClick: () => removeProposedColumn(table.id, column.id)
          })
    ]));
  }

  return section;
}

/**
 * Everything on this table's card is drawn if, and only if, its column is ticked below.
 *
 * `column.selected` is a permission - "this column may be drawn" - not a statement that it is being
 * drawn. In Relationship-columns mode a card shows only the key and the lookups, so the tick shows
 * what is actually drawn rather than the raw flag.
 *
 * Switching to All selected columns first writes the currently drawn set into the flags, so the
 * card does not change at the moment of switching, and the next tick adds exactly one column to it.
 */
function columnSelector(table) {
  const section = el('div', { class: 'insp-section' });

  section.appendChild(field('How much detail this table shows', select([
    { value: '', label: 'Follow diagram setting' },
    { value: 'TablesOnly', label: 'Table name only' },
    { value: 'RelationshipFields', label: 'Relationship columns' },
    { value: 'AllFields', label: 'All selected columns' }
  ], table.detailOverride || '', value => {
    mutate('detail override', () => {
      if (value === 'AllFields') seedFromCard(table);
      table.detailOverride = value || null;
    });

    invalidateSizes();
    render();
    refreshInspector();
  })));

  if (!(table.columns || []).length) {
    section.appendChild(el('div', { class: 'small muted', text: 'This table has no columns on the diagram yet.' }));
    return section;
  }

  const search = el('input', {
    type: 'search', placeholder: 'Filter columns...',
    class: 'selectable',
    style: {
      width: '100%', marginBottom: '8px', padding: '5px 8px',
      border: '1px solid var(--line-strong)', borderRadius: '6px', background: 'var(--surface-input)'
    }
  });

  const list = el('div', { style: { maxHeight: '220px', overflow: 'auto' } });

  function paint() {
    clear(list);
    const term = search.value.toLowerCase();
    const drawn = new Set(visibleColumns(table).map(column => column.id));

    // In the order the card draws them, not the order the metadata lists them. The two differ once
    // a row has been dragged.
    for (const column of orderedColumns(table)) {
      const label = (column.displayName || '') + ' ' + (column.logicalName || '');
      if (term && !label.toLowerCase().includes(term)) continue;

      list.appendChild(columnRow(table, column, drawn.has(column.id), paint));
    }
  }

  search.addEventListener('input', paint);
  paint();

  section.appendChild(el('div', { class: 'insp-heading' }, [
    'Columns on this card',
    el('span', { style: { float: 'right' } }, [
      el('button', {
        class: 'text-btn', text: 'All',
        title: 'Draw every column, switching this table to all selected columns',
        onClick: () => {
          mutate('column visibility', () => {
            table.columns.forEach(c => { c.selected = true; });
            table.detailOverride = 'AllFields';
            table.collapsed = false;
          });
          invalidateSizes();
          render();
          refreshInspector();
        }
      }),
      el('button', {
        class: 'text-btn', text: 'None',
        onClick: () => {
          // Same rule as the individual tick: a lookup a proposed relationship owns is not the
          // user's to take off the card, so this button leaves it ticked.
          mutate('column visibility', () => {
            table.columns.forEach(c => { if (!livingOwner(c)) c.selected = false; });
          });
          invalidateSizes();
          render();
          refreshInspector();
        }
      })
    ])
  ]));
  section.appendChild(search);
  section.appendChild(list);
  section.appendChild(el('div', { class: 'small muted', style: { marginTop: '8px', lineHeight: '1.5' } },
    'A tick means the column is on the card right now, and exports draw the same set. Ticking one ' +
    'the current detail level would not show switches this table to all selected columns and adds ' +
    'that column alone. The clock marks a column as deprecated on this diagram - it is drawn ' +
    'struck through, and Dataverse is not touched.'));

  return section;
}

/**
 * Writes the card a table is showing right now into its per-column `selected` flags, so that moving
 * it to All selected columns does not change what is drawn.
 *
 * Only from Relationship columns. That is the one mode that draws a chosen subset - the key, the
 * lookups behind the connectors on screen and anything proposed - so it is the one mode where "the
 * card it already had" means something.
 *
 * From Table name only, or from a collapsed card, nothing is drawn at all, and reading that as the
 * card to preserve would untick every column. That could not be recovered without undo, because
 * visibleColumns filters on `selected` before it applies any of the relationship rules and before
 * the never-show-an-empty-card fallback - so the table would draw no columns at any detail level.
 *
 * Proposed columns are never unticked either way: they are drawn at every detail level, and losing
 * one here would lose part of the design.
 */
export function seedFromCard(table) {
  if (effectiveDetail(table) !== 'RelationshipFields') return;

  const drawn = new Set(visibleColumns(table).map(column => column.id));
  if (!drawn.size) return;

  applyCardSelection(table, drawn);
}

/**
 * Puts one column onto a table's card, whatever detail level the card is on.
 *
 * Ticking a column on a table left on Relationship columns would change nothing on screen, so the
 * table moves to All selected columns and then shows the card the user was already looking at plus
 * the one column they ticked.
 *
 * That card is read before anything changes. On a tables-only or collapsed card it is empty, and
 * the result is a card with just this one column on it.
 *
 * @returns true when the table's own detail level was changed, so the caller knows to say so.
 */
export function addColumnToCard(table, column) {
  const switched = effectiveDetail(table) !== 'AllFields';

  const keep = new Set(visibleColumns(table).map(entry => entry.id));
  keep.add(column.id);

  mutate('column visibility', () => {
    if (switched) {
      applyCardSelection(table, keep);
      table.detailOverride = 'AllFields';
      table.collapsed = false;
    } else {
      column.selected = true;
    }
  });

  return switched;
}

/**
 * Makes a chosen set of columns the card, by writing it into the per-column `selected` flags.
 *
 * Proposed columns are always kept: they are drawn at every detail level, and dropping one here
 * would lose part of a design rather than change a display setting.
 */
function applyCardSelection(table, keepIds) {
  for (const column of table.columns || []) {
    column.selected = keepIds.has(column.id) || column.status === 'Proposed';
  }
}

/**
 * One column row: a tick saying whether it is on the card, and a deprecate toggle.
 *
 * A real table's *metadata* is never editable here - deprecating records a diagram-level intention
 * to retire the column, exactly as for a table or a relationship.
 */
/**
 * The proposed relationship a column belongs to, or null.
 *
 * Null once the relationship has been marked existing or has gone: a settled lookup is an ordinary
 * column again, and the ordinary controls have to apply to it or it is stuck on the card for ever.
 */
function livingOwner(column) {
  if (!column || !column.fromRelationshipId) return null;

  const owner = relationshipById(column.fromRelationshipId);
  return owner && owner.status === 'Proposed' ? owner : null;
}

/** How to name the owning relationship in a message. */
function ownerName(relationship) {
  return relationship && relationship.schemaName ? '"' + relationship.schemaName + '"' : 'it';
}

function columnRow(table, column, onCard, repaint) {
  const deprecated = column.status === 'Deprecated';
  const owner = livingOwner(column);
  const marker = column.isPrimaryId ? 'PK' : column.isLookup ? 'FK' : '';

  const box = el('span', {
    class: 'chk' + (onCard ? ' is-on' : ''),
    html: onCard ? '&#10003;' : ''
  });

  return el('div', {
    class: 'column-row' + (deprecated ? ' is-deprecated' : ''),
    style: { display: 'flex', alignItems: 'center', gap: '8px' },
    title: onCard
      ? 'On the card. Click to take it off.'
      : 'Not on the card. Click to add it.'
  }, [
    el('span', {
      class: 'toggle',
      style: { display: 'inline-flex', alignItems: 'center', gap: '8px', flex: '1 1 auto', margin: 0, minWidth: 0 },
      onClick: () => {
        if (onCard) {
          // A lookup a proposed relationship owns is not the user's to take off the card: the
          // connector anchors to its row, every export includes it, and the sync writes selected:
          // true back whenever the relationship changes.
          if (owner) {
            toast('This lookup is part of the proposed relationship ' + ownerName(owner) +
              ', so it stays on the card while that relationship does.', 'warning');
            return;
          }

          mutate('column visibility', () => { column.selected = false; });
          invalidateSizes();
          render();
          repaint();
          return;
        }

        const switched = addColumnToCard(table, column);

        invalidateSizes();
        render();

        if (switched) {
          toast('This table now shows the columns you tick. The rest of the diagram is unchanged.', 'info');
          refreshInspector();
          return;
        }

        repaint();
      }
    }, [
      box,
      el('span', {
        style: {
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          textDecoration: deprecated ? 'line-through' : 'none'
        },
        text: (column.displayName || column.logicalName) + (marker ? '  (' + marker + ')' : '')
      })
    ]),

    statusBadge(column.status),

    el('button', {
      class: 'icon-btn' + (deprecated ? ' is-on' : ''),
      html: '&#9201;',
      title: deprecated
        ? 'This column is marked deprecated on the diagram. Click to clear that.'
        : 'Mark this column as deprecated on the diagram. Dataverse is not changed.',
      onClick: event => {
        event.stopPropagation();

        // Named, and checked before the Proposed test. A relationship's lookup cannot be
        // deprecated on its own at any status: a lookup column and its relationship are one object
        // in Dataverse, so a card drawn struck through beside a connector drawn as live says two
        // contradictory things about the same thing.
        if (owner) {
          toast('This lookup is part of the proposed relationship ' + ownerName(owner) +
            '. Change that relationship\'s status and the column follows it.', 'warning');
          return;
        }

        if (column.fromRelationshipId && relationshipById(column.fromRelationshipId)) {
          toast('This lookup belongs to a relationship on the diagram. Mark that relationship ' +
            'deprecated and the column follows it.', 'warning');
          return;
        }

        if (column.status === 'Proposed') {
          toast('A proposed column does not exist yet, so it cannot be deprecated. Remove it ' +
            'instead, from the "Proposed columns" list above.', 'warning');
          return;
        }

        mutate('column status', () => {
          column.status = deprecated ? 'Existing' : 'Deprecated';
        });

        invalidateSizes();
        render();
        renderPanels();
        repaint();
      }
    })
  ]);
}

// ---------------------------------------------------------------- note ----

/** Preset widths, plus whatever the note has been dragged to, so the control never lies. */
function widthOptions(current) {
  const rounded = Math.round(Number(current) || 0);
  const widths = [140, 180, 220, 260, 320, 400];

  if (rounded > 0 && !widths.includes(rounded)) widths.push(rounded);
  widths.sort((a, b) => a - b);

  return widths.map(width => ({ value: String(width), label: width + ' px' }));
}

/**
 * Tells the stylesheet whether the inspector is on screen.
 *
 * The legend is painted underneath the panels, and its default corner is directly below the
 * inspector, so while the inspector is open the default corner steps aside to keep the legend and
 * its right-click menu reachable. A legend the user has dragged somewhere is left exactly where
 * they put it - its inline `right: auto` beats the rule in the stylesheet.
 */
function markInspectorOpen(open) {
  if (document.body && document.body.classList) {
    document.body.classList.toggle('inspector-open', !!open);
  }
}

/**
 * Angles offered for a sticky note, plus whatever it is standing at, so the control never lies.
 *
 * The current angle is rounded to a whole degree for the comparison as well as for the label: the
 * canvas derives an untouched note's slant to one decimal place, and a select whose value is not
 * among its options shows the first one instead, so a note at -1.3 would read "-45 degrees".
 */
function angleOptions(current) {
  const rounded = roundAngle(current);
  // Out to a half turn either way, because the handle goes that far and this box is the only way in
  // without a mouse.
  //
  // A half turn is listed once, as -180. wrapDegrees folds an angle into [-180, 180), so the
  // handle can never produce +180 and offering both would be two entries for one note - picking
  // the one it was not standing at would appear to do nothing. A file that carries 180 gets it
  // back from the line below, which adds whatever the note is actually at.
  const angles = [-180, -135, -90, -60, -45, -30, -20, -15, -10, -5, 0,
                  5, 10, 15, 20, 30, 45, 60, 90, 135];

  if (!angles.includes(rounded)) angles.push(rounded);
  angles.sort((a, b) => a - b);

  return angles.map(angle => ({
    value: String(angle),
    label: angle === 0 ? 'Straight' : (angle > 0 ? '+' : '') + angle + '\u00b0'
  }));
}

/** A tilt as a whole number of degrees, with -0 folded onto 0 so it matches the "Straight" entry. */
function roundAngle(value) {
  const rounded = Math.round(Number(value) || 0);
  return rounded === 0 ? 0 : rounded;
}

/** Ink colours offered for a text box and an arrow. Chosen to stay legible in both themes. */
const INK_COLOURS = [
  '#101725', '#1f5fe0', '#0f7b8a', '#16a34a', '#c98a12', '#d9722f', '#c0392f', '#7a4fd1'
];

function annotationBody(annotation) {
  if (!annotation) return el('div');

  const kind = annotationKind(annotation);
  if (kind === 'arrow') return arrowBody(annotation);

  // Relationships as well as tables. A note explaining why a cascade is set the way it is belongs
  // on the connector, not on one of the two tables it happens to touch.
  const targets = [{ value: '', label: 'Not attached' }]
    .concat(state.doc.tables.map(t => ({
      value: t.id,
      label: 'Table:  ' + (t.displayName || t.logicalName)
    })))
    .concat(state.doc.relationships.map(r => {
      const from = tableById(r.fromTableId);
      const to = tableById(r.toTableId);
      const ends = (from ? from.displayName || from.logicalName : '?') + ' → ' +
                   (to ? to.displayName || to.logicalName : '?');

      return { value: r.id, label: 'Relationship:  ' + (r.schemaName || ends) };
    }));

  const isText = kind === 'text';

  return el('div', {}, [
    el('div', { class: 'insp-section' }, [
      field('Text', liveText(textArea, {
        label: 'note text',
        value: annotation.text,
        write: value => { annotation.text = value; },
        live: () => { render(); renderPanels(); },
        attrs: {
          rows: 6,
          placeholder: isText
            ? 'A label for this part of the canvas...'
            : 'Design decision, assumption, warning...'
        }
      }))
    ]),
    el('div', { class: 'insp-section' }, [
      el('div', { class: 'field-row' }, [
        field('Font size', select(
          [10, 11, 12, 13, 14, 16, 18, 22, 28, 36].map(size => ({ value: String(size), label: size + ' px' })),
          String(annotation.fontSize || 14),
          value => { mutate('note style', () => { annotation.fontSize = Number(value); }); render(); })),
        // The current width is always in the list. A select whose value is not among its options
        // falls back to showing the first one, and touching it would then snap the note to that
        // width.
        //
        // Width only; the height is the grip's job, because a sticky note resizes freely and this
        // box must not change the other side.
        field('Width', select(
          widthOptions(annotation.width || (isText ? 220 : NOTE_DEFAULT_SIZE)),
          String(Math.round(annotation.width || (isText ? 220 : NOTE_DEFAULT_SIZE))),
          value => { mutate('note style', () => { annotation.width = Number(value); }); render(); }))
      ]),

      // Notes only, matching the handle on the canvas: a text box is words, and words at an angle
      // are harder to read for nothing gained.
      //
      // Here as well as on the canvas because the handle is mouse-only and is drawn above the top
      // edge of the note - which can be off screen, or under a card if the note has been sent
      // behind one. "Straight" is a listed value rather than something to hunt for by hand: a note
      // that has never been turned carries the small derived slant, and putting it back is
      // otherwise impossible with a pointer.
      isText ? null : field('Angle', select(
        angleOptions(stickyTilt(annotation)),
        String(roundAngle(stickyTilt(annotation))),
        value => {
          mutate('note angle', () => { annotation.tilt = Number(value); });
          render();
        }), 'Or drag the round handle above a selected note on the canvas. Hold Shift for 15 ' +
            'degree steps and Ctrl for fine adjustment.'),

      el('div', { class: 'small muted', style: { marginBottom: '8px' } },
        'Drag the grip in the bottom-right corner to size it on the canvas.'),
      checkbox('Bold', !!annotation.bold, value => {
        mutate('note style', () => { annotation.bold = value; });
        render();
      }),

      // Which side of the table cards this is drawn on. Painting order is hit-test order, so this
      // decides whether the annotation can be picked up where it overlaps a card as well as
      // whether it can be seen there - which is why the hint says so.
      field('Depth', select([
        { value: 'front', label: 'In front of the model' },
        { value: 'behind', label: 'Behind the model' }
      ], annotationBehind(annotation) ? 'behind' : 'front', value => {
        mutate('annotation depth', () => { annotation.behind = value === 'behind'; });
        render();
      }), 'Behind puts it under the cards and the relationship lines both, so anything drawn over ' +
          'it hides it and clicking there selects the card or the connector. Exports draw it on ' +
          'the same side.'),

      field('Attach to', select(targets, annotation.attachedToId || '', value => {
        mutate('note attach', () => { annotation.attachedToId = value || null; });
        render();
        renderPanels();
      }), 'Draws a dashed leader line to the table card, or to the middle of the connector.')
    ]),

    // A text box has no paper to colour, so it gets ink instead. Offering it a background would
    // turn it into a note, which is the one thing it exists not to be.
    isText
      ? el('div', { class: 'insp-section' }, [
          el('div', { class: 'insp-heading', text: 'Text colour' }),
          el('div', { class: 'swatch-row' },
            INK_COLOURS.map(ink => el('button', {
              class: 'swatch-btn' + (annotation.ink === ink ? ' is-picked' : ''),
              style: { background: ink, borderColor: ink },
              title: ink,
              onClick: () => {
                mutate('text colour', () => { annotation.ink = ink; });
                render();
                refreshInspector();
              }
            })))
        ])
      : el('div', { class: 'insp-section' }, [
          el('div', { class: 'insp-heading', text: 'Paper' }),
          el('div', { class: 'swatch-row' }, [
            ['#fff8e1', '#e8d9a8'], ['#eaf1ff', '#d3e0f8'], ['#f1e9ff', '#ddd0f5'],
            ['#fbe6e2', '#f3cdc7'], ['#e9f7ef', '#c3e6d0'], ['#ffffff', '#e4e9f2']
          ].map(([background, border]) => el('button', {
            class: 'swatch-btn' + (annotation.background === background ? ' is-picked' : ''),
            style: { background, borderColor: border },
            onClick: () => {
              mutate('note colour', () => { annotation.background = background; annotation.border = border; });
              render();
              refreshInspector();
            }
          })))
        ]),

    el('div', { class: 'insp-section' }, [
      el('button', {
        class: 'btn danger', text: isText ? 'Delete text box' : 'Delete sticky note',
        onClick: () => {
          mutate('delete note', () => removeAnnotation(annotation.id));
          clearSelection();
          render();
          renderPanels();
          refreshInspector();
        }
      })
    ])
  ]);
}

/**
 * An arrow has no text and nothing to attach to - it points, and that is all it does. What it does
 * have is a colour, which is the whole reason it is worth having as an object rather than a note
 * with a line drawn on it.
 */
function arrowBody(annotation) {
  const length = Math.round(Math.hypot(Number(annotation.dx) || 0, Number(annotation.dy) || 0));

  return el('div', {}, [
    el('div', { class: 'insp-section' }, [
      el('div', { class: 'small muted', style: { lineHeight: '1.5' } },
        'Drag the arrow to move it, or either round handle to re-aim it. Hold Ctrl while dragging ' +
        'for fine adjustment and Shift to keep it to 45 degrees.'),
      el('div', { class: 'small muted', style: { marginTop: '6px' },
        text: length + ' units long' })
    ]),
    // The arrow's own copy of the Depth control. The context menu offers it for every annotation
    // kind, but an arrow sent behind a card cannot be right-clicked where the card covers it, so
    // this is how it is brought forward again.
    el('div', { class: 'insp-section' }, [
      field('Depth', select([
        { value: 'front', label: 'In front of the model' },
        { value: 'behind', label: 'Behind the model' }
      ], annotationBehind(annotation) ? 'behind' : 'front', value => {
        mutate('annotation depth', () => { annotation.behind = value === 'behind'; });
        render();
      }), 'Behind puts it under the cards and the relationship lines both.')
    ]),
    el('div', { class: 'insp-section' }, [
      el('div', { class: 'insp-heading', text: 'Colour' }),
      el('div', { class: 'swatch-row' },
        INK_COLOURS.map(ink => el('button', {
          class: 'swatch-btn' + (annotation.ink === ink ? ' is-picked' : ''),
          style: { background: ink, borderColor: ink },
          title: ink,
          onClick: () => {
            mutate('arrow colour', () => { annotation.ink = ink; });
            render();
            refreshInspector();
          }
        })))
    ]),
    el('div', { class: 'insp-section' }, [
      el('button', {
        class: 'btn danger', text: 'Delete arrow',
        onClick: () => {
          mutate('delete arrow', () => removeAnnotation(annotation.id));
          clearSelection();
          render();
          renderPanels();
          refreshInspector();
        }
      })
    ])
  ]);
}

// -------------------------------------------------------------- shared ----

/**
 * Emphasis swatches. Each is painted with the header tint the card will get, bordered in the
 * saturated hue - the same two colours the canvas uses - so the button previews the result
 * rather than standing in for it with an unrelated dot.
 */
function highlightSwatches(onPick, current) {
  const none = el('button', {
    class: 'swatch-btn none' + (current ? '' : ' is-picked'),
    title: 'No emphasis',
    onClick: () => onPick(null)
  });

  const row = el('div', { class: 'swatch-row' }, [none].concat(EMPHASIS_COLOURS.map(entry => el('button', {
    class: 'swatch-btn' + (current === entry.value ? ' is-picked' : ''),
    style: {
      background: emphasisHead(entry.value),
      borderColor: entry.value
    },
    title: emphasisName(entry.value),
    onClick: () => onPick(entry.value)
  }))));

  if (!current) return row;

  // Naming a colour puts its meaning in the legend and in the export, where the reader is.
  //
  // The dialog itself lives in app.js beside the legend it feeds; an event rather than an import
  // because app.js already imports this module.
  return el('div', {}, [
    row,
    el('button', {
      class: 'text-btn',
      style: { paddingLeft: 0 },
      text: 'Name this colour: ' + emphasisName(current),
      onClick: () => window.dispatchEvent(
        new CustomEvent('dmd:name-colour', { detail: { colour: current } }))
    })
  ]);
}

/**
 * Ownership in words. Kept here as well as in RefreshService because the inspector needs it
 * synchronously and the refresh summary needs it host-side - the same reason the column
 * visibility rules exist in both runtimes. Two short switch statements, both marked.
 */
function describeOwnership(ownershipType) {
  switch (ownershipType) {
    case 'UserOwned': return 'User or team owned';
    case 'TeamOwned': return 'Team owned';
    case 'OrganizationOwned': return 'Organisation owned';
    case 'BusinessOwned': return 'Business unit owned';
    case 'BusinessParented': return 'Business unit parented';
    case 'None': return 'Not owned';
    default: return ownershipType || '-';
  }
}
