// The left panel: model contents, relationship inclusion and notes.

import { el, clear, $, $$, matchesSearch, sortBy, plural } from './util.js';
import {
  state, mutate, tableById, relationshipById, visibleRelationships,
  relationshipsForTable, selectOnly, clearSelection, notify, annotationKind
} from './state.js';
import { render } from './render.js';
import { focusTable, fitToView } from './interact.js';
import { statusBadge } from './ui.js';
import { emphasisName } from './theme.js';

let activeTab = 'model';
let searchTerm = '';
let onInspect = () => {};

export function initPanels(handlers) {
  onInspect = handlers.onInspect || onInspect;

  $$('.panel-tab').forEach(tab => {
    tab.addEventListener('click', () => showTab(tab.dataset.tab));
  });

  $('#panel-search').addEventListener('input', event => {
    searchTerm = event.target.value;
    renderPanels();
  });

  $('#left-panel-toggle').addEventListener('click', () => {
    $('#left-panel').classList.toggle('is-collapsed');
  });
}

/**
 * Switches the left panel to one of its three tabs and repaints it.
 *
 * Exported rather than kept inside the click handler, so the tab can be chosen by something other
 * than a mouse - the tab buttons only exist in index.html, and the verification suite builds
 * every tab through this.
 */
export function showTab(name) {
  activeTab = ['model', 'relationships', 'notes'].includes(name) ? name : 'model';

  $$('.panel-tab').forEach(tab => tab.classList.toggle('is-active', tab.dataset.tab === activeTab));
  $('#tab-model').hidden = activeTab !== 'model';
  $('#tab-relationships').hidden = activeTab !== 'relationships';
  $('#tab-notes').hidden = activeTab !== 'notes';

  renderPanels();
}

export function renderPanels() {
  if (activeTab === 'model') renderModelTab();
  else if (activeTab === 'relationships') renderRelationshipTab();
  else renderNotesTab();
}

// ---------------------------------------------------------------- model ---

function renderModelTab() {
  const container = clear($('#tab-model'));
  const tables = state.doc.tables;

  if (!tables.length && !searchTerm) {
    container.appendChild(el('div', {
      class: 'empty-note',
      text: 'Nothing on the canvas yet. Use "Add existing tables" to pick from a solution or the environment catalogue, or "Explore relationships" to walk out from one table.'
    }));
    return;
  }

  const matching = tables.filter(table => matchesSearch(tableHaystack(table), searchTerm));

  container.appendChild(el('div', { class: 'group-head' }, [
    el('span', { text: 'In diagram · ' + matching.length + (matching.length !== tables.length ? ' of ' + tables.length : '') }),
    el('button', { class: 'text-btn', text: 'Fit view', onClick: () => fitToView() })
  ]));

  const counts = new Map();
  for (const relationship of visibleRelationships()) {
    counts.set(relationship.fromTableId, (counts.get(relationship.fromTableId) || 0) + 1);
    counts.set(relationship.toTableId, (counts.get(relationship.toTableId) || 0) + 1);
  }

  // Hub detection is relative rather than absolute: "connected to three other tables" means
  // something different in a diagram of five tables and one of eighty. A table is called a hub
  // when it carries at least twice the average number of connectors and at least three of them.
  const degrees = Array.from(counts.values());
  const average = degrees.length ? degrees.reduce((a, b) => a + b, 0) / tables.length : 0;
  const hubThreshold = Math.max(3, Math.ceil(average * 2));

  for (const table of sortBy(matching, t => t.displayName || t.logicalName || '')) {
    const count = counts.get(table.id) || 0;
    const selected = state.selection.tables.has(table.id);
    const isHub = count >= hubThreshold;

    container.appendChild(el('div', {
      class: 'row' + (selected ? ' is-selected' : ''),
      onClick: () => {
        selectOnly('tables', table.id);
        render();
        focusTable(table.id);
        onInspect();
        renderPanels();
      }
    }, [
      tableMark(table),
      el('span', { class: 'row-name', text: table.displayName || table.logicalName }),
      table.missingSinceRefresh ? el('span', { class: 'badge badge-missing', text: 'NOT FOUND' }) : null,
      statusBadge(table.status),
      isHub
        ? el('span', {
            class: 'tag tag-hub', text: 'HUB',
            title: 'One of the most connected tables on this diagram (' + count + ' connectors)'
          })
        : null,
      el('span', {
        class: 'row-meta' + (count ? '' : ' is-orphan'),
        title: count ? '' : 'No connectors are drawn to this table on this diagram',
        text: count ? count + ' rel.' : 'no rel.'
      })
    ]));
  }

  // Columns that matched the search but whose table did not, so a match on a column name shows
  // which column it was.
  if (searchTerm) {
    const columnHits = [];

    for (const table of tables) {
      for (const column of table.columns || []) {
        if (!matchesSearch([column.displayName, column.logicalName, column.schemaName].join(' '), searchTerm)) continue;
        columnHits.push({ table, column });
        if (columnHits.length >= 60) break;
      }
      if (columnHits.length >= 60) break;
    }

    if (columnHits.length) {
      container.appendChild(el('div', { class: 'group-head' }, [
        el('span', { text: 'Matching columns · ' + columnHits.length })
      ]));

      for (const hit of columnHits) {
        container.appendChild(el('div', {
          class: 'row',
          style: { flexDirection: 'column', alignItems: 'flex-start', gap: '2px' },
          onClick: () => {
            selectOnly('tables', hit.table.id);
            render();
            focusTable(hit.table.id);
            onInspect();
            renderPanels();
          }
        }, [
          el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', width: '100%' } }, [
            el('span', { class: 'row-name', text: hit.column.displayName || hit.column.logicalName }),
            statusBadge(hit.column.status),
            el('span', {
              class: 'row-meta',
              text: hit.column.isPrimaryId ? 'PK' : hit.column.isLookup ? 'FK' : (hit.column.typeName || '')
            })
          ]),
          el('div', { class: 'row-sub' }, 'on ' + (hit.table.displayName || hit.table.logicalName))
        ]));
      }
    }

    container.appendChild(environmentSearchSection());
  }
}

/**
 * The mark at the left of a row in the model list.
 *
 * It carries the table's emphasis colour when one has been applied, and its status colour when one
 * has not, so the list, the cards and the legend all agree on the colour scheme on the canvas.
 *
 * Status is not lost: the badge further along the same row says it in words, which is the only
 * thing on the row that says it at all for anyone who cannot tell the two blues apart.
 */
function tableMark(table) {
  const colour = table.highlight;
  const status = table.status || 'Existing';

  // The tooltip names both. Four of the twelve emphasis colours are the same hex as one of the four
  // status colours, and a table whose status is Existing carries no badge on its row - so an
  // Existing table emphasised in red shows the same mark a deprecated one does, and hovering it is
  // the only way to tell which it is.
  return el('span', {
    class: 'status-mark st-' + status.toLowerCase() + (colour ? ' is-emphasis' : ''),
    style: colour ? { background: colour } : null,
    title: colour ? emphasisName(colour) + ' \u00b7 ' + status : status
  });
}

function tableHaystack(table) {
  return [table.displayName, table.logicalName, table.schemaName].join(' ');
}

// ------------------------------------------------- environment search -----

/**
 * Tables in the environment that match the search but are not on the canvas, with a button to add
 * each one.
 *
 * Covers what people most often type into a search box: the name of a table they want and have
 * not added yet. The catalogue is cached for the life of the connection, so this costs nothing
 * once it has been read.
 */
function environmentSearchSection() {
  const section = el('div');
  const catalogue = cachedCatalogue();

  if (!state.connection || !state.connection.connected) return section;

  if (!catalogue) {
    // Not read yet. Offered rather than fetched automatically: reading the catalogue on the first
    // keystroke in a search box would be a surprising place for a multi-second wait.
    section.appendChild(el('div', { class: 'group-head' }, [
      el('span', { text: 'Elsewhere in the environment' })
    ]));

    section.appendChild(el('div', { class: 'empty-note' }, [
      el('div', { style: { marginBottom: '8px' } },
        'Search the whole environment as well, not just this diagram.'),
      el('button', {
        class: 'btn', text: 'Read the table catalogue',
        onClick: () => {
          import('./sourcepicker.js').then(module => {
            import('./ui.js').then(ui =>
              ui.withProgress('Reading the environment...', module.ensureCatalogue)
                .then(() => renderPanels())
                .catch(() => {}));
          });
        }
      })
    ]));

    return section;
  }

  const onCanvas = new Set(state.doc.tables
    .filter(t => t.logicalName)
    .map(t => t.logicalName.toLowerCase()));

  const hits = catalogue
    .filter(summary => !onCanvas.has((summary.logicalName || '').toLowerCase()))
    .filter(summary => matchesSearch(
      [summary.displayName, summary.logicalName, summary.schemaName].join(' '), searchTerm))
    .slice(0, 25);

  if (!hits.length) return section;

  section.appendChild(el('div', { class: 'group-head' }, [
    el('span', { text: 'Elsewhere in the environment · ' + hits.length }),
    el('span', { class: 'row-meta', text: 'not on this diagram' })
  ]));

  for (const summary of hits) {
    section.appendChild(el('div', {
      class: 'row',
      style: { alignItems: 'center' }
    }, [
      el('span', { class: 'status-mark st-existing' }),
      el('span', { class: 'row-name', text: summary.displayName || summary.logicalName }),
      el('span', { class: 'row-meta', text: summary.isCustom ? 'Custom' : 'System' }),
      el('button', {
        class: 'text-btn', text: 'Add',
        title: 'Add this table to the diagram, with any relationships it has to what is already here',
        onClick: event => {
          event.stopPropagation();
          addFromSearch(summary.logicalName);
        }
      })
    ]));
  }

  return section;
}

function cachedCatalogue() {
  // Read off state rather than importing sourcepicker.js, which imports this module. A static
  // import back the other way would close that loop; parking the catalogue on state keeps the
  // dependency one-directional and makes this a lookup rather than a load.
  return state.catalogue || null;
}

async function addFromSearch(logicalName) {
  const ui = await import('./ui.js');
  const { host } = await import('./bridge.js');
  const stateModule = await import('./state.js');
  const layout = await import('./layout.js');
  const geometry = await import('./geometry.js');

  let loaded;
  let relationships;

  try {
    loaded = await ui.withProgress('Loading ' + logicalName + '...',
      () => host.loadTables([logicalName]), { cancellable: true });

    const scope = state.doc.tables
      .filter(t => t.logicalName && t.status !== 'Proposed')
      .map(t => t.logicalName)
      .concat([logicalName]);

    relationships = await ui.withProgress('Finding its relationships to this diagram...',
      () => host.discoverRelationships(Array.from(new Set(scope))), { cancellable: true });
  } catch (error) {
    return;
  }

  const tables = (loaded && loaded.tables) || [];
  if (!tables.length) {
    ui.toast('Could not read ' + logicalName + ' from the environment.', 'error');
    return;
  }

  let added = [];
  stateModule.mutate('add table from search', () => {
    added = stateModule.addTablesFromMetadata(tables);
    stateModule.addRelationshipsFromMetadata(relationships, { included: true });
    layout.positionNewTables(added);
  });

  geometry.invalidateSizes();
  render();
  renderPanels();

  if (added.length) {
    selectOnly('tables', added[0].id);
    focusTable(added[0].id);
    onInspect();
  }

  ui.toast('Added ' + (tables[0].displayName || logicalName) + '.', 'success');
}

// -------------------------------------------------------- relationships ---

function renderRelationshipTab() {
  const container = clear($('#tab-relationships'));
  const all = state.doc.relationships;

  if (!all.length) {
    container.appendChild(el('div', {
      class: 'empty-note',
      text: 'No relationships yet. They are discovered automatically when both of their tables are on the canvas.'
    }));
    return;
  }

  const filters = state.filters;

  // Filter by table. Narrows the list to relationships with the chosen table at either end, rather
  // than a text search on display name that also catches relationships whose other end shares a word.
  const tableOptions = sortBy(state.doc.tables, t => t.displayName || t.logicalName || '');
  const tableFilter = el('select', {
    class: 'panel-select',
    onChange: event => {
      filters.tableId = event.target.value || null;
      renderPanels();
    }
  }, [
    el('option', { value: '', text: 'Any table', selected: !filters.tableId }),
    ...tableOptions.map(t => el('option', {
      value: t.id,
      text: t.displayName || t.logicalName,
      selected: filters.tableId === t.id
    }))
  ]);

  // A table filter pointing at a table that has since been removed would silently hide everything.
  if (filters.tableId && !tableById(filters.tableId)) filters.tableId = null;
  tableFilter.value = filters.tableId || '';

  container.appendChild(el('div', { class: 'filter-row' }, [
    el('span', { class: 'small muted', text: 'Touching' }),
    tableFilter
  ]));

  container.appendChild(el('div', { class: 'filter-chips' }, [
    chip('1:N', filters.relationshipTypes.has('OneToMany'), () => toggleType('OneToMany')),
    chip('N:N', filters.relationshipTypes.has('ManyToMany'), () => toggleType('ManyToMany')),
    // "Visible only": there is one flag - hidden - and this chip narrows the list to what is
    // actually drawn. The state key is named showExcluded; it lives in state.js and nothing outside
    // this panel reads it.
    chip('Visible only', !filters.showExcluded, () => {
      filters.showExcluded = !filters.showExcluded;
      renderPanels();
    }),
    chip('Custom only', !!filters.customOnly, () => {
      filters.customOnly = !filters.customOnly;
      renderPanels();
    })
  ]));

  const shown = all.filter(relationship => {
    if (!filters.relationshipTypes.has(relationship.kind)) return false;
    // `included` is read here but never written: a .dvmd file saved before tool 1.7.0 can carry
    // included: false, which means the same as hidden.
    if (!filters.showExcluded && (relationship.hidden || relationship.included === false)) return false;
    if (filters.customOnly && !relationship.isCustom) return false;

    if (filters.tableId &&
        relationship.fromTableId !== filters.tableId &&
        relationship.toTableId !== filters.tableId) {
      return false;
    }

    const from = tableById(relationship.fromTableId);
    const to = tableById(relationship.toTableId);

    return matchesSearch([
      relationship.schemaName, relationship.displayName, relationship.referencingAttribute,
      from && from.displayName, from && from.logicalName,
      to && to.displayName, to && to.logicalName
    ].join(' '), searchTerm);
  });

  const visibleCount = all.filter(r => r.included !== false && !r.hidden).length;

  container.appendChild(el('div', { class: 'group-head' }, [
    el('span', { text: visibleCount + ' of ' + all.length + ' shown' }),
    el('span', {}, [
      el('button', {
        class: 'text-btn', text: 'All',
        onClick: () => setVisibility(shown, true)
      }),
      el('button', {
        class: 'text-btn', text: 'None',
        onClick: () => setVisibility(shown, false)
      })
    ])
  ]));

  for (const relationship of sortBy(shown, r => {
    const from = tableById(r.fromTableId);
    return (from && from.displayName) || '';
  }, r => r.schemaName || '')) {
    container.appendChild(relationshipRow(relationship));
  }

  if (!shown.length) {
    container.appendChild(el('div', { class: 'empty-note', text: 'No relationships match the current filters.' }));
  }
}

function relationshipRow(relationship) {
  const from = tableById(relationship.fromTableId);
  const to = tableById(relationship.toTableId);
  const visible = relationship.included !== false && !relationship.hidden;
  const selected = state.selection.relationships.has(relationship.id);

  const check = el('span', {
    class: 'chk' + (visible ? ' is-on' : ''),
    html: visible ? '&#10003;' : '',
    onClick: event => {
      event.stopPropagation();
      // Writes `hidden` and nothing else. The legacy `included` flag is only ever read.
      mutate('toggle relationship', () => { relationship.hidden = visible; });
      render();
      renderPanels();
    }
  });

  return el('div', {
    class: 'row' + (selected ? ' is-selected' : ''),
    style: { alignItems: 'flex-start', flexDirection: 'column', gap: '2px' },
    onClick: () => {
      selectOnly('relationships', relationship.id);
      render();
      onInspect();
      renderPanels();
    }
  }, [
    el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', width: '100%' } }, [
      check,
      el('span', {
        class: 'row-name',
        text: (from ? from.displayName || from.logicalName : '?') + ' → ' + (to ? to.displayName || to.logicalName : '?')
      }),
      statusBadge(relationship.status),
      el('span', { class: 'row-meta', text: relationship.kind === 'ManyToMany' ? 'N:N' : '1:N' })
    ]),
    el('div', { class: 'row-sub', style: { paddingLeft: '22px' } }, [
      // The display name is included when it says something the schema name does not. Dataverse
      // often sets it to the schema name, and printing the same string twice is noise.
      (relationship.displayName && relationship.displayName !== relationship.schemaName
        ? relationship.displayName + ' · '
        : '') +
      (relationship.schemaName || '') +
      (relationship.referencingAttribute ? ' · ' + relationship.referencingAttribute : '') +
      (relationship.intersectEntity ? ' · via ' + relationship.intersectEntity : '')
    ])
  ]);
}

function setVisibility(relationships, visible) {
  mutate('bulk visibility', () => {
    for (const relationship of relationships) relationship.hidden = !visible;
  });
  render();
  renderPanels();
}

function toggleType(kind) {
  const set = state.filters.relationshipTypes;
  if (set.has(kind)) set.delete(kind);
  else set.add(kind);
  renderPanels();
}

function chip(label, on, onClick) {
  return el('button', { class: 'chip' + (on ? ' is-on' : ''), text: label, onClick });
}

// ---------------------------------------------------------------- notes ---

/**
 * One line for an annotation in the Notes list.
 *
 * An arrow has no text, so it is listed as "Arrow" rather than by a first line of text it does not
 * have.
 */
function annotationLabel(annotation) {
  const kind = annotationKind(annotation);
  const text = String(annotation.text || '').split('\n')[0].trim().slice(0, 80);

  if (kind === 'arrow') return 'Arrow';
  if (text) return text;

  return kind === 'text' ? '(empty text box)' : '(empty sticky note)';
}

function renderNotesTab() {
  const container = clear($('#tab-notes'));
  const notes = state.doc.annotations;

  container.appendChild(el('div', { class: 'group-head' }, [
    el('span', { text: notes.length + ' ' + plural(notes.length, 'item') }),
    el('button', {
      class: 'text-btn', text: '+ Add sticky note',
      onClick: () => window.dispatchEvent(new CustomEvent('dmd:add-annotation'))
    })
  ]));

  if (!notes.length) {
    container.appendChild(el('div', {
      class: 'empty-note',
      text: 'Sticky notes, text boxes and arrows carry the reasoning a diagram cannot: design decisions, assumptions, migration steps and ownership. They are saved with the diagram and included in exports.'
    }));
  }

  for (const annotation of notes) {
    // Notes attach to a connector as well as a card, so both are resolved - otherwise a relationship
    // note would have no line saying what it is about.
    const attachedTo = describeAttachment(annotation.attachedToId);
    const selected = state.selection.annotations.has(annotation.id);

    container.appendChild(el('div', {
      class: 'row' + (selected ? ' is-selected' : ''),
      style: { flexDirection: 'column', alignItems: 'flex-start', gap: '2px' },
      onClick: () => {
        selectOnly('annotations', annotation.id);
        render();
        onInspect();
        renderPanels();
      }
    }, [
      el('div', {
        class: 'row-name',
        style: { width: '100%' },
        text: annotationLabel(annotation)
      }),
      attachedTo ? el('div', { class: 'row-sub', text: 'on ' + attachedTo }) : null
    ]));
  }

  const tableNotes = state.doc.tables.filter(t => t.notes);
  const linkNotes = state.doc.relationships.filter(r => r.notes);

  if (tableNotes.length || linkNotes.length) {
    container.appendChild(el('div', { class: 'group-head', text: 'Object notes' }));

    for (const table of tableNotes) {
      container.appendChild(el('div', {
        class: 'row',
        style: { flexDirection: 'column', alignItems: 'flex-start' },
        onClick: () => { selectOnly('tables', table.id); render(); focusTable(table.id); onInspect(); renderPanels(); }
      }, [
        el('div', { class: 'row-name', text: table.displayName || table.logicalName }),
        el('div', { class: 'row-sub', text: table.notes.slice(0, 90) })
      ]));
    }

    for (const relationship of linkNotes) {
      container.appendChild(el('div', {
        class: 'row',
        style: { flexDirection: 'column', alignItems: 'flex-start' },
        onClick: () => { selectOnly('relationships', relationship.id); render(); onInspect(); renderPanels(); }
      }, [
        el('div', { class: 'row-name', text: relationship.schemaName }),
        el('div', { class: 'row-sub', text: relationship.notes.slice(0, 90) })
      ]));
    }
  }
}

/** What a note is attached to, as a phrase, or null when it is attached to nothing that exists. */
function describeAttachment(id) {
  if (!id) return null;

  const table = tableById(id);
  if (table) return table.displayName || table.logicalName;

  const relationship = relationshipById(id);
  if (!relationship) return null;

  const from = tableById(relationship.fromTableId);
  const to = tableById(relationship.toTableId);

  return relationship.schemaName ||
    ((from ? from.displayName || from.logicalName : '?') + ' → ' +
     (to ? to.displayName || to.logicalName : '?'));
}
