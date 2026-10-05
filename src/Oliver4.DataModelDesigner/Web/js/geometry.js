// Table sizing, column visibility and connector routing.
//
// The column visibility rules here mirror Export/ExportRowBuilder.cs on the host side. The canvas
// needs them synchronously on every redraw and the text exporters need them without a round trip,
// so the rules exist in both runtimes. Change one, change the other.

import { measureText, truncateToWidth } from './util.js';
import {
  state, tableById, visibleRelationships, annotationKind, topologyVersion, NOTE_DEFAULT_SIZE
} from './state.js';
import { palette, mix } from './theme.js';

export const METRICS = {
  headerHeight: 30,
  rowHeight: 20,
  padX: 9,
  markerWidth: 20,
  typeGap: 10,

  /// Gap between a column's display name and its schema name when both are shown on one row.
  secondaryGap: 8,

  minWidth: 172,
  maxWidth: 340,
  cornerRadius: 7,
  connectorGap: 14,
  channel: 34,
  noteTagWidth: 38,

  /// Width of the ownership pill in a card header.
  ownershipWidth: 34,
  jumpRadius: 5
};

export const FONTS = {
  title: '600 12px "Segoe UI", sans-serif',
  schema: '9.5px Consolas, monospace',
  row: '10.5px Consolas, monospace',
  rowDisplay: '11px "Segoe UI", sans-serif',
  type: '9.5px "Segoe UI", sans-serif',
  marker: '600 8.5px Consolas, monospace',
  badge: '600 8px "Segoe UI", sans-serif',
  edgeLabel: '10px Consolas, monospace',
  note: '12px "Segoe UI", sans-serif'
};

/**
 * Card styling per diagram status. Read through the active palette rather than a fixed table so
 * the same call site works in both themes.
 */
export function statusStyle(status) {
  const styles = palette().status;
  return styles[status] || styles.Existing;
}

/** Mixes a hex colour towards the current theme's card background. */
export function tint(hex, amount) {
  return mix(hex, palette().tintTarget, amount);
}

// ------------------------------------------------------------- columns ---

/** Columns that should be drawn inside a table card for the current settings. */
export function visibleColumns(table) {
  const doc = state.doc;
  const mode = table.collapsed ? 'TablesOnly' : (table.detailOverride || doc.settings.fieldDetail);
  if (mode === 'TablesOnly') return [];

  const columns = table.columns || [];
  if (mode === 'AllFields') return orderColumns(columns.filter(c => c.selected !== false), doc.settings.fieldOrder, table);

  const wanted = new Set();
  if (table.primaryIdAttribute) wanted.add(table.primaryIdAttribute.toLowerCase());

  for (const relationship of visibleRelationships()) {
    if (relationship.toTableId === table.id && relationship.referencingAttribute) {
      wanted.add(relationship.referencingAttribute.toLowerCase());
    }
    if (relationship.fromTableId === table.id && relationship.referencedAttribute) {
      wanted.add(relationship.referencedAttribute.toLowerCase());
    }
  }

  if (doc.settings.showAlternateKeys) {
    for (const key of table.alternateKeys || []) {
      for (const column of key.columns || []) wanted.add(String(column).toLowerCase());
    }
  }

  let selected = columns.filter(c =>
    c.selected !== false &&
    (c.isPrimaryId || c.status === 'Proposed' || wanted.has(String(c.logicalName || '').toLowerCase())));

  // An empty card usually reads as a bug rather than a choice, so fall back to the primary name
  // column - but never to one the user has deliberately unticked in the inspector.
  if (!selected.length) {
    const available = columns.filter(c => c.selected !== false);
    const fallback = available.find(c => c.isPrimaryName) || available[0];
    if (fallback) selected = [fallback];
  }

  return orderColumns(selected, doc.settings.fieldOrder, table);
}

/**
 * The key a card's manual field order is written against.
 *
 * The logical name rather than the column id, because a column can be replaced by an object with a
 * new id and the same name - a proposed column settling against the real one on a refresh does
 * exactly that - and the position the user put it in should survive that. The cost is the other
 * way round: a column that is *renamed* loses its place and goes back to the bottom of the card.
 */
export function columnOrderKey(column) {
  const entry = column || {};

  // The id is the last resort, for the reason in the doc comment above. Every column still needs a
  // key of some kind: a proposed column whose display name slugs to nothing carries neither name,
  // and without the id the manual order could not place it.
  const named = String(entry.logicalName || entry.schemaName || '').toLowerCase();
  return named || String(entry.id || '').toLowerCase();
}

/** The card's manual field order as name to position, or null when the user has not set one. */
export function manualColumnOrder(table) {
  const order = (table || {}).columnOrder;
  if (!Array.isArray(order) || !order.length) return null;

  const positions = new Map();
  order.forEach((name, index) => {
    const key = String(name || '').toLowerCase();
    if (key && !positions.has(key)) positions.set(key, index);
  });

  return positions.size ? positions : null;
}

function orderColumns(columns, order, table) {
  // A card the user has dragged rows around on is drawn in the order they left it in, and neither
  // the sort nor the key float moves them back.
  //
  // A column the manual order has never heard of - added by a refresh, or renamed since - sorts
  // after everything it has, in the order it would have had on its own.
  const manual = manualColumnOrder(table);
  if (manual) {
    const size = manual.size;
    return columns.slice().sort((a, b) => manualRank(a) - manualRank(b));

    function manualRank(column) {
      const at = manual.get(columnOrderKey(column));
      return at === undefined ? size + rank(column) : at;
    }
  }

  const ranked = columns.slice();
  if (order === 'displayName') {
    ranked.sort((a, b) => String(a.displayName || '').localeCompare(String(b.displayName || ''), 'en-GB'));
  } else if (order === 'schemaName') {
    ranked.sort((a, b) => String(a.logicalName || '').localeCompare(String(b.logicalName || ''), 'en-GB'));
  }

  // Keys always float to the top whatever the sort, because that is what makes a card scannable.
  return ranked.sort((a, b) => rank(a) - rank(b));

  function rank(column) {
    if (column.isPrimaryId) return 0;
    if (column.isPrimaryName) return 1;
    if (column.isLookup) return 2;
    return 3;
  }
}

/**
 * Every column on a table, in the order the card would draw them in - the ones it is not currently
 * showing included.
 *
 * Used by the inspector's column list so it matches the card's order, including any rows the
 * user has dragged into a manual order.
 */
export function orderedColumns(table) {
  return orderColumns((table || {}).columns || [], state.doc.settings.fieldOrder, table);
}

/**
 * The card's manual field order once the drawn rows have been put in a new order.
 *
 * Pure: it hands back the array to write to `table.columnOrder` and touches nothing, so the drag
 * that calls it on every pointer move can put the old one back when it is abandoned.
 *
 * Only the drawn rows move, and only among the positions they already occupy. A column the card is
 * not showing keeps its place in the order exactly, so switching a card to all its columns after
 * dragging two rows about does not find the hidden ones piled up at one end.
 */
export function cardOrderAfterMove(table, movedKeys) {
  const full = orderColumns(table.columns || [], state.doc.settings.fieldOrder, table)
    .map(columnOrderKey)
    .filter(key => key);

  const wanted = (movedKeys || []).filter(key => key);
  const next = full.slice();
  const slots = [];

  full.forEach((key, index) => { if (wanted.includes(key)) slots.push(index); });

  let taken = 0;
  for (const slot of slots) next[slot] = wanted[taken++];

  // A drawn column with no place in the order at all - one whose logical name is empty, or which
  // arrived after the order was written. It goes on the end rather than being dropped, so the
  // order always describes every row the user can see.
  for (const key of wanted.slice(taken)) if (!next.includes(key)) next.push(key);

  return next;
}

/**
 * The text drawn for one column row.
 *
 * Both name toggles are honoured independently, and both being off leaves the row showing the
 * schema name rather than nothing, since the schema name is the one that identifies the column.
 */
export function columnLabel(column) {
  const settings = state.doc.settings;
  const schema = column.logicalName || column.schemaName || '';
  const display = column.displayName || schema;
  const differ = display.toLowerCase() !== schema.toLowerCase();

  // Defaults matched exactly: display name off, schema name on. Reading these as `!== false`
  // would turn a hand-edited file that omits them into one that draws both names on every row.
  const wantDisplay = settings.showFieldDisplayName === true;
  const wantSchema = settings.showFieldSchemaName !== false;

  if (wantDisplay && wantSchema && differ) {
    // Both turned on and genuinely different: the display name leads, with the schema name
    // appended in the muted secondary style so one row still carries both.
    return { primary: display, secondary: schema, font: FONTS.rowDisplay };
  }

  if (wantDisplay) return { primary: display, secondary: null, font: FONTS.rowDisplay };

  // Schema name, and also the fallback when both are off. A row with a key marker, a type and no
  // name at all identifies nothing, so the Display settings dialog does not let the user reach
  // that state: unticking one name toggle turns the other on (see dialogs.js).
  return { primary: schema, secondary: null, font: FONTS.row };
}

/**
 * Whether a card gets an ownership pill. Read by the renderer and by the card measurer below,
 * which have to agree exactly: if the measurer allows width the renderer does not use, the header
 * carries a gap; if the renderer draws a pill the measurer did not allow for, it overlaps the
 * title.
 */
export function hasOwnershipMark(table) {
  if (!state.doc.settings.showOwnership) return false;

  // A proposed or external table has no ownership until it is created in the environment, so no
  // pill is drawn for it.
  if (table.status !== 'Existing' && table.status !== 'Deprecated') return false;

  return !!table.ownershipType;
}

/**
 * Whether a card gets a NOTE tag. Shared by the measurer and the renderer for the same reason as
 * hasOwnershipMark: a note of nothing but whitespace gets no tag and reserves no header width.
 */
export function hasNote(table) {
  return !!(table && table.notes && String(table.notes).trim());
}

/**
 * Whether a column row gets the red asterisk that marks it mandatory.
 *
 * `isRequired` already carries both halves of what that means - MetadataService sets it for
 * ApplicationRequired *and* SystemRequired, and the proposed column editor's "Business required"
 * tick box writes the same flag - so there is nothing to work out here beyond reading it. It lives
 * in geometry.js rather than the renderer because the card size cache folds it into its digest,
 * so the rule for "is this row marked" is defined once.
 */
export function hasRequiredMark(column) {
  return !!(column && column.isRequired);
}

/**
 * How much of the marker gutter the asterisk takes, measured from the gutter's right-hand edge.
 *
 * The asterisk is drawn inside the width already reserved for PK/FK/AK rather than beside the
 * name, so it costs a card no width and cannot collide with a truncated name or with the
 * right-aligned type text. See appendRow in render.js for the
 * arithmetic that keeps it clear of the marker itself.
 */
export const REQUIRED_MARK_INSET = 2.5;

export function tableTitle(table) {
  const settings = state.doc.settings;
  const schema = table.logicalName || table.schemaName || '';
  const display = table.displayName || schema;

  if (settings.showTableDisplayName) return display;
  return schema || display;
}

export function tableSubtitle(table) {
  const settings = state.doc.settings;
  if (!settings.showTableSchemaName) return null;

  const schema = table.logicalName || table.schemaName || '';
  if (!schema) return null;

  // Compared against the title that will actually be drawn, whatever the display-name setting is,
  // so a header whose title is already the schema name does not draw it twice.
  if (schema.toLowerCase() === String(tableTitle(table) || '').toLowerCase()) return null;
  return schema;
}

// -------------------------------------------------------------- sizing ---

const sizeCache = new Map();
let sizeCacheKey = '';
let sizeCacheTopology = -1;

/**
 * Memoised column digests, keyed by the columns array itself. Declared here rather than beside
 * columnNameKey below because invalidateSizes empties it, and invalidateSizes is above.
 */
let nameKeyCache = new WeakMap();

/** Invalidate cached card sizes; call whenever display settings change. */
export function invalidateSizes() {
  sizeCache.clear();
  nameKeyCache = new WeakMap();
  sizeCacheKey = JSON.stringify(state.doc.settings);
}

export function measureTable(table) {
  const settingsKey = JSON.stringify(state.doc.settings);
  if (settingsKey !== sizeCacheKey) invalidateSizes();

  // Which relationships are visible decides which lookup rows a card draws under "relationship
  // fields", so it has to be part of what the cache is keyed on. state.js counts structural
  // changes as a topology version, which is cheap to read and distinguishes two different sets of
  // the same size. Entries measured under an older topology can never be asked for again, so the
  // map is emptied rather than left to accumulate them.
  const topology = topologyVersion();
  if (topology !== sizeCacheTopology) {
    sizeCache.clear();
    sizeCacheTopology = topology;
  }

  // The per-column "selected" flags are part of the key, so unticking a column in the inspector
  // re-measures the card.
  const selectionKey = (table.columns || [])
    .map(column => (column.selected === false ? '0' : '1')).join('');

  // Status and ownership are part of the key because both change the *width*: a non-Existing card
  // reserves 62px for its status badge, and hasOwnershipMark - which is false for anything other
  // than Existing and Deprecated - reserves the ownership pill. The renderer and the measurer have
  // to agree exactly; that is the contract hasOwnershipMark holds.
  //
  // The table's own three names are here because they are what the title is drawn from and the
  // title sets the minimum width; primaryIdAttribute and the alternate keys because they decide
  // which columns are wanted. Keying on them keeps undo correct, since undo swaps in a clone
  // rather than calling invalidateSizes.
  const key = table.id + '|' + (table.width || 0) + '|' + (table.detailOverride || '') +
              '|' + (table.collapsed ? 1 : 0) + '|' + (table.columns || []).length +
              '|' + selectionKey + '|' + (hasNote(table) ? 1 : 0) +
              '|' + (table.status || '') + '|' + (table.ownershipType || '') +
              '|' + (table.displayName || '') + '~' + (table.logicalName || '') +
              '~' + (table.schemaName || '') + '|' + (table.primaryIdAttribute || '') +
              '|' + alternateKeyKey(table) +
              '|' + columnNameKey(table) +
              '|' + (table.columnOrder || []).join(',') +
              '|' + topology;

  const cached = sizeCache.get(key);
  if (cached) return cached;

  const columns = visibleColumns(table);
  const rows = columns.map(column => {
    const label = columnLabel(column);
    const marker = markerFor(column);
    const type = state.doc.settings.showFieldType ? (column.typeName || '') : '';
    return { column, label, marker, type };
  });

  let contentWidth = METRICS.minWidth;

  const titleWidth = measureText(tableTitle(table), FONTS.title) +
                     (tableSubtitle(table) ? measureText(tableSubtitle(table), FONTS.schema) + 12 : 0) +
                     (table.status !== 'Existing' && state.doc.settings.showStatusBadges ? 62 : 0) +
                     (hasNote(table) ? METRICS.noteTagWidth + 6 : 0) +
                     (hasOwnershipMark(table) ? METRICS.ownershipWidth + 6 : 0) +
                     METRICS.padX * 2 + 14;

  contentWidth = Math.max(contentWidth, titleWidth);

  for (const row of rows) {
    const width = METRICS.padX * 2 + METRICS.markerWidth +
                  measureText(row.label.primary, row.label.font) +
                  // The secondary name is drawn on the same line when both name toggles are on,
                  // so the card has to be wide enough for it or it would simply be truncated away.
                  (row.label.secondary ? METRICS.secondaryGap + measureText(row.label.secondary, FONTS.row) : 0) +
                  (row.type ? METRICS.typeGap + measureText(row.type, FONTS.type) : 0);
    contentWidth = Math.max(contentWidth, width);
  }

  const width = table.width || Math.min(METRICS.maxWidth, Math.ceil(contentWidth));
  const height = METRICS.headerHeight + rows.length * METRICS.rowHeight + (rows.length ? 4 : 0);

  const size = { width, height, rows };
  sizeCache.set(key, size);
  return size;
}

/**
 * The alternate keys as they affect what is drawn, which is only while the setting that shows them
 * is on. Off - and it is off by default - a document pays nothing for keys it never draws.
 */
function alternateKeyKey(table) {
  if (!state.doc.settings.showAlternateKeys) return '';
  return (table.alternateKeys || []).map(key => (key.columns || []).join(',')).join(';');
}

/**
 * A digest of everything about a table's columns that changes the rows drawn for it.
 *
 * Covers names, types, statuses and key flags. Undo and redo swap in a clone of the document
 * rather than calling invalidateSizes, so without this digest a renamed column would come back
 * under an unchanged key, and the cached rows would still reference the discarded document.
 *
 * A rolling hash rather than a joined string, memoised against the columns array itself, because
 * measureTable is reached several times per card per frame - once for the card and once for each
 * end of every connector touching it - and large cards at "all fields" would otherwise slow panning.
 * The array is the right key because the case this exists for is undo,
 * which swaps in a clone and therefore a new array; an edit in place leaves the array identity
 * alone, and every path that does one already calls invalidateSizes, which empties this too.
 */
function columnNameKey(table) {
  const columns = table.columns;
  if (!columns || !columns.length) return 0;

  const cached = nameKeyCache.get(columns);
  if (cached !== undefined) return cached;

  let hash = 5381;

  const fold = value => {
    const text = String(value || '');
    for (let i = 0; i < text.length; i++) hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0;
    hash = ((hash * 33) ^ 31) >>> 0;
  };

  for (const column of columns) {
    fold(column.logicalName || column.schemaName);
    fold(column.displayName);
    fold(column.typeName);
    fold(column.status);

    // The key flags as one nibble. They decide the marker drawn on the row, where the row sorts,
    // and under "relationship fields" whether the row is drawn at all - so a card measured before
    // a column became the primary name, or stopped being a lookup, is measured wrong.
    //
    // isRequired joins them for the mandatory asterisk. It costs no width - the asterisk is drawn
    // inside the marker gutter - but the cached entry holds the row's `column` reference, and undo
    // swaps in a clone, so the flag must change the digest for the card to pick up the live column.
    const flags = (column.isPrimaryId ? 1 : 0) | (column.isPrimaryName ? 2 : 0) |
                  (column.isLookup ? 4 : 0) | (column.isAlternateKey ? 8 : 0) |
                  (hasRequiredMark(column) ? 16 : 0);
    hash = ((hash * 33) ^ flags) >>> 0;
  }

  nameKeyCache.set(columns, hash);
  return hash;
}

function markerFor(column) {
  const settings = state.doc.settings;
  if (column.isPrimaryId && settings.showPrimaryKey) return 'PK';
  if (column.isLookup && settings.showForeignKey) return 'FK';
  if (column.isAlternateKey && settings.showAlternateKeys) return 'AK';
  return '';
}

export function tableRect(table) {
  const size = measureTable(table);
  return { x: table.x, y: table.y, width: size.width, height: size.height, ...size };
}

/**
 * The bounding box of an annotation, whatever kind it is.
 *
 * An arrow has no width and height of its own - it is a start point and a vector, and either can
 * be negative - so every caller that needs to know where annotations are has to come through here
 * rather than reading `width`/`height` directly, or an arrow drawn up and to the left would fall
 * outside Fit, outside the export bounds and out of reach of the marquee.
 */
export function annotationRect(annotation) {
  if (!annotation) return { x: 0, y: 0, width: 0, height: 0 };

  if (annotationKind(annotation) === 'arrow') {
    const endX = annotation.x + (Number(annotation.dx) || 0);
    const endY = annotation.y + (Number(annotation.dy) || 0);

    return {
      x: Math.min(annotation.x, endX),
      y: Math.min(annotation.y, endY),
      width: Math.abs(endX - annotation.x),
      height: Math.abs(endY - annotation.y)
    };
  }

  // The same defaults and the same floors the renderer uses, so the box the marquee tests against
  // and the box Fit allows for are the box that is actually drawn. The defaults apply to a
  // hand-edited or pre-1.6.0 file with no size stored. The note default is NOTE_DEFAULT_SIZE rather
  // than a number written out here, for the same reason.
  const text = annotationKind(annotation) === 'text';

  return {
    x: annotation.x,
    y: annotation.y,
    width: Math.max(120, Number(annotation.width) || (text ? 220 : NOTE_DEFAULT_SIZE)),
    height: Math.max(text ? 24 : 56, Number(annotation.height) || (text ? 40 : NOTE_DEFAULT_SIZE))
  };
}

/**
 * How far a sticky note is tilted, in degrees, positive clockwise.
 *
 * An explicit `annotation.tilt` wins: a selected note has a rotation handle above it, and a note
 * the user has turned by hand carries that angle. Zero is a real answer there - a note
 * deliberately straightened - which is why the test is on the *type* and not on the value.
 *
 * With nothing stored the angle is derived from the note's own id, so it is stable for the life of
 * the note - including across a save and reopen - without writing a property to the file. A
 * random tilt per render would make the canvas twitch on every redraw; the same tilt for every
 * note would look like a grid rather than paper.
 *
 * The derived angle is up to five degrees either way.
 *
 * It lives here rather than in render.js because annotationBounds needs it too, and render.js
 * imports geometry.js and never the reverse.
 */
export function stickyTilt(annotation) {
  if (!annotation) return 0;
  if (typeof annotation.tilt === 'number' && isFinite(annotation.tilt)) return annotation.tilt;

  const id = String(annotation.id || '');
  let hash = 7;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) % 100000;

  return ((hash % 101) - 50) / 10;
}

/**
 * The envelope a drawn annotation actually occupies. A sticky note is drawn rotated about its own
 * centre, so its corners reach past the rectangle it is placed in - at a five-degree tilt a 240x96
 * note reaches about ten pixels beyond its own box.
 *
 * This is the box for anything asking what is on the canvas: the marquee, Fit, and the exported
 * drawing. It is not `annotationRect`, which is the placed rectangle a resize drag is
 * seeded from - growing that by the tilt would make every resize inflate the note a little more.
 *
 * The magnitudes of the sine and cosine are what the envelope is made of, not their signs: the
 * rotation handle turns a note to any angle, and past 90 degrees a signed cosine would give a box
 * narrower than the note itself.
 */
export function annotationBounds(annotation) {
  const rect = annotationRect(annotation);
  if (annotationKind(annotation) !== 'note') return rect;

  const radians = stickyTilt(annotation) * Math.PI / 180;
  if (!radians) return rect;

  const cos = Math.abs(Math.cos(radians));
  const sin = Math.abs(Math.sin(radians));
  const width = rect.width * cos + rect.height * sin;
  const height = rect.width * sin + rect.height * cos;

  return {
    x: rect.x - (width - rect.width) / 2,
    y: rect.y - (height - rect.height) / 2,
    width,
    height
  };
}

/**
 * The box everything drawn on the canvas fits inside, plus padding. Used to size an export and to
 * fit the view.
 *
 * Connectors are measured, not just cards and annotations. A route is not inside the union of the
 * two cards it joins: a dead-level run that has been dragged is lifted clear of both of them, a
 * dragged diagonal pushes its middle segment out sideways, and every self-loop stands 30px plus
 * its fan spread past the card edge. An export sized to the cards alone would cut them off.
 */
export function documentBounds(padding) {
  const pad = padding === undefined ? 60 : padding;
  const rects = state.doc.tables.map(tableRect);

  for (const annotation of state.doc.annotations || []) rects.push(annotationBounds(annotation));

  if (!rects.length) return { x: 0, y: 0, width: 800, height: 600 };

  let minX = Math.min(...rects.map(r => r.x));
  let minY = Math.min(...rects.map(r => r.y));
  let maxX = Math.max(...rects.map(r => r.x + r.width));
  let maxY = Math.max(...rects.map(r => r.y + r.height));

  // Routed exactly as the renderer routes them - same grouping, same fan order - so the box is
  // measured against the points that will be drawn rather than an approximation of them.
  for (const group of groupRelationships(visibleRelationships()).values()) {
    group.forEach((relationship, index) => {
      const route = routeRelationship(relationship, index, group.length);
      if (!route) return;

      for (const point of route.points) {
        if (point.x < minX) minX = point.x;
        if (point.y < minY) minY = point.y;
        if (point.x > maxX) maxX = point.x;
        if (point.y > maxY) maxY = point.y;
      }
    });
  }

  return {
    x: minX - pad,
    y: minY - pad,
    width: (maxX - minX) + pad * 2,
    height: (maxY - minY) + pad * 2
  };
}

// -------------------------------------------------------------- routing ---

/**
 * Groups relationships by unordered table pair so several connectors between the same two tables
 * can be fanned out instead of drawn on top of each other.
 */
export function groupRelationships(relationships) {
  const groups = new Map();
  for (const relationship of relationships) {
    const a = relationship.fromTableId;
    const b = relationship.toTableId;
    const key = a < b ? a + '|' + b : b + '|' + a;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(relationship);
  }
  return groups;
}

/** Vertical centre of the row showing a given column, or null when that column is not on the card. */
function rowCentreY(rect, attributeName) {
  if (!attributeName) return null;

  const wanted = String(attributeName).toLowerCase();
  const rows = rect.rows || [];
  const index = rows.findIndex(row => {
    const column = row.column || {};
    return String(column.logicalName || column.schemaName || '').toLowerCase() === wanted;
  });

  if (index < 0) return null;
  return rect.y + METRICS.headerHeight + index * METRICS.rowHeight + METRICS.rowHeight / 2;
}

/** Vertical centre of the card's primary-key row, or null when that row is not drawn. */
function primaryKeyRowY(rect) {
  const rows = rect.rows || [];
  const index = rows.findIndex(row => (row.column || {}).isPrimaryId);

  if (index < 0) return null;
  return rect.y + METRICS.headerHeight + index * METRICS.rowHeight + METRICS.rowHeight / 2;
}

/**
 * The row on a card that a connector end belongs to, or null when the card is not showing it.
 *
 * The one end of a *proposed* 1:N takes a second try: the row the card itself calls its primary
 * key. What a lookup holds is the other table's primary key, so that row is the right target
 * whether or not `referencedAttribute` has been filled in - and on a proposal it is derived rather
 * than read from Dataverse, so it can still be empty when the table at the one end has not named
 * its key yet. An existing relationship's referenced attribute comes from the metadata and is
 * already right; if the column it names is not on the card, the card genuinely is not showing it.
 *
 * Deliberately a fallback rather than an override. A named attribute that *is* drawn still wins,
 * and a primary key the user has unticked in the inspector is not drawn at all, so this never puts
 * back a row the user has taken off the card.
 *
 * Separate from anchorY because the answer "there is no row to point at" is itself load-bearing:
 * it is what decides whether a vertical run may leave through the side of the card - see
 * routeRelationship.
 */
function rowAnchor(rect, attributeName, fallBackToPrimaryKey) {
  const row = rowCentreY(rect, attributeName);
  if (row !== null) return row;

  if (fallBackToPrimaryKey) {
    const key = primaryKeyRowY(rect);
    if (key !== null) return key;
  }

  return null;
}

/**
 * Where a connector meets the left or right edge of a card. It points at the column the
 * relationship actually uses when that column is drawn; otherwise it meets the middle of the
 * header rather than its bottom edge, so it reads as "this table" instead of pointing at whichever
 * field happens to be first.
 */
function anchorY(rect, attributeName, fallBackToPrimaryKey) {
  const row = rowAnchor(rect, attributeName, fallBackToPrimaryKey);
  return row === null ? rect.y + METRICS.headerHeight / 2 : row;
}

function clampBetween(value, a, b) {
  const low = Math.min(a, b);
  const high = Math.max(a, b);
  return high <= low ? (a + b) / 2 : Math.max(low, Math.min(high, value));
}

/**
 * Drops the points a route does not need: a repeat of the point before it, and a corner that turns
 * through nothing.
 *
 * Both appear once an offset can be dragged to zero along either axis - the shapes below are
 * written so that a zero offset collapses back to the shape the route had before the drag, rather
 * than jumping to a different one as the pointer crosses the axis, and collapsing is what leaves
 * these behind. A zero-length leg would give pathFromPoints a corner with no direction to round
 * and midpointOf a label position that is not on the drawn line.
 */
function tidy(points) {
  let kept = dedupe(points);

  for (let i = kept.length - 2; i > 0; i--) {
    const before = kept[i - 1];
    const here = kept[i];
    const after = kept[i + 1];

    const inLine = Math.abs(before.x - here.x) < 0.01 && Math.abs(here.x - after.x) < 0.01;
    const level = Math.abs(before.y - here.y) < 0.01 && Math.abs(here.y - after.y) < 0.01;
    if (!inLine && !level) continue;

    // Sharing a coordinate is not enough to make a point removable. Three points on one line with
    // the middle one *outside* the other two is a leg that goes out and comes straight back, and a
    // route through a hand-placed corner can be exactly that. Removing it as a straight run would
    // stop the line passing through the corner and leave its handle off the end of the line.
    //
    // Only a hand-placed corner is spared. An automatic route can produce the same shape when an
    // offset is dragged past a clamp, and there the excursion is tidied away.
    const doublesBack = inLine
      ? !between(here.y, before.y, after.y)
      : !between(here.x, before.x, after.x);

    if (doublesBack && Number.isInteger(here.pin)) continue;

    kept.splice(i, 1);
  }

  // Again, because taking a point out of the middle can leave its two neighbours on top of each
  // other, and the first pass has already been past them. A leg of no length gives pathFromPoints
  // a corner with no direction to round.
  kept = dedupe(kept);

  return kept.length >= 2 ? kept : points.slice();
}

/** Drops a point that repeats the one before it. */
function dedupe(points) {
  const kept = [];

  for (const point of points) {
    const last = kept[kept.length - 1];
    if (last && samePoint(last, point)) continue;
    kept.push(point);
  }

  return kept;
}

/** Whether a value lies between two others, either way round, ends included. */
function between(value, a, b) {
  return value >= Math.min(a, b) - 0.01 && value <= Math.max(a, b) + 0.01;
}

/**
 * How much clear space there has to be between two cards before a connector will turn between
 * them. Less than this and a route that leaves through the sides has nowhere to put its middle
 * segment, so it goes round the outside instead.
 */
const SIDE_ROUTE_CLEARANCE = 40;

/**
 * Orthogonal route between two table cards, with whatever corners the user has moved by hand.
 *
 * The automatic route below decides everything about the two ends - which sides the connector
 * leaves through, which row each end points at, which of the three shapes the pair of cards calls
 * for. Hand-placed corners replace the *middle* of it and nothing else, so dragging a corner can
 * never take an end off the column it points at, and a connector that is followed round the
 * outside of two stacked cards is still followed round the outside once one of its corners has
 * been moved.
 */
export function routeRelationship(relationship, offsetIndex, offsetCount) {
  const route = autoRoute(relationship, offsetIndex, offsetCount);
  if (!route) return null;

  const pinned = pinnedPoints(relationship);

  if (!pinned.length) {
    // Nothing placed by hand. Every corner of the automatic route is still a handle - dragging one
    // is what turns the whole route manual - but none of them is pinned yet, which is what
    // `waypointIndex: null` says to the drag.
    route.manual = false;
    route.corners = cornersOf(route.points);
    return route;
  }

  const points = tidy(chainThrough(route.start, pinned, route.end, route.startSide, route.endSide));

  route.manual = true;
  route.points = points;
  route.label = midpointOf(points);
  route.corners = cornersOf(points);

  return route;
}

/**
 * The corners of a connector with one bend taken out of it - or null when that bend cannot go.
 *
 * A bend is rarely one corner. A route that steps out of a card, runs across and steps back in has
 * a corner at each end of the step, and taking out either one on its own puts it straight back:
 * the router has to turn somewhere to reach the corner that is left. So the corner the user pointed
 * at is tried on its own and then with each of its neighbours, and the answer is whichever leaves
 * the fewest turns - or nothing at all, when none of the three does better than the line already
 * has.
 *
 * Returning null matters: a line leaving one card's side and arriving at another's at a different
 * height has to turn twice and no route exists with fewer, so the menu item is offered only when
 * this returns a result and never appears to do nothing.
 *
 * A reduced set that draws the same line the canvas would draw on its own comes back as an empty
 * list rather than as itself, so taking out the last bend anybody moved hands the connector back to
 * following its cards.
 */
export function cornersWithout(relationship, fanIndex, fanCount, index) {
  const route = routeRelationship(relationship, fanIndex, fanCount);
  if (!route) return null;

  const corners = route.corners || [];
  if (!Number.isInteger(index) || index < 0 || index >= corners.length) return null;

  const baked = corners.map(corner => ({ x: corner.x, y: corner.y }));
  const tries = [[index], [index - 1, index], [index, index + 1]]
    .filter(pair => pair.every(at => at >= 0 && at < baked.length));

  const held = relationship.waypoints;

  try {
    let best = null;
    let fewest = corners.length;

    for (const pair of tries) {
      const reduced = baked.filter((point, at) => !pair.includes(at));

      relationship.waypoints = reduced;
      const after = routeRelationship(relationship, fanIndex, fanCount);
      if (!after) continue;

      const turns = (after.corners || []).length;
      if (turns >= fewest) continue;

      fewest = turns;
      best = { reduced, points: after.points };
    }

    if (!best) return null;

    relationship.waypoints = [];
    const automatic = routeRelationship(relationship, fanIndex, fanCount);

    return automatic && samePolyline(automatic.points, best.points) ? [] : best.reduced;
  } finally {
    relationship.waypoints = held;
  }
}

function samePolyline(a, b) {
  return a.length === b.length && a.every((point, at) => samePoint(point, b[at]));
}

/**
 * The corners the user has placed by hand, in the order the route visits them.
 *
 * Guarded exactly as the two offsets are: a coordinate that is NaN or infinite reaches the drawn
 * points, and from there documentBounds, Fit and every picture export. Neither can be produced by
 * a drag; both can arrive in a hand-edited or corrupted file.
 */
function pinnedPoints(relationship) {
  const raw = Array.isArray(relationship.waypoints) ? relationship.waypoints : [];
  const points = [];

  for (const point of raw) {
    if (!point) continue;
    const x = Number(point.x);
    const y = Number(point.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    points.push({ x, y });
  }

  return points;
}

/** Which way a connector has to travel to leave a card through a given side. */
function sideAxis(side) {
  return side === 'top' || side === 'bottom' ? 'y' : 'x';
}

function otherAxis(axis) {
  return axis === 'x' ? 'y' : 'x';
}

function samePoint(a, b) {
  return Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01;
}

/**
 * An orthogonal path from one anchor to the other, through every hand-placed corner in turn.
 *
 * Three rules, and between them they reproduce every automatic shape exactly when the automatic
 * shape's own corners are the pinned ones - which is what stops the picture jumping the moment a
 * drag begins, because that is precisely what the drag pins:
 *
 *  - the first leg travels along the axis the start anchor's side faces, so the connector leaves
 *    the card the way it always has;
 *  - the last leg travels along the axis the end anchor's side faces, for the same reason;
 *  - the route turns at every hand-placed corner, so a corner the user put somewhere is a corner
 *    rather than a bend in a straight run - and, more to the point, the line does not travel out
 *    to it and straight back the way it came.
 *
 * The last hop is the only place those pull against each other. Two legs can turn at the corner or
 * arrive along the right axis, not always both; when they cannot do both it takes three, turning
 * at the corner, crossing, and coming in to the card the way the card's side requires. That keeps
 * a corner dragged well clear of its row from being reached by a leg that doubles straight back on
 * itself.
 */
function chainThrough(start, pinned, end, startSide, endSide) {
  const startAxis = sideAxis(startSide);
  const endAxis = sideAxis(endSide);

  // How much clear ground a step away from either card has to work with: the distance between the
  // two anchors along the axis that step travels on. Half of it at most, so a step out of one card
  // cannot land inside the other when the two are nearly touching.
  const startRoom = startAxis === 'x' ? end.x - start.x : end.y - start.y;
  const endRoom = endAxis === 'x' ? end.x - start.x : end.y - start.y;

  const points = [{ x: start.x, y: start.y }];
  const stops = pinned.map((point, index) => ({ x: point.x, y: point.y, pin: index }));
  stops.push({ x: end.x, y: end.y, pin: null });

  let from = points[0];
  let incoming = null;

  for (let i = 0; i < stops.length; i++) {
    const to = stops[i];
    const last = i === stops.length - 1;

    // The hop's first leg. The second is always the other axis, so a hop of two legs arrives along
    // whichever axis this one is not.
    const leave = i === 0 ? startAxis : otherAxis(incoming);

    let bends;

    if (last && i > 0 && leave === endAxis) {
      // Turning here would arrive across the card's side rather than into it, and not turning
      // would double back along the leg that got here. Three legs do both.
      //
      // The crossing point is halfway between, unless the two are already in line - then halfway
      // is on top of both of them, every bend collapses, and what is left is one leg running along
      // the card's edge into an anchor whose marker points out sideways. A step clear of the card
      // is the shape that leaves through the side it says it leaves through.
      bends = threeLegBends(from, to, endAxis, endSide, endRoom);
    } else {
      bends = [leave === 'x' ? { x: to.x, y: from.y } : { x: from.x, y: to.y }];

      // The same collapse at the other end: a first corner sitting exactly on the anchor's own
      // line leaves the bend on top of the anchor, and the connector sets off along the card's
      // edge rather than out of it.
      if (i === 0 && samePoint(bends[0], from)) {
        bends = stepOut(from, to, startAxis, startSide, startRoom);
      }
    }

    // A bend sitting on either end of its own hop is not a corner, and pushing it would put a
    // duplicate point next to a pinned one - which tidy then drops in favour of the *untagged*
    // copy, leaving two handles on one point: one that moves the pinned corner and one that
    // inserts a second corner beside it.
    let cursor = from;

    for (const bend of bends) {
      if (samePoint(bend, cursor) || samePoint(bend, to)) continue;
      bend.hop = to.pin === null ? pinned.length : to.pin;
      points.push(bend);
      cursor = bend;
    }

    const landing = { x: to.x, y: to.y };
    if (to.pin !== null) landing.pin = to.pin;
    points.push(landing);

    // Which way the route was travelling as it arrived, so the next hop can turn away from it.
    // Read off the last leg actually drawn rather than assumed from the shape: a hop whose bends
    // collapsed is a single leg, and it is that leg the next hop has to turn away from.
    incoming = Math.abs(to.x - cursor.x) > Math.abs(to.y - cursor.y) ? 'x' : 'y';
    from = landing;
  }

  return points;
}

/**
 * How far a route steps clear of a card before turning, when it has nowhere else to turn - and
 * never more than half the gap to the card at the other end, or the step lands inside it and the
 * connector is drawn across a table.
 */
const ANCHOR_STEP = 18;

function anchorStep(room) {
  return Math.max(2, Math.min(ANCHOR_STEP, Math.abs(room) / 2));
}

/** Which way is away from the card, along the axis a side faces. */
function outward(side) {
  return side === 'right' || side === 'bottom' ? 1 : -1;
}

/**
 * The three bends that turn at `from`, cross, and come in to `to` along the end card's own axis.
 * Falls back to a step clear of the card when the two points are already in line, because halfway
 * between them is then on top of both.
 */
function threeLegBends(from, to, endAxis, endSide, room) {
  if (endAxis === 'x') {
    const span = to.x - from.x;
    const cross = Math.abs(span) < 0.01
      ? to.x + anchorStep(room) * outward(endSide) : from.x + span / 2;
    return [{ x: cross, y: from.y }, { x: cross, y: to.y }];
  }

  const span = to.y - from.y;
  const cross = Math.abs(span) < 0.01
    ? to.y + anchorStep(room) * outward(endSide) : from.y + span / 2;
  return [{ x: from.x, y: cross }, { x: to.x, y: cross }];
}

/**
 * The two bends that take a route out of a card's side and then round to a corner sitting on the
 * anchor's own line - where the ordinary single bend would land on the anchor itself and the
 * connector would set off along the card's edge.
 */
function stepOut(from, to, startAxis, startSide, room) {
  const step = anchorStep(room) * outward(startSide);

  return startAxis === 'x'
    ? [{ x: from.x + step, y: from.y }, { x: from.x + step, y: to.y }]
    : [{ x: from.x, y: from.y + step }, { x: to.x, y: from.y + step }];
}

/**
 * Every corner of the drawn route, in drawing order, with which way it can be dragged.
 *
 * Exactly one corner per interior point of the drawn line, in the same order: `corners[i]` is
 * `points[i + 1]`, always. Everything about a corner drag is built on that - the drag bakes the
 * corners as the route's points and then moves one of them by index - so nothing here may drop,
 * merge or reorder an entry.
 *
 * `waypointIndex` says whether this corner is one the user has placed or one the router turned to
 * reach them, which is all the drawing uses it for. A drag does not care: it works on the route as
 * it is drawn, whichever of the two it grabbed.
 */
function cornersOf(points) {
  // Which way a corner can go, and which of its neighbours comes with it.
  //
  // Dragging a corner moves the two legs that meet at it and nothing else - that is what makes it
  // a move rather than a new bend. A move along x carries the leg lying *across* x, the vertical
  // one, so both ends of that leg travel together; a move along y carries the horizontal one. A leg
  // whose far end is one of the two anchors cannot move at all, because that end is sitting on the
  // column the relationship points at - so a corner next to an anchor slides on one axis only, and
  // a corner with an anchor on both sides does not move at all and is not given a handle.
  const freedom = at => {
    // Moving along x slides the leg lying across x - the vertical one - and every point on it
    // travels together. "The leg" is the whole run of points sharing that x, not just the one
    // neighbour: three points in a line are one leg with a redundant point in the middle, and
    // moving two of the three would bend it.
    //
    // An anchor anywhere in the run freezes the lot. It is sitting on the column the relationship
    // points at, so it cannot travel, and dragging the rest of the run without it would pull the
    // line out into an additional bend.
    const along = axis => {
      const value = points[at][axis];

      let low = at;
      let high = at;
      while (low > 0 && Math.abs(points[low - 1][axis] - value) < 0.01) low--;
      while (high < points.length - 1 && Math.abs(points[high + 1][axis] - value) < 0.01) high++;

      if (low === high) return null;
      if (low === 0 || high === points.length - 1) return null;

      const carried = [];
      for (let i = low; i <= high; i++) {
        if (i !== at) carried.push(i - 1);
      }

      return carried;
    };

    return { carryX: along('x'), carryY: along('y') };
  };

  const corners = [];

  for (let i = 1; i < points.length - 1; i++) {
    const point = points[i];
    const free = freedom(i);

    corners.push({
      x: point.x, y: point.y,
      waypointIndex: Number.isInteger(point.pin) ? point.pin : null,
      carryX: free.carryX,
      carryY: free.carryY
    });
  }

  return corners;
}

/**
 * The route the canvas works out for itself: the path points, the two end anchors, the side each
 * anchor sits on so markers can be oriented, and which axis each of the two manual offsets moves
 * the route along.
 *
 * End anchors never move with either offset: dragging a connector separates it from the ones it
 * overlaps without changing what either end points at.
 */
function autoRoute(relationship, offsetIndex, offsetCount) {
  const from = tableById(relationship.fromTableId);
  const to = tableById(relationship.toTableId);
  if (!from || !to) return null;

  const a = tableRect(from);
  const b = tableRect(to);

  const spread = ((offsetIndex || 0) - ((offsetCount || 1) - 1) / 2) * METRICS.connectorGap;

  // `Number(x) || 0` turns NaN into zero and leaves Infinity alone, and an infinite offset reaches
  // documentBounds, which then hands Fit and every picture export an infinite drawing to lay out.
  // Neither value can be produced by a drag; both can arrive in a hand-edited or corrupted file.
  const along = finite(relationship.routeOffset);
  const across = finite(relationship.routeOffsetCross);

  if (from.id === to.id) return selfLoop(a, spread, along);

  const aCentre = { x: a.x + a.width / 2, y: a.y + a.height / 2 };
  const bCentre = { x: b.x + b.width / 2, y: b.y + b.height / 2 };

  const dx = bCentre.x - aCentre.x;
  const dy = bCentre.y - aCentre.y;

  // Only a proposal gets the primary-key fallback at its one end - see rowAnchor.
  const derivedKey = relationship.status === 'Proposed';
  const goingRight = dx >= 0;

  const startY = anchorY(a, relationship.referencedAttribute, derivedKey);
  const endY = anchorY(b, relationship.referencingAttribute, false);

  // Clear space between the two cards, which is where a side-to-side route puts its middle segment.
  const between = goingRight ? b.x - (a.x + a.width) : a.x - (b.x + b.width);

  if (Math.abs(dx) >= Math.abs(dy)) {
    // Cards that overlap each other have no space between them at all, and the clamp that keeps the
    // middle segment between them then has nothing to clamp to, so every leg would be drawn inside
    // one card or the other. Overlapping cards are routed round the outside instead.
    return between < 0
      ? sameSideRoute(a, b, startY, endY, spread, along)
      : sideToSideRoute(a, b, startY, endY, goingRight, spread, along, across);
  }

  // For cards stacked one above the other, no point along a top or bottom edge can pick out a row,
  // since the rows are stacked in the same direction. When either end has its column drawn, the
  // connector leaves through the *side* instead and points at the row.
  //
  // Only then. A card showing no columns has nothing to point at, and the straight top-to-bottom
  // run is the better drawing for it, so that is what it keeps.
  const rowA = rowAnchor(a, relationship.referencedAttribute, derivedKey);
  const rowB = rowAnchor(b, relationship.referencingAttribute, false);

  if (rowA !== null || rowB !== null) {
    // Stacked cards have no room between them to turn in, so those go round the outside.
    return between >= SIDE_ROUTE_CLEARANCE
      ? sideToSideRoute(a, b, startY, endY, goingRight, spread, along, across)
      : sameSideRoute(a, b, startY, endY, spread, along);
  }

  return topToBottomRoute(a, b, aCentre, bCentre, dy >= 0, spread, along, across);
}

/** A usable number, or zero. Guards the route against NaN and against infinity alike. */
function finite(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * The ordinary route: out of one card's side, across, into the other card's facing side.
 *
 * `along` moves the middle segment. `across` moves the whole
 * middle of the route the other way and joins it back to the two anchors with a short step at each
 * end - so both offsets together can take a connector out of a bundle of overlapping lines without
 * either end stopping pointing at its column. At zero the steps have no length and the shape
 * collapses back to the three-segment run, which is why the picture does not jump as a drag
 * crosses the axis.
 */
function sideToSideRoute(a, b, startY, endY, goingRight, spread, along, across) {
  const start = { x: goingRight ? a.x + a.width : a.x, y: startY };
  const end = { x: goingRight ? b.x : b.x + b.width, y: endY };

  const direction = goingRight ? 1 : -1;
  const stub = Math.max(14, Math.min(34, Math.abs(end.x - start.x) / 3));

  // The same tolerance tidy uses, and it has to be. The level branch treats the two anchors as
  // being at one height and draws the middle of the route between `start.y + lift` and
  // `end.y + lift`; at a wider tolerance cards slightly apart in height would get a diagonal leg,
  // which crossingPoints does not recognise, so no bridges would be drawn for it.
  const level = Math.abs(start.y - end.y) < 0.01;

  let points;
  let offsetAxis;
  let crossAxis;

  if (level) {
    // A dead-straight run has no middle segment to shift sideways, so the offset lifts the span
    // instead. Two connectors that would sit exactly on top of each other can be parted.
    offsetAxis = 'y';
    crossAxis = 'x';

    const lift = along + spread;

    if (Math.abs(lift) < 0.5) {
      // Still a straight line between the two anchors. The cross offset has nothing to move *yet*,
      // but the axis is still reported, so a single drag can take the line off the straight run and
      // slide it along in the same gesture.
      points = [start, end];
    } else {
      const x1 = clampBetween(start.x + stub * direction + across, start.x, end.x);
      const x2 = clampBetween(end.x - stub * direction + across, start.x, end.x);

      points = [
        start,
        { x: x1, y: start.y },
        { x: x1, y: start.y + lift },
        { x: x2, y: end.y + lift },
        { x: x2, y: end.y },
        end
      ];
    }
  } else {
    offsetAxis = 'x';
    crossAxis = 'y';

    // Both bounds are direction-corrected: going right to left `start.x` is the source card's
    // *left* edge, so an uncorrected bound would put the middle segment 12 units inside that card.
    const midX = clampBetween((start.x + end.x) / 2 + along + spread,
      start.x + 12 * direction, end.x - 12 * direction);

    if (Math.abs(across) < 0.5) {
      points = [start, { x: midX, y: start.y }, { x: midX, y: end.y }, end];
    } else {
      const x1 = clampBetween(start.x + stub * direction, start.x, midX);
      const x2 = clampBetween(end.x - stub * direction, midX, end.x);

      points = [
        start,
        { x: x1, y: start.y },
        { x: x1, y: start.y + across },
        { x: midX, y: start.y + across },
        { x: midX, y: end.y + across },
        { x: x2, y: end.y + across },
        { x: x2, y: end.y },
        end
      ];
    }
  }

  points = tidy(points);

  return {
    points,
    start,
    end,
    startSide: goingRight ? 'right' : 'left',
    endSide: goingRight ? 'left' : 'right',
    offsetAxis,
    crossAxis,
    label: midpointOf(points)
  };
}

/**
 * Two cards stacked one above the other, both ends pointing at a row. Both connectors leave
 * through the same side and the route runs down a lane just outside them.
 *
 * One degree of freedom rather than two: the lane is the only part of this shape that can move.
 * The two arms are at the rows they point at, and moving either of those is exactly what the whole
 * route exists to avoid.
 */
function sameSideRoute(a, b, startY, endY, spread, along) {
  const aRight = a.x + a.width;
  const bRight = b.x + b.width;

  // Round whichever side gives the shorter pair of arms, so the lane hugs the cards rather than
  // reaching across the whole of the wider one.
  const outerRight = Math.max(aRight, bRight);
  const outerLeft = Math.min(a.x, b.x);
  const rightCost = (outerRight - aRight) + (outerRight - bRight);
  const leftCost = (a.x - outerLeft) + (b.x - outerLeft);
  const side = leftCost < rightCost ? 'left' : 'right';

  const direction = side === 'right' ? 1 : -1;
  const start = { x: side === 'right' ? aRight : a.x, y: startY };
  const end = { x: side === 'right' ? bRight : b.x, y: endY };
  const outer = side === 'right' ? outerRight : outerLeft;

  // `along` is a drag in screen x, so it moves the lane the way the pointer went whichever side
  // the lane is on. The spread fans parallel connectors away from the cards.
  let lane = outer + (METRICS.channel + spread) * direction + along;
  lane = side === 'right' ? Math.max(lane, outer + 12) : Math.min(lane, outer - 12);

  // Two anchors at the same height collapse this to the straight line between them, which crosses
  // whatever lies between the two cards. That is not a case worth routing around: the arms have to
  // arrive at their rows horizontally, so *every* orthogonal route into an anchor at that height
  // crosses the same ground, and the straight line is the shortest of them. It only arises when one
  // card has been dropped on another, which is a thing to fix by moving the card.
  const points = tidy([start, { x: lane, y: start.y }, { x: lane, y: end.y }, end]);

  return {
    points,
    start,
    end,
    startSide: side,
    endSide: side,
    offsetAxis: 'x',
    crossAxis: null,
    label: midpointOf(points)
  };
}

/**
 * Straight down from one card's bottom edge into the other card's top edge. What a vertical run
 * looks like when neither end has a row to point at.
 *
 * The two offsets work the same way round as they do side to side: `along` moves the middle
 * segment, `across` moves the whole middle of the route the other way with a step at each end.
 */
function topToBottomRoute(a, b, aCentre, bCentre, goingDown, spread, along, across) {
  const start = {
    x: clampToRect(aCentre.x + spread, a.x, a.x + a.width),
    y: goingDown ? a.y + a.height : a.y
  };
  const end = {
    x: clampToRect(bCentre.x + spread, b.x, b.x + b.width),
    y: goingDown ? b.y : b.y + b.height
  };

  const direction = goingDown ? 1 : -1;
  const stub = Math.max(14, Math.min(34, Math.abs(end.y - start.y) / 3));
  const level = Math.abs(start.x - end.x) < 0.01;   // see sideToSideRoute

  let points;
  let offsetAxis;
  let crossAxis;

  if (level) {
    offsetAxis = 'x';
    crossAxis = 'y';

    if (Math.abs(along) < 0.5) {
      points = [start, end];   // see sideToSideRoute: the cross axis is still reported
    } else {
      const y1 = clampBetween(start.y + stub * direction + across, start.y, end.y);
      const y2 = clampBetween(end.y - stub * direction + across, start.y, end.y);

      points = [
        start,
        { x: start.x, y: y1 },
        { x: start.x + along, y: y1 },
        { x: end.x + along, y: y2 },
        { x: end.x, y: y2 },
        end
      ];
    }
  } else {
    offsetAxis = 'y';
    crossAxis = 'x';

    // Both bounds direction-corrected, for the reason given against midX in sideToSideRoute: a run
    // going upward would otherwise have its middle segment clamped 12 units inside the card the
    // connector has just left.
    const midY = clampBetween((start.y + end.y) / 2 + along + spread,
      start.y + 12 * direction, end.y - 12 * direction);

    if (Math.abs(across) < 0.5) {
      points = [start, { x: start.x, y: midY }, { x: end.x, y: midY }, end];
    } else {
      const y1 = clampBetween(start.y + stub * direction, start.y, midY);
      const y2 = clampBetween(end.y - stub * direction, midY, end.y);

      points = [
        start,
        { x: start.x, y: y1 },
        { x: start.x + across, y: y1 },
        { x: start.x + across, y: midY },
        { x: end.x + across, y: midY },
        { x: end.x + across, y: y2 },
        { x: end.x, y: y2 },
        end
      ];
    }
  }

  points = tidy(points);

  return {
    points,
    start,
    end,
    startSide: goingDown ? 'bottom' : 'top',
    endSide: goingDown ? 'top' : 'bottom',
    offsetAxis,
    crossAxis,
    label: midpointOf(points)
  };
}

function selfLoop(rect, spread, manual) {
  const out = Math.max(16, 30 + Math.abs(spread) + (manual || 0));
  const top = rect.y + rect.height * 0.3;
  const bottom = rect.y + rect.height * 0.7;
  const right = rect.x + rect.width;

  const points = [
    { x: right, y: top },
    { x: right + out, y: top },
    { x: right + out, y: bottom },
    { x: right, y: bottom }
  ];

  return {
    points,
    start: points[0],
    end: points[3],
    startSide: 'right',
    endSide: 'right',
    offsetAxis: 'x',
    crossAxis: null,
    label: { x: right + out + 6, y: (top + bottom) / 2 }
  };
}

function clampToRect(value, min, max) {
  const inset = 12;
  return Math.max(min + inset, Math.min(max - inset, value));
}

function midpointOf(points) {
  if (points.length <= 2) {
    return { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 };
  }
  const a = points[Math.floor((points.length - 1) / 2)];
  const b = points[Math.floor((points.length - 1) / 2) + 1];
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export function pathFromPoints(points, radius, jumps) {
  if (!points || points.length < 2) return '';
  const r = radius === undefined ? 6 : radius;
  const hops = jumps && jumps.length ? jumps : null;

  let d = 'M ' + round(points[0].x) + ' ' + round(points[0].y);
  let cursor = points[0];

  for (let i = 1; i < points.length - 1; i++) {
    const previous = points[i - 1];
    const current = points[i];
    const next = points[i + 1];

    const inLength = Math.hypot(current.x - previous.x, current.y - previous.y);
    const outLength = Math.hypot(next.x - current.x, next.y - current.y);
    const corner = Math.min(r, inLength / 2, outLength / 2);

    const enter = pointTowards(current, previous, corner);
    const exit = pointTowards(current, next, corner);

    d += straightRun(cursor, enter, hops);
    d += ' Q ' + round(current.x) + ' ' + round(current.y) + ' ' + round(exit.x) + ' ' + round(exit.y);
    cursor = exit;
  }

  d += straightRun(cursor, points[points.length - 1], hops);
  return d;
}

/**
 * One straight leg of a route, with a small semicircular hop wherever it crosses a connector that
 * was drawn earlier. Only horizontal legs hop, so a crossing produces one bridge rather than two.
 */
function straightRun(from, to, hops) {
  const horizontal = Math.abs(to.y - from.y) < 0.01;
  if (!hops || !horizontal) return ' L ' + round(to.x) + ' ' + round(to.y);

  const direction = to.x >= from.x ? 1 : -1;
  const radius = METRICS.jumpRadius;

  const onThisRun = hops
    .filter(hop =>
      Math.abs(hop.y - from.y) < 0.5 &&
      (hop.x - from.x) * direction > radius + 1 &&
      (to.x - hop.x) * direction > radius + 1)
    .sort((a, b) => (a.x - b.x) * direction);

  let d = '';
  for (const hop of onThisRun) {
    d += ' L ' + round(hop.x - radius * direction) + ' ' + round(from.y);
    d += ' A ' + radius + ' ' + radius + ' 0 0 ' + (direction > 0 ? 1 : 0) + ' ' +
         round(hop.x + radius * direction) + ' ' + round(from.y);
  }

  return d + ' L ' + round(to.x) + ' ' + round(to.y);
}

/** Straight legs of a route, as axis-aligned segments. */
export function segmentsOf(points) {
  const segments = [];
  for (let i = 0; i < (points || []).length - 1; i++) {
    segments.push({ a: points[i], b: points[i + 1] });
  }
  return segments;
}

/**
 * Points where this route's horizontal legs cross the vertical legs of routes already drawn.
 * Crossings very close to a corner or an end anchor are ignored: a bridge there reads as a kink.
 */
export function crossingPoints(points, priorSegments) {
  const found = [];
  if (!priorSegments || !priorSegments.length) return found;

  const clearance = METRICS.jumpRadius + 3;

  for (const own of segmentsOf(points)) {
    if (Math.abs(own.a.y - own.b.y) >= 0.5) continue;

    const left = Math.min(own.a.x, own.b.x);
    const right = Math.max(own.a.x, own.b.x);
    const y = own.a.y;

    for (const other of priorSegments) {
      if (Math.abs(other.a.x - other.b.x) >= 0.5) continue;

      const x = other.a.x;
      const top = Math.min(other.a.y, other.b.y);
      const bottom = Math.max(other.a.y, other.b.y);

      if (x <= left + clearance || x >= right - clearance) continue;
      if (y <= top + clearance || y >= bottom - clearance) continue;

      if (!found.some(hop => Math.abs(hop.x - x) < 1 && Math.abs(hop.y - y) < 1)) {
        found.push({ x, y });
      }
    }
  }

  return found;
}

function pointTowards(from, to, distance) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  return { x: from.x + (dx / length) * distance, y: from.y + (dy / length) * distance };
}

export function round(value) {
  return Math.round(value * 100) / 100;
}

export function pointInRect(point, rect) {
  return point.x >= rect.x && point.x <= rect.x + rect.width &&
         point.y >= rect.y && point.y <= rect.y + rect.height;
}

export function rectsIntersect(a, b) {
  return !(b.x > a.x + a.width || b.x + b.width < a.x || b.y > a.y + a.height || b.y + b.height < a.y);
}

/** Shortest distance from a point to a polyline, used for connector hit testing. */
export function distanceToPolyline(point, points) {
  let best = Infinity;
  for (let i = 0; i < points.length - 1; i++) {
    best = Math.min(best, distanceToSegment(point, points[i], points[i + 1]));
  }
  return best;
}

function distanceToSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (!lengthSquared) return Math.hypot(p.x - a.x, p.y - a.y);

  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export { truncateToWidth };
