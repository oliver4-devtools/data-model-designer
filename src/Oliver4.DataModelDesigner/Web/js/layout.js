// Automatic layout.
//
// The default is a layered (Sugiyama-style) arrangement: relationships in a Dataverse model are
// directional, so layering by the 1:N direction and then reducing crossings with a barycentre
// pass produces something an architect recognises. Disconnected tables are packed into a grid
// beside the graph rather than scattered through it.

import { state, tableById, visibleRelationships, clearManualRoute } from './state.js';
import { measureTable } from './geometry.js';

const GAP_X = 90;
const GAP_Y = 46;
const COMPONENT_GAP = 90;

/**
 * Applies one of the automatic layouts. Auto and Horizontal are distinct:
 *
 *   Auto        layers left to right, each layer centred on the one before it. The default, and
 *               the one that reads as a data model.
 *   Horizontal  the same layering, but each layer packed from a common top edge rather than
 *               centred, which gives a flatter, wider band suited to a landscape document.
 */
export function applyLayout(mode) {
  if (mode === 'Manual') return;

  // Every card is about to move, and a connector's hand-placed corners are absolute canvas
  // coordinates: left alone they would hold the line at points the cards have left, so they are
  // cleared. The two offsets go with them - they are measured from the automatic route, which is
  // about to be a different shape.
  //
  // Undo puts the whole rearrangement back, routing included, because this runs inside the same
  // mutate as the layout itself.
  for (const relationship of state.doc.relationships) clearManualRoute(relationship);

  switch (mode) {
    case 'Grid': return gridLayout();
    case 'Horizontal': return layeredLayout('LR', { align: 'start' });
    case 'Vertical': return layeredLayout('TB');
    case 'Hierarchical': return layeredLayout('TB', { strictHierarchy: true });
    default: return layeredLayout('LR');
  }
}

export function gridLayout() {
  const tables = state.doc.tables;
  if (!tables.length) return;

  const sizes = tables.map(measureTable);
  const columnCount = Math.max(1, Math.ceil(Math.sqrt(tables.length * 1.35)));
  const columnWidth = Math.max(...sizes.map(s => s.width)) + GAP_X;

  let x = 0;
  let y = 0;
  let rowHeight = 0;
  let column = 0;

  tables.forEach((table, index) => {
    const size = sizes[index];
    table.x = x;
    table.y = y;
    rowHeight = Math.max(rowHeight, size.height);
    column++;

    if (column >= columnCount) {
      column = 0;
      x = 0;
      y += rowHeight + GAP_Y;
      rowHeight = 0;
    } else {
      x += columnWidth;
    }
  });
}

export function layeredLayout(orientation, options) {
  const opts = options || {};
  const tables = state.doc.tables;
  if (!tables.length) return;

  const nodes = new Map();
  for (const table of tables) {
    const size = measureTable(table);
    nodes.set(table.id, {
      table,
      width: size.width,
      height: size.height,
      out: new Set(),
      in: new Set(),
      layer: 0,
      order: 0
    });
  }

  for (const relationship of visibleRelationships()) {
    const from = nodes.get(relationship.fromTableId);
    const to = nodes.get(relationship.toTableId);
    if (!from || !to || from === to) continue;

    from.out.add(to.table.id);
    to.in.add(from.table.id);
  }

  const components = findComponents(nodes);
  let cursor = 0;

  for (const component of components) {
    const extent = layoutComponent(component, nodes, orientation, opts, cursor);
    cursor += extent + COMPONENT_GAP;
  }
}

function findComponents(nodes) {
  const seen = new Set();
  const components = [];

  for (const id of nodes.keys()) {
    if (seen.has(id)) continue;

    const component = [];
    const queue = [id];
    seen.add(id);

    while (queue.length) {
      const current = queue.shift();
      component.push(current);
      const node = nodes.get(current);

      for (const neighbour of [...node.out, ...node.in]) {
        if (seen.has(neighbour)) continue;
        seen.add(neighbour);
        queue.push(neighbour);
      }
    }

    components.push(component);
  }

  // Largest component first keeps the main model at the origin, where the user is looking.
  return components.sort((a, b) => b.length - a.length);
}

function layoutComponent(componentIds, nodes, orientation, opts, offset) {
  const component = componentIds.map(id => nodes.get(id));

  assignLayers(component, nodes, opts);
  const layers = groupIntoLayers(component);
  reduceCrossings(layers, nodes);

  const horizontal = orientation !== 'TB';

  // Cross-axis size of each layer decides where the next layer starts.
  const layerExtents = layers.map(layer =>
    Math.max(0, ...layer.map(node => (horizontal ? node.width : node.height))));

  let along = 0;
  let maxAcross = 0;

  layers.forEach((layer, layerIndex) => {
    let across = 0;

    const layerSize = layer.reduce(
      (total, node) => total + (horizontal ? node.height : node.width) + GAP_Y, -GAP_Y);

    // Centred by default, so each layer sits against the middle of the one before it. With
    // align: 'start' every layer begins on the same edge instead, which packs the drawing into a
    // flatter band - the shape that fits a landscape page.
    across = opts.align === 'start' ? 0 : -layerSize / 2;

    for (const node of layer) {
      if (horizontal) {
        node.table.x = along;
        node.table.y = across;
        across += node.height + GAP_Y;
      } else {
        node.table.x = across;
        node.table.y = along;
        across += node.width + GAP_Y;
      }
    }

    maxAcross = Math.max(maxAcross, layerSize);
    along += layerExtents[layerIndex] + GAP_X;
  });

  // Shift the whole component onto the positive axis and past anything already placed.
  const minAcross = Math.min(...component.map(n => horizontal ? n.table.y : n.table.x));
  for (const node of component) {
    if (horizontal) {
      node.table.y = node.table.y - minAcross + offset;
    } else {
      node.table.x = node.table.x - minAcross + offset;
    }
  }

  return maxAcross;
}

/**
 * Longest-path layering. Nodes with no incoming 1:N land on layer 0, everything else sits one
 * layer past its deepest parent. Cycles (a self-referential model is common in Dataverse) are
 * broken by capping the walk at the node count.
 */
function assignLayers(component, nodes, opts) {
  const ids = new Set(component.map(n => n.table.id));

  for (const node of component) node.layer = 0;

  let changed = true;
  let iterations = 0;
  const limit = component.length + 2;

  while (changed && iterations++ < limit) {
    changed = false;

    for (const node of component) {
      for (const targetId of node.out) {
        if (!ids.has(targetId)) continue;
        const target = nodes.get(targetId);
        if (target.layer < node.layer + 1) {
          target.layer = node.layer + 1;
          changed = true;
        }
      }
    }
  }

  if (opts.strictHierarchy) return;

  // Pull leaf nodes as close to their parent as possible so the drawing is not needlessly wide.
  for (const node of component) {
    if (!node.out.size && node.in.size) {
      const parents = [...node.in].map(id => nodes.get(id)).filter(Boolean);
      if (parents.length) node.layer = Math.max(...parents.map(p => p.layer)) + 1;
    }
  }
}

function groupIntoLayers(component) {
  const maxLayer = Math.max(...component.map(n => n.layer));
  const layers = [];

  for (let i = 0; i <= maxLayer; i++) {
    layers.push(component.filter(n => n.layer === i));
  }

  return layers.filter(layer => layer.length);
}

/** Four barycentre sweeps, which is enough to tidy the diagrams this tool produces. */
function reduceCrossings(layers, nodes) {
  layers.forEach(layer => layer.forEach((node, index) => { node.order = index; }));

  for (let pass = 0; pass < 4; pass++) {
    const forward = pass % 2 === 0;
    const sequence = forward ? layers : layers.slice().reverse();

    for (let i = 1; i < sequence.length; i++) {
      const layer = sequence[i];
      const previous = sequence[i - 1];
      const positions = new Map(previous.map((node, index) => [node.table.id, index]));

      for (const node of layer) {
        const neighbours = [...(forward ? node.in : node.out)]
          .map(id => positions.get(id))
          .filter(value => value !== undefined);

        node.barycentre = neighbours.length
          ? neighbours.reduce((a, b) => a + b, 0) / neighbours.length
          : node.order;
      }

      layer.sort((a, b) => a.barycentre - b.barycentre);
      layer.forEach((node, index) => { node.order = index; });
    }
  }
}

/**
 * Places tables that have just been added without moving anything already on the canvas.
 * Used when the user adds to an existing diagram and does not want a full re-layout.
 */
export function positionNewTables(newTables) {
  if (!newTables || !newTables.length) return;

  const placed = state.doc.tables
    .filter(t => !newTables.includes(t))
    .map(t => {
      const size = measureTable(t);
      return { x: t.x, y: t.y, width: size.width, height: size.height };
    });

  let cursorX = placed.length ? Math.max(...placed.map(r => r.x + r.width)) + GAP_X : 0;
  let cursorY = placed.length ? Math.min(...placed.map(r => r.y)) : 0;
  const columnTop = cursorY;
  let columnWidth = 0;
  const maxColumnHeight = 900;

  for (const table of newTables) {
    const size = measureTable(table);

    if (cursorY > columnTop + maxColumnHeight) {
      cursorX += columnWidth + GAP_X;
      cursorY = columnTop;
      columnWidth = 0;
    }

    table.x = cursorX;
    table.y = cursorY;

    cursorY += size.height + GAP_Y;
    columnWidth = Math.max(columnWidth, size.width);
  }
}
