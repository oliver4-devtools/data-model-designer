// Smaller dialogs: display settings, diagram properties and the relationship path finder.

import { el, clear, sortBy, matchesSearch, plural, productName } from './util.js';
import { host } from './bridge.js';
import {
  state, mutate, tableByLogicalName, tableById, visibleRelationships
} from './state.js';
import {
  openModal, modalFooter, toast, withProgress, checkbox, select, field, textInput, textArea,
  furniturePosition,
  versionLine
} from './ui.js';
import { render } from './render.js';
import { invalidateSizes } from './geometry.js';
import { renderPanels } from './panels.js';
import { fitToView, focusTable } from './interact.js';
import { currentTheme } from './theme.js';
import { applyLayout } from './layout.js';
import { ensureCatalogue } from './sourcepicker.js';

// ---------------------------------------------------------- display -------

const TOGGLES = [
  ['showTableDisplayName', 'Table display name'],
  ['showTableSchemaName', 'Table schema name'],
  ['showFieldDisplayName', 'Column display name'],
  ['showFieldSchemaName', 'Column schema name'],
  ['showFieldType', 'Column data type'],
  ['showPrimaryKey', 'Primary key marker'],
  ['showForeignKey', 'Lookup / foreign key marker'],
  ['showAlternateKeys', 'Alternate key columns'],
  ['showRelationshipName', 'Relationship name on connectors'],
  ['showCardinality', 'Relationship type on connectors (1:N, N:N)'],
  ['showCascade', 'Cascade summary on connectors'],
  ['showStatusBadges', 'Status badges on tables'],
  ['showOwnership', 'Ownership marker on tables'],
  ['showLegend', 'Legend'],
  ['showTitleBlock', 'Title block'],
  ['showGrid', 'Canvas grid']
];

/** True once the legend has been dragged off the corner the stylesheet puts it in. */
function legendMoved() {
  const settings = state.doc.settings || {};
  return !!furniturePosition(settings.legendX, settings.legendY);
}

export function openDisplaySettings() {
  openModal({
    title: 'Display settings',
    width: 620,
    body: () => build(),
    footer: api => modalFooter(api, { primaryLabel: 'Done', onPrimary: () => api.close(null) })
  });

  function build() {
    const container = el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', minHeight: '380px' } });

    const left = el('div', { style: { padding: '16px', borderRight: '1px solid var(--line)' } });
    const right = el('div', { style: { padding: '16px', overflow: 'auto' } });
    container.append(left, right);

    left.appendChild(field('Field detail', select([
      { value: 'TablesOnly', label: 'Tables only' },
      { value: 'RelationshipFields', label: 'Relationship columns (recommended)' },
      { value: 'AllFields', label: 'All selected columns' }
    ], state.doc.settings.fieldDetail, value => {
      mutate('field detail', () => {
        state.doc.settings.fieldDetail = value;
      });
      invalidateSizes();
      render();
    })));

    left.appendChild(field('Column order', select([
      { value: 'metadata', label: 'Keys first, then metadata order' },
      { value: 'displayName', label: 'Display name' },
      { value: 'schemaName', label: 'Schema name' }
    ], state.doc.settings.fieldOrder, value => {
      mutate('column order', () => { state.doc.settings.fieldOrder = value; });
      invalidateSizes();
      render();
    })));

    // Choosing a layout here rearranges the canvas straight away, like the toolbar button, rather
    // than only setting a preference.
    left.appendChild(field('Arrange the canvas', select([
      { value: 'Auto', label: 'Layered, left to right (centred)' },
      { value: 'Horizontal', label: 'Layered, left to right (flat band)' },
      { value: 'Vertical', label: 'Layered, top to bottom' },
      { value: 'Hierarchical', label: 'Strict hierarchy' },
      { value: 'Grid', label: 'Grid' },
      { value: 'Manual', label: 'Manual - never move anything' }
    ], state.doc.settings.layoutMode, value => {
      mutate('layout mode', () => {
        state.doc.settings.layoutMode = value;
        if (value !== 'Manual') applyLayout(value);
      });

      render();

      if (value === 'Manual') {
        toast('Positions are yours to set. Nothing will be moved automatically.', 'info');
      } else {
        fitToView();
        toast('Canvas rearranged. Connectors go back to their automatic routes. ' +
          'Undo (Ctrl+Z) restores both.', 'success');
      }
    }), 'Applies immediately and becomes the style used by the Auto-layout button.'));

    left.appendChild(checkbox('Position new tables automatically', state.doc.settings.autoLayoutOnAdd !== false,
      value => { mutate('auto layout', () => { state.doc.settings.autoLayoutOnAdd = value; }); }));

    left.appendChild(el('div', {
      class: 'small muted', style: { margin: '-4px 0 0 26px', lineHeight: '1.45' },
      text: 'Off means a new table is placed clear of the diagram and left for you to move, ' +
            'rather than joining the automatic arrangement.'
    }));

    right.appendChild(el('div', { class: 'insp-heading', text: 'Show' }));

    // The two column-name toggles are a pair: turning both off would leave every row with a key
    // marker and a type and no name at all, which identifies nothing. Unticking one therefore turns
    // the other on, so the box always produces a visible change.
    const NAME_PAIR = { showFieldDisplayName: 'showFieldSchemaName', showFieldSchemaName: 'showFieldDisplayName' };

    const repaintToggles = () => {
      openDisplaySettings();
    };

    for (const [key, label] of TOGGLES) {
      right.appendChild(checkbox(label, !!state.doc.settings[key], value => {
        const partner = NAME_PAIR[key];
        const flipsPartner = partner && !value && !state.doc.settings[partner];

        mutate('toggle ' + key, () => {
          state.doc.settings[key] = value;
          if (flipsPartner) state.doc.settings[partner] = true;
        });

        invalidateSizes();
        render();

        if (flipsPartner) {
          toast('Columns need a name, so the other name is now shown instead.', 'info');
          repaintToggles();
        }
      }));
    }

    right.appendChild(el('div', {
      class: 'small muted', style: { marginTop: '12px', lineHeight: '1.5' },
      text: 'Cascade detail is off by default. Full cascade configuration is always available in the relationship inspector, where it does not compete with the diagram for space.'
    }));

    // The legend is draggable, and both the drag and the way back are otherwise only reachable by
    // right-clicking the legend itself - which is no use at all to someone who has just switched
    // it off, because the menu goes with it.
    right.appendChild(el('div', {
      class: 'small muted', style: { marginTop: '10px', lineHeight: '1.5' },
      text: 'The legend can be dragged anywhere on the canvas, and its position is saved with the ' +
            'diagram. It sits underneath the panels, so one parked behind the inspector is hidden ' +
            'until it is reset. Right-clicking it offers the same two commands as this dialog.'
    }));

    if (legendMoved()) {
      right.appendChild(el('button', {
        class: 'btn', type: 'button', style: { marginTop: '8px' },
        text: 'Reset legend position',
        onClick: () => {
          mutate('legend position', () => {
            state.doc.settings.legendX = null;
            state.doc.settings.legendY = null;
          });
          toast('Legend back in its corner.', 'success');
          repaintToggles();
        }
      }));
    }

    return container;
  }
}

// ------------------------------------------------------- diagram title ----

export function openDiagramProperties() {
  const model = {
    title: state.doc.title || '',
    description: state.doc.description || ''
  };

  openModal({
    title: 'Diagram properties',
    width: 520,
    padded: true,
    body: () => el('div', {}, [
      field('Title', textInput(model.title, value => { model.title = value; })),
      field('Description', textArea(model.description, value => { model.description = value; }, {
        placeholder: 'What this diagram is for, and who it is aimed at.'
      })),
      state.doc.source && state.doc.source.environmentUrl
        ? el('div', { class: 'small muted', style: { marginTop: '8px', lineHeight: '1.6' } }, [
            el('div', { text: 'Source environment: ' + (state.doc.source.organizationFriendlyName || '') }),
            el('div', { class: 'mono', text: state.doc.source.environmentUrl }),
            state.doc.source.lastRefreshUtc
              ? el('div', { text: 'Last refreshed ' + new Date(state.doc.source.lastRefreshUtc).toLocaleString('en-GB') })
              : null
          ])
        : null
    ]),
    footer: api => modalFooter(api, {
      primaryLabel: 'Save',
      onPrimary: () => {
        mutate('properties', () => {
          state.doc.title = model.title || 'Untitled diagram';
          state.doc.description = model.description;
        });
        render();
        api.close(null);
      }
    })
  });
}

// ---------------------------------------------------------- path finder ---

export async function openPathFinder() {
  if (!state.connection || !state.connection.connected) {
    toast('Connect to a Dataverse environment in XrmToolBox first.', 'warning');
    return;
  }

  let catalogue;
  try {
    catalogue = await withProgress('Reading the environment...', ensureCatalogue);
  } catch (error) {
    // withProgress has already said what went wrong. Letting the rejection through would have it
    // reported a second time - by the command-bar handler, or by the global sticky handler when
    // the overflow menu invoked this and discarded the returned promise.
    return;
  }

  const onCanvas = state.doc.tables
    .filter(t => t.logicalName)
    .map(t => ({ value: t.logicalName, label: t.displayName || t.logicalName }));

  const selected = Array.from(state.selection.tables)
    .map(id => tableById(id))
    .filter(t => t && t.logicalName);

  const model = {
    from: selected[0] ? selected[0].logicalName : (onCanvas[0] ? onCanvas[0].value : ''),
    to: selected[1] ? selected[1].logicalName : (onCanvas[1] ? onCanvas[1].value : ''),
    maxDepth: 4,
    result: null
  };

  const CATALOGUE_LIMIT = 500;
  const sorted = sortBy(catalogue, t => t.displayName || '');

  let options;
  let truncated = 0;

  if (onCanvas.length >= 2) {
    options = onCanvas;
  } else {
    options = sorted.slice(0, CATALOGUE_LIMIT)
      .map(t => ({ value: t.logicalName, label: t.displayName }));
    if (sorted.length > CATALOGUE_LIMIT) truncated = sorted.length;
  }

  // from/to are seeded from the canvas and the selection, which are independent of this list. A
  // seeded value the list does not contain leaves the browser at selectedIndex -1, so the box
  // renders blank while Search still uses the hidden value. Anything seeded is folded back in.
  const known = new Set(options.map(o => o.value));
  for (const seeded of [model.from, model.to]) {
    if (!seeded || known.has(seeded)) continue;
    const entry = catalogue.find(t => t.logicalName === seeded);
    const onCanvasEntry = onCanvas.find(o => o.value === seeded);
    options.unshift({
      value: seeded,
      label: (entry && entry.displayName) || (onCanvasEntry && onCanvasEntry.label) || seeded
    });
    known.add(seeded);
  }

  // The other way a box comes up blank: nothing seeded it at all, which happens whenever fewer
  // than two tables on the canvas have a logical name. An unset select also sits at index -1.
  if (!model.from && options.length) model.from = options[0].value;
  if (!model.to) {
    const other = options.find(o => o.value !== model.from);
    if (other) model.to = other.value;
  }

  openModal({
    title: 'Find relationship path',
    width: 620,
    body: dialog => build(dialog, model, options, truncated),
    footer: dialog => modalFooter(dialog, {
      primaryLabel: 'Search',
      onPrimary: () => search(model, dialog)
    })
  });
}

function build(dialog, model, options, truncated) {
  const container = el('div', { style: { padding: '16px' } });

  container.appendChild(el('div', {
    class: 'small', style: { marginBottom: '14px', lineHeight: '1.55', color: 'var(--ink-3)' }
  }, [
    el('div', { style: { fontWeight: 600, color: 'var(--ink)', marginBottom: '3px' },
      text: 'How are these two tables connected?' }),
    'Pick two tables and this walks the live relationship metadata to find the chains of lookups ' +
    'that join them - useful for working out how to roll data up, where a security model reaches, ' +
    'or whether a proposed lookup already has an equivalent. Each result is a chain of tables and ' +
    'the relationship used at every hop. Selecting one highlights that chain on the canvas, which ' +
    'needs every table on it to be on the diagram already. Nothing is added or changed.'
  ]));

  container.appendChild(el('div', { class: 'field-row' }, [
    field('From', select(options, model.from, value => { model.from = value; })),
    field('To', select(options, model.to, value => { model.to = value; }))
  ]));

  if (truncated) {
    container.appendChild(el('div', {
      class: 'empty-note',
      text: 'Showing the first 500 of ' + truncated + ' tables, in display-name order. ' +
        'Put both tables on the diagram to choose from those instead.'
    }));
  }

  container.appendChild(field('Maximum hops', select(
    [2, 3, 4, 5].map(n => ({ value: String(n), label: n + ' hops' })),
    String(model.maxDepth),
    value => { model.maxDepth = Number(value); }),
    'The search walks live metadata, so it can find a path through tables that are not on the canvas.'));

  const results = el('div', { id: 'path-results', style: { marginTop: '10px' } });
  container.appendChild(results);

  model.paint = () => paintResults(results, model, dialog);
  return container;
}

async function search(model, dialog) {
  if (!model.from || !model.to || model.from === model.to) {
    toast('Choose two different tables.', 'warning');
    return;
  }

  let result;
  try {
    result = await withProgress('Searching for a path...',
      () => host.findPaths(model.from, model.to, model.maxDepth, 8), { cancellable: true });
  } catch (error) {
    // withProgress has already reported it - a quiet acknowledgement for a cancellation, the
    // host's own message for a failure. Rethrowing would add a second, sticky report telling the
    // user to close and reopen the tool after they pressed Cancel themselves. The previous result
    // is cleared so a stale list cannot look like the answer to the search that just failed.
    model.result = null;
    model.paint();
    return;
  }

  model.result = result;
  model.paint();
}

function paintResults(container, model, dialog) {
  clear(container);
  const result = model.result;
  if (!result) return;

  if (result.message) {
    container.appendChild(el('div', {
      class: 'small', style: { color: 'var(--proposed-ink)', marginBottom: '8px' }, text: result.message
    }));
  }

  if (!result.paths.length) return;

  const ranked = rankPaths(result.paths);
  const drawable = ranked.filter(entry => entry.onCanvas).length;

  container.appendChild(el('div', { class: 'insp-heading',
    text: result.paths.length + ' ' + plural(result.paths.length, 'path') + ' found' }));

  container.appendChild(el('div', {
    class: 'small muted', style: { margin: '-4px 0 8px', lineHeight: '1.5' },
    text: drawable
      ? 'Click a path to highlight it on the canvas. ' + drawable + ' of ' + ranked.length +
        ' ' + (drawable === 1 ? 'is' : 'are') + ' already fully on the diagram - those are listed first.'
      : 'None of these paths is fully on the diagram yet, so none of them can be highlighted. ' +
        'Add the missing tables and search again.'
  }));

  for (const entry of ranked) {
    const { path, hops, onCanvas } = entry;

    container.appendChild(el('div', {
      class: 'row' + (onCanvas ? ' is-drawable' : ''),
      style: { flexDirection: 'column', alignItems: 'flex-start', gap: '3px' },
      title: onCanvas
        ? 'Click to highlight this chain on the canvas'
        : 'Some tables on this path are not on the diagram',
      onClick: () => {
        if (!onCanvas) {
          toast('Some tables on this path are not on the canvas, so it cannot be highlighted. Add them first.', 'warning');
          return;
        }
        highlightPath(path);
        dialog.close(null);
      }
    }, [
      el('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', width: '100%' } }, [
        el('span', { class: 'row-name', text: path.steps.map(s => s.table).join('  →  ') }),
        onCanvas ? el('span', { class: 'badge badge-oncanvas', text: 'ON CANVAS' }) : null,
        el('span', { class: 'row-meta', text: hops + ' ' + plural(hops, 'hop') })
      ]),
      el('div', { class: 'row-sub', style: { whiteSpace: 'normal' },
        text: path.steps.slice(1).map(s => s.relationshipSchemaName).join(' · ') }),
      el('div', {
        class: onCanvas ? 'small path-hint' : 'small muted',
        text: onCanvas
          ? 'Click to highlight this path on the canvas'
          : 'Not fully on the canvas - ' + missingFromPath(path).join(', ') + ' missing'
      })
    ]));
  }
}

/**
 * Path results, with the usable ones first.
 *
 * Whether every table on a path is already drawn decides whether the result is usable at all:
 * clicking one highlights the chain on the canvas, and a path through tables that are not there has
 * nothing to highlight, so those are grouped after the ones that work.
 *
 * Order within each group is the order the host returned - shortest first - so sorting by
 * usefulness does not also quietly resort by something else. The index carried through the sort is
 * what makes that stable rather than relying on Array.sort being stable.
 */
export function rankPaths(paths) {
  return (paths || [])
    .map((path, index) => ({
      path,
      index,
      hops: path.steps.length - 1,
      onCanvas: path.steps.every(step => tableByLogicalName(step.table))
    }))
    .sort((a, b) => (a.onCanvas === b.onCanvas ? a.index - b.index : (a.onCanvas ? -1 : 1)));
}

/** The tables on a path that are not on the diagram, so the row can name them rather than hint. */
function missingFromPath(path) {
  const missing = [];

  for (const step of path.steps) {
    if (!tableByLogicalName(step.table) && !missing.includes(step.table)) missing.push(step.table);
  }

  return missing.slice(0, 4);
}

function highlightPath(path) {
  const tables = new Set();
  const relationships = new Set();

  for (const step of path.steps) {
    const table = tableByLogicalName(step.table);
    if (table) tables.add(table.id);
  }

  const schemaNames = new Set(path.steps.map(s => s.relationshipSchemaName).filter(Boolean));
  for (const relationship of visibleRelationships()) {
    if (schemaNames.has(relationship.schemaName)) relationships.add(relationship.id);
  }

  state.highlightPath = { tables, relationships };
  render();
  fitToView();

  toast('Path highlighted. Press Escape or click empty canvas to clear.', 'info');
}

// ----------------------------------------------------------- layout menu --

export function openLayoutMenu(anchor) {
  const modes = [
    ['Auto', 'Layered, left to right', 'Each layer centred on the one before it. The usual choice.'],
    ['Horizontal', 'Layered, flat band', 'Layers packed from a common top edge - wider and shallower, for a landscape page.'],
    ['Vertical', 'Layered, top to bottom', 'The same layering rotated, for a portrait page.'],
    ['Hierarchical', 'Strict hierarchy', 'Every table sits one layer below its parent, even when that leaves gaps.'],
    ['Grid', 'Grid', 'Ignores relationships entirely and packs the cards into rows.']
  ];

  openModal({
    title: 'Automatic layout',
    width: 460,
    padded: true,
    body: api => el('div', {}, [
      el('div', { class: 'small muted', style: { marginBottom: '12px', lineHeight: '1.5' } },
        'Auto-layout replaces every manual position on the canvas, and puts every connector ' +
        'back on its automatic route. Undo restores both.'),
      ...modes.map(([mode, label, detail]) => el('button', {
        class: 'choice-card',
        onClick: () => {
          mutate('auto layout', () => {
            state.doc.settings.layoutMode = mode;
            applyLayout(mode);
          });
          render();
          fitToView();
          api.close(null);
          toast('Layout applied. Connectors go back to their automatic routes. ' +
            'Undo (Ctrl+Z) restores both.', 'success');
        }
      }, [
        el('div', { class: 'choice-title', text: label }),
        el('div', { class: 'choice-detail', text: detail })
      ]))
    ])
  });
}

// -------------------------------------------------------- feature guide --

/**
 * "What this tool can do", in plain language.
 *
 * The tool's most useful capabilities are not the obvious ones - nobody guesses that they can
 * walk out from a table to a chosen depth, or propose a lookup between two real tables, from
 * looking at the toolbar. It covers what each area is for and how to reach it, and stops short
 * of documenting every checkbox; Display settings explains itself once opened.
 */
const FEATURES = [
  {
    heading: 'Build a diagram worth showing someone',
    lines: [
      ['Add existing tables', 'Start from a solution, or search the whole environment and tick the tables you want. Relationships between them are found automatically and offered for review before anything is drawn.'],
      ['Explore relationships', 'Pick one table and see everything one relationship away from it. Raise the depth to walk further out, hop by hop. Filters keep the platform plumbing - audit, async operations, sync errors - out of the answer.'],
      ['Find path', 'Given two tables, this walks live metadata to find the chains of lookups that join them, and highlights one on the canvas.']
    ]
  },
  {
    heading: 'Control how much it says',
    lines: [
      ['Detail', 'Three levels: table names only, just the keys and lookups behind the relationships on screen, or every column you have ticked. Any single table can override the diagram-wide choice from its inspector.'],
      ['Display settings', 'Independent switches for names, data types, key markers, cardinality, cascade summaries and the legend. Cascade detail is off by default and lives in full in the relationship inspector instead.'],
      ['Columns', 'The tick list in a table’s inspector says what is on that card right now. Untick one and it is gone from the canvas and from exports; tick one the current detail level would not show and that table starts showing the columns you choose, with that one added.']
    ]
  },
  {
    heading: 'Understand what a relationship actually does',
    lines: [
      ['Relationship inspector', 'Click a connector for its schema name, cardinality, the lookup column behind it, whether it is custom or system, and the full assign, delete, merge, reparent, share and unshare cascade configuration.'],
      ['Polymorphic lookups', 'Customer, Owner and Regarding produce one relationship per target table. All of them are shown, and the inspector explains why.'],
      ['Relationships tab', 'Every relationship on the diagram in one list, filterable by type, by table, by custom-or-system, and by text. Untick one to take it off the canvas without losing it from the file.'],
      ['Cascade impact', 'Pick a table and see what deleting or reassigning one of its records actually reaches, following the chain rather than one connector at a time. Also tells you what would refuse the operation outright, and what keeps its records but loses the link. Reads live metadata, so it finds cascades into tables you have not drawn.'],
      ['Ownership', 'How each table\'s records are owned - user or team, organisation, business unit - in the inspector, and as a marker on each card from Display settings.']
    ]
  },
  {
    heading: 'Design the future state',
    lines: [
      ['Propose new tables', 'The button opens one hub for all of it: a new table, a column on a table that already exists, a relationship between any two tables, or an external system to show an integration boundary.'],
      ['Statuses', 'Existing, proposed, external and deprecated are told apart by border pattern, badge text and colour together, so the difference survives a black-and-white print. A proposed column on a real table gets the same treatment inside the card.'],
      ['Deprecated', 'Mark a table, a column or a relationship as planned for retirement. It is drawn struck through or in the deprecated style, and Dataverse is never touched.'],
      ['Notes', 'A table, a column and a connector can each carry a note of its own. A card with one shows a NOTE tag, and clicking that opens the note on the canvas. This is where the assumption behind a design decision belongs.'],
      ['Lookups', 'A proposed 1:N relationship writes the lookup column it implies onto the table at the many end and points the connector at that row. Proposing a lookup column on its own is therefore not offered - the relationship is the thing that creates it.']
    ]
  },
  {
    heading: 'Draw on the model',
    lines: [
      ['Sticky note', 'A piece of paper you can put anywhere, optionally attached to a table or a connector with a leader line. It starts square and the corner grip resizes each side. For the caveat, the question, the thing that has to be said next to the drawing rather than in a document beside it.'],
      ['Text box', 'Text with no background and no border, for labelling a region of the canvas - "phase 2", "owned by the integration team" - without adding another box to a diagram made of boxes.'],
      ['Arrow', 'Drag one out anywhere and give it a colour. Hold Shift while drawing to keep it straight; select it and drag either end to re-aim it.'],
      ['In front or behind', 'Each of the three can be drawn in front of the model or behind it - the Depth box in the inspector, or its right-click menu. In front is the default. Behind means under the cards and under the relationship lines both, so anything drawn over it hides it and clicking there selects the card or the connector rather than the note. Text boxes and arrows are always drawn over sticky notes on the same side.'],
      ['Turning a note', 'A selected sticky note has a round handle above its top edge. Drag it to set the angle - Shift for 15 degree steps, Ctrl for fine adjustment - or pick one from the Angle box in the inspector, where Straight puts it square to the page. A note nobody has turned keeps the slight slant that makes it read as paper.']
    ]
  },
  {
    heading: 'Keep it, and keep it current',
    lines: [
      ['Save', 'Diagrams are .dvmd files - plain JSON, so they diff cleanly and can live in source control next to the solution they describe.'],
      ['Close', 'Puts the open diagram away and leaves an empty canvas, asking first if there is anything unsaved. In the ⋯ menu, under Save as.'],
      ['Refresh', 'Compares an open diagram against the connected environment and reports what is unchanged, what has changed, what has gone, and which proposed objects now appear to exist. Layout, notes and emphasis are preserved.'],
      ['Promotion', 'Nothing proposed is ever promoted automatically. A match is offered, you confirm it, and a match you decline is simply offered again next time.'],
      ['Export', 'PNG, SVG, draw.io, Mermaid and Visio. Before you pick a filename, the dialog says what that format cannot carry - based on what is actually on your diagram, not a generic warning.'],
      ['Documentation', 'Two of those formats produce a document rather than a picture: Azure DevOps wiki Markdown, and a self-contained HTML page that prints. Table catalogue, relationships with their cascade behaviour, alternate keys, and a register of everything the diagram proposes with the note explaining why.']
    ]
  },
  {
    heading: 'Worth knowing',
    lines: [
      ['This tool only ever reads', 'Nothing it does changes the connected environment. Removing an object from a diagram, marking it deprecated, designing a proposed table - all of it lives in the diagram file alone.'],
      ['Right-click everything', 'The canvas, a table card, a connector, a sticky note and the legend each have their own menu, and most commands are quicker to reach there than from the toolbar. The legend can also be dragged anywhere on the canvas.'],
      ['Untangling a diagram', 'A connector can be dragged out of the way in both directions at once, and its two ends stay on the columns they point at. Selecting a card puts a grip beside each of its rows - on a card showing more than one - and dragging one moves that column up or down the card, taking the connectors anchored to it with it. Between them, two lines that insist on crossing can usually be persuaded not to. A card\'s right-click menu puts its columns back in the ordinary order.'],
      ['Moving one corner of a line', 'Select a connector and every right angle on it gains a handle. Drag one and the two legs that meet there move with it - nothing else does, and the line never gains a bend it did not have. A leg that ends on a card cannot move, because that end is sitting on the column the relationship points at, so a corner next to a card slides one way only and its cursor says which. Ctrl while dragging is fine adjustment. Right-click a corner for "Remove this bend", or hold Shift while dragging it, and the bend goes - offered only where the line can actually do without it. Dragging the line itself moves the leg you grabbed, the same way - the legs either side stretch to follow. A leg that ends on a card has nothing behind it to stretch, so the route is broken beside the card and the new corner carries that end: that is the one gesture here that adds a bend, and it is the gesture you are asking for one. "Straighten this connector" is the way back to the automatic route, and an auto-layout does the same to every connector at once.'],
      ['Naming a colour', 'An emphasis colour applied to a card or a connector is listed in the legend. Click that row to give the colour a name - "Phase 2", "Out of scope" - and the name is what the legend, the exports and the inspector call it from then on. The model list beside the canvas paints its mark in the same colour.'],
      ['Keyboard', 'Ctrl+S save, Ctrl+O open, Ctrl+E export, Ctrl+Z and Ctrl+Y undo and redo, Ctrl+F search, Ctrl+0 reset zoom, Delete to remove the selection from the diagram.'],
      ['Modifiers while dragging', 'Shift adds to or removes from the selection, keeps an arrow straight, turns a sticky note in 15 degree steps, and releases a connector corner. Ctrl is fine adjustment - a card, an arrow or a corner moves a unit at a time instead of snapping. Space or Alt with a drag pans the canvas, as does the right button.']
    ]
  }
];

/**
 * @param appInfo the payload from app.info - tool name and version. Passed in rather than fetched
 *        here because app.js already holds it, and a dialog that has to await a host round trip
 *        before it can draw its own heading opens visibly late.
 * @param pendingInfo optional promise for a retry of that fetch, for when the one at boot came back
 *        with nothing. The guide still draws at once; the version line repaints when it settles.
 */
export function openFeatureGuide(appInfo, pendingInfo) {
  const info = appInfo || {};

  openModal({
    title: 'What this tool can do',
    subtitle: 'The short version',
    width: 720,
    height: 620,
    body: () => {
      const container = el('div', { style: { padding: '18px 20px', lineHeight: '1.55' } });

      // Which tool, and which build of it. The guide describes behaviour that changes between
      // releases, so a page of it with no version on it is a page that cannot be trusted.
      container.appendChild(el('div', { class: 'guide-head' }, [
        el('img', {
          class: 'guide-logo',
          src: currentTheme() === 'dark' ? 'img/logo-dark-256.png' : 'img/logo-256.png',
          alt: 'Oliver4'
        }),
        el('div', {}, [
          el('div', { class: 'brand-eyebrow', text: 'OLIVER4' }),
          productName(info.toolName),
          versionLine(info, pendingInfo)
        ])
      ]));

      container.appendChild(el('p', {
        style: { marginTop: 0, color: 'var(--ink-2)' },
        text: 'A data-model exploration and design tool rather than an ERD exporter. The journey it ' +
              'is built around is: focus the model, understand its relationships, shape the story, ' +
              'design the future state, then keep and refresh the result.'
      }));

      for (const group of FEATURES) {
        container.appendChild(el('div', { class: 'insp-heading', style: { marginTop: '18px' }, text: group.heading }));

        for (const [name, detail] of group.lines) {
          container.appendChild(el('div', { class: 'feature-line' }, [
            el('span', { class: 'feature-name', text: name }),
            el('span', { class: 'feature-detail', text: detail })
          ]));
        }
      }

      return container;
    },
    footer: api => modalFooter(api, {
      primaryLabel: 'Close',
      hideCancel: true,
      onPrimary: () => api.close(null)
    })
  });
}
