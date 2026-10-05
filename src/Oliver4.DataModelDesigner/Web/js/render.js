// SVG canvas renderer.
//
// The canvas is drawn as real SVG rather than HTML boxes so that what is on screen, what is
// exported to SVG and what is rasterised to PNG are the same drawing. Visual properties are set
// as presentation attributes rather than CSS classes, which keeps the exported file self-contained.

import { svg, clear, truncateToWidth, measureText } from './util.js';
import {
  state, tableById, visibleRelationships, relationshipById, annotationKind, annotationBehind,
  annotationPaintOrder,
  NOTE_DEFAULT_SIZE, NOTE_DEFAULT_FONT_SIZE
} from './state.js';
import {
  METRICS, FONTS, statusStyle, measureTable, tableRect, tableTitle, tableSubtitle,
  hasOwnershipMark, hasNote, hasRequiredMark, REQUIRED_MARK_INSET, stickyTilt,
  routeRelationship, groupRelationships, pathFromPoints, documentBounds, round,
  segmentsOf, crossingPoints
} from './geometry.js';
import { palette, withLightPalette, emphasisHead, emphasisLine, emphasisName } from './theme.js';

/** Size of the drag handle in the bottom-right corner of a note, in world units. */
export const ANNOTATION_HANDLE = 12;

/** How far above the top edge of a sticky note its rotation knob stands, in world units. */
export const ROTATE_GRIP_OFFSET = 20;

/** Width of the grip that reorders a row, drawn just outside the left edge of a selected card. */
const ROW_GRIP_WIDTH = 10;

/** Side of the mark drawn on a corner of a selected connector, in screen pixels. */
const CORNER_HANDLE = 8;

/**
 * Side of the transparent square that catches the pointer on one, in screen pixels.
 *
 * Big enough to hit at any zoom, small enough not to make dead spots: the handles sit in the
 * overlay, above the cards, so each one takes the press from whatever is underneath it.
 */
const CORNER_TARGET = 16;

/** Lines of a table note shown on the canvas before it is cut short and left to the inspector. */
const NOTE_MAX_LINES = 10;

/** Screen height of the command bar and its margins - the strip a popover must not open under. */
const TOP_CHROME_HEIGHT = 84;

/** Clearance a popover keeps from an edge of the window with nothing floating over it. */
const EDGE_MARGIN = 16;

/** Screen height of the zoom pill, the legend and their margins along the bottom edge. */
const BOTTOM_CHROME_HEIGHT = 66;

/**
 * How far in from one side a popover has to start to clear the panel floating there.
 *
 * Returns the plain edge margin when the panel is closed or collapsed, so a note gets the whole
 * width when there is nothing in the way.
 */
function panelInset(id) {
  const panel = typeof document !== 'undefined' ? document.getElementById(id) : null;
  if (!panel || panel.hidden || (panel.classList && panel.classList.contains('is-collapsed'))) {
    return EDGE_MARGIN;
  }

  return (panel.offsetWidth || 0) + EDGE_MARGIN + 14;
}

let layers = null;
const routeCache = new Map();

export function initRenderer() {
  layers = {
    defs: document.getElementById('canvas-defs'),
    links: document.getElementById('layer-links'),
    annotations: document.getElementById('layer-annotations'),
    annotationsFront: document.getElementById('layer-annotations-front'),
    tables: document.getElementById('layer-tables'),
    overlay: document.getElementById('layer-overlay'),
    viewport: document.getElementById('viewport'),
    grid: document.getElementById('grid-rect')
  };

  buildDefs();
}

/** Rebuilds the theme-dependent definitions. Called when the user switches light and dark. */
export function refreshRendererTheme() {
  if (!layers) return;
  buildDefs();
  render();
}

function buildDefs() {
  clear(layers.defs);

  const theme = palette();

  const pattern = svg('pattern', {
    id: 'dot-grid', width: 24, height: 24, patternUnits: 'userSpaceOnUse'
  }, [svg('circle', { cx: 1, cy: 1, r: theme.gridDotRadius, fill: theme.gridDot })]);

  const shadow = svg('filter', { id: 'card-shadow', x: '-20%', y: '-20%', width: '140%', height: '150%' }, [
    svg('feDropShadow', {
      dx: 0, dy: 3, stdDeviation: 4, 'flood-color': '#000000', 'flood-opacity': theme.shadowOpacity
    })
  ]);

  layers.defs.appendChild(pattern);
  layers.defs.appendChild(shadow);
}

// ------------------------------------------------------------------------

export function render() {
  if (!layers) return;

  const doc = state.doc;

  layers.grid.setAttribute('class', doc.settings.showGrid ? 'grid-rect with-grid' : 'grid-rect');
  layers.viewport.setAttribute(
    'transform',
    'translate(' + round(state.view.panX) + ',' + round(state.view.panY) + ') scale(' + round(state.view.zoom) + ')'
  );

  // The grid pattern must not scroll with the viewport transform, so it is offset instead.
  const pattern = document.getElementById('dot-grid');
  if (pattern) {
    pattern.setAttribute('patternTransform',
      'translate(' + round(state.view.panX % (24 * state.view.zoom)) + ',' +
      round(state.view.panY % (24 * state.view.zoom)) + ') scale(' + round(state.view.zoom) + ')');
  }

  renderLinks();
  renderAnnotations();
  renderTables();
  renderOverlay();
}

/**
 * Which objects to keep at full strength while everything else is dimmed, or null for "dim
 * nothing".
 *
 * highlightPath is checked first and on its own, before any return on an empty selection: the
 * path finder sets highlightPath and closes its dialog without selecting anything, and the
 * selection is not a precondition for a highlight.
 */
function dimming() {
  if (state.highlightPath) {
    const emphasised = { tables: new Set(), links: new Set() };
    for (const id of state.highlightPath.tables) emphasised.tables.add(id);
    for (const id of state.highlightPath.relationships) emphasised.links.add(id);
    return emphasised;
  }

  return null;
}

// --------------------------------------------------------------- links ---

function renderLinks() {
  clear(layers.links);
  routeCache.clear();

  const relationships = visibleRelationships();
  const groups = groupRelationships(relationships);
  const emphasis = dimming();

  // Each connector hops over the ones already drawn, so a crossing gets exactly one bridge.
  const drawnSegments = [];

  for (const group of groups.values()) {
    group.forEach((relationship, index) => {
      const route = routeRelationship(relationship, index, group.length);
      if (!route) return;

      // Where this connector sat in its fan of parallel lines. Anything that has to re-derive the
      // same route later - the check that says whether a bend can be taken out - needs the same
      // two numbers, or it is asking about a line drawn somewhere slightly else.
      route.fanIndex = index;
      route.fanCount = group.length;

      routeCache.set(relationship.id, route);

      const jumps = crossingPoints(route.points, drawnSegments);
      layers.links.appendChild(renderLink(relationship, route, emphasis, jumps));
      drawnSegments.push(...segmentsOf(route.points));
    });
  }
}

function renderLink(relationship, route, emphasis, jumps) {
  const theme = palette();
  const selected = state.selection.relationships.has(relationship.id);
  const dimmed = emphasis && !emphasis.links.has(relationship.id);

  let stroke = relationship.highlight || theme.connector;
  if (relationship.status === 'Proposed') stroke = relationship.highlight || theme.status.Proposed.mark;
  else if (relationship.status === 'Deprecated') stroke = relationship.highlight || theme.status.Deprecated.mark;
  if (selected) stroke = theme.connectorSelected;
  if (dimmed) stroke = theme.connectorDim;

  const dash = relationship.status === 'Existing' ? null
    : relationship.status === 'Deprecated' ? '3 4' : '5 4';

  const group = svg('g', {
    'data-kind': 'relationship',
    'data-id': relationship.id,
    opacity: dimmed ? 0.45 : 1
  });

  const plain = pathFromPoints(route.points, 8);
  const d = pathFromPoints(route.points, 8, jumps);

  // A wide transparent path underneath makes thin connectors easy to click and to drag.
  group.appendChild(svg('path', {
    d: plain, fill: 'none', stroke: 'transparent', 'stroke-width': 12,
    'data-hit': 'relationship', 'data-id': relationship.id, 'pointer-events': 'stroke'
  }));

  group.appendChild(svg('path', {
    d,
    fill: 'none',
    stroke,
    'stroke-width': selected ? 2.2 : 1.5,
    'stroke-dasharray': dash,
    'stroke-linejoin': 'round',
    'pointer-events': 'none'
  }));

  appendCardinalityMarkers(group, relationship, route, stroke);

  if (relationship.missingSinceRefresh) {
    group.appendChild(svg('circle', {
      cx: round(route.label.x), cy: round(route.label.y), r: 4,
      fill: theme.missingFill, stroke: theme.missing, 'stroke-width': 1, 'pointer-events': 'none'
    }));
  }

  const label = linkLabel(relationship);
  if (label) {
    const width = measureText(label, FONTS.edgeLabel) + 8;
    group.appendChild(svg('rect', {
      x: round(route.label.x - width / 2), y: round(route.label.y - 8),
      width: round(width), height: 15, rx: 3,
      fill: theme.labelChip, 'fill-opacity': theme.labelChipOpacity, 'pointer-events': 'none'
    }));
    group.appendChild(svg('text', {
      x: round(route.label.x), y: round(route.label.y + 3),
      'text-anchor': 'middle',
      'font-family': 'Consolas, monospace', 'font-size': 10,
      fill: relationship.status === 'Proposed' ? theme.labelProposedInk : theme.labelInk,
      'pointer-events': 'none',
      text: label
    }));
  }

  return group;
}

/**
 * The ownership pill for a card, or null when it should not be drawn.
 *
 * Only for tables that actually exist in the environment: a proposed table has no ownership until
 * someone creates it, and claiming one on the diagram would be inventing a design decision that
 * has not been made.
 */
function ownershipMark(table) {
  if (!hasOwnershipMark(table)) return null;

  switch (table.ownershipType) {
    case 'UserOwned':
      return { mark: 'USER', title: 'User or team owned - records have an owner and can be assigned' };
    case 'TeamOwned':
      return { mark: 'TEAM', title: 'Team owned' };
    case 'OrganizationOwned':
      return { mark: 'ORG', title: 'Organisation owned - every record is visible to the whole organisation' };
    case 'BusinessOwned':
      return { mark: 'BU', title: 'Business unit owned' };
    case 'BusinessParented':
      return { mark: 'BU', title: 'Business unit parented' };
    case 'None':
      return { mark: 'NONE', title: 'Not owned - no ownership-based security applies' };
    default:
      // MetadataService.DescribeOwnership only ever emits the values above, so this is
      // unreachable from a refreshed diagram. A hand-edited file could still get here, and a
      // question mark is better than an unrecognised enum name squeezed into a 34px pill.
      return { mark: '?', title: 'Ownership: ' + table.ownershipType };
  }
}

function linkLabel(relationship) {
  const settings = state.doc.settings;
  const parts = [];

  // The "1:N"/"N:N" text and the crow's-foot terminators are both the cardinality toggle's job,
  // so unticking it removes both.
  if (settings.showCardinality) parts.push(relationship.kind === 'ManyToMany' ? 'N:N' : '1:N');
  if (settings.showRelationshipName && relationship.schemaName) parts.push(relationship.schemaName);

  if (settings.showCascade && relationship.cascade) {
    const cascade = relationship.cascade;
    if (cascade.delete) parts.push('del:' + shortCascade(cascade.delete));
    if (cascade.assign) parts.push('asg:' + shortCascade(cascade.assign));
  }

  if (relationship.status === 'Proposed') parts.unshift('proposed');
  return parts.join(' · ');
}

function shortCascade(value) {
  switch (value) {
    case 'Cascade': return 'Csc';
    case 'NoCascade': return 'None';
    case 'RemoveLink': return 'Link';
    case 'Restrict': return 'Rstr';
    case 'Active': return 'Actv';
    case 'UserOwned': return 'User';
    default: return value;
  }
}

/**
 * Crow's foot terminators drawn as explicit paths rather than SVG markers, so an exported file
 * needs no marker definitions and the orientation is readable in the output.
 */
function appendCardinalityMarkers(group, relationship, route, stroke) {
  if (state.doc.settings.showCardinality === false) return;

  const many = relationship.kind === 'ManyToMany';

  appendMarker(group, route.start, route.startSide, many ? 'many' : 'one', stroke);
  appendMarker(group, route.end, route.endSide, 'many', stroke);
}

/**
 * One terminator, drawn in the marker's own space where +x points away from the card along the
 * connector, whichever side of the card the connector leaves from.
 *
 * The many terminator is a crow's foot, and which way round it goes is the whole of its meaning.
 * The three prongs belong on the card - they are the "many" records fanning out of the one row the
 * line arrives at - and the apex belongs out on the connector. Drawn the other way round, apex on
 * the card and prongs out in the whitespace, it reads as an arrowhead pointing into the table and
 * says nothing about cardinality at all.
 */
function appendMarker(group, point, side, kind, stroke) {
  const angle = { right: 0, left: 180, bottom: 90, top: 270 }[side] || 0;
  const transform = 'translate(' + round(point.x) + ',' + round(point.y) + ') rotate(' + angle + ')';

  const marker = svg('g', { transform, 'pointer-events': 'none' });

  if (kind === 'one') {
    marker.appendChild(svg('line', {
      x1: 7, y1: -5, x2: 7, y2: 5, stroke, 'stroke-width': 1.5, 'stroke-linecap': 'round'
    }));
  } else {
    // Two outer prongs touching the card at x = 0 and meeting the connector at x = 11...
    marker.appendChild(svg('path', {
      d: 'M 0 -5 L 11 0 L 0 5',
      fill: 'none', stroke, 'stroke-width': 1.4, 'stroke-linecap': 'round', 'stroke-linejoin': 'round'
    }));
    // ...and the middle one, which lies along the connector itself.
    marker.appendChild(svg('line', {
      x1: 0, y1: 0, x2: 11, y2: 0, stroke, 'stroke-width': 1.4, 'stroke-linecap': 'round'
    }));
  }

  group.appendChild(marker);
}

export function routeFor(relationshipId) {
  return routeCache.get(relationshipId) || null;
}

/**
 * Where a note's leader line should point. A table gives its card centre; a relationship gives the
 * middle of its drawn route, falling back to the midpoint between its two cards when the route has
 * not been computed yet (an excluded or hidden connector never gets one).
 */
function attachmentAnchor(id) {
  const table = tableById(id);
  if (table) {
    const rect = tableRect(table);
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  }

  const relationship = relationshipById(id);
  if (!relationship) return null;

  // route.label is the point the connector already puts its own label on, so a note attached to a
  // relationship lands where the eye is already looking.
  const route = routeCache.get(relationship.id);
  if (route && route.label) return { x: route.label.x, y: route.label.y };

  const from = tableById(relationship.fromTableId);
  const to = tableById(relationship.toTableId);
  if (!from || !to) return null;

  const a = tableRect(from);
  const b = tableRect(to);

  return {
    x: (a.x + a.width / 2 + b.x + b.width / 2) / 2,
    y: (a.y + a.height / 2 + b.y + b.height / 2) / 2
  };
}

// -------------------------------------------------------------- tables ---

function renderTables() {
  clear(layers.tables);
  const emphasis = dimming();

  for (const table of state.doc.tables) {
    layers.tables.appendChild(renderTableCard(table, emphasis));
  }
}

function renderTableCard(table, emphasis) {
  const theme = palette();
  const rect = tableRect(table);
  const style = statusStyle(table.status);
  const selected = state.selection.tables.has(table.id);
  const dimmed = emphasis && !emphasis.tables.has(table.id);

  const group = svg('g', {
    'data-kind': 'table',
    'data-id': table.id,
    transform: 'translate(' + round(table.x) + ',' + round(table.y) + ')',
    opacity: dimmed ? 0.4 : 1,
    class: 'node'
  });

  const strokeColour = table.highlight || (selected ? theme.selection : style.stroke);

  // Emphasis colours the header band and the border, never the body. The header uses a heavily
  // washed-out version of the chosen hue so a row of emphasised cards stays readable rather than
  // shouting, and the column text below keeps the contrast its status fill gives it.
  const bodyFill = style.fill;
  const headFill = table.highlight ? emphasisHead(table.highlight) : style.head;
  const headLine = table.highlight ? emphasisLine(table.highlight) : style.headLine;
  const markColour = table.highlight || style.mark;

  if (selected) {
    group.appendChild(svg('rect', {
      x: -3, y: -3, width: rect.width + 6, height: rect.height + 6,
      rx: METRICS.cornerRadius + 3,
      fill: 'none', stroke: theme.selection, 'stroke-opacity': 0.22, 'stroke-width': 3
    }));
  }

  group.appendChild(svg('rect', {
    x: 0, y: 0, width: rect.width, height: rect.height, rx: METRICS.cornerRadius,
    fill: bodyFill,
    stroke: strokeColour,
    'stroke-width': table.highlight || selected ? 2 : 1,
    'stroke-dasharray': style.dash,
    filter: 'url(#card-shadow)'
  }));

  // Header
  group.appendChild(svg('path', {
    d: headerPath(rect.width, METRICS.headerHeight, METRICS.cornerRadius),
    fill: headFill
  }));
  group.appendChild(svg('line', {
    x1: 0, y1: METRICS.headerHeight, x2: rect.width, y2: METRICS.headerHeight,
    stroke: headLine, 'stroke-width': 1
  }));

  group.appendChild(svg('rect', {
    x: METRICS.padX, y: METRICS.headerHeight / 2 - 3, width: 6, height: 6, rx: 2, fill: markColour
  }));

  const badge = state.doc.settings.showStatusBadges && table.status !== 'Existing'
    ? table.status.toUpperCase() : null;
  const missing = table.missingSinceRefresh;
  // Through geometry.js so the tag is drawn exactly when the card was measured to have room for
  // it: both use the same test, so a note of nothing but whitespace neither draws a tag nor
  // reserves header space for one.
  const noteTag = hasNote(table);
  const ownership = ownershipMark(table);

  let titleSpace = rect.width - METRICS.padX * 2 - 12;
  if (badge) titleSpace -= measureText(badge, FONTS.badge) + 16;
  if (missing) titleSpace -= 62;
  if (noteTag) titleSpace -= METRICS.noteTagWidth + 6;
  if (ownership) titleSpace -= METRICS.ownershipWidth + 6;

  const subtitle = tableSubtitle(table);
  if (subtitle && !badge) titleSpace -= measureText(subtitle, FONTS.schema) + 10;

  group.appendChild(svg('text', {
    x: METRICS.padX + 12, y: METRICS.headerHeight / 2 + 4,
    'font-family': '"Segoe UI", sans-serif', 'font-size': 12, 'font-weight': 600,
    fill: style.ink,
    text: truncateToWidth(tableTitle(table), FONTS.title, Math.max(40, titleSpace))
  }));

  let rightEdge = rect.width - METRICS.padX;

  // Ownership sits at the right-hand end of the header, before the note tag. A small outlined
  // pill rather than a colour, because the four status colours already carry meaning and a second
  // colour dimension on the same card would make neither of them readable.
  if (ownership) {
    const width = METRICS.ownershipWidth;

    // Its own group, with the <title> as the first child. An SVG <title> scopes its tooltip to its
    // parent element, so appended to the card group it would show on every hover anywhere on the
    // card - and a <title> that is not the first child of its parent is treated inconsistently
    // outside Chromium, which matters because this drawing is also the export.
    const pill = svg('g', {}, [
      svg('title', { text: ownership.title }),
      svg('rect', {
        x: rightEdge - width, y: METRICS.headerHeight / 2 - 7,
        width, height: 14, rx: 7,
        fill: 'none', stroke: theme.ownershipLine, 'stroke-width': 1
      }),
      svg('text', {
        x: rightEdge - width / 2, y: METRICS.headerHeight / 2 + 3,
        'text-anchor': 'middle',
        'font-family': '"Segoe UI", sans-serif', 'font-size': 8, 'font-weight': 600,
        'letter-spacing': '0.3',
        fill: theme.ownershipInk,
        text: ownership.mark
      })
    ]);

    group.appendChild(pill);
    rightEdge -= width + 6;
  }

  if (noteTag) {
    const tagWidth = METRICS.noteTagWidth;
    const open = state.openNote === table.id;

    // The tag is a control, not just a marker: clicking it opens the note on the card being
    // pointed at, without going through the inspector.
    const tag = svg('g', {
      'data-note-for': table.id,
      'pointer-events': 'all',
      style: 'cursor: pointer'
    }, [
      svg('title', { text: open ? 'Hide this note' : 'Show this note on the canvas' }),

      // Open is drawn as a heavier border in the tag's own ink, not as an inversion. Inverted, the
      // ink and fill pairs fall below the 4.5:1 that 8px bold text needs: white on #d9bf6e is 1.81:1
      // in the light theme and #232b3c on #8d7429 is 3.15:1 in the dark one. The normal pair is
      // 4.76:1 and 8.48:1.
      svg('rect', {
        x: rightEdge - tagWidth, y: METRICS.headerHeight / 2 - 7,
        width: tagWidth, height: 14, rx: 3,
        fill: theme.noteTagFill,
        stroke: open ? theme.noteTagInk : theme.noteTagLine,
        'stroke-width': open ? 2 : 1
      }),
      svg('text', {
        x: rightEdge - tagWidth / 2, y: METRICS.headerHeight / 2 + 3,
        'text-anchor': 'middle',
        'font-family': '"Segoe UI", sans-serif', 'font-size': 8, 'font-weight': 600,
        'letter-spacing': '0.4',
        fill: theme.noteTagInk,
        text: 'NOTE'
      })
    ]);

    group.appendChild(tag);
    rightEdge -= tagWidth + 6;
  }

  if (badge) {
    const badgeWidth = measureText(badge, FONTS.badge) + 10;
    group.appendChild(svg('rect', {
      x: rightEdge - badgeWidth, y: METRICS.headerHeight / 2 - 7,
      width: badgeWidth, height: 14, rx: 3,
      fill: theme.badgeFill, stroke: style.mark, 'stroke-width': 0.8, 'stroke-opacity': 0.6
    }));
    group.appendChild(svg('text', {
      x: rightEdge - badgeWidth / 2, y: METRICS.headerHeight / 2 + 3,
      'text-anchor': 'middle',
      'font-family': '"Segoe UI", sans-serif', 'font-size': 8, 'font-weight': 600,
      fill: style.mark,
      text: badge
    }));
    rightEdge -= badgeWidth + 6;
  }

  if (missing) {
    group.appendChild(svg('text', {
      x: rightEdge, y: METRICS.headerHeight / 2 + 3, 'text-anchor': 'end',
      'font-family': '"Segoe UI", sans-serif', 'font-size': 8, 'font-weight': 600,
      fill: theme.missing, text: 'NOT FOUND'
    }));
    rightEdge -= 60;
  } else if (subtitle) {
    group.appendChild(svg('text', {
      x: rightEdge, y: METRICS.headerHeight / 2 + 3, 'text-anchor': 'end',
      'font-family': 'Consolas, monospace', 'font-size': 9.5, fill: theme.subtitleInk,
      text: truncateToWidth(subtitle, FONTS.schema, rect.width * 0.42)
    }));
  }

  // Rows
  rect.rows.forEach((row, index) => {
    const y = METRICS.headerHeight + index * METRICS.rowHeight;
    appendRow(group, row, y, rect);
  });

  appendRowGrips(group, table, rect, selected);

  if (table.collapsed && (table.columns || []).length) {
    group.appendChild(svg('text', {
      x: rect.width / 2, y: rect.height + 12, 'text-anchor': 'middle',
      'font-family': '"Segoe UI", sans-serif', 'font-size': 9, fill: theme.hintInk,
      text: (table.columns || []).length + ' columns hidden'
    }));
  }

  return group;
}

// Takes the card's rect rather than the table, because the caller has already measured it, so no
// row goes back through measureTable for an answer already in hand.
function appendRow(group, row, y, rect) {
  const theme = palette();
  const width = rect.width;
  const isProposed = row.column.status === 'Proposed';
  const isDeprecated = row.column.status === 'Deprecated';

  // A proposed column carries the same tinted background a proposed table card does, so "this part
  // does not exist yet" reads the same way at every level of the drawing. The tint makes it stand
  // out among real columns, and the left rule keeps it visible on a black-and-white print.
  if (isProposed) {
    group.appendChild(svg('rect', {
      x: 1, y: y + 0.5, width: width - 2, height: METRICS.rowHeight - 1, rx: 3,
      fill: theme.status.Proposed.head
    }));
  }

  if (y + METRICS.rowHeight < rect.height) {
    group.appendChild(svg('line', {
      x1: 1, y1: y + METRICS.rowHeight, x2: width - 1, y2: y + METRICS.rowHeight,
      stroke: theme.rowRule, 'stroke-width': 1
    }));
  }

  if (isProposed) {
    group.appendChild(svg('rect', {
      x: 1, y: y + 1, width: 2.5, height: METRICS.rowHeight - 2, rx: 1.2,
      fill: theme.proposedRule
    }));
  }

  const baseline = y + METRICS.rowHeight / 2 + 3.5;

  if (row.marker) {
    group.appendChild(svg('text', {
      x: METRICS.padX, y: baseline,
      'font-family': 'Consolas, monospace', 'font-size': 8.5, 'font-weight': 600,
      fill: row.marker === 'PK' ? theme.markerPk : row.marker === 'FK' ? theme.markerFk : theme.markerAk,
      text: row.marker
    }));
  }

  // Business required or system required, which is the one flag isRequired already carries.
  //
  // Right-aligned against the far edge of the marker gutter, which is the only slot on the row
  // that is fixed. The gutter runs from padX to padX + markerWidth - 9 to 29 - and a marker is
  // always exactly two characters of 8.5px Consolas, so it ends at 18.35 and can never grow into
  // the asterisk. The name starts at padX + markerWidth whatever it says and however hard it has
  // been truncated, and the type is anchored to the opposite edge of the card, so neither can
  // reach this either. Costing no width is the point: nothing about the asterisk changes what the
  // measurer has to allow for, so measurer and renderer cannot drift apart over it.
  //
  // Drawn from the palette like everything else on the card, so an export - which runs the whole
  // drawing through withLightPalette - gets the light red rather than the dark one.
  if (hasRequiredMark(row.column)) {
    group.appendChild(svg('text', {
      x: METRICS.padX + METRICS.markerWidth - REQUIRED_MARK_INSET, y: baseline + 0.5,
      'text-anchor': 'end',
      'font-family': 'Consolas, monospace', 'font-size': 10, 'font-weight': 600,
      fill: theme.requiredMark,
      text: '*'
    }));
  }

  const typeWidth = row.type ? measureText(row.type, FONTS.type) : 0;
  const nameSpace = width - METRICS.padX * 2 - METRICS.markerWidth - (typeWidth ? typeWidth + METRICS.typeGap : 0);

  // When both name toggles are on, the schema name follows the display name on the same row in a
  // muted monospace. It shares the row's available width, so the display name gives ground first.
  const secondaryWidth = row.label.secondary
    ? Math.min(measureText(row.label.secondary, FONTS.row) + METRICS.secondaryGap, nameSpace * 0.5)
    : 0;

  const nameNode = svg('text', {
    x: METRICS.padX + METRICS.markerWidth, y: baseline,
    'font-family': row.label.font.includes('Consolas') ? 'Consolas, monospace' : '"Segoe UI", sans-serif',
    'font-size': row.label.font.includes('Consolas') ? 10.5 : 11,
    fill: isDeprecated ? theme.rowDeprecatedInk : isProposed ? theme.rowProposedInk : theme.rowInk,
    'text-decoration': isDeprecated ? 'line-through' : null
  });

  nameNode.appendChild(svg('tspan', {
    text: truncateToWidth(row.label.primary, row.label.font, Math.max(30, nameSpace - secondaryWidth))
  }));

  if (row.label.secondary && secondaryWidth > 18) {
    nameNode.appendChild(svg('tspan', {
      dx: METRICS.secondaryGap,
      'font-family': 'Consolas, monospace',
      'font-size': 9.5,
      fill: theme.typeInk,
      text: truncateToWidth(row.label.secondary, FONTS.row, secondaryWidth - METRICS.secondaryGap)
    }));
  }

  group.appendChild(nameNode);

  if (row.type) {
    group.appendChild(svg('text', {
      x: width - METRICS.padX, y: baseline, 'text-anchor': 'end',
      'font-family': '"Segoe UI", sans-serif', 'font-size': 9.5, fill: theme.typeInk,
      text: row.type
    }));
  }
}

/**
 * The handles that reorder the fields on a card, one per drawn row, down the outside of its left
 * edge - and only while the card is selected.
 *
 * Outside the card rather than in the marker gutter, and behind a selection, because the whole face
 * of a card is already a drag target that moves the card. A row that started a different drag
 * depending on where in it the pointer went down would make moving a card a gamble, and the field
 * order is not something anyone needs to change by accident.
 *
 * Nothing here is drawn into an export: buildExportSvgInner empties the selection first, which is
 * the same thing that takes away the selection outline and the note tag's open state.
 */
function appendRowGrips(group, table, rect, selected) {
  if (!selected || rect.rows.length < 2) return;

  const theme = palette();

  rect.rows.forEach((row, index) => {
    const y = METRICS.headerHeight + index * METRICS.rowHeight;
    const top = y + 2;
    const height = METRICS.rowHeight - 4;

    group.appendChild(svg('rect', {
      x: -ROW_GRIP_WIDTH - 2, y: top, width: ROW_GRIP_WIDTH, height, rx: 2.5,
      fill: theme.selection, 'fill-opacity': 0.14,
      stroke: theme.selection, 'stroke-opacity': 0.4, 'stroke-width': 1,
      'pointer-events': 'none'
    }));

    // Centred in the grip. The rect runs from -(width + 2) to -2, so its centre line is at
    // -(width / 2 + 2) and a 6-unit mark starts 3 units before that, at -(width / 2 + 5) - which is
    // -10 at the width this is drawn at.
    const midY = y + METRICS.rowHeight / 2;
    const markX = round(-(ROW_GRIP_WIDTH / 2 + 5));
    group.appendChild(svg('path', {
      d: 'M ' + markX + ' ' + round(midY - 2) + ' h 6 M ' +
         markX + ' ' + round(midY + 2) + ' h 6',
      fill: 'none',
      stroke: theme.selection, 'stroke-width': 1, opacity: 0.85, 'pointer-events': 'none'
    }));

    // A separate, larger target. The mark is drawn small so it does not read as part of the
    // drawing, and 10 units is a hard thing to hit with a mouse at 60% zoom.
    //
    // It stops one unit short of the card, so pressing on the left-hand border of a selected card
    // at the height of a row moves the card rather than starting a reorder.
    const target = svg('rect', {
      x: -ROW_GRIP_WIDTH - 6, y, width: ROW_GRIP_WIDTH + 5, height: METRICS.rowHeight,
      fill: 'transparent',
      'data-row-grip': 'column',
      'data-id': row.column.id,
      'data-table': table.id,
      style: 'cursor: grab'
    });
    target.appendChild(svg('title', { text: 'Drag to move this column up or down the card' }));
    group.appendChild(target);
  });
}

function headerPath(width, height, radius) {
  return 'M 0 ' + height +
         ' L 0 ' + radius +
         ' Q 0 0 ' + radius + ' 0' +
         ' L ' + (width - radius) + ' 0' +
         ' Q ' + width + ' 0 ' + width + ' ' + radius +
         ' L ' + width + ' ' + height + ' Z';
}

// ---------------------------------------------------------- annotations ---

/**
 * Every annotation, into whichever of the two layers it belongs in.
 *
 * The layers are separate groups in the SVG rather than one group re-sorted, because painting
 * order is also hit-test order: the browser gives the pointer to the topmost painted element, so
 * a note sent behind a card must actually be *under* the card in the document, not merely drawn
 * before it with the same parent. The behind layer sits below the connectors too - see
 * annotationBehind.
 *
 * Within each layer the order is annotationPaintOrder's: sticky notes below text boxes and
 * arrows, so a label or an arrow drawn over a note is not swallowed by the paper.
 */
function renderAnnotations() {
  clear(layers.annotations);
  clear(layers.annotationsFront);

  for (const annotation of annotationPaintOrder(state.doc.annotations)) {
    const layer = annotationBehind(annotation) ? layers.annotations : layers.annotationsFront;
    layer.appendChild(renderAnnotation(annotation));
  }
}

/**
 * One annotation, of whichever kind it is.
 *
 * Three things share this layer because they share everything that matters about them - they are
 * drawn on top of the model rather than being part of it, they move and delete the same way, and
 * none of them means anything to Dataverse. What differs is only how they look: a sticky note is
 * paper, a text box is text and nothing else, and an arrow is a line with a head on it.
 */
function renderAnnotation(annotation, options) {
  const kind = annotationKind(annotation);

  if (kind === 'arrow') return renderArrow(annotation, options || {});
  if (kind === 'text') return renderTextBox(annotation, options || {});
  return renderStickyNote(annotation, options || {});
}

/** The shell every annotation sits in, with its leader line if it has one. */
function annotationGroup(annotation, options, size) {
  const group = svg('g', {
    'data-kind': 'annotation',
    'data-id': annotation.id,
    transform: 'translate(' + round(annotation.x) + ',' + round(annotation.y) + ')'
  });

  // A leader line to whatever the note is attached to - a table card, or the midpoint of a
  // connector.
  //
  // Drawn here, outside anything the note itself is rotated by: a sticky note is tilted a couple of
  // degrees, and a leader line inside that rotation would swing away from the card it points at.
  if (annotation.attachedToId) {
    const anchor = attachmentAnchor(annotation.attachedToId);

    if (anchor) {
      group.appendChild(svg('line', {
        x1: size.width / 2, y1: size.height / 2,
        x2: anchor.x - annotation.x,
        y2: anchor.y - annotation.y,
        stroke: noteColour(annotation.border, palette().annotationLine), 'stroke-width': 1,
        'stroke-dasharray': '3 3', 'pointer-events': 'none'
      }));
    }
  }

  return group;
}


function renderStickyNote(annotation, opts) {
  const theme = palette();
  const selected = !opts.forExport && state.selection.annotations.has(annotation.id);

  const width = Math.max(MIN_NOTE_WIDTH, annotation.width || NOTE_DEFAULT_SIZE);
  const height = Math.max(MIN_NOTE_HEIGHT, annotation.height || NOTE_DEFAULT_SIZE);

  const group = annotationGroup(annotation, opts, { width, height });

  // Square corners, a square-ish shape and a small tilt: the point is that it reads as a piece of
  // paper stuck onto the drawing rather than as another rounded card competing with the tables.
  const paper = svg('g', {
    transform: 'rotate(' + round(stickyTilt(annotation)) + ',' + round(width / 2) + ',' + round(height / 2) + ')'
  });

  paper.appendChild(svg('rect', {
    x: 0, y: 0, width, height, rx: 0,
    fill: noteColour(annotation.background, theme.annotationFill),
    stroke: selected ? theme.selection : noteColour(annotation.border, theme.annotationLine),
    'stroke-width': selected ? 2 : 1,
    filter: 'url(#card-shadow)'
  }));

  appendAnnotationText(paper, annotation, width, NOTE_DEFAULT_FONT_SIZE, theme.annotationInk);
  appendResizeGrip(paper, annotation, opts, width, height, selected);
  appendRotateGrip(paper, annotation, opts, width, selected);

  group.appendChild(paper);
  return group;
}

/**
 * The rotation handle: a stem and a knob standing above the top edge of a selected sticky note.
 *
 * Inside the rotated group, so it stands off the top edge of the *paper* rather than off the top
 * of the untilted box - a handle that stayed upright while the note turned under it would point
 * somewhere the note is not.
 *
 * Notes only. A text box has no paper to turn - it is words on the canvas, and words at an angle
 * are harder to read for nothing gained - and an arrow is already aimed by dragging either end.
 *
 * Gated on the selection like the resize grip, and for the same reason: an invisible control
 * hovering over every note would turn a drag meant to move one into a rotation with nothing on
 * screen to explain it.
 */
function appendRotateGrip(parent, annotation, opts, width, selected) {
  if (opts.forExport || !selected) return;

  const theme = palette();
  const cx = round(width / 2);

  parent.appendChild(svg('line', {
    class: 'rotate-stem',
    x1: cx, y1: 0, x2: cx, y2: -ROTATE_GRIP_OFFSET + 5,
    stroke: theme.selection, 'stroke-width': 1.2, opacity: 0.9, 'pointer-events': 'none'
  }));

  parent.appendChild(svg('circle', {
    cx, cy: -ROTATE_GRIP_OFFSET, r: 4.5,
    fill: theme.selection, stroke: theme.selection, 'stroke-width': 1, 'pointer-events': 'none'
  }));

  // A separate, larger, invisible target. 4.5 units is a hard thing to hit with a mouse at 60%
  // zoom, and the knob is drawn small on purpose so it does not read as part of the diagram.
  parent.appendChild(svg('circle', {
    cx, cy: -ROTATE_GRIP_OFFSET, r: 11,
    fill: 'transparent',
    'data-rotate': 'annotation',
    'data-id': annotation.id,
    style: 'cursor: grab'
  }));
}

/**
 * A plain text box: the words and nothing else.
 *
 * Deliberately has no background and no border, so it can label a region of the canvas without
 * putting another box on a drawing already made of boxes. That leaves nothing to click, which is
 * why there is a transparent hit rectangle - on screen only, since an invisible rectangle in an
 * exported file is just a thing that catches the mouse in a viewer.
 */
function renderTextBox(annotation, opts) {
  const theme = palette();
  const selected = !opts.forExport && state.selection.annotations.has(annotation.id);

  const width = Math.max(MIN_NOTE_WIDTH, annotation.width || 220);
  const height = Math.max(24, annotation.height || 40);

  const group = annotationGroup(annotation, opts, { width, height });

  if (!opts.forExport) {
    group.appendChild(svg('rect', {
      x: 0, y: 0, width, height,
      fill: 'transparent',
      stroke: selected ? theme.selection : 'none',
      'stroke-width': selected ? 1 : 0,
      'stroke-dasharray': selected ? '4 3' : null,
      'data-hit': 'annotation',
      'data-id': annotation.id,
      'pointer-events': 'all'
    }));
  }

  appendAnnotationText(group, annotation, width, 14,
    readableInk(annotation.ink, theme.annotationInk), { padding: 2 });

  appendResizeGrip(group, annotation, opts, width, height, selected);
  return group;
}

/**
 * A straight arrow, stored as a start point and a vector.
 *
 * The vector is what makes moving one a plain move: like every other annotation, an arrow is
 * dragged by changing x and y, with no special case in the drag handler, the undo snapshot or the
 * layout code.
 */
function renderArrow(annotation, opts) {
  const theme = palette();
  const selected = !opts.forExport && state.selection.annotations.has(annotation.id);

  const dx = Number(annotation.dx) || 0;
  const dy = Number(annotation.dy) || 0;
  const length = Math.hypot(dx, dy);

  const stroke = selected ? theme.selection : readableInk(annotation.ink, theme.annotationInk);

  const group = svg('g', {
    'data-kind': 'annotation',
    'data-id': annotation.id,
    transform: 'translate(' + round(annotation.x) + ',' + round(annotation.y) + ')'
  });

  // The same wide transparent path connectors use, for the same reason: a 2px line is a hard
  // target and an arrow that cannot be picked up cannot be moved or recoloured.
  if (!opts.forExport) {
    group.appendChild(svg('path', {
      d: 'M 0 0 L ' + round(dx) + ' ' + round(dy),
      fill: 'none', stroke: 'transparent', 'stroke-width': 14,
      'data-hit': 'annotation', 'data-id': annotation.id, 'pointer-events': 'stroke'
    }));
  }

  group.appendChild(svg('line', {
    x1: 0, y1: 0, x2: round(dx), y2: round(dy),
    stroke, 'stroke-width': selected ? 2.6 : 2, 'stroke-linecap': 'round',
    'pointer-events': 'none'
  }));

  if (length >= 1) {
    const angle = Math.atan2(dy, dx) * 180 / Math.PI;

    group.appendChild(svg('path', {
      d: 'M 0 0 L -12 -5.5 L -8.5 0 L -12 5.5 Z',
      fill: stroke, stroke: 'none',
      transform: 'translate(' + round(dx) + ',' + round(dy) + ') rotate(' + round(angle) + ')',
      'pointer-events': 'none'
    }));
  }

  // Grab handles at both ends, only while selected. The start handle moves the tail and leaves the
  // head where it is, which is what "re-aim this arrow" means; dragging the body moves both.
  if (!opts.forExport && selected) {
    group.appendChild(arrowHandle(annotation.id, 'data-arrow-start', 0, 0, theme));
    group.appendChild(arrowHandle(annotation.id, 'data-arrow-end', dx, dy, theme));
  }

  return group;
}

function arrowHandle(id, attribute, x, y, theme) {
  const handle = svg('circle', {
    cx: round(x), cy: round(y), r: 5,
    fill: theme.badgeFill, stroke: theme.selection, 'stroke-width': 1.5,
    'data-id': id,
    'pointer-events': 'all',
    style: 'cursor: crosshair'
  });

  handle.setAttribute(attribute, id);
  return handle;
}

/** The wrapped text of a note or a text box. */
function appendAnnotationText(parent, annotation, width, defaultSize, ink, options) {
  const opts = options || {};
  const padding = opts.padding === undefined ? 10 : opts.padding;
  const size = annotation.fontSize || defaultSize;

  const font = (annotation.bold ? '600 ' : '') + size + 'px "Segoe UI", sans-serif';
  const lines = wrapForSvg(annotation.text || '', font, Math.max(20, width - padding * 2));
  const lineHeight = size * 1.45;

  lines.forEach((line, index) => {
    parent.appendChild(svg('text', {
      x: padding, y: padding + lineHeight * (index + 0.85),
      'font-family': '"Segoe UI", sans-serif',
      'font-size': size,
      'font-weight': annotation.bold ? 600 : 400,
      fill: ink,
      'pointer-events': 'none',
      text: line
    }));
  });
}

/**
 * Bottom-right grip. Drawn on screen only: it is a control, not part of the drawing, so it is
 * left out of exports entirely rather than stripped afterwards.
 *
 * The two diagonal marks and the transparent hit rectangle are drawn only while the annotation is
 * selected, for all three annotation kinds, the same way an arrow's end handles are. The grip is a
 * control of the selection: select the annotation, then resize it. Drawn all the time, it would
 * put marks in the corner of every text box and leave an invisible resize zone there, turning a
 * drag meant to move the box into a resize.
 */
function appendResizeGrip(parent, annotation, opts, width, height, selected) {
  if (opts.forExport || !selected) return;

  const theme = palette();
  const size = ANNOTATION_HANDLE;

  parent.appendChild(svg('rect', {
    x: width - size, y: height - size, width: size, height: size,
    fill: 'transparent',
    'data-resize': 'annotation',
    'data-id': annotation.id,
    style: 'cursor: nwse-resize'
  }));

  for (let i = 1; i <= 2; i++) {
    const inset = 3 + (i - 1) * 4;
    parent.appendChild(svg('line', {
      // Named so the two diagonal scratches can be told from the rotation stem, which is drawn in
      // the same selection colour on the same note. The verify suite counts them.
      class: 'resize-mark',
      x1: width - inset, y1: height - inset - 4,
      x2: width - inset - 4, y2: height - inset,
      stroke: theme.selection,
      'stroke-width': 1.4, 'stroke-linecap': 'round',
      opacity: 0.95,
      'pointer-events': 'none'
    }));
  }
}

/**
 * A user-chosen ink, kept readable on the current canvas.
 *
 * Note *backgrounds* are mixed towards the dark canvas so the hue survives (see noteColour). Ink is
 * the opposite problem: a dark red chosen on the white canvas is very nearly invisible on the dark
 * one, so it is lifted towards white instead of being dimmed with everything else. Exports always
 * run on the light palette, so the stored colour is what reaches a file.
 */
function readableInk(stored, fallback) {
  if (!stored) return fallback;
  if (palette().name !== 'dark') return stored;

  const parsed = String(stored).replace('#', '').trim();
  if (!/^[0-9a-fA-F]{6}$/.test(parsed)) return stored;

  const [r, g, b] = [0, 2, 4].map(i => parseInt(parsed.slice(i, i + 2), 16));
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;

  return luminance > 0.62 ? stored : mixToward(stored, '#ffffff', 0.45);
}

export const MIN_NOTE_WIDTH = 120;
export const MIN_NOTE_HEIGHT = 56;

/**
 * Note colours are chosen by the user and stored as light hex values. Rather than throwing them
 * away in dark mode, each is mixed towards the dark canvas so the hue survives and the text on
 * top of it stays readable.
 */
function noteColour(stored, fallback) {
  const value = stored || fallback;
  if (palette().name !== 'dark') return value;
  return mixToward(value, palette().canvas, 0.74);
}

function mixToward(hex, target, amount) {
  const parse = value => {
    const clean = String(value || '').replace('#', '').trim();
    return /^[0-9a-fA-F]{6}$/.test(clean)
      ? [0, 2, 4].map(i => parseInt(clean.slice(i, i + 2), 16))
      : null;
  };

  const a = parse(hex);
  const b = parse(target);
  if (!a || !b) return hex;

  return '#' + a.map((channel, index) =>
    Math.round(channel + (b[index] - channel) * amount).toString(16).padStart(2, '0')).join('');
}

function wrapForSvg(text, font, maxWidth) {
  const paragraphs = String(text || '').split('\n');
  const lines = [];

  for (const paragraph of paragraphs) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (!words.length) { lines.push(''); continue; }

    let current = '';
    for (const word of words) {
      const candidate = current ? current + ' ' + word : word;
      if (measureText(candidate, font) <= maxWidth || !current) current = candidate;
      else { lines.push(current); current = word; }
    }
    if (current) lines.push(current);
  }

  return lines;
}

// ------------------------------------------------------------- overlay ---

function renderOverlay() {
  clear(layers.overlay);

  // The arrow currently being dragged out. Transient by definition, so it lives in the overlay
  // rather than in the document, and it is drawn as the real thing would be so what the user
  // releases the button on is what they get.
  if (state.pendingArrow) {
    const arrow = state.pendingArrow;

    // pointer-events off on the wrapper, so the preview never becomes a hit target of its own
    // while the drag that is producing it is still running.
    layers.overlay.appendChild(svg('g', { 'pointer-events': 'none', opacity: 0.85 }, [
      renderArrow({
        id: 'pending-arrow',
        x: arrow.x, y: arrow.y,
        dx: arrow.dx, dy: arrow.dy,
        ink: arrow.ink
      }, { forExport: true })
    ]));
  }

  const noteCard = openNoteCard();
  if (noteCard) layers.overlay.appendChild(noteCard);

  appendCornerHandles();
}

/**
 * The handles on the corners of every selected connector, one per turn in its drawn route.
 *
 * Gated on the selection like the row grips and the note's resize corner, and for the same reason:
 * the whole length of a connector is already a drag target that moves the route, and a gesture
 * that meant one thing or the other depending on where along the line the pointer went down would
 * make dragging a connector a gamble.
 *
 * Drawn in the overlay layer rather than inside the connector's own group, so nothing stands over
 * them: not a table card (the cards are painted above the links), not an annotation drawn in
 * front, and not the twelve-unit invisible stroke every *other* connector carries to be clickable,
 * which would block them exactly where two lines cross. The overlay is above all three and is not
 * drawn into an export at all.
 *
 * Sized in screen pixels rather than world units. Untangling a diagram is the one canvas task done
 * zoomed *out*: at the 35% a twenty-table model fits at, a seven-unit mark is under three pixels
 * across and its target is smaller than the pointer. The connector's own hit tolerance is
 * screen-constant for the same reason.
 *
 * A corner the user placed is drawn filled with a pale outline, one the router worked out is drawn
 * hollow, so the line says which parts of itself are being held where they are. The outline
 * matters: the fill and the selected connector underneath it are the same colour, so without it a
 * placed corner would read as a slight thickening of the line rather than as something to take
 * hold of.
 */
function appendCornerHandles() {
  if (!state.selection.relationships.size) return;

  const theme = palette();
  const emphasis = dimming();
  const scale = state.view.zoom > 0 ? state.view.zoom : 1;
  const mark = CORNER_HANDLE / scale;
  const target = CORNER_TARGET / scale;

  for (const id of state.selection.relationships) {
    const route = routeCache.get(id);
    if (!route) continue;

    // A path highlight dims everything that is not on the path, connectors included. The overlay
    // does not inherit that from the connector's group, so handles are skipped on a faded line
    // rather than standing on it at full strength.
    if (emphasis && !emphasis.links.has(id)) continue;

    (route.corners || []).forEach((corner, index) => {
      // A corner with a card at both ends of it has nothing that can move: both of its legs are
      // held on the columns the relationship points at. A handle there would be a control that
      // does nothing, so there is not one.
      if (!corner.carryX && !corner.carryY) return;

      const pinned = corner.waypointIndex !== null && corner.waypointIndex !== undefined;

      layers.overlay.appendChild(svg('rect', {
        x: round(corner.x - mark / 2), y: round(corner.y - mark / 2),
        width: round(mark), height: round(mark), rx: round(1.5 / scale),
        fill: pinned ? theme.selection : theme.canvas,
        stroke: pinned ? theme.canvas : theme.selection,
        'stroke-width': round(1.4 / scale),
        'pointer-events': 'none'
      }));

      // The cursor says which way this one goes, because a corner beside a card goes one way only
      // and a handle that ignores half of every drag needs to say so before the drag, not during
      // it.
      const cursor = corner.carryX && corner.carryY ? 'move'
        : corner.carryX ? 'ew-resize' : 'ns-resize';

      const hit = svg('rect', {
        x: round(corner.x - target / 2), y: round(corner.y - target / 2),
        width: round(target), height: round(target),
        fill: 'transparent',
        'data-corner': String(index),
        'data-id': id,
        style: 'cursor: ' + cursor
      });
      hit.appendChild(svg('title', {
        text: cursor === 'move' ? 'Drag to move the two legs that meet here'
          : cursor === 'ew-resize' ? 'Drag left and right to move this leg'
          : 'Drag up and down to move this leg'
      }));
      layers.overlay.appendChild(hit);
    });
  }
}

/**
 * The note on a table, opened by clicking the NOTE tag on its card.
 *
 * Drawn in the overlay layer in world coordinates, so it pans and zooms with the card it belongs
 * to and cannot end up floating over an unrelated part of the diagram. It is a reader, not an
 * editor - the inspector is where a note is written - and it is transient, so it is not part of
 * the document and never reaches an export.
 */
function openNoteCard() {
  if (!state.openNote) return null;

  const table = tableById(state.openNote);
  if (!table) { state.openNote = null; return null; }

  const text = String(table.notes || '').trim();
  if (!text) { state.openNote = null; return null; }

  const theme = palette();
  const rect = tableRect(table);

  const width = 260;
  const padding = 11;
  const closeSize = 16;

  const wrapped = wrapForSvg(text, FONTS.note, width - padding * 2 - closeSize - 4);
  const lines = wrapped.slice(0, NOTE_MAX_LINES);
  if (wrapped.length > NOTE_MAX_LINES) lines[lines.length - 1] += ' ...';

  const lineHeight = 16;
  const headerHeight = 20;
  const height = padding * 2 + headerHeight + lines.length * lineHeight;

  // Placed above the card, which is where the NOTE tag is and where there is usually room, and
  // below it when there is not - then clamped into the window either way.
  //
  // All of this is decided in screen coordinates rather than world ones. The card the user has
  // just clicked is on screen by definition, but the note may not be: a tall card - forty columns
  // at "all fields" is over 800 units - has no room above it *or* below it. The clamp guarantees
  // the popover is somewhere the user can see it, and the tail is dropped when clamping has moved
  // it away from the card it points at.
  const zoom = state.view.zoom || 1;
  const viewWidth = (typeof window !== 'undefined' && window.innerWidth) || 1440;
  const viewHeight = (typeof window !== 'undefined' && window.innerHeight) || 900;

  const screenHeight = height * zoom;
  const screenWidth = width * zoom;

  const above = (table.y - height - 10) * zoom + state.view.panY;
  const below = (rect.y + rect.height + 10) * zoom + state.view.panY;

  const roomAbove = above >= TOP_CHROME_HEIGHT;
  let screenY = roomAbove ? above : below;
  let screenX = rect.x * zoom + state.view.panX;

  // The clamp is to the part of the window the drawing actually has, not to the window. The left
  // panel and the inspector are opaque and painted over the canvas, so clamping to the raw window
  // width could put a note on a right-hand card entirely behind the inspector. fitToView and
  // resetView inset for the same two panels for the same reason.
  const clampedY = Math.max(
    TOP_CHROME_HEIGHT,
    Math.min(screenY, viewHeight - screenHeight - BOTTOM_CHROME_HEIGHT));
  const clampedX = Math.max(
    panelInset('left-panel'),
    Math.min(screenX, viewWidth - screenWidth - panelInset('inspector')));

  const moved = Math.abs(clampedY - screenY) > 1 || Math.abs(clampedX - screenX) > 1;

  screenY = clampedY;
  screenX = clampedX;

  const x = (screenX - state.view.panX) / zoom;
  const y = (screenY - state.view.panY) / zoom;

  const group = svg('g', {
    'data-note-card': table.id,
    transform: 'translate(' + round(x) + ',' + round(y) + ')'
  });

  // A small tail towards the card, so a note near several cards says which one it belongs to. Only
  // when the note is where it was meant to go: a clamped note is not aligned with its card any
  // more, and a tail pointing at empty canvas is worse than no tail.
  if (!moved) {
    const tailBase = roomAbove ? height : 0;
    const tailTip = roomAbove ? height + 9 : -9;

    group.appendChild(svg('path', {
      d: 'M 20 ' + tailBase + ' L 34 ' + tailTip + ' L 48 ' + tailBase + ' Z',
      fill: theme.noteTagFill, stroke: theme.noteTagLine, 'stroke-width': 1
    }));
  }

  group.appendChild(svg('rect', {
    x: 0, y: 0, width, height, rx: 8,
    fill: theme.noteTagFill, stroke: theme.noteTagLine, 'stroke-width': 1,
    filter: 'url(#card-shadow)'
  }));

  group.appendChild(svg('text', {
    x: padding, y: padding + 8,
    'font-family': '"Segoe UI", sans-serif', 'font-size': 8.5, 'font-weight': 600,
    'letter-spacing': '0.5', fill: theme.noteTagInk,
    text: truncateToWidth(
      (table.displayName || table.logicalName || 'NOTE').toUpperCase(),
      FONTS.badge, width - padding * 2 - closeSize - 8)
  }));

  lines.forEach((line, index) => {
    group.appendChild(svg('text', {
      x: padding, y: padding + headerHeight + lineHeight * (index + 0.75),
      'font-family': '"Segoe UI", sans-serif', 'font-size': 12,
      fill: theme.annotationInk,
      text: line
    }));
  });

  group.appendChild(svg('g', {
    'data-note-close': table.id,
    'pointer-events': 'all',
    style: 'cursor: pointer'
  }, [
    svg('title', { text: 'Close this note' }),
    svg('rect', {
      x: width - padding - closeSize + 3, y: padding - 5,
      width: closeSize, height: closeSize, rx: 4,
      fill: theme.badgeFill, stroke: theme.noteTagLine, 'stroke-width': 1
    }),
    svg('text', {
      x: width - padding - closeSize / 2 + 3, y: padding + 7,
      'text-anchor': 'middle',
      'font-family': '"Segoe UI", sans-serif', 'font-size': 12, fill: theme.noteTagInk,
      text: '×'
    })
  ]));

  return group;
}

// -------------------------------------------------------------- export ---

/**
 * Builds a standalone SVG document of the whole diagram at natural size, independent of the
 * current pan and zoom. Used for both SVG export and as the source image for PNG export.
 */
export function buildExportSvg(options) {
  // Exports are always light. A dark PNG pasted into a document or a slide reads as a mistake,
  // and the .dvmd file carries no theme, so the output is stable whichever theme is on screen.
  return withLightPalette(() => buildExportSvgInner(options));
}

function buildExportSvgInner(options) {
  const opts = options || {};
  const bounds = documentBounds(opts.padding === undefined ? 48 : opts.padding);

  const root = svg('svg', {
    xmlns: 'http://www.w3.org/2000/svg',
    'xmlns:xlink': 'http://www.w3.org/1999/xlink',
    width: Math.max(1, Math.round(bounds.width)),
    height: Math.max(1, Math.round(bounds.height)),
    viewBox: [round(bounds.x), round(bounds.y), round(bounds.width), round(bounds.height)].join(' ')
  });

  root.appendChild(svg('title', { text: state.doc.title || 'Dataverse model' }));

  const defs = svg('defs', {}, [
    svg('filter', { id: 'card-shadow', x: '-20%', y: '-20%', width: '140%', height: '150%' }, [
      svg('feDropShadow', { dx: 0, dy: 3, stdDeviation: 4, 'flood-color': '#101725', 'flood-opacity': 0.1 })
    ])
  ]);
  root.appendChild(defs);

  root.appendChild(svg('rect', {
    x: round(bounds.x), y: round(bounds.y),
    width: round(bounds.width), height: round(bounds.height),
    fill: '#ffffff'
  }));

  // Draw with nothing selected so the export never carries transient UI emphasis.
  const savedSelection = {
    tables: new Set(state.selection.tables),
    relationships: new Set(state.selection.relationships),
    annotations: new Set(state.selection.annotations)
  };
  const savedHighlight = state.highlightPath;

  // An open note is transient UI state exactly like a selection, and the card's NOTE tag is drawn
  // differently while it is open - a heavier border. Left set, the export would show one tag
  // marked as open for no reason a reader of the picture could see.
  const savedOpenNote = state.openNote;

  state.selection.tables = new Set();
  state.selection.relationships = new Set();
  state.selection.annotations = new Set();
  state.highlightPath = null;
  state.openNote = null;

  try {
    const linkGroup = svg('g');
    const groups = groupRelationships(visibleRelationships());
    const drawnSegments = [];

    for (const group of groups.values()) {
      group.forEach((relationship, index) => {
        const route = routeRelationship(relationship, index, group.length);
        if (!route) return;
        linkGroup.appendChild(renderLink(relationship, route, null, crossingPoints(route.points, drawnSegments)));
        drawnSegments.push(...segmentsOf(route.points));
      });
    }

    // The same two layers the canvas draws, in the same order, so an annotation the user tucked
    // behind the model is behind it in the file as well - behind the connectors too, so the behind
    // group goes in ahead of the links rather than between them and the cards.
    const behindGroup = svg('g');
    const frontGroup = svg('g');

    for (const annotation of annotationPaintOrder(state.doc.annotations)) {
      const group = annotationBehind(annotation) ? behindGroup : frontGroup;
      group.appendChild(renderAnnotation(annotation, { forExport: true }));
    }

    root.appendChild(behindGroup);
    root.appendChild(linkGroup);

    const tableGroup = svg('g');
    for (const table of state.doc.tables) tableGroup.appendChild(renderTableCard(table, null));
    root.appendChild(tableGroup);

    root.appendChild(frontGroup);
  } finally {
    state.selection = savedSelection;
    state.highlightPath = savedHighlight;
    state.openNote = savedOpenNote;
  }

  if (state.doc.settings.showLegend) root.appendChild(buildLegend(bounds));
  if (state.doc.settings.showTitleBlock) root.appendChild(buildTitleBlock(bounds));

  stripInteractionAttributes(root);
  return new XMLSerializer().serializeToString(root);
}

function buildLegend(bounds) {
  const entries = [
    ['Existing', statusStyle('Existing')],
    ['Proposed', statusStyle('Proposed')],
    ['External', statusStyle('External')],
    ['Deprecated', statusStyle('Deprecated')]
  ];

  // Emphasis colours actually used on this diagram, under whatever name the user gave them. A
  // recoloured card no longer matches any status swatch, so a legend that lists only the four
  // statuses is describing a drawing that is not on the page.
  const emphasis = [];
  for (const object of state.doc.tables.concat(state.doc.relationships)) {
    const colour = object.highlight;
    if (colour && !emphasis.includes(colour)) emphasis.push(colour);
  }
  emphasis.sort();

  for (const colour of emphasis) {
    entries.push([emphasisName(colour), {
      fill: emphasisHead(colour), mark: colour, dash: null
    }]);
  }

  // Ownership is explained only when it is being drawn. A legend entry for a marker that is not
  // on the diagram is one more thing to read and nothing to look for.
  const ownershipNote = state.doc.settings.showOwnership;

  const labelWidth = Math.max(...entries.map(([label]) => measureText(label, FONTS.note)));
  const width = Math.max(132, Math.ceil(labelWidth) + 46);
  const height = 22 + entries.length * 18 + (ownershipNote ? 26 : 0);
  const x = bounds.x + bounds.width - width - 12;
  const y = bounds.y + bounds.height - height - 12;

  const group = svg('g', { transform: 'translate(' + round(x) + ',' + round(y) + ')' });

  group.appendChild(svg('rect', {
    x: 0, y: 0, width, height, rx: 8, fill: '#ffffff', stroke: '#e4e9f2', 'stroke-width': 1
  }));
  group.appendChild(svg('text', {
    x: 11, y: 15, 'font-family': '"Segoe UI", sans-serif', 'font-size': 8.5,
    'letter-spacing': '0.8', fill: '#8a93a5', text: 'LEGEND'
  }));

  entries.forEach(([label, style], index) => {
    const rowY = 24 + index * 18;
    group.appendChild(svg('rect', {
      x: 11, y: rowY, width: 9, height: 9, rx: 2,
      fill: style.fill, stroke: style.mark, 'stroke-width': 1.2, 'stroke-dasharray': style.dash
    }));
    group.appendChild(svg('text', {
      x: 27, y: rowY + 8, 'font-family': '"Segoe UI", sans-serif', 'font-size': 11,
      fill: '#5b6577', text: label
    }));
  });

  if (ownershipNote) {
    const rowY = 24 + entries.length * 18 + 6;

    group.appendChild(svg('rect', {
      x: 11, y: rowY, width: 26, height: 11, rx: 5.5,
      fill: 'none', stroke: '#c3cad6', 'stroke-width': 1
    }));
    group.appendChild(svg('text', {
      x: 24, y: rowY + 8, 'text-anchor': 'middle',
      'font-family': '"Segoe UI", sans-serif', 'font-size': 7, 'font-weight': 600,
      fill: '#67717f', text: 'USER'
    }));
    group.appendChild(svg('text', {
      x: 43, y: rowY + 8, 'font-family': '"Segoe UI", sans-serif', 'font-size': 10,
      fill: '#5b6577', text: 'Ownership'
    }));
  }

  return group;
}

function buildTitleBlock(bounds) {
  const group = svg('g');
  const source = state.doc.source || {};

  const subtitleParts = [];
  if (source.organizationFriendlyName) subtitleParts.push(source.organizationFriendlyName);
  if (source.environmentUrl) subtitleParts.push(source.environmentUrl);
  if (source.lastRefreshUtc) {
    const date = new Date(source.lastRefreshUtc);
    if (!isNaN(date.getTime())) {
      subtitleParts.push('refreshed ' + date.toLocaleDateString('en-GB'));
    }
  }

  group.appendChild(svg('text', {
    x: round(bounds.x + 16), y: round(bounds.y + 26),
    'font-family': '"Segoe UI", sans-serif', 'font-size': 15, 'font-weight': 600, fill: '#101725',
    text: state.doc.title || 'Dataverse model'
  }));

  if (state.doc.description) {
    group.appendChild(svg('text', {
      x: round(bounds.x + 16), y: round(bounds.y + 43),
      'font-family': '"Segoe UI", sans-serif', 'font-size': 11, fill: '#5b6577',
      text: truncateToWidth(state.doc.description, FONTS.note, bounds.width - 200)
    }));
  }

  if (subtitleParts.length) {
    group.appendChild(svg('text', {
      x: round(bounds.x + 16), y: round(bounds.y + (state.doc.description ? 59 : 43)),
      'font-family': '"Segoe UI", sans-serif', 'font-size': 10, fill: '#8a93a5',
      text: subtitleParts.join('  ·  ')
    }));
  }

  return group;
}

/** Removes canvas-only attributes so the exported file is clean markup. */
function stripInteractionAttributes(root) {
  const nodes = root.querySelectorAll(
    '[data-kind],[data-id],[data-hit],[data-note-for],[data-note-close],[data-resize],' +
    '[data-rotate],[data-row-grip],[data-corner],[data-arrow-start],[data-arrow-end],[pointer-events]');

  for (const node of nodes) {
    // A control's tooltip describes what clicking it does, which is a lie in a static file. The
    // ownership pill's <title> is left alone deliberately - that one explains the drawing, and is
    // worth having when the SVG is opened in a browser.
    // A grip carries a tooltip describing a gesture, which is nonsense in a static file - and one
    // is never drawn into an export anyway, because buildExportSvgInner empties the selection
    // first. This is a safeguard for that: the title is what would survive the rest of this pass,
    // since a <title> is a child element rather than an attribute.
    if (node.hasAttribute && (node.hasAttribute('data-note-for') ||
        node.hasAttribute('data-row-grip') || node.hasAttribute('data-corner'))) {
      // Array.from because childNodes is a live NodeList in a real DOM and removing from it while
      // iterating skips entries.
      for (const child of Array.from(node.childNodes)) {
        if (child.tagName === 'title') node.removeChild(child);
      }
    }

    node.removeAttribute('data-kind');
    node.removeAttribute('data-id');
    node.removeAttribute('data-hit');
    node.removeAttribute('data-note-for');
    node.removeAttribute('data-note-close');
    node.removeAttribute('data-resize');
    node.removeAttribute('data-rotate');
    node.removeAttribute('data-row-grip');
    node.removeAttribute('data-corner');
    node.removeAttribute('data-arrow-start');
    node.removeAttribute('data-arrow-end');

    // The cursor style is a control's, not a drawing's. Left in place it makes an exported SVG
    // opened in a browser look like it has clickable parts that do nothing.
    if (node.getAttribute('style') && node.getAttribute('style').indexOf('cursor') >= 0) {
      node.removeAttribute('style');
    }

    // Every invisible node in this drawing is a hit target: the wide path under a connector, the
    // rectangle that makes a text box clickable, the grip beside a row. They are drawn transparent
    // rather than not drawn at all, and in a file opened in a browser they are parts of the picture
    // that catch the mouse and do nothing.
    if (node.getAttribute('stroke') === 'transparent' ||
        node.getAttribute('fill') === 'transparent') node.remove();
    else node.removeAttribute('pointer-events');
  }
}
